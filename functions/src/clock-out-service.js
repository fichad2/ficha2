import { createHash } from "node:crypto";
import { DOMAIN_VERSION, validateSessionRequest, evaluateSessionOperation } from "./session-domain.js";

// Reuse the existing callable transport error type; no change to clockIn.
import { ClockInError } from "./clock-in-service.js";

import { rejectDecision, pick, stateFields, receiptFields, safeId, assertLocalFirestore, assertPersistibleTimestamp, readClosingHistory } from "./session-transaction-support.js";

// All dependencies are trusted server adapters. No Firebase initialization here.
export function createClockOutService({ firestore, environment, now, serverTimestamp }) {
  const guard = () => assertLocalFirestore(firestore, environment);
  return async function clockOut({ data, identity }) {
    guard();
    if (!identity || !safeId(identity.uid)) throw new ClockInError("UNAUTHENTICATED");
    if (identity.emailVerified !== true) throw new ClockInError("EMAIL_NOT_VERIFIED");
    const request = rejectDecision(validateSessionRequest(data)).request;
    if (request.operation !== "clockOut") throw new ClockInError("INVALID_REQUEST");
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
      const context = { request,
        actor: { uid: identity.uid, companyId, role, emailVerified: true },
        control: pick(control.exists ? control.data() : null, ["companyId", "writeMode", "epoch", "minProtocolVersion"]),
        state: pick(state.exists ? state.data() : null, stateFields),
        receipt: pick(receipt.exists ? receipt.data() : null, receiptFields),
      };
      // Validate/replay first. Only a valid open state may request history reads.
      const preliminary = evaluateSessionOperation({ ...context, now: now() });
      if (preliminary.ok && preliminary.replayed) return { ok: true, replayed: true, result: preliminary.result };
      if (preliminary.ok) throw new ClockInError("INVALID_STATE");
      if (preliminary.error.code !== "HISTORY_INCOMPLETE") rejectDecision(preliminary);
      const entryId = context.state.activeEntryId;
      const { original, history } = await readClosingHistory(transaction, firestore, {
        companyId, userId: identity.uid, entryId, openedAt: context.state.openedAt,
      });
      // Re-read the server clock after history reads, on every transaction retry.
      const effectiveAt = now();
      const decision = rejectDecision(evaluateSessionOperation({ ...context, now: effectiveAt, history }));
      assertPersistibleTimestamp(effectiveAt);
      const plan = decision.plan;
      if (plan.requestKey !== requestKey) throw new ClockInError("INVALID_RECEIPT");
      guard();
      // create(), never set(): collisions must abort the entire transaction.
      transaction.create(firestore.doc("logs/" + plan.event.id), {
        userId: identity.uid, companyId, tipo: "salida", timestamp: effectiveAt,
        entradaLogId: entryId, inicioSesion: original.data().timestamp, minutosSesion: plan.event.minutosSesion,
      });
      // Preserve initialization/source metadata; originals are append-only.
      transaction.update(stateRef, { ...plan.nextState, updatedAt: serverTimestamp() });
      transaction.create(receiptRef, { ...plan.receipt, committedAt: serverTimestamp() });
      return { ok: true, replayed: false, result: decision.result };
    });
  };
}

