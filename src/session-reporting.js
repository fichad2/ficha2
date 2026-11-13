import { reconstructSessions } from "./session-reconstruction.js";

export const REPORT_TIME_ZONE = "Europe/Madrid";
const dayFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: REPORT_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
});
const displayFormatter = new Intl.DateTimeFormat("es-ES", {
  timeZone: REPORT_TIME_ZONE, dateStyle: "short", timeStyle: "medium",
});

export function reportDate(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (!value || !Number.isSafeInteger(value.seconds) || !Number.isInteger(value.nanoseconds)
    || value.nanoseconds < 0 || value.nanoseconds >= 1e9) return null;
  const date = new Date(value.seconds * 1000 + Math.trunc(value.nanoseconds / 1e6));
  return Number.isFinite(date.getTime()) ? date : null;
}

export const madridDay = (value) => {
  const date = reportDate(value);
  return date ? dayFormatter.format(date) : null;
};
export const formatReportDate = (value) => {
  const date = reportDate(value);
  return date ? displayFormatter.format(date) : "Fecha no válida";
};
export const formatReportHours = (minutes) => Number.isFinite(minutes)
  ? (minutes / 60).toFixed(2) : "Desconocida";

export function historyDurationLabel(record) {
  if (record.tipo === "entrada" && record.reportStatus === "Sesión cerrada") return "—";
  return Number.isFinite(record.reportMinutes) ? `${formatReportHours(record.reportMinutes)}h` : "Desconocida";
}

export function madridWeek(now) {
  const today = madridDay(now);
  if (!today) throw new TypeError("Invalid analysis date");
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  const from = date.toISOString().slice(0, 10);
  date.setUTCDate(date.getUTCDate() + 6);
  return { from, to: date.toISOString().slice(0, 10) };
}

function validDay(day) {
  return !day || (/^\d{4}-\d{2}-\d{2}$/.test(day)
    && Number.isFinite(Date.parse(`${day}T12:00:00Z`))
    && new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) === day);
}
const includesDay = (day, from, to) => day !== null && (!from || day >= from) && (!to || day <= to);
const MINUTE_NS = 60_000_000_000n;
const timestampNs = (value) => value instanceof Date ? BigInt(value.getTime()) * 1_000_000n
  : BigInt(value.seconds) * 1_000_000_000n + BigInt(value.nanoseconds);

// Called only for closed sessions already validated by reconstruction. Find real
// local-day boundaries instead of adding 24 hours (Madrid has 23/25-hour days).
function allocateDays(session) {
  if (session.status !== "closed") return { dailyMinutes: null, allocationBlocked: false };
  const end = timestampNs(session.exit.timestamp);
  let cursor = timestampNs(session.entry.timestamp);
  const spans = [];
  while (cursor < end) {
    const cursorMs = Number((cursor - (cursor < 0n ? 999_999n : 0n)) / 1_000_000n);
    const day = madridDay(new Date(cursorMs));
    let boundary = end;
    if (madridDay(session.exit.timestamp) !== day) {
      let low = cursorMs + 1;
      let high = reportDate(session.exit.timestamp).getTime();
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (madridDay(new Date(middle)) === day) low = middle + 1;
        else high = middle;
      }
      boundary = BigInt(low) * 1_000_000n;
    }
    spans.push({ day, duration: boundary - cursor });
    cursor = boundary;
  }
  // Within one occupied day, retain the existing whole-session minute floor.
  // Across days, sub-minute remainders have no approved allocation: do not move
  // or discard them in order to force the stored total to fit a chosen day.
  if (spans.length === 1) return {
    dailyMinutes: [{ day: spans[0].day, minutes: session.minutes }], allocationBlocked: false,
  };
  if (spans.some((span) => span.duration % MINUTE_NS !== 0n)) {
    return { dailyMinutes: null, allocationBlocked: true };
  }
  const dailyMinutes = spans.map((span) => ({ day: span.day, minutes: Number(span.duration / MINUTE_NS) }));
  return dailyMinutes.reduce((sum, day) => sum + day.minutes, 0) === session.minutes
    ? { dailyMinutes, allocationBlocked: false } : { dailyMinutes: null, allocationBlocked: true };
}

const issueLabels = {
  daily_allocation_ambiguous: "El reparto diario exige decidir cómo asignar fracciones de minuto. Se conserva la duración total; el informe queda pendiente de revisión.",
  session_minutes_mismatch: "La duración guardada difiere del intervalo entre fichajes.",
  session_start_mismatch: "La fecha de inicio guardada no coincide con la entrada.",
  missing_entry_reference: "La salida no identifica su entrada; no se ha supuesto un emparejamiento.",
  entry_not_found: "No se encuentra la entrada indicada por la salida.",
  multiple_exits: "Varias salidas identifican la misma entrada.",
  overdue_open_session: "La entrada lleva más de 24 horas pendiente de salida.",
  session_exceeds_24_hours: "La sesión supera 24 horas y requiere revisión.",
};

/** Read model only. Never used by fichar/getOpenEntry/guardarSalidaYHoras.
 * A blocking reconstruction issue means no replacement aggregate is available:
 * null is deliberately different from a confirmed zero-minute total.
 */
export function buildSessionView(records, { now } = {}) {
  const reconstruction = reconstructSessions(records, { now });
  // Diagnostic only: re-evaluate explicit references without the saved duration
  // to explain a discrepancy. This result never supplies an accounting total.
  const calculatedByExit = new Map();
  if (reconstruction.issues.some((issue) => issue.code === "session_minutes_mismatch")) {
    const diagnostic = reconstructSessions(records.map((record) => {
      if (record?.tipo !== "salida") return record;
      const { minutosSesion, ...copy } = record;
      return copy;
    }), { now });
    for (const session of diagnostic.sessions) if (session.status === "closed") {
      calculatedByExit.set(session.exit.id, session.minutes);
    }
  }
  const issuesByIndex = new Map();
  for (const issue of reconstruction.issues) for (const index of issue.recordIndexes) {
    if (!issuesByIndex.has(index)) issuesByIndex.set(index, []);
    issuesByIndex.get(index).push(issue);
  }
  const sessionByRecord = new Map();
  const sessions = reconstruction.sessions.map((session) => {
    // Only coherent sessions reach this branch. Preserve saved minutes, including
    // zero; derive minutes solely for old, explicitly referenced coherent pairs.
    const minutes = session.status === "closed"
      ? (Object.hasOwn(session.exit, "minutosSesion") ? session.exit.minutosSesion : session.minutes)
      : null;
    const row = { ...session, minutes, ...allocateDays({ ...session, minutes }) };
    if (row.allocationBlocked) {
      const recordIndexes = [records.indexOf(session.entry), records.indexOf(session.exit)];
      const issue = { code: "daily_allocation_ambiguous", blocking: true,
        logIds: [session.entry.id, session.exit.id], recordIndexes };
      reconstruction.issues.push(issue);
      for (const index of recordIndexes) {
        if (!issuesByIndex.has(index)) issuesByIndex.set(index, []);
        issuesByIndex.get(index).push(issue);
      }
    }
    sessionByRecord.set(session.entry, row);
    if (session.exit) sessionByRecord.set(session.exit, row);
    return row;
  });
  const history = records.map((record, index) => {
    const session = sessionByRecord.get(record);
    const issues = issuesByIndex.get(index) || [];
    const calculatedMinutes = session?.status === "closed" ? session.minutes : calculatedByExit.get(record?.id) ?? null;
    const discrepancy = issues.some((issue) => issue.code === "session_minutes_mismatch")
      && record?.tipo === "salida" && calculatedMinutes !== null
      ? ` Guardados: ${record.minutosSesion} min; intervalo entre fichajes: ${calculatedMinutes} min.` : "";
    return {
      ...record, original: record, sourceIndex: index, date: reportDate(record?.timestamp),
      reportMinutes: record?.tipo === "salida" && session?.status === "closed" ? session.minutes : null,
      reportStatus: issues.some((issue) => issue.blocking) ? "Requiere revisión"
        : session?.status === "closed" ? "Sesión cerrada"
          : session?.status === "open" ? "Entrada pendiente: duración desconocida" : "Sin cierre confirmado",
      issues,
      dailyMinutes: session?.dailyMinutes ?? null,
      calculatedMinutes,
      reportDetails: issues.map((issue) => issueLabels[issue.code]
        || (issue.blocking ? "Los datos de este fichaje requieren revisión." : "Aviso de precisión de fecha.")).join(" ") + discrepancy
        + (session?.dailyMinutes?.length > 1 ? " Reparto Europe/Madrid: "
          + session.dailyMinutes.map((day) => `${day.day}: ${day.minutes} min`).join("; ") + "." : ""),
    };
  }).sort((a, b) => (b.date?.getTime() ?? -Infinity) - (a.date?.getTime() ?? -Infinity));
  const compatible = reconstruction.canReconstruct && !sessions.some((s) => s.allocationBlocked);
  return {
    ...reconstruction, sessions, history,
    compatible,
    knownMinutes: compatible
      ? sessions.filter((s) => s.status === "closed").reduce((sum, s) => sum + s.minutes, 0) : null,
    unknownCount: sessions.filter((s) => s.status !== "closed").length,
  };
}

/** A period contains one projection per original session, with only the minutes
 * belonging to the selected Madrid days. Unknown durations remain null; all
 * history issues survive filtering. No synthetic entry/exit records are made.
 */
export function sessionPeriod(view, { from = "", to = "" } = {}) {
  if (!validDay(from) || !validDay(to) || (from && to && from > to)) {
    throw new RangeError("El rango de fechas no es válido.");
  }
  const sessions = view.sessions.flatMap((session) => {
    if (session.status !== "closed") return includesDay(madridDay(session.entry.timestamp), from, to)
      ? [{ ...session, periodMinutes: null }] : [];
    const days = session.dailyMinutes?.filter((day) => includesDay(day.day, from, to)) || [];
    return days.length ? [{ ...session,
      periodMinutes: days.reduce((sum, day) => sum + day.minutes, 0) }] : [];
  });
  return {
    compatible: view.compatible, sessions,
    knownMinutes: view.compatible ? sessions.filter((s) => s.status === "closed")
      .reduce((sum, s) => sum + s.periodMinutes, 0) : null,
    unknownCount: sessions.filter((s) => s.status !== "closed").length,
    issues: view.issues,
  };
}

export function reportSummary(view, period) {
  if (!period.compatible) return "Revisión pendiente: no se ha sustituido el cálculo histórico.";
  const outOfRange = Math.max(0, view.unknownCount - period.unknownCount);
  return `${formatReportHours(period.knownMinutes)} h cuantificadas; ${period.unknownCount} jornadas con duración desconocida en rango`
    + (outOfRange ? `; ${outOfRange} pendientes fuera del rango` : "")
    + (view.issues.length ? `; ${view.issues.length} avisos en el historial completo` : "")
    + ". Reparto por días naturales Europe/Madrid.";
}

/** Integrate only proven-compatible histories. An unsafe history/range returns
 * ready=false, never a new zero total. Callers keep the previous calculation
 * labelled as unverified and do not export a reconstructed accounting report.
 */
export function buildSharedReport(records, workers, { from = "", to = "", now = new Date() } = {}) {
  const view = buildSessionView(records, { now });
  const period = sessionPeriod(view, { from, to });
  const week = madridWeek(now);
  const weekly = sessionPeriod(view, week);
  const ready = period.compatible && weekly.compatible;
  const notice = !ready
    ? "Hay incidencias en el historial completo o en el reparto diario. Se conserva el cálculo anterior sin verificar; no se ha sustituido ningún total. Exportación detenida."
    : reportSummary(view, period);
  if (!ready) return { ready, from, to, view, period, notice, summary: null, inspectionRows: null };
  const belongs = (s, worker) => s.userId === worker.id && (!worker.companyId || s.companyId === worker.companyId);
  const minutes = (sessions) => sessions.filter((s) => s.status === "closed")
    .reduce((sum, s) => sum + (s.periodMinutes ?? s.minutes), 0);
  const unknown = (sessions) => sessions.filter((s) => s.status !== "closed").length;
  const summary = workers.map((worker) => {
    const all = view.sessions.filter((s) => belongs(s, worker));
    const selected = period.sessions.filter((s) => belongs(s, worker));
    const inWeek = weekly.sessions.filter((s) => belongs(s, worker));
    return { id: worker.id, email: worker.email, minutosMes: minutes(selected), minutosAcumulados: minutes(all),
      minutosSemana: minutes(inWeek), unknownPeriod: unknown(selected), unknownTotal: unknown(all),
      unknownWeek: unknown(inWeek) };
  });
  const top = [...summary].sort((a, b) => b.minutosMes - a.minutosMes)[0];
  const today = madridDay(now);
  const stats = { totalTrabajadores: workers.length, totalHorasMes: Math.floor(period.knownMinutes / 60),
    topTrabajador: top?.minutosMes > 0 ? top.email : "-",
    sinFicharHoy: workers.filter((w) => !records.some((r) => r.userId === w.id && madridDay(r.timestamp) === today))
      .map((w) => w.email) };
  const rows = period.sessions.map((session) => {
    const entrada = session.entry;
    const salida = session.exit;
    const worker = workers.find((w) => w.id === session.userId) || { id: session.userId };
    return {
      worker, entrada, salida, sessionMinutes: session.minutes === null ? "" : session.minutes,
      sessionHours: formatReportHours(session.minutes),
      periodMinutes: session.periodMinutes === null ? "" : session.periodMinutes,
      dailyAllocation: session.dailyMinutes?.map((day) => `${day.day}: ${day.minutes} min`).join("; ") || "",
      sessionStatus: session.status === "closed" ? "cerrada" : "duracion_desconocida",
      entradaTimestamp: reportDate(entrada.timestamp)?.toISOString() || "",
      salidaTimestamp: salida ? reportDate(salida.timestamp)?.toISOString() || "" : "",
      entradaMadrid: formatReportDate(entrada.timestamp), salidaMadrid: salida ? formatReportDate(salida.timestamp) : "",
      entradaLogId: entrada.id, salidaLogId: salida?.id || "", entradaLogIdPairing: salida?.entradaLogId || "",
    };
  });
  // Preserve the existing no-records export, explicitly labelled as a placeholder.
  const inspectionRows = (rows.length ? rows : workers.map((worker) => ({ worker, sessionMinutes: "", periodMinutes: "", dailyAllocation: "",
    sessionHours: "Sin fichajes", sessionStatus: "sin_fichajes_en_rango", entradaTimestamp: "",
    salidaTimestamp: "", entradaMadrid: "", salidaMadrid: "", entradaLogId: "", salidaLogId: "", entradaLogIdPairing: "" })))
    .map((row) => ({ ...row, totalPeriodHours: formatReportHours(period.knownMinutes),
      unknownPeriod: period.unknownCount, unknownHistory: view.unknownCount, historyIssueCount: view.issues.length,
      timeZone: REPORT_TIME_ZONE, datePolicy: "reparto_dias_naturales" }));
  return { ready, from, to, view, period, notice, summary, stats, inspectionRows,
    weeklySummary: [...summary].sort((a, b) => b.minutosSemana - a.minutosSemana), generatedAt: reportDate(now).toISOString() };
}
