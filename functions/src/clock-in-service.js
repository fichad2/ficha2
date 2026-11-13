import { createHash } from "node:crypto";
import { DOMAIN_VERSION, ERROR_MESSAGES, validateSessionRequest, evaluateSessionOperation } from "./session-domain.js";
import { assertEmulatorEnvironment } from "./emulator-environment.js";

export class ClockInError extends Error {
  constructor(code, message = ERROR_MESSAGES[code], details = {}, retryable = false) {
    super(message); this.code = code; this.details = details; this.retryable = retryable;
  }
}
const rejectDecision = (decision) => {
  if (!decision.ok) throw new ClockInError(decision.error.code, decision.error.message, decision.error.details);
  return decision;
};
const pick = (value, fields) => value == null ? null : Object.fromEntries(fields.map((key) => [key, value[key]]));
const stateFields = ["schemaVersion", "companyId", "userId", "status", "version", "activeEntryId", "openedAt", "reviewReason", "lastResolution", "lastRequestId"];
const receiptFields = ["schemaVersion", "requestKey", "actorUid", "companyId", "requestId", "operation", "payloadFingerprint", "result"];
const safeId = (v) => typeof v === "string" && v.length > 0 && v.length <= 128 && v.trim() === v && !v.includes(String.fromCharCode(92)) && !/[\/\x00-\x1f\x7f]/.test(v) && ![".", ".."].includes(v);

// All dependencies are trusted server adapters. No Firebase initialization here.
export function createClockInService({ firestore, environment, now, serverTimestamp }) {
  function guard() {
    const local = assertEmulatorEnvironment(environment());
    if (firestore.projectId !== local.projectId) throw new ClockInError("EMULATOR_ISOLATION", "Destino de pruebas no autorizado.");
  }
  return async function clockIn({ data, identity }) {
    guard();
    if (!identity || !safeId(identity.uid)) throw new ClockInError("UNAUTHENTICATED");
    if (identity.emailVerified !== true) throw new ClockInError("EMAIL_NOT_VERIFIED");
    const request = rejectDecision(validateSessionRequest(data)).request;
    if (request.operation !== "clockIn") throw new ClockInError("INVALID_REQUEST");
    return firestore.runTransaction(async (transaction) => {
      guard();
      const profile = await transaction.get(firestore.doc("users/" + identity.uid));
      if (!profile.exists) throw new ClockInError("PROFILE_NOT_FOUND", "No se encuentra tu perfil. Contacta con el administrador.");
      const { companyId, role } = profile.data();
      if (!safeId(companyId) || !["trabajador", "administrador"].includes(role)) throw new ClockInError("FORBIDDEN");
      if (companyId !== request.companyContext) throw new ClockInError("COMPANY_MISMATCH");
      const companyRef = firestore.doc("companies/" + companyId);
      const controlRef = firestore.doc("companies/" + companyId + "/session_control/config");
      const stateRef = firestore.doc("companies/" + companyId + "/session_states/" + identity.uid);
      // Same versioned identity as the pure domain; verify agreement before writing.
      const requestKey = createHash("sha256").update(JSON.stringify([DOMAIN_VERSION, companyId, identity.uid, request.requestId])).digest("hex");
      const receiptRef = firestore.doc("companies/" + companyId + "/session_requests/" + requestKey);
      const [company, control, state, receipt] = await transaction.getAll(companyRef, controlRef, stateRef, receiptRef);
      if (!company.exists) throw new ClockInError("COMPANY_NOT_FOUND", "No se encuentra tu empresa. Contacta con el administrador.");
      const effectiveAt = now();
      const decision = rejectDecision(evaluateSessionOperation({ request,
        actor: { uid: identity.uid, companyId, role, emailVerified: true },
        control: pick(control.exists ? control.data() : null, ["companyId", "writeMode", "epoch", "minProtocolVersion"]),
        state: pick(state.exists ? state.data() : null, stateFields), now: effectiveAt,
        receipt: pick(receipt.exists ? receipt.data() : null, receiptFields),
      }));
      if (decision.replayed) return { ok: true, replayed: true, result: decision.result };
      const plan = decision.plan;
      if (plan.requestKey !== requestKey) throw new ClockInError("INVALID_RECEIPT");
      guard();
      // create(), never set(): collisions must abort the entire transaction.
      transaction.create(firestore.doc("logs/" + plan.event.id), {
        userId: identity.uid, companyId, tipo: "entrada", timestamp: effectiveAt,
      });
      // Preserve initialization/source metadata; originals are append-only.
      transaction.update(stateRef, { ...plan.nextState, openedAt: effectiveAt, updatedAt: serverTimestamp() });
      transaction.create(receiptRef, { ...plan.receipt, committedAt: serverTimestamp() });
      return { ok: true, replayed: false, result: decision.result };
    });
  };
}
