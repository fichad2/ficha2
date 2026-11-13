import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionView, buildSharedReport, sessionPeriod, reportSummary, madridDay, madridWeek,
  formatReportHours } from "../src/session-reporting.js";

const at = (iso) => new Date(iso);
const entry = (id = "e", timestamp = at("2026-01-01T08:00:00Z")) => ({
  id, userId: "fictional-worker", companyId: "fictional-company", tipo: "entrada", timestamp,
});
const exit = (overrides = {}) => ({ id: "s", userId: "fictional-worker", companyId: "fictional-company",
  tipo: "salida", timestamp: at("2026-01-01T12:00:00Z"), entradaLogId: "e", minutosSesion: 240,
  inicioSesion: at("2026-01-01T08:00:00Z"), ...overrides });

test("coherent stored minutes and all original IDs survive the read model", () => {
  const records = [entry(), exit()];
  const before = structuredClone(records);
  records.forEach(Object.freeze);
  Object.freeze(records);
  const view = buildSessionView(records);
  assert.equal(view.knownMinutes, 240);
  assert.equal(view.sessions[0].minutes, records[1].minutosSesion);
  assert.equal(view.sessions[0].entry, records[0]);
  assert.equal(view.sessions[0].exit, records[1]);
  assert.deepEqual(view.history.map((r) => r.id).sort(), ["e", "s"]);
  assert.deepEqual(records, before);
});

test("a zero-minute closed session differs from an open unknown duration", () => {
  const view = buildSessionView([entry(), exit({ timestamp: at("2026-01-01T08:00:30Z"), minutosSesion: 0 }),
    entry("pending", at("2026-01-02T08:00:00Z"))]);
  assert.equal(view.knownMinutes, 0);
  assert.equal(view.unknownCount, 1);
  assert.equal(view.history.find((r) => r.id === "s").reportMinutes, 0);
  assert.equal(view.history.find((r) => r.id === "pending").reportMinutes, null);
  assert.equal(formatReportHours(0), "0.00");
  assert.equal(formatReportHours(null), "Desconocida");
  assert.match(reportSummary(view, sessionPeriod(view)), /0.00 h cuantificadas; 1 jornadas/);
});

test("discrepant stored duration stays in the original; no replacement aggregate is issued", () => {
  const record = exit({ minutosSesion: 239 });
  const view = buildSessionView([entry(), record]);
  assert.equal(record.minutosSesion, 239);
  assert.equal(view.history.find((r) => r.id === "s").original, record);
  assert.equal(view.history.find((r) => r.id === "s").minutosSesion, 239);
  assert.equal(view.history.find((r) => r.id === "s").calculatedMinutes, 240);
  assert.equal(view.knownMinutes, null);
  assert.equal(view.compatible, false);
  assert.ok(view.issues.some((i) => i.code === "session_minutes_mismatch"));
});

test("legacy referenced pairs without derived minutes remain supported", () => {
  const old = exit();
  delete old.minutosSesion;
  delete old.inicioSesion;
  const view = buildSessionView([entry(), old]);
  assert.equal(view.compatible, true);
  assert.equal(view.knownMinutes, 240);
  assert.equal(Object.hasOwn(old, "minutosSesion"), false);
});

test("unreferenced legacy exits do not get paired or silently reduce an old total to zero", () => {
  const old = exit();
  delete old.entradaLogId;
  const view = buildSessionView([entry(), old]);
  assert.equal(view.compatible, false);
  assert.equal(sessionPeriod(view).knownMinutes, null);
  assert.equal(view.history.length, 2);
  assert.equal(view.unresolvedLogs[0], old);
});

test("contradictory exits are retained and cannot double the aggregate", () => {
  const view = buildSessionView([entry(), exit(), exit({ id: "s2",
    timestamp: at("2026-01-01T12:01:00Z"), minutosSesion: 241 })]);
  assert.equal(view.history.length, 3);
  assert.equal(view.knownMinutes, null);
  assert.ok(view.issues.some((i) => i.code === "multiple_exits"));
});

test("Madrid calendar does not depend on the browser timezone", () => {
  assert.equal(madridDay(at("2026-01-01T23:30:00Z")), "2026-01-02");
  assert.equal(madridDay(at("2026-07-01T22:30:00Z")), "2026-07-02");
  assert.deepEqual(madridWeek(at("2026-01-04T23:30:00Z")), { from: "2026-01-05", to: "2026-01-11" });
  assert.equal(madridDay({ seconds: Date.parse("2026-07-01T21:59:59Z") / 1000, nanoseconds: 999999999 }), "2026-07-01");
});

test("a cross-midnight period splits saved minutes across Madrid days", () => {
  const start = at("2026-01-01T22:00:00Z");
  const view = buildSessionView([entry("e", start), exit({ inicioSesion: start,
    timestamp: at("2026-01-02T02:00:00Z") })]);
  assert.equal(sessionPeriod(view, { from: "2026-01-01", to: "2026-01-01" }).knownMinutes, 60);
  assert.equal(sessionPeriod(view, { from: "2026-01-02", to: "2026-01-02" }).knownMinutes, 180);
  assert.equal(sessionPeriod(view).knownMinutes, 240);
  assert.equal(view.sessions.length, 1);
  assert.equal(view.records.length, 2);
});

test("daylight saving changes preserve elapsed time, not wall-clock subtraction", () => {
  for (const [start, end] of [
    ["2026-03-29T00:30:00Z", "2026-03-29T01:30:00Z"],
    ["2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z"],
  ]) {
    const view = buildSessionView([entry("e", at(start)), exit({ timestamp: at(end),
      inicioSesion: at(start), minutosSesion: 60 })]);
    assert.equal(view.knownMinutes, 60);
    assert.equal(sessionPeriod(view).knownMinutes, 60);
  }
});

test("filters cannot hide unresolved references or pending sessions outside the range", () => {
  const view = buildSessionView([entry()], { now: at("2026-01-05T08:00:00Z") });
  const period = sessionPeriod(view, { from: "2026-02-01", to: "2026-02-28" });
  assert.equal(period.unknownCount, 0);
  assert.equal(period.knownMinutes, 0);
  assert.equal(period.issues.length, 1);
  assert.match(reportSummary(view, period), /1 pendientes fuera del rango/);
});

test("invalid dates remain in history rather than being filtered away", () => {
  const record = entry("invalid", null);
  const view = buildSessionView([record]);
  assert.equal(view.history.length, 1);
  assert.equal(view.history[0].original, record);
  assert.equal(view.compatible, false);
  assert.equal(view.knownMinutes, null);
});

test("date ranges are validated", () => {
  const view = buildSessionView([]);
  assert.throws(() => sessionPeriod(view, { from: "2026-02-30" }), RangeError);
  assert.throws(() => sessionPeriod(view, { from: "2026-02-01", to: "2026-01-01" }), RangeError);
});

test("a fictitious 79-record baseline keeps 9623 minutes and a separate unknown session", () => {
  const records = [];
  // Same audited aggregates, entirely invented dates/IDs and session lengths.
  const minutes = [0, ...Array(37).fill(253), 262];
  for (let i = 0; i < 40; i++) {
    const start = new Date(Date.UTC(2026, 0, i + 1, 8));
    records.push(entry(`fake-entry-${i}`, start));
    if (i < 39) records.push(exit({ id: `fake-exit-${i}`, entradaLogId: `fake-entry-${i}`,
      inicioSesion: start, timestamp: new Date(start.getTime() + (minutes[i] * 60 + 1) * 1000),
      minutosSesion: minutes[i] }));
  }
  const view = buildSessionView(records, { now: at("2026-03-01T00:00:00Z") });
  assert.equal(view.compatible, true);
  assert.equal(view.records.length, 79);
  assert.equal(view.history.length, 79);
  assert.equal(view.sessions.filter((s) => s.status === "closed").length, 39);
  assert.equal(view.unknownCount, 1);
  assert.equal(view.knownMinutes, 9623);
  assert.equal(sessionPeriod(view).knownMinutes, 9623);
  assert.equal(new Set(view.history.map((r) => r.id)).size, 79);
  const report = buildSharedReport(records, [{ id: "fictional-worker", companyId: "fictional-company" }],
    { now: at("2026-03-01T00:00:00Z") });
  assert.equal(report.ready, true);
  assert.equal(report.period.knownMinutes, 9623);
  assert.equal(report.summary[0].minutosAcumulados, 9623);
  assert.equal(report.summary[0].unknownTotal, 1);
  assert.equal(report.inspectionRows.reduce((n, r) => n + (typeof r.sessionMinutes === "number" ? r.sessionMinutes : 0), 0), 9623);
  const exportedIds = report.inspectionRows.flatMap((r) => [r.entradaLogId, r.salidaLogId].filter(Boolean));
  assert.equal(exportedIds.length, 79);
  assert.equal(new Set(exportedIds).size, 79);
  assert.deepEqual(exportedIds.sort(), records.map((r) => r.id).sort());
});

test("shared reports stop at legacy ambiguity instead of changing its previous total", () => {
  const old = exit();
  delete old.entradaLogId;
  const report = buildSharedReport([entry(), old], [{ id: "fictional-worker" }]);
  assert.equal(report.ready, false);
  assert.equal(report.summary, null);
  assert.equal(report.inspectionRows, null);
  assert.match(report.notice, /cálculo anterior sin verificar/);
});

test("shared reports expose pending sessions even when the filter excludes them", () => {
  const report = buildSharedReport([entry()], [{ id: "fictional-worker" }],
    { from: "2026-02-01", to: "2026-02-28", now: at("2026-03-01T12:00:00Z") });
  assert.equal(report.ready, true);
  assert.equal(report.summary[0].minutosMes, 0);
  assert.equal(report.summary[0].unknownPeriod, 0);
  assert.equal(report.summary[0].unknownTotal, 1);
  assert.match(report.notice, /pendientes fuera del rango/);
  assert.equal(report.inspectionRows[0].sessionStatus, "sin_fichajes_en_rango");
  assert.equal(report.inspectionRows[0].unknownHistory, 1);
});

test("shared report uses the approved daily split without duplicating a session", () => {
  const start = at("2026-01-01T22:00:00Z");
  const records = [entry("e", start), exit({ inicioSesion: start, timestamp: at("2026-01-02T02:00:00Z") })];
  const report = buildSharedReport(records, [{ id: "fictional-worker" }],
    { from: "2026-01-01", to: "2026-01-01", now: at("2026-01-10T12:00:00Z") });
  assert.equal(report.ready, true);
  assert.equal(report.period.knownMinutes, 60);
  assert.equal(report.summary[0].minutosMes, 60);
  assert.equal(report.summary[0].minutosAcumulados, 240);
  assert.equal(report.inspectionRows.length, 1);
  assert.equal(report.inspectionRows[0].sessionMinutes, 240);
  assert.equal(report.inspectionRows[0].periodMinutes, 60);
  assert.equal(report.inspectionRows[0].datePolicy, "reparto_dias_naturales");
});
