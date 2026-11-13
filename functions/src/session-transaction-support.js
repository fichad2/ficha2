import { assertEmulatorEnvironment } from "./emulator-environment.js";
import { ClockInError } from "./clock-in-service.js";

export const rejectDecision = (decision) => {
  if (!decision.ok) throw new ClockInError(decision.error.code, decision.error.message, decision.error.details);
  return decision;
};
export const pick = (value, fields) => value == null ? null : Object.fromEntries(fields.map((key) => [key, value[key]]));
export const stateFields = ["schemaVersion", "companyId", "userId", "status", "version", "activeEntryId", "openedAt", "reviewReason", "lastResolution", "lastRequestId"];
export const receiptFields = ["schemaVersion", "requestKey", "actorUid", "companyId", "requestId", "operation", "payloadFingerprint", "result"];
export const safeId = (v) => typeof v === "string" && v.length > 0 && v.length <= 128 && v.trim() === v && !v.includes(String.fromCharCode(92)) && !/[\/\x00-\x1f\x7f]/.test(v) && ![".", ".."].includes(v);

// Only derive facts about this active entry. Never pair an unreferenced exit.
export function timeNs(value) {
  if (!value || !Number.isSafeInteger(value.seconds) || value.seconds < -62135596800 || value.seconds > 253402300799
    || !Number.isInteger(value.nanoseconds) || value.nanoseconds < 0 || value.nanoseconds >= 1e9) return null;
  return BigInt(value.seconds) * 1_000_000_000n + BigInt(value.nanoseconds);
}
export function inspectClosingHistory({ original, resolution, linked, ownLogs, resolutions, entryId, openedAt }) {
  const entry = original.exists ? { ...original.data(), id: original.id } : null;
  const exitIds = [], conflicts = [];
  for (const doc of linked.docs) {
    if (doc.data().tipo === "salida") exitIds.push(doc.id);
    else conflicts.push(doc.id);
  }
  const regularizationIds = [...new Set([...(resolution.exists ? [resolution.id] : []), ...resolutions.docs.map(doc => doc.id)])];
  const opened = timeNs(openedAt);
  const byId = new Map(ownLogs.docs.map(doc => [doc.id, doc.data()]));
  let nextEntryAt = null, nextTime = null;
  for (const doc of ownLogs.docs) {
    if (doc.id === entryId) continue;
    const log = doc.data(), time = timeNs(log.timestamp);
    if (time === null || !["entrada", "salida"].includes(log.tipo)) { conflicts.push(doc.id); continue; }
    if (log.tipo === "entrada" && time === opened) conflicts.push(doc.id);
    if (log.tipo === "entrada" && time > opened && (nextTime === null || time < nextTime)) {
      nextTime = time; nextEntryAt = log.timestamp;
    }
    // A previous referenced session may end exactly when this one starts.
    // No unreferenced exit is adopted, even at that boundary.
    if (log.tipo === "salida" && time >= opened && log.entradaLogId !== entryId) {
      const prior = byId.get(log.entradaLogId), priorTime = timeNs(prior?.timestamp);
      const validBoundary = time === opened && prior?.tipo === "entrada" && priorTime !== null && priorTime < opened;
      if (!validBoundary) conflicts.push(doc.id);
    }
  }
  return { complete: true, entry, exitIds, regularizationIds, nextEntryAt, conflicts };
}

export function assertLocalFirestore(firestore, environment) {
  const local = assertEmulatorEnvironment(environment());
  if (firestore.projectId !== local.projectId) throw new ClockInError("EMULATOR_ISOLATION", "Destino de pruebas no autorizado.");
}
export function assertPersistibleTimestamp(time, field = "serverTimePrecision") {
  if (time.nanoseconds % 1000 !== 0) throw new ClockInError("INVALID_TIME",
    field === "serverTimePrecision" ? "La hora del servidor no puede guardarse sin perder precisión." : "La fecha no puede guardarse sin perder precisión.", { field });
}
export async function readClosingHistory(transaction, firestore, { companyId, userId, entryId, openedAt, original: providedOriginal }) {
  const companyPath = "companies/" + companyId;
  const regRef = firestore.doc(companyPath + "/regularizations/" + entryId);
  const [original, resolution] = providedOriginal
    ? [providedOriginal, await transaction.get(regRef)]
    : await transaction.getAll(firestore.doc("logs/" + entryId), regRef);
  const linked = await transaction.get(firestore.collection("logs").where("entradaLogId", "==", entryId));
  const ownLogs = await transaction.get(firestore.collection("logs").where("companyId", "==", companyId).where("userId", "==", userId));
  const resolutions = await transaction.get(firestore.collection(companyPath + "/regularizations").where("originalEntryId", "==", entryId));
  return { original, history: inspectClosingHistory({ original, resolution, linked, ownLogs, resolutions, entryId, openedAt }) };
}
