import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformSync } from "esbuild";
import { buildSessionView, historyDurationLabel, formatReportDate } from "../src/session-reporting.js";

// Render the real WorkerPanel without mounting App or importing Firebase.
const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const start = source.indexOf("function WorkerPanel(");
const end = source.indexOf("function App()", start);
assert.ok(start >= 0 && end > start);
const component = transformSync(source.slice(start, end), { loader: "jsx", target: "es2022" }).code;
const WorkerPanel = new Function("React", "AlertMessage", "BrandHeader", "historyDurationLabel",
  "formatReportDate", "minutesToHours", `${component}; return WorkerPanel;`)(React,
  ({ text }) => text ? React.createElement("p", null, text) : null,
  ({ title }) => React.createElement("h1", null, title),
  historyDurationLabel, formatReportDate, (n) => (n / 60).toFixed(2));
const entry = (id = "e", timestamp = new Date("2026-01-01T08:00:00Z")) => ({
  id, tipo: "entrada", userId: "fictional-worker", companyId: "fictional-company", timestamp,
});
const render = (records, notice = "") => renderToStaticMarkup(React.createElement(WorkerPanel, {
  workerHistory: buildSessionView(records).history, workerHistoryPage: 1, totalHistoryPages: 1,
  workerSessionNotice: notice, emailVerified: true,
}));

test("actual mobile and desktop history show unknown durations explicitly", () => {
  const html = render([entry()], "Una jornada pendiente con duración desconocida.");
  assert.match(html, /Una jornada pendiente con duración desconocida/);
  assert.equal((html.match(/Desconocida/g) || []).length, 2);
  assert.doesNotMatch(html, /0\.00h/);
  assert.match(html, /Madrid/);
});

test("a real zero in a closed pair is rendered as zero, not unknown", () => {
  const html = render([entry(), { ...entry("s", new Date("2026-01-01T08:00:30Z")), tipo: "salida",
    entradaLogId: "e", minutosSesion: 0 }]);
  assert.equal((html.match(/0\.00h/g) || []).length, 2);
  assert.doesNotMatch(html, /Desconocida/);
});

test("discrepancies display the saved value without substituting calculated hours", () => {
  const html = render([entry(), { ...entry("s", new Date("2026-01-01T12:00:00Z")), tipo: "salida",
    entradaLogId: "e", minutosSesion: 239 }]);
  assert.match(html, /Duración guardada: 3\.98h/);
  assert.match(html, /La duración guardada difiere del intervalo entre fichajes/);
  assert.match(html, /Guardados: 239 min; intervalo entre fichajes: 240 min/);
  assert.match(html, /Requiere revisión/);
  assert.doesNotMatch(html, /4\.00h/);
});

test("invalid dates stay visible in the real history component", () => {
  const html = render([entry("bad", null)]);
  assert.equal((html.match(/Fecha no válida/g) || []).length, 2);
  assert.match(html, /Requiere revisión/);
});

test("duplicate IDs keep both original records visible with distinct render keys", () => {
  const html = render([entry(), entry()]);
  assert.equal((html.match(/<tr class="border-b"/g) || []).length, 2);
  assert.match(html, /Requiere revisión/);
});

const adminStart = source.indexOf("function AdminPanel(");
const adminCode = transformSync(source.slice(adminStart, start), { loader: "jsx", target: "es2022" }).code;
const AdminPanel = new Function("React", "useMemo", "AlertMessage", "BrandHeader", "minutesToHours",
  `${adminCode}; return AdminPanel;`)(React, React.useMemo,
  ({ text }) => text ? React.createElement("p", null, text) : null,
  ({ title }) => React.createElement("h1", null, title), (n) => (n / 60).toFixed(2));

test("actual admin panel labels quantified totals and pending durations", () => {
  const html = renderToStaticMarkup(React.createElement(AdminPanel, {
    stats: { totalTrabajadores: 1, totalHorasMes: 0, topTrabajador: "-", sinFicharHoy: [] },
    sessionReportNotice: "0.00 h cuantificadas; 1 jornada con duración desconocida", sessionReportReady: false,
    editEmpresa: {}, trabajadores: [], resumenTrabajadores: [{ id: "worker", email: "fake@example.invalid",
      minutosMes: 0, minutosAcumulados: 0, unknownPeriod: 1, unknownTotal: 1 }],
    weeklySummary: [{ id: "worker", minutosSemana: 0, unknownWeek: 1 }], weeklyLimitHours: 40,
  }));
  assert.match(html, /Horas cuantificadas en rango/);
  assert.match(html, /duración desconocida/);
  assert.match(html, /1 desconocidas/);
  assert.equal((html.match(/disabled=""/g) || []).length, 3);
});

test("actual mobile and desktop history show the daily allocation without duplicating original records", () => {
  const start = new Date("2026-07-31T21:00:00Z");
  const html = render([entry("e", start), { ...entry("s", new Date("2026-08-01T01:00:00Z")),
    tipo: "salida", entradaLogId: "e", minutosSesion: 240 }]);
  assert.match(html, /Reparto Europe\/Madrid: 2026-07-31: 60 min; 2026-08-01: 180 min/);
  assert.equal((html.match(/<tr class="border-b"/g) || []).length, 2);
  assert.equal((html.match(/4\.00h/g) || []).length, 2);
});

test("actual history flags an ambiguous daily allocation while retaining its stored duration", () => {
  const html = render([entry("e", new Date("2026-07-31T21:59:30Z")),
    { ...entry("s", new Date("2026-07-31T22:01:30Z")), tipo: "salida", entradaLogId: "e", minutosSesion: 2 }]);
  assert.match(html, /fracciones de minuto/);
  assert.match(html, /Requiere revisión/);
  assert.match(html, /Duración guardada: 0\.03h/);
  assert.equal((html.match(/<tr class="border-b"/g) || []).length, 2);
});
