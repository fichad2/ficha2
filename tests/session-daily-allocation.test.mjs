import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionView, buildSharedReport, sessionPeriod } from "../src/session-reporting.js";

const now = new Date("2027-02-01T12:00:00Z");
const workers = [{ id: "fictional-worker", companyId: "fictional-company" }];
function pair(start, end, minutes, extra = {}) {
  const common = { userId: "fictional-worker", companyId: "fictional-company" };
  const timestamp = (value) => typeof value === "string" ? new Date(value) : value;
  return [{ ...common, id: "entry", tipo: "entrada", timestamp: timestamp(start) },
    { ...common, id: "exit", tipo: "salida", timestamp: timestamp(end), entradaLogId: "entry",
      minutosSesion: minutes, ...extra }];
}
const period = (view, day) => sessionPeriod(view, { from: day, to: day });
function checkSplit(start, end, expected) {
  const total = expected.reduce((sum, day) => sum + day.minutes, 0);
  const records = pair(start, end, total);
  const before = structuredClone(records);
  for (const record of records) Object.freeze(record);
  Object.freeze(records);
  const view = buildSessionView(records, { now });
  assert.equal(view.compatible, true);
  assert.equal(view.sessions.length, 1);
  assert.equal(view.history.length, 2);
  assert.deepEqual(view.sessions[0].dailyMinutes, expected);
  assert.equal(view.knownMinutes, total);
  assert.equal(sessionPeriod(view).knownMinutes, total);
  for (const day of expected) assert.equal(period(view, day.day).knownMinutes, day.minutes);
  const report = buildSharedReport(records, workers, { now });
  assert.equal(report.ready, true);
  assert.equal(report.summary[0].minutosAcumulados, total);
  assert.equal(report.inspectionRows.length, 1);
  assert.equal(report.inspectionRows[0].sessionMinutes, total);
  assert.equal(report.inspectionRows[0].periodMinutes, total);
  assert.deepEqual(records, before);
  assert.equal(report.inspectionRows[0].entradaLogId, "entry");
  assert.equal(report.inspectionRows[0].salidaLogId, "exit");
  return view;
}

test("month-end splits one closed session across July and August without changing its saved total", () => {
  const view = checkSplit("2026-07-31T21:00:00Z", "2026-08-01T01:00:00Z", [
    { day: "2026-07-31", minutes: 60 }, { day: "2026-08-01", minutes: 180 },
  ]);
  assert.equal(sessionPeriod(view, { from: "2026-07-01", to: "2026-07-31" }).knownMinutes, 60);
  assert.equal(sessionPeriod(view, { from: "2026-08-01", to: "2026-08-31" }).knownMinutes, 180);
});

test("year-end uses Madrid days, even when UTC still belongs to the previous year", () => {
  checkSplit("2026-12-31T22:30:00Z", "2027-01-01T00:30:00Z", [
    { day: "2026-12-31", minutes: 30 }, { day: "2027-01-01", minutes: 90 },
  ]);
});

test("spring transition day is 23 elapsed hours", () => {
  checkSplit("2026-03-28T22:00:00Z", "2026-03-29T22:00:00Z", [
    { day: "2026-03-28", minutes: 60 }, { day: "2026-03-29", minutes: 1380 },
  ]);
});

test("a 24-hour session can touch three Madrid days across the spring transition", () => {
  checkSplit("2026-03-28T22:30:00Z", "2026-03-29T22:30:00Z", [
    { day: "2026-03-28", minutes: 30 }, { day: "2026-03-29", minutes: 1380 },
    { day: "2026-03-30", minutes: 30 },
  ]);
});

test("autumn transition includes the repeated hour once as elapsed work", () => {
  checkSplit("2026-10-24T21:00:00Z", "2026-10-25T03:00:00Z", [
    { day: "2026-10-24", minutes: 60 }, { day: "2026-10-25", minutes: 300 },
  ]);
});

test("a full 25-hour autumn day stays blocked under the unchanged 24-hour reconstruction rule", () => {
  const view = buildSessionView(pair("2026-10-24T22:00:00Z", "2026-10-25T23:00:00Z", 1500), { now });
  assert.equal(view.compatible, false);
  assert.equal(view.knownMinutes, null);
  assert.ok(view.issues.some((issue) => issue.code === "session_exceeds_24_hours"));
});

test("exit exactly at midnight does not create a zero-minute session on the following day", () => {
  const view = checkSplit("2026-07-31T21:00:00Z", "2026-07-31T22:00:00Z", [
    { day: "2026-07-31", minutes: 60 },
  ]);
  assert.equal(period(view, "2026-08-01").sessions.length, 0);
  assert.equal(period(view, "2026-08-01").knownMinutes, 0);
});

test("entry exactly at midnight has no allocation to the previous day", () => {
  const view = checkSplit("2026-07-31T22:00:00Z", "2026-08-01T01:00:00Z", [
    { day: "2026-08-01", minutes: 180 },
  ]);
  assert.equal(period(view, "2026-07-31").sessions.length, 0);
});

test("weekly totals use the portion after Sunday midnight in Madrid", () => {
  const records = pair("2026-01-04T22:00:00Z", "2026-01-05T02:00:00Z", 240);
  const report = buildSharedReport(records, workers, { now: new Date("2026-01-07T12:00:00Z") });
  assert.equal(report.ready, true);
  assert.equal(report.summary[0].minutosSemana, 180);
  assert.equal(report.weeklySummary[0].minutosSemana, 180);
  assert.equal(report.summary[0].minutosAcumulados, 240);
});

test("fractional minutes across midnight require review even when the saved total matches elapsed floor", () => {
  const records = pair("2026-07-31T21:59:30Z", "2026-07-31T22:01:30Z", 2);
  const view = buildSessionView(records, { now });
  assert.equal(view.compatible, false);
  assert.equal(view.knownMinutes, null);
  assert.equal(view.sessions[0].minutes, 2);
  assert.equal(view.sessions[0].dailyMinutes, null);
  assert.equal(records[1].minutosSesion, 2);
  assert.match(view.history[0].reportDetails, /fracciones de minuto/);
  assert.ok(view.history.every((row) => row.reportStatus === "Requiere revisión"));
  const report = buildSharedReport(records, workers, { from: "2026-09-01", to: "2026-09-30", now });
  assert.equal(report.ready, false);
  assert.equal(report.inspectionRows, null);
  assert.ok(report.view.issues.some((issue) => issue.code === "daily_allocation_ambiguous"));
});

test("nanosecond fractions must not disappear during a daily allocation", () => {
  const seconds = Date.parse("2026-07-31T21:59:00Z") / 1000;
  const records = pair({ seconds, nanoseconds: 1 }, { seconds: seconds + 120, nanoseconds: 1 }, 2);
  const view = buildSessionView(records, { now });
  assert.equal(view.sessions[0].minutes, 2);
  assert.equal(view.compatible, false);
  assert.ok(view.issues.some((issue) => issue.code === "daily_allocation_ambiguous"));
});

test("stored-minute discrepancy never gets proportionally redistributed or corrected", () => {
  const records = pair("2026-07-31T21:00:00Z", "2026-08-01T01:00:00Z", 239);
  const report = buildSharedReport(records, workers, { now });
  assert.equal(report.ready, false);
  assert.equal(report.period.knownMinutes, null);
  assert.equal(report.inspectionRows, null);
  assert.equal(records[1].minutosSesion, 239);
  assert.ok(report.view.issues.some((issue) => issue.code === "session_minutes_mismatch"));
});

test("legacy explicit references without saved duration get the same faithful daily split", () => {
  const records = pair("2026-07-31T21:00:00Z", "2026-08-01T01:00:00Z", 240);
  delete records[1].minutosSesion;
  const view = buildSessionView(records, { now });
  assert.equal(view.compatible, true);
  assert.deepEqual(view.sessions[0].dailyMinutes, [
    { day: "2026-07-31", minutes: 60 }, { day: "2026-08-01", minutes: 180 },
  ]);
  assert.equal(Object.hasOwn(records[1], "minutosSesion"), false);
});

test("unreferenced exits remain unresolved; daily splitting does not invent pairings", () => {
  const records = pair("2026-07-31T21:00:00Z", "2026-08-01T01:00:00Z", 240);
  delete records[1].entradaLogId;
  const report = buildSharedReport(records, workers, { now });
  assert.equal(report.ready, false);
  assert.equal(report.view.history.length, 2);
  assert.equal(report.view.sessions[0].dailyMinutes, null);
});

test("open duration stays unknown across months and remains visible outside the filter", () => {
  const [entry] = pair("2026-07-31T21:00:00Z", "2026-08-01T01:00:00Z", 240);
  const view = buildSessionView([entry], { now });
  assert.equal(view.sessions[0].minutes, null);
  assert.equal(view.sessions[0].dailyMinutes, null);
  const report = buildSharedReport([entry], workers, { from: "2026-08-01", to: "2026-08-31", now });
  assert.equal(report.ready, true);
  assert.equal(report.summary[0].unknownTotal, 1);
  assert.equal(report.summary[0].unknownPeriod, 0);
  assert.match(report.notice, /pendientes fuera del rango/);
});

test("same-day whole-session flooring is preserved, including a genuine zero-minute duration", () => {
  const view = buildSessionView(pair("2026-07-31T10:00:00Z", "2026-07-31T10:00:30Z", 0), { now });
  assert.equal(view.compatible, true);
  assert.equal(view.unknownCount, 0);
  assert.deepEqual(view.sessions[0].dailyMinutes, [{ day: "2026-07-31", minutes: 0 }]);
  assert.equal(period(view, "2026-07-31").sessions.length, 1);
  assert.equal(period(view, "2026-07-31").knownMinutes, 0);
});
