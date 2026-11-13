import { createHash } from "node:crypto";

// Domain DTOs only: no Firebase, clock reads, randomness, persistence or React.
// actor/control/history/receipt must eventually come from a trusted backend,
// never directly from an HTTP request. A plan is NOT a committed operation.
export const DOMAIN_VERSION = 1;
export const PROTOCOL_VERSION = 1;
export const MAX_SESSION_MINUTES = 1440;
export const SESSION_STATUS = Object.freeze({ IDLE: "idle", OPEN: "open", NEEDS_REVIEW: "needs_review", REGULARIZED: "regularized" });
export const OPERATIONS = Object.freeze({ ENTRY: "clockIn", EXIT: "clockOut", REGULARIZE: "regularizeSession" });
export const REGULARIZATION_MODE = Object.freeze({ ACCREDITED: "accredited_exit", UNKNOWN: "unknown_exit" });
const MINUTE_NS = 60_000_000_000n;
const MAX_NS = BigInt(MAX_SESSION_MINUTES) * MINUTE_NS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const messages = Object.freeze({
  INVALID_REQUEST: "La solicitud no tiene un formato válido.",
  UNSUPPORTED_PROTOCOL: "Actualiza la aplicación para continuar.",
  UNAUTHENTICATED: "Inicia sesión para continuar.",
  EMAIL_NOT_VERIFIED: "Verifica tu correo antes de continuar.",
  FORBIDDEN: "No tienes permiso para realizar esta operación.",
  COMPANY_MISMATCH: "La solicitud no corresponde a tu empresa.",
  INVALID_CONTROL: "No se pudo validar la configuración del servicio.",
  SERVICE_PAUSED: "El servicio de fichaje no está disponible en este modo.",
  EPOCH_CONFLICT: "La configuración ha cambiado. Actualiza el estado antes de continuar.",
  STATE_UNINITIALIZED: "El estado de fichaje necesita inicialización autorizada.",
  INVALID_STATE: "El estado de la jornada requiere revisión.",
  VERSION_CONFLICT: "La jornada ha cambiado en otro dispositivo. Actualiza el estado.",
  SESSION_ALREADY_OPEN: "Ya tienes una entrada abierta.",
  NO_OPEN_SESSION: "No hay una entrada abierta para cerrar.",
  REGULARIZATION_NOT_DUE: "La sesión todavía no supera las 24 horas; no puede regularizarse por esta operación.",
  REGULARIZATION_REQUIRED: "La jornada necesita revisión del administrador.",
  INVALID_TIME: "Las fechas de la jornada no son coherentes.",
  DURATION_EXCEEDED: "La duración supera el límite de 24 horas y necesita revisión.",
  REFERENCE_MISMATCH: "La entrada indicada no coincide con la jornada.",
  HISTORY_INCOMPLETE: "Falta información para validar la jornada.",
  HISTORY_CONFLICT: "Hay registros contradictorios que deben revisarse.",
  ALREADY_CLOSED: "La entrada ya tiene una salida registrada.",
  ALREADY_REGULARIZED: "La entrada ya está regularizada.",
  REQUEST_ID_CONFLICT: "El identificador de solicitud ya se utilizó con otros datos.",
  INVALID_RECEIPT: "No se pudo validar el justificante de la operación.",
});
export const ERROR_MESSAGES = messages;
const fail = (code, details = {}) => ({ ok: false, error: { code, message: messages[code], details, retryable: false } });
const object = (v) => v !== null && typeof v === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const exact = (v, keys) => object(v) && Reflect.ownKeys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
const id = (v) => typeof v === "string" && v.length > 0 && v.length <= 128 && v.trim() === v && !/[\/\x00-\x1f\x7f]/.test(v) && ![".", ".."].includes(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const clone = (v) => JSON.parse(JSON.stringify(v));

// Canonical JSON timestamp preserving nanoseconds; Date is permitted only in
// trusted inputs. JSON requests must carry explicit seconds/nanoseconds.
function timestamp(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) return null;
    const seconds = Math.floor(ms / 1000);
    value = { seconds, nanoseconds: (ms - seconds * 1000) * 1_000_000 };
  }
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.seconds)
    || value.seconds < -62135596800 || value.seconds > 253402300799
    || !Number.isInteger(value.nanoseconds) || value.nanoseconds < 0 || value.nanoseconds >= 1e9) return null;
  return { seconds: value.seconds, nanoseconds: value.nanoseconds };
}
const ns = (t) => BigInt(t.seconds) * 1_000_000_000n + BigInt(t.nanoseconds);
const sameTime = (a, b) => ns(a) === ns(b);
const jsonTime = (t) => exact(t, ["seconds", "nanoseconds"]) && timestamp(t) !== null;
const commonFields = ["operation", "requestId", "companyContext", "expectedStateVersion", "expectedEpoch", "protocolVersion"];

export function validateSessionRequest(request) {
  if (!object(request) || !Object.values(OPERATIONS).includes(request.operation)) return fail("INVALID_REQUEST", { field: "operation" });
  const fields = request.operation === OPERATIONS.REGULARIZE
    ? [...commonFields, "originalEntryId", "mode", "reason", "evidenceReference", "accreditedExitAt"] : commonFields;
  if (!exact(request, fields)) return fail("INVALID_REQUEST", { field: "fields" });
  if (typeof request.requestId !== "string" || !UUID.test(request.requestId)) return fail("INVALID_REQUEST", { field: "requestId" });
  if (!id(request.companyContext)) return fail("INVALID_REQUEST", { field: "companyContext" });
  if (!integer(request.expectedStateVersion) || request.expectedStateVersion >= Number.MAX_SAFE_INTEGER) return fail("INVALID_REQUEST", { field: "expectedStateVersion" });
  if (!integer(request.expectedEpoch)) return fail("INVALID_REQUEST", { field: "expectedEpoch" });
  if (request.protocolVersion !== PROTOCOL_VERSION) return fail("UNSUPPORTED_PROTOCOL");
  const normalized = Object.fromEntries(commonFields.map((key) => [key, key === "requestId" ? request[key].toLowerCase() : request[key]]));
  if (request.operation === OPERATIONS.REGULARIZE) {
    if (!id(request.originalEntryId)) return fail("INVALID_REQUEST", { field: "originalEntryId" });
    if (!Object.values(REGULARIZATION_MODE).includes(request.mode)) return fail("INVALID_REQUEST", { field: "mode" });
    if (!text(request.reason, 1000)) return fail("INVALID_REQUEST", { field: "reason" });
    if (request.mode === REGULARIZATION_MODE.UNKNOWN) {
      if (request.accreditedExitAt !== null || request.evidenceReference !== null) return fail("INVALID_REQUEST", { field: "unknownExit" });
    } else if (!jsonTime(request.accreditedExitAt) || !text(request.evidenceReference, 500)) {
      return fail("INVALID_REQUEST", { field: "accreditedExit" });
    }
    Object.assign(normalized, { originalEntryId: request.originalEntryId, mode: request.mode,
      reason: request.reason.trim(), evidenceReference: request.evidenceReference?.trim() ?? null,
      accreditedExitAt: request.accreditedExitAt === null ? null : timestamp(request.accreditedExitAt) });
  }
  return { ok: true, request: normalized };
}

const stateFields = ["schemaVersion", "companyId", "userId", "status", "version", "activeEntryId", "openedAt", "reviewReason", "lastResolution", "lastRequestId"];
const resolutionFields = ["regularizationId", "originalEntryId", "mode", "minutes", "exitAt", "regularizedAt", "adminUid"];
function normalizeState(state) {
  if (state === null || state === undefined) return fail("STATE_UNINITIALIZED");
  if (!exact(state, stateFields) || state.schemaVersion !== DOMAIN_VERSION || !id(state.companyId) || !id(state.userId)
    || !Object.values(SESSION_STATUS).includes(state.status) || !integer(state.version) || state.version >= Number.MAX_SAFE_INTEGER
    || !(state.lastRequestId === null || (typeof state.lastRequestId === "string" && UUID.test(state.lastRequestId)))) return fail("INVALID_STATE");
  const result = { ...state };
  const active = [SESSION_STATUS.OPEN, SESSION_STATUS.NEEDS_REVIEW].includes(state.status);
  if (active) {
    const openedAt = timestamp(state.openedAt);
    if (!id(state.activeEntryId) || openedAt === null || state.lastResolution !== null) return fail("INVALID_STATE");
    if (state.status === SESSION_STATUS.OPEN ? state.reviewReason !== null
      : !["overdue", "manual_review", "history_conflict"].includes(state.reviewReason)) return fail("INVALID_STATE");
    result.openedAt = openedAt;
  } else {
    if (state.activeEntryId !== null || state.openedAt !== null || state.reviewReason !== null) return fail("INVALID_STATE");
    if (state.status === SESSION_STATUS.IDLE) {
      if (state.lastResolution !== null) return fail("INVALID_STATE");
    } else {
      const r = state.lastResolution;
      if (!exact(r, resolutionFields) || !id(r.originalEntryId) || r.regularizationId !== r.originalEntryId
        || !id(r.adminUid) || !Object.values(REGULARIZATION_MODE).includes(r.mode) || !timestamp(r.regularizedAt)) return fail("INVALID_STATE");
      const known = r.mode === REGULARIZATION_MODE.ACCREDITED;
      if (known ? !integer(r.minutes) || r.minutes > MAX_SESSION_MINUTES || !timestamp(r.exitAt)
        || ns(timestamp(r.exitAt)) > ns(timestamp(r.regularizedAt)) : r.minutes !== null || r.exitAt !== null) return fail("INVALID_STATE");
      result.lastResolution = { ...r, regularizedAt: timestamp(r.regularizedAt), exitAt: known ? timestamp(r.exitAt) : null };
    }
  }
  return { ok: true, state: result };
}

export function inspectSessionState(state, now) {
  const checked = normalizeState(state);
  if (!checked.ok) return checked;
  const time = timestamp(now);
  if (!time) return fail("INVALID_TIME", { field: "now" });
  const result = checked.state;
  if (result.openedAt) {
    const duration = ns(time) - ns(result.openedAt);
    if (duration < 0n) return fail("INVALID_TIME", { field: "openedAt" });
    if (duration > MAX_NS && result.status === SESSION_STATUS.OPEN) {
      result.status = SESSION_STATUS.NEEDS_REVIEW;
      result.reviewReason = "overdue";
    }
  } else if (result.lastResolution && ns(result.lastResolution.regularizedAt) > ns(time)) return fail("INVALID_TIME");
  return { ok: true, state: clone(result) };
}

function validateHistory(history, state) {
  const fields = ["complete", "entry", "exitIds", "regularizationIds", "nextEntryAt", "conflicts"];
  if (!exact(history, fields) || history.complete !== true) return fail("HISTORY_INCOMPLETE");
  if (![history.exitIds, history.regularizationIds, history.conflicts].every((v) => Array.isArray(v)
    && Object.keys(v).length === v.length && v.every(id))) return fail("HISTORY_INCOMPLETE");
  if (history.conflicts.length || state.reviewReason === "history_conflict") return fail("HISTORY_CONFLICT");
  const entry = history.entry;
  if (!object(entry) || entry.tipo !== "entrada" || entry.id !== state.activeEntryId || entry.userId !== state.userId
    || entry.companyId !== state.companyId || !timestamp(entry.timestamp) || !sameTime(timestamp(entry.timestamp), state.openedAt)) return fail("REFERENCE_MISMATCH");
  if (history.exitIds.length) return fail("ALREADY_CLOSED");
  if (history.regularizationIds.length) return fail("ALREADY_REGULARIZED");
  if (history.nextEntryAt !== null && (!timestamp(history.nextEntryAt)
    || ns(timestamp(history.nextEntryAt)) <= ns(state.openedAt))) return fail("HISTORY_CONFLICT");
  return { ok: true, nextEntryAt: history.nextEntryAt === null ? null : timestamp(history.nextEntryAt) };
}

const resultFields = ["operation", "eventId", "originalEntryId", "stateVersion", "status", "minutes", "exitAt", "mode"];
function replayReceipt(receipt, identity, request) {
  const fields = ["schemaVersion", "requestKey", "actorUid", "companyId", "requestId", "operation", "payloadFingerprint", "result"];
  if (!exact(receipt, fields) || receipt.schemaVersion !== DOMAIN_VERSION || receipt.actorUid !== identity.actorUid
    || receipt.companyId !== identity.companyId || receipt.requestId !== request.requestId || receipt.requestKey !== identity.requestKey) return fail("INVALID_RECEIPT");
  if (receipt.operation !== request.operation || receipt.payloadFingerprint !== identity.payloadFingerprint) return fail("REQUEST_ID_CONFLICT");
  const r = receipt.result;
  if (!exact(r, resultFields) || r.operation !== request.operation || r.eventId !== identity.eventId || !id(r.originalEntryId)
    || r.stateVersion !== request.expectedStateVersion + 1) return fail("INVALID_RECEIPT");
  const isEntry = request.operation === OPERATIONS.ENTRY;
  const isReg = request.operation === OPERATIONS.REGULARIZE;
  const unknown = isEntry || (isReg && request.mode === REGULARIZATION_MODE.UNKNOWN);
  if (r.status !== (isEntry ? SESSION_STATUS.OPEN : isReg ? SESSION_STATUS.REGULARIZED : SESSION_STATUS.IDLE)
    || r.mode !== (isReg ? request.mode : null)
    || (isEntry && r.originalEntryId !== identity.eventId) || (isReg && r.originalEntryId !== request.originalEntryId)
    || (unknown ? r.minutes !== null || r.exitAt !== null : !integer(r.minutes) || r.minutes > MAX_SESSION_MINUTES || !jsonTime(r.exitAt))
    || (isReg && !unknown && !sameTime(r.exitAt, request.accreditedExitAt))) return fail("INVALID_RECEIPT");
  return { ok: true, replayed: true, result: clone(r), plan: null };
}

/** Return a pure decision/creation plan, never perform it. Persisting and
 * enforcing the read-version preconditions atomically is a later phase.
 * Missing initialized states and bootstrap proofs are intentionally not inferred.
 */
export function evaluateSessionOperation(input = {}) {
  if (!object(input)) return fail("INVALID_REQUEST");
  const { request, actor, control, state, now, history, receipt = null } = input;
  const checkedRequest = validateSessionRequest(request);
  if (!checkedRequest.ok) return checkedRequest;
  const req = checkedRequest.request;
  if (!object(actor) || !id(actor.uid)) return fail("UNAUTHENTICATED");
  if (actor.emailVerified !== true) return fail("EMAIL_NOT_VERIFIED");
  if (!id(actor.companyId) || !["trabajador", "administrador"].includes(actor.role)) return fail("FORBIDDEN");
  if (req.companyContext !== actor.companyId) return fail("COMPANY_MISMATCH");
  if (req.operation === OPERATIONS.REGULARIZE && actor.role !== "administrador") return fail("FORBIDDEN");
  if (!exact(control, ["companyId", "writeMode", "epoch", "minProtocolVersion"]) || !id(control.companyId)
    || !["legacy", "paused", "backend"].includes(control.writeMode) || !integer(control.epoch)
    || !Number.isSafeInteger(control.minProtocolVersion) || control.minProtocolVersion < 1) return fail("INVALID_CONTROL");
  if (control.companyId !== actor.companyId) return fail("COMPANY_MISMATCH");
  const requestKey = hash([DOMAIN_VERSION, actor.companyId, actor.uid, req.requestId]);
  const payloadFingerprint = hash(req);
  const eventId = req.operation === OPERATIONS.REGULARIZE ? req.originalEntryId
    : (req.operation === OPERATIONS.ENTRY ? "entry_" : "exit_") + requestKey;
  const identity = { requestKey, payloadFingerprint, eventId, actorUid: actor.uid, companyId: actor.companyId };
  if (receipt !== null) return replayReceipt(receipt, identity, req);
  if (req.protocolVersion < control.minProtocolVersion) return fail("UNSUPPORTED_PROTOCOL");
  if (control.writeMode !== "backend") return fail("SERVICE_PAUSED");
  if (req.expectedEpoch !== control.epoch) return fail("EPOCH_CONFLICT");
  const inspection = inspectSessionState(state, now);
  if (!inspection.ok) return inspection;
  const current = inspection.state;
  if (current.companyId !== actor.companyId) return fail("COMPANY_MISMATCH");
  if (req.operation !== OPERATIONS.REGULARIZE && current.userId !== actor.uid) return fail("FORBIDDEN");
  if (req.expectedStateVersion !== current.version) return fail("VERSION_CONFLICT", { currentVersion: current.version });
  const effectiveAt = timestamp(now);
  let event;
  let minutes = null;
  let exitAt = null;
  let originalEntryId = current.activeEntryId;
  let status;
  let resolution = null;
  if (req.operation === OPERATIONS.ENTRY) {
    if (current.status === SESSION_STATUS.NEEDS_REVIEW) return fail("REGULARIZATION_REQUIRED");
    if (current.status === SESSION_STATUS.OPEN) return fail("SESSION_ALREADY_OPEN");
    originalEntryId = eventId;
    status = SESSION_STATUS.OPEN;
    event = { type: "entry", id: eventId, companyId: current.companyId, userId: current.userId,
      tipo: "entrada", timestamp: effectiveAt };
  } else {
    if (current.status === SESSION_STATUS.REGULARIZED) return fail("ALREADY_REGULARIZED");
    if (current.status === SESSION_STATUS.IDLE) return fail("NO_OPEN_SESSION");
    if (req.operation === OPERATIONS.REGULARIZE && req.originalEntryId !== current.activeEntryId) return fail("REFERENCE_MISMATCH");
    const historyCheck = validateHistory(history, current);
    if (!historyCheck.ok) return historyCheck;
    if (historyCheck.nextEntryAt && ns(historyCheck.nextEntryAt) > ns(effectiveAt)) return fail("HISTORY_CONFLICT");
    if (req.operation === OPERATIONS.EXIT) {
      if (current.status === SESSION_STATUS.NEEDS_REVIEW) return fail("REGULARIZATION_REQUIRED");
      exitAt = effectiveAt;
    } else if (req.mode === REGULARIZATION_MODE.ACCREDITED) exitAt = req.accreditedExitAt;
    if (exitAt !== null) {
      const duration = ns(exitAt) - ns(current.openedAt);
      if (duration <= 0n || ns(exitAt) > ns(effectiveAt)) return fail("INVALID_TIME");
      if (duration > MAX_NS) return fail("DURATION_EXCEEDED");
      if (historyCheck.nextEntryAt && ns(exitAt) > ns(historyCheck.nextEntryAt)) return fail("HISTORY_CONFLICT");
      minutes = Number(duration / MINUTE_NS);
    } else if (historyCheck.nextEntryAt !== null) {
      // A missing exit cannot prove where a subsequent historical session starts.
      // Do not erase an existing ambiguity by choosing an invented boundary.
      return fail("HISTORY_CONFLICT");
    }
    if (req.operation === OPERATIONS.EXIT) {
      status = SESSION_STATUS.IDLE;
      event = { type: "exit", id: eventId, companyId: current.companyId, userId: current.userId,
        tipo: "salida", timestamp: exitAt, entradaLogId: current.activeEntryId,
        inicioSesion: current.openedAt, minutosSesion: minutes };
    } else {
      status = SESSION_STATUS.REGULARIZED;
      event = { type: "regularization", id: eventId, schemaVersion: DOMAIN_VERSION,
        originalEntryId: current.activeEntryId, companyId: current.companyId, workerUid: current.userId,
        mode: req.mode, reason: req.reason, evidenceReference: req.evidenceReference,
        accreditedExitAt: exitAt, effectiveMinutes: minutes, adminUid: actor.uid,
        regularizedAt: effectiveAt, status: minutes === null ? "resolved_unknown" : "resolved_known", requestId: req.requestId };
      resolution = { regularizationId: eventId, originalEntryId: current.activeEntryId, mode: req.mode,
        minutes, exitAt, regularizedAt: effectiveAt, adminUid: actor.uid };
    }
  }
  const nextState = { schemaVersion: DOMAIN_VERSION, companyId: current.companyId, userId: current.userId,
    status, version: current.version + 1, activeEntryId: status === SESSION_STATUS.OPEN ? eventId : null,
    openedAt: status === SESSION_STATUS.OPEN ? effectiveAt : null, reviewReason: null,
    lastResolution: resolution, lastRequestId: req.requestId };
  const result = { operation: req.operation, eventId, originalEntryId, stateVersion: nextState.version,
    status, minutes, exitAt, mode: req.operation === OPERATIONS.REGULARIZE ? req.mode : null };
  const plannedReceipt = { schemaVersion: DOMAIN_VERSION, requestKey, actorUid: actor.uid,
    companyId: actor.companyId, requestId: req.requestId, operation: req.operation, payloadFingerprint, result };
  return clone({ ok: true, replayed: false, result, plan: { requestKey, payloadFingerprint,
    expectedStateVersion: current.version, expectedEpoch: req.expectedEpoch, event, nextState, receipt: plannedReceipt } });
}

/** Additional policy for the administrative overdue-session callable only.
 * Existing general transitions remain compatible; no clocks or persistence here. */
export function validateOverdueRegularization(state, now, history) {
  const checked = inspectSessionState(state, now);
  if (!checked.ok) return checked;
  if (!checked.state.openedAt) return fail("NO_OPEN_SESSION");
  // This callable cannot reconstruct the operative state of a later session.
  if (history && history.nextEntryAt !== null) return fail("HISTORY_CONFLICT");
  return ns(timestamp(now)) - ns(checked.state.openedAt) > MAX_NS
    ? { ok: true } : fail("REGULARIZATION_NOT_DUE");
}
