import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { reconstructSessions } from "../src/session-reconstruction.js";

// Characterization tests: compare the actual current calculation functions with
// phase 1. Expected differences are integration blockers, NOT approved behavior.
// Evaluate only selected pure functions, never App, Firebase or an export action.
const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
function declaration(name, nextMarker) {
  const start = source.indexOf(`const ${name} =`);
  const end = source.indexOf(nextMarker, start);
  assert.ok(start >= 0 && end > start, `Review extraction of ${name} if App.jsx changes`);
  return source.slice(start, end);
}

function currentCalculations(records, { from = "", to = "" } = {}) {
  let summary;
  const calculate = runInNewContext([
    declaration("minutesToHours", "const parseLogDate ="),
    declaration("parseLogDate", "const inRange ="),
    declaration("inRange", "function AlertMessage("),
    declaration("buildDashboardFromData", "const calcularDashboard ="),
    declaration("formatExportDateTime", "const getWorkerName ="),
    declaration("getWorkerName", "const getSessionMinutes ="),
    declaration("getSessionMinutes", "const buildInspectionRows ="),
    declaration("buildInspectionRows", "const descargarPDFTrabajadores ="),
    `({ minutesToHours, parseLogDate, buildDashboardFromData, buildInspectionRows })`,
  ].join("\n"), {
    dateFrom: from, dateTo: to,
    startOfWeek: () => new Date("2025-01-01T00:00:00Z"),
    endOfWeek: () => new Date("2027-01-01T00:00:00Z"),
    setResumenTrabajadores: (value) => { summary = value; },
    setWeeklySummary: () => {}, setStats: () => {},
  }, { timeout: 1000 });
  const workers = [{ id: "fictional-worker", email: "fictional@example.invalid" }];
  const logs = records.map((record) => ({ ...record, date: calculate.parseLogDate(record.timestamp) }))
    .filter((record) => record.date);
  calculate.buildDashboardFromData(workers, logs);
  return {
    dashboardMinutes: summary[0].minutosAcumulados,
    dashboardPeriodMinutes: summary[0].minutosMes,
    inspection: calculate.buildInspectionRows(workers, logs, {}),
    unknownFormatting: calculate.minutesToHours(null),
    reconstructed: reconstructSessions(records),
  };
}

// All records and dates below are synthetic, with no real worker/company data.
const timestamp = (iso) => {
  const ms = Date.parse(iso);
  return { seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6,
    toDate: () => new Date(ms) };
};
const start = timestamp("2026-01-01T08:00:00Z");
const finish = timestamp("2026-01-01T12:00:00Z");
const entry = (id = "entry", overrides = {}) => ({ id, companyId: "fictional-company",
  userId: "fictional-worker", tipo: "entrada", timestamp: start, ...overrides });
const exit = (id = "exit", overrides = {}) => ({ id, companyId: "fictional-company",
  userId: "fictional-worker", tipo: "salida", timestamp: finish, entradaLogId: "entry",
  inicioSesion: start, minutosSesion: 240, ...overrides });
const closedMinutes = (result) => result.reconstructed.sessions
  .filter((session) => session.status === "closed").map((session) => session.minutes);

test("coherent modern format agrees across current panel, inspection and module", () => {
  const result = currentCalculations([entry(), exit()]);
  assert.equal(result.dashboardMinutes, 240);
  assert.equal(result.inspection[0].sessionMinutes, 240);
  assert.deepEqual(closedMinutes(result), [240]);
  assert.equal(result.reconstructed.canReconstruct, true);
});

test("explicit legacy reference without derived metadata remains compatible", () => {
  const oldExit = exit();
  delete oldExit.inicioSesion;
  delete oldExit.minutosSesion;
  const result = currentCalculations([entry(), oldExit]);
  assert.equal(result.dashboardMinutes, 240);
  assert.equal(result.inspection[0].sessionMinutes, 240);
  assert.deepEqual(closedMinutes(result), [240]);
});

test("BLOCKER: original historical format without a reference loses quantified hours on replacement", () => {
  // The initial App.jsx (cba5c2d) wrote this four-field payload for both event types.
  const oldExit = { id: "exit", companyId: "fictional-company", userId: "fictional-worker",
    tipo: "salida", timestamp: finish };
  const records = [entry(), oldExit];
  const result = currentCalculations(records);
  assert.equal(result.dashboardMinutes, 240);
  assert.equal(result.inspection[0].sessionMinutes, 240);
  assert.deepEqual(closedMinutes(result), []);
  assert.equal(result.reconstructed.sessions[0].minutes, null);
  assert.ok(result.reconstructed.issues.some((issue) => issue.code === "missing_entry_reference"));
  assert.equal(result.reconstructed.records.length, records.length);
});

test("BLOCKER: stored duration permitted by rules differs from server timestamps", () => {
  // Current rules constrain type/range, not equality with timestamp subtraction.
  // The client calculates minutes before the server assigns the exit timestamp.
  const result = currentCalculations([entry(), exit("exit", { minutosSesion: 239 })]);
  assert.equal(result.dashboardMinutes, 239);
  assert.equal(result.inspection[0].sessionMinutes, 239);
  assert.deepEqual(closedMinutes(result), []);
  assert.ok(result.reconstructed.issues.some((issue) => issue.code === "session_minutes_mismatch"));
});

test("BLOCKER: rules accept 1440 stored minutes even if elapsed time exceeds 24 hours slightly", () => {
  const result = currentCalculations([entry(), exit("exit", {
    timestamp: timestamp("2026-01-02T08:00:30Z"), minutosSesion: 1440,
  })]);
  assert.equal(result.dashboardMinutes, 1440);
  assert.equal(result.inspection[0].sessionMinutes, 1440);
  assert.deepEqual(closedMinutes(result), []);
  assert.ok(result.reconstructed.issues.some((issue) => issue.code === "session_exceeds_24_hours"));
});

test("AMBIGUITY: consecutive unreferenced entries already disagree between current views", () => {
  const oldExit = { id: "exit", companyId: "fictional-company", userId: "fictional-worker",
    tipo: "salida", timestamp: finish };
  const result = currentCalculations([entry(), entry("entry-b", {
    timestamp: timestamp("2026-01-01T09:00:00Z"),
  }), oldExit]);
  assert.equal(result.dashboardMinutes, 180);
  assert.equal(result.inspection.find((row) => row.salidaLogId === "exit").sessionMinutes, 240);
  assert.deepEqual(closedMinutes(result), []);
  assert.ok(result.reconstructed.issues.some((issue) => issue.code === "consecutive_entries"));
  assert.equal(result.reconstructed.records.length, 3);
});

test("AMBIGUITY: two exits for one entry are currently counted twice", () => {
  const result = currentCalculations([entry(), exit(), exit("exit-b", {
    timestamp: timestamp("2026-01-01T12:01:00Z"), minutosSesion: 241,
  })]);
  assert.equal(result.dashboardMinutes, 481);
  assert.equal(result.inspection.reduce((sum, row) => sum + row.sessionMinutes, 0), 481);
  assert.deepEqual(closedMinutes(result), []);
  assert.ok(result.reconstructed.issues.some((issue) => issue.code === "multiple_exits"));
  assert.equal(result.reconstructed.records.length, 3);
});

test("BLOCKER: an open unknown duration currently appears as a zero total", () => {
  const result = currentCalculations([entry()]);
  assert.equal(result.dashboardMinutes, 0);
  assert.equal(result.inspection[0].sessionMinutes, "");
  assert.equal(result.inspection[0].totalPeriodHours, "0.00");
  assert.equal(result.unknownFormatting, "0.00");
  assert.equal(result.reconstructed.sessions[0].minutes, null);
});

test("BLOCKER: reporting period selects different sessions in panel and inspection", () => {
  const a = timestamp("2026-01-01T22:00:00Z");
  const b = timestamp("2026-01-02T02:00:00Z");
  const result = currentCalculations([entry("entry", { timestamp: a }),
    exit("exit", { timestamp: b, inicioSesion: a })], { from: "2026-01-01", to: "2026-01-01" });
  assert.equal(result.dashboardPeriodMinutes, 0);
  assert.equal(result.inspection[0].sessionMinutes, 240);
  assert.deepEqual(closedMinutes(result), [240]);
});
