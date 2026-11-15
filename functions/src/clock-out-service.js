import { createHash } from "node:crypto";
import { DOMAIN_VERSION, validateSessionRequest, evaluateSessionOperation } from "./session-domain.js";

// Reuse the existing callable transport error type; no change to clockIn.
import { ClockInError } from "./clock-in-service.js";
import { createSessionOperationRecovery, SessionRecoveryUncertainError } from "./session-operation-recovery.js";

import { rejectDecision, pick, stateFields, receiptFields, safeId, assertLocalFirestore, assertPersistibleTimestamp, readClosingHistory } from "./session-transaction-support.js";

// All dependencies are trusted server adapters. No Firebase initialization here.
export function createClockOutService({ firestore, environment, now, serverTimestamp }) {
  const guard = () => assertLocalFirestore(firestore, environment);
  async function readAuthorityAndReceipt(transaction, { request, identity }) {
    guard();
    const profile = await transaction.get(firestore.doc("users/" + identity.uid));
    if (!profile.exists) throw new ClockInError("PROFILE_NOT_FOUND", "No se encuentra tu perfil. Contacta con el administrador.");
    const { companyId, role } = profile.data();
    if (!safeId(companyId) || !["trabajador", "administrador"].includes(role)) throw new ClockInError("FORBIDDEN");
    if (companyId !== request.companyContext) throw new ClockInError("COMPANY_MISMATCH");
    const companyPath = "companies/" + companyId;
    const requestKey = createHash("sha256").update(JSON.stringify([DOMAIN_VERSION, companyId, identity.uid, request.requestId])).digest("hex");
    const receiptRef = firestore.doc(companyPath + "/session_requests/" + requestKey);
    const [company, control, receipt] = await transaction.getAll(firestore.doc(companyPath),
      firestore.doc(companyPath + "/session_control/config"), receiptRef);
    if (!company.exists) throw new ClockInError("COMPANY_NOT_FOUND", "No se encuentra tu empresa. Contacta con el administrador.");
    return { requestKey, receiptRef, stateRef: firestore.doc(companyPath + "/session_states/" + identity.uid),
      context: { request, actor: { uid: identity.uid, companyId, role, emailVerified: true },
        control: pick(control.exists ? control.data() : null, ["companyId", "writeMode", "epoch", "minProtocolVersion"]),
        state: null, receipt: pick(receipt.exists ? receipt.data() : null, receiptFields) } };
  }
  return async function clockOut({ data, identity, reauthorize }) {
    guard();
    if (!identity || !safeId(identity.uid)) throw new ClockInError("UNAUTHENTICATED");
    if (identity.emailVerified !== true) throw new ClockInError("EMAIL_NOT_VERIFIED");
    const request = rejectDecision(validateSessionRequest(data)).request;
    if (request.operation !== "clockOut") throw new ClockInError("INVALID_REQUEST");
    // The optional capability is supplied by trusted server code, never data.
    // Direct internal callers without it can execute once, but cannot recover
    // using a stale Auth assertion. Their native uncertainty remains unchanged.
    let authorizationChecks = 0;
    const historyInputs = new WeakMap();
    const recover = createSessionOperationRecovery({
      runTransaction: (callback, options) => firestore.runTransaction(callback, options),
      runReadOnlyTransaction: (callback, options) => firestore.runTransaction(callback, options),
      isBusinessError: error => error instanceof ClockInError,
      reauthorize: async ({ request: envelope }) => {
        guard();
        if (typeof reauthorize === "function") await reauthorize(envelope.identity);
        else if (authorizationChecks > 0) throw new Error("A trusted Auth revalidation capability is required for recovery.");
        authorizationChecks++;
      },
      readConfirmation: ({ transaction, request: envelope }) => readAuthorityAndReceipt(transaction, envelope),
      validateConfirmation: ({ evidence }) => {
        const decision = evaluateSessionOperation({ ...evidence.context, now: now() });
        if (evidence.context.receipt !== null) {
          rejectDecision(decision);
          return { kind: "confirmed", result: decision.result };
        }
        if (decision.error.code !== "STATE_UNINITIALIZED") rejectDecision(decision);
        return { kind: "absent" };
      },
      readHistory: async ({ transaction }) => {
        const parameters = historyInputs.get(transaction);
        if (!parameters) throw new ClockInError("INVALID_STATE");
        return readClosingHistory(transaction, firestore, parameters);
      },
      execute: async ({ transaction, request: envelope, readHistory }) => {
        const { identity, request } = envelope;
        const { requestKey, receiptRef, stateRef, context } = await readAuthorityAndReceipt(transaction, envelope);
        // A receipt can be replayed without reading or altering a newer state.
        if (context.receipt !== null) {
          const replay = rejectDecision(evaluateSessionOperation({ ...context, now: now() }));
          return { ok: true, replayed: true, result: replay.result };
        }
        const state = await transaction.get(stateRef);
        context.state = pick(state.exists ? state.data() : null, stateFields);
        // Validate/replay first. Only a valid open state may request history reads.
        const preliminary = evaluateSessionOperation({ ...context, now: now() });
        if (preliminary.ok && preliminary.replayed) return { ok: true, replayed: true, result: preliminary.result };
        if (preliminary.ok) throw new ClockInError("INVALID_STATE");
        if (preliminary.error.code !== "HISTORY_INCOMPLETE") rejectDecision(preliminary);
        const entryId = context.state.activeEntryId;
        historyInputs.set(transaction, { companyId: context.actor.companyId, userId: identity.uid,
          entryId, openedAt: context.state.openedAt });
        let closingHistory;
        try { closingHistory = await readHistory(); }
        finally { historyInputs.delete(transaction); }
        const { original, history } = closingHistory;
        // Re-read the server clock after history reads, on every transaction retry.
        const effectiveAt = now();
        const decision = rejectDecision(evaluateSessionOperation({ ...context, now: effectiveAt, history }));
        assertPersistibleTimestamp(effectiveAt);
        const plan = decision.plan;
        if (plan.requestKey !== requestKey) throw new ClockInError("INVALID_RECEIPT");
        guard();
        // create(), never set(): collisions must abort the entire transaction.
        transaction.create(firestore.doc("logs/" + plan.event.id), {
          userId: identity.uid, companyId: context.actor.companyId, tipo: "salida", timestamp: effectiveAt,
          entradaLogId: entryId, inicioSesion: original.data().timestamp, minutosSesion: plan.event.minutosSesion,
        });
        // Preserve initialization/source metadata; originals are append-only.
        transaction.update(stateRef, { ...plan.nextState, updatedAt: serverTimestamp() });
        transaction.create(receiptRef, { ...plan.receipt, committedAt: serverTimestamp() });
        return { ok: true, replayed: false, result: decision.result };
      },
    });
    try { return await recover({ request, identity: { uid: identity.uid, emailVerified: identity.emailVerified } }); }
    catch (error) {
      // Preserve the internal service's native-error contract. The unchanged
      // callable mapping reports these as CONFIRMATION_UNAVAILABLE, never as
      // VERSION_CONFLICT or definitive absence of a committed operation.
      if (error instanceof SessionRecoveryUncertainError && error.cause) throw error.cause;
      throw error;
    }
  };
}

