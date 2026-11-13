import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { buildSharedReport, formatReportDate } from "../src/session-reporting.js";

const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const extract = (name, next) => {
  const start = source.indexOf(`const ${name} =`);
  const end = source.indexOf(next, start);
  assert.ok(start >= 0 && end > start, `Review ${name} extraction`);
  return source.slice(start, end);
};
const start = new Date("2026-01-01T08:00:00Z");
const records = [
  { id: "e", tipo: "entrada", timestamp: start, userId: "worker", companyId: "company" },
  { id: "s", tipo: "salida", timestamp: new Date("2026-01-01T12:00:00Z"),
    entradaLogId: "e", inicioSesion: start, minutosSesion: 240, userId: "worker", companyId: "company" },
  { id: "pending", tipo: "entrada", timestamp: new Date("2026-01-02T08:00:00Z"), userId: "worker", companyId: "company" },
];
const workers = [{ id: "worker", companyId: "company", email: "fictional@example.invalid" }];
const report = buildSharedReport(records, workers, { now: new Date("2026-01-10T12:00:00Z") });

test("the actual cached-report ownership check requires the same company and viewer", () => {
  const start = source.indexOf("const sessionReportMatchesContext =");
  const end = source.indexOf(";", start);
  assert.ok(start >= 0 && end > start);
  const expression = source.slice(start, end + 1) + "\nsessionReportMatchesContext;";
  const cached = { ...report, companyId: "company", viewerUid: "viewer" };
  assert.equal(runInNewContext(expression, { sessionReport: cached, companyId: "company", user: { uid: "viewer" } }), true);
  assert.equal(runInNewContext(expression, { sessionReport: cached, companyId: "other", user: { uid: "viewer" } }), false);
  assert.equal(runInNewContext(expression, { sessionReport: cached, companyId: "company", user: { uid: "other" } }), false);
  assert.equal(runInNewContext(expression, { sessionReport: cached, companyId: "company", user: null }), false);
});

test("real dashboard loader retains Firestore IDs and applies the shared calculation", async () => {
  const captured = {};
  const f = runInNewContext(extract("calcularDashboard", "const cargarHistorialTrabajador =") + "\ncalcularDashboard;", {
    Date, db: {}, companyId: "company", user: { uid: "viewer" }, dateFrom: "", dateTo: "", buildSharedReport,
    collection: () => ({}), where: () => ({}), query: () => ({}),
    getDocs: async () => ({ docs: records.map(({ id, ...data }) => ({ id, data: () => data })) }),
    cargarTrabajadores: async () => workers,
    clearMessages: () => {}, setBusy: () => {}, setInfoMsg: () => {},
    setErrorMsg: (v) => { captured.error = v; }, setSessionReport: (v) => { captured.report = v; },
    setResumenTrabajadores: (v) => { captured.summary = v; }, setWeeklySummary: () => {}, setStats: () => {},
    buildDashboardFromData: () => { captured.legacyCalled = true; },
  });
  await f();
  assert.equal(captured.error, undefined);
  assert.equal(captured.legacyCalled, undefined);
  assert.equal(captured.report.ready, true);
  assert.equal(captured.report.companyId, "company");
  assert.equal(captured.report.viewerUid, "viewer");
  assert.equal(captured.summary[0].minutosAcumulados, 240);
  assert.equal(captured.summary[0].unknownTotal, 1);
  assert.deepEqual(captured.report.view.records.map((r) => r.id), records.map((r) => r.id));
});

test("real dashboard loader keeps the old calculation and blocks exports on ambiguity", async () => {
  const old = { ...records[1] };
  delete old.entradaLogId;
  const captured = {};
  const f = runInNewContext(extract("calcularDashboard", "const cargarHistorialTrabajador =") + "\ncalcularDashboard;", {
    Date, db: {}, companyId: "company", user: { uid: "viewer" }, dateFrom: "", dateTo: "", buildSharedReport,
    collection: () => ({}), where: () => ({}), query: () => ({}), parseLogDate: (v) => v,
    getDocs: async () => ({ docs: [records[0], old].map(({ id, ...data }) => ({ id, data: () => data })) }),
    cargarTrabajadores: async () => workers, clearMessages: () => {}, setBusy: () => {}, setInfoMsg: () => {},
    setErrorMsg: (v) => { captured.error = v; }, setSessionReport: (v) => { captured.report = v; },
    setResumenTrabajadores: () => { captured.replacementCalled = true; }, setWeeklySummary: () => {}, setStats: () => {},
    buildDashboardFromData: () => { captured.legacyCalled = true; },
  });
  await f();
  assert.equal(captured.error, undefined);
  assert.equal(captured.legacyCalled, true);
  assert.equal(captured.replacementCalled, undefined);
  assert.equal(captured.report.ready, false);
  assert.equal(captured.report.summary, null);
});

function exportHarness(name, next, overrides = {}, pdfStub = false) {
  const captured = { audits: 0, downloads: 0 };
  const context = {
    Date, formatReportDate, sessionReport: report, sessionReportMatchesContext: true, dateFrom: "", dateTo: "", trabajadores: workers,
    companyId: "company", db: {}, editEmpresa: {},
    buildReportRows: () => report.summary,
    getWorkerName: () => "Ficticio", minutesToHours: (n) => (n / 60).toFixed(2),
    csvEscape: (v) => `"${String(v ?? "").replaceAll('"', '""')}"`,
    clearMessages: () => {}, setBusy: () => {}, setInfoMsg: (v) => { captured.info = v; },
    setErrorMsg: (v) => { captured.error = v; }, registrarAuditoria: async () => { captured.audits++; },
    doc: () => ({}), getDoc: async () => ({ exists: () => true, data: () => ({ name: "Ficticia" }) }),
    Blob: class { constructor(parts) { captured.csv = parts.join(""); } },
    URL: { createObjectURL: () => "blob:fake", revokeObjectURL: () => {} },
    document: { createElement: () => ({ setAttribute: () => {}, click: () => { captured.downloads++; } }),
      body: { appendChild: () => {}, removeChild: () => {} } },
    fakeJsPdfModule: { jsPDF: class {
      setFontSize() {}
      text(value) { (captured.pdfText ||= []).push(value); }
      splitTextToSize(value) { return [value]; }
      addPage() {}
      save() { captured.downloads++; }
    } },
    ...overrides,
  };
  const body = pdfStub ? extract(name, next).replace('await import("jspdf")', "fakeJsPdfModule") : extract(name, next);
  return { captured, run: runInNewContext(body + `\n${name};`, context) };
}

test("real PDF content uses the shared hours and declares unknown durations", async () => {
  const { run, captured } = exportHarness("descargarPDFTrabajadores", "const descargarCSVTrabajadores =", {}, true);
  await run();
  assert.equal(captured.error, undefined);
  assert.equal(captured.downloads, 1);
  assert.ok(captured.pdfText.includes("4.00"));
  assert.ok(captured.pdfText.some((text) => text.includes("1 jornadas con duración desconocida")));
  assert.ok(captured.pdfText.some((text) => text.includes("Duracion desconocida: 1 en rango; 1 en historial.")));
  assert.ok(captured.pdfText.some((text) => /Generado:.*Madrid/.test(text)));
});

test("real summary CSV exports quantified hours plus unknown counts", async () => {
  const { run, captured } = exportHarness("descargarCSVTrabajadores", "const descargarCSVInspeccion =");
  await run();
  assert.equal(captured.error, undefined);
  assert.equal(captured.downloads, 1);
  assert.match(captured.csv, /jornadas_desconocidas_historial/);
  assert.match(captured.csv, /"4\.00","4\.00","1","1"/);
  assert.match(captured.csv, /Europe\/Madrid/);
});

test("real inspection CSV keeps entry/exit IDs and explicitly marks unknown duration", async () => {
  const { run, captured } = exportHarness("descargarCSVInspeccion", "const cerrarSesion =");
  await run();
  assert.equal(captured.error, undefined);
  assert.equal(captured.downloads, 1);
  assert.match(captured.csv, /duracion_desconocida/);
  assert.match(captured.csv, /Desconocida/);
  assert.match(captured.csv, /"e","s","e"/);
  assert.match(captured.csv, /"pending","",""/);
  assert.match(captured.csv, /jornadas_desconocidas_historial/);
});

for (const [name, next] of [
  ["descargarCSVTrabajadores", "const descargarCSVInspeccion ="],
  ["descargarCSVInspeccion", "const cerrarSesion ="],
  ["descargarPDFTrabajadores", "const descargarCSVTrabajadores ="],
]) {
  test(`${name} refuses unverified or stale-filter exports before any side effects`, async () => {
    for (const overrides of [{ sessionReport: { ...report, ready: false } }, { dateFrom: "2026-01-02" },
      { sessionReportMatchesContext: false }]) {
      const { run, captured } = exportHarness(name, next, overrides);
      await run();
      assert.match(captured.error, /Actualiza el filtro/);
      assert.equal(captured.downloads, 0);
      assert.equal(captured.audits, 0);
      assert.equal(captured.csv, undefined);
    }
  });
}

const midnightStart = new Date("2026-07-31T21:00:00Z");
const midnightRecords = [
  { ...records[0], timestamp: midnightStart },
  { ...records[1], timestamp: new Date("2026-08-01T01:00:00Z"), inicioSesion: midnightStart },
];
const midnightReport = buildSharedReport(midnightRecords, workers, {
  from: "2026-07-31", to: "2026-07-31", now: new Date("2026-08-03T12:00:00Z"),
});
const splitContext = { sessionReport: midnightReport, dateFrom: "2026-07-31", dateTo: "2026-07-31",
  buildReportRows: () => midnightReport.summary };

test("actual dashboard loads day portions while retaining the full accumulated total", async () => {
  const captured = {};
  const run = runInNewContext(extract("calcularDashboard", "const cargarHistorialTrabajador =") + "\ncalcularDashboard;", {
    Date, db: {}, companyId: "company", user: { uid: "viewer" },
    dateFrom: splitContext.dateFrom, dateTo: splitContext.dateTo, buildSharedReport,
    collection: () => ({}), where: () => ({}), query: () => ({}),
    getDocs: async () => ({ docs: midnightRecords.map(({ id, ...data }) => ({ id, data: () => data })) }),
    cargarTrabajadores: async () => workers, clearMessages: () => {}, setBusy: () => {}, setInfoMsg: () => {},
    setErrorMsg: (v) => { captured.error = v; }, setSessionReport: (v) => { captured.report = v; },
    setResumenTrabajadores: (v) => { captured.summary = v; }, setWeeklySummary: () => {}, setStats: () => {},
    buildDashboardFromData: () => { captured.legacy = true; },
  });
  await run();
  assert.equal(captured.error, undefined);
  assert.equal(captured.legacy, undefined);
  assert.equal(captured.report.ready, true);
  assert.equal(captured.summary[0].minutosMes, 60);
  assert.equal(captured.summary[0].minutosAcumulados, 240);
});

test("actual PDF uses split-period hours instead of the entire crossing session", async () => {
  const { run, captured } = exportHarness("descargarPDFTrabajadores", "const descargarCSVTrabajadores =", splitContext, true);
  await run();
  assert.equal(captured.error, undefined);
  assert.equal(captured.downloads, 1);
  assert.ok(captured.pdfText.includes("1.00"));
  assert.ok(captured.pdfText.includes("4.00"));
});

test("actual summary CSV separates the split-period hours and the full history hours", async () => {
  const { run, captured } = exportHarness("descargarCSVTrabajadores", "const descargarCSVInspeccion =", splitContext);
  await run();
  assert.equal(captured.error, undefined);
  assert.match(captured.csv, /"1\.00","4\.00","0","0"/);
});

test("actual inspection CSV retains one original pair, its full duration and its minutes in range", async () => {
  const { run, captured } = exportHarness("descargarCSVInspeccion", "const cerrarSesion =", splitContext);
  await run();
  assert.equal(captured.error, undefined);
  const lines = captured.csv.split("\n");
  assert.equal(lines.length, 2);
  // All fixture values are free of embedded commas/quotes; keep the parser local.
  const fields = (line) => line.slice(1, -1).split('","');
  const row = Object.fromEntries(fields(lines[0]).map((key, i) => [key, fields(lines[1])[i]]));
  assert.equal(row.session_minutes, "240");
  assert.equal(row.minutos_en_rango, "60");
  assert.equal(row.total_period_hours, "1.00");
  assert.equal(row.entrada_log_id, "e");
  assert.equal(row.salida_log_id, "s");
  assert.equal(row.criterio_fecha, "reparto_dias_naturales");
  assert.equal(row.reparto_diario_madrid, "2026-07-31: 60 min; 2026-08-01: 180 min");
});
