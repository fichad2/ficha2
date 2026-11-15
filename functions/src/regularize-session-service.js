import { createHash } from "node:crypto";
import { DOMAIN_VERSION, validateSessionRequest, evaluateSessionOperation, validateOverdueRegularization } from "./session-domain.js";
import { ClockInError } from "./clock-in-service.js";
import { createSessionOperationRecovery, SessionRecoveryUncertainError } from "./session-operation-recovery.js";
import { rejectDecision, pick, stateFields, receiptFields, safeId, assertLocalFirestore,
  assertPersistibleTimestamp, readClosingHistory } from "./session-transaction-support.js";

// Only trusted server adapters. The request never supplies a worker/admin UID.
export function createRegularizeSessionService({ firestore, environment, now, serverTimestamp, toTimestamp }) {
  const guard = () => assertLocalFirestore(firestore, environment);
  async function readAuthorityAndReceipt(transaction, { request, identity }) {
    guard();
    const profile = await transaction.get(firestore.doc("users/" + identity.uid));
    if (!profile.exists) throw new ClockInError("PROFILE_NOT_FOUND", "No se encuentra tu perfil de administrador.");
    const { companyId, role } = profile.data();
    if (!safeId(companyId) || role !== "administrador") throw new ClockInError("FORBIDDEN");
    if (companyId !== request.companyContext) throw new ClockInError("COMPANY_MISMATCH");
    const path = "companies/" + companyId;
    // Actor-scoped identity: another administrator's matching UUID never
    // identifies this administrator's receipt or confirms their operation.
    const requestKey = createHash("sha256").update(JSON.stringify([DOMAIN_VERSION, companyId, identity.uid, request.requestId])).digest("hex");
    const receiptRef = firestore.doc(path + "/session_requests/" + requestKey);
    const [company, control, receipt] = await transaction.getAll(firestore.doc(path),
      firestore.doc(path + "/session_control/config"), receiptRef);
    if (!company.exists) throw new ClockInError("COMPANY_NOT_FOUND", "No se encuentra tu empresa.");
    return { path, requestKey, receiptRef,
      context: { request, actor: { uid: identity.uid, companyId, role, emailVerified: true },
        control: pick(control.exists ? control.data() : null, ["companyId", "writeMode", "epoch", "minProtocolVersion"]),
        receipt: pick(receipt.exists ? receipt.data() : null, receiptFields) } };
  }
  return async function regularizeSession({ data, identity, reauthorize }) {
    guard();
    if (!identity || !safeId(identity.uid)) throw new ClockInError("UNAUTHENTICATED");
    if (identity.emailVerified !== true) throw new ClockInError("EMAIL_NOT_VERIFIED");
    const request = rejectDecision(validateSessionRequest(data)).request;
    if (request.operation !== "regularizeSession") throw new ClockInError("INVALID_REQUEST");
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
        const decision = evaluateSessionOperation({ ...evidence.context, state: null, now: now() });
        if (evidence.context.receipt !== null) {
          rejectDecision(decision);
          return { kind: "confirmed", result: decision.result };
        }
        if (decision.error.code !== "STATE_UNINITIALIZED") rejectDecision(decision);
        return { kind: "absent" };
      },
      readHistory: ({ transaction }) => {
        const parameters = historyInputs.get(transaction);
        if (!parameters) throw new ClockInError("INVALID_STATE");
        return readClosingHistory(transaction, firestore, parameters);
      },
      execute: async ({ transaction, request: envelope, readHistory }) => {
        const { identity, request } = envelope;
        const { path, requestKey, receiptRef, context } = await readAuthorityAndReceipt(transaction, envelope);
        const companyId = context.actor.companyId;
        // Recover a committed outcome without applying it to a newer session.
        const receiptCheck = evaluateSessionOperation({ ...context, state: null, now: now() });
        if (context.receipt !== null) {
          rejectDecision(receiptCheck);
          return { ok: true, replayed: true, result: receiptCheck.result };
        }
        if (receiptCheck.error.code !== "STATE_UNINITIALIZED") rejectDecision(receiptCheck);
        const original = await transaction.get(firestore.doc("logs/" + request.originalEntryId));
        if (!original.exists || original.data().tipo !== "entrada") throw new ClockInError("REFERENCE_MISMATCH");
        if (original.data().companyId !== companyId) throw new ClockInError("COMPANY_MISMATCH");
        const workerUid = original.data().userId;
        if (!safeId(workerUid)) throw new ClockInError("REFERENCE_MISMATCH");
        const stateRef = firestore.doc(path + "/session_states/" + workerUid);
        const [worker, state] = await transaction.getAll(firestore.doc("users/" + workerUid), stateRef);
        if (!worker.exists) throw new ClockInError("WORKER_PROFILE_NOT_FOUND", "No se encuentra el perfil vigente del trabajador.");
        if (worker.data().companyId !== companyId) throw new ClockInError("COMPANY_MISMATCH");
        if (!["trabajador", "administrador"].includes(worker.data().role)) throw new ClockInError("FORBIDDEN");
        context.state = pick(state.exists ? state.data() : null, stateFields);
        const checkedAt = now();
        const preliminary = evaluateSessionOperation({ ...context, now: checkedAt });
        if (preliminary.ok) throw new ClockInError("INVALID_STATE");
        if (preliminary.error.code !== "HISTORY_INCOMPLETE") rejectDecision(preliminary);
        // Domain permits an admin to inspect another worker's state. Bind it here
        // to the worker derived from this original before allowing any transition.
        if (context.state.userId !== workerUid) throw new ClockInError("REFERENCE_MISMATCH");
        rejectDecision(validateOverdueRegularization(context.state, checkedAt));
        historyInputs.set(transaction, { companyId, userId: workerUid, entryId: request.originalEntryId,
          openedAt: context.state.openedAt, original });
        let closingHistory;
        try { closingHistory = await readHistory(); }
        finally { historyInputs.delete(transaction); }
        const { history } = closingHistory;
        const effectiveAt = now();
        rejectDecision(validateOverdueRegularization(context.state, effectiveAt, history));
        const decision = rejectDecision(evaluateSessionOperation({ ...context, now: effectiveAt, history }));
        assertPersistibleTimestamp(effectiveAt);
        if (request.accreditedExitAt !== null) assertPersistibleTimestamp(request.accreditedExitAt, "accreditedExitPrecision");
        const plan = decision.plan;
        if (plan.requestKey !== requestKey || plan.event.workerUid !== workerUid) throw new ClockInError("INVALID_RECEIPT");
        const { type: _type, id: _id, ...event } = plan.event;
        guard();
        // The immutable resolution and receipt together form the server audit.
        // No write to logs, and no client-writable audit_logs as a confirmation.
        transaction.create(firestore.doc(path + "/regularizations/" + request.originalEntryId), {
          ...event, regularizedAt: effectiveAt,
          accreditedExitAt: request.accreditedExitAt === null ? null : toTimestamp(request.accreditedExitAt),
          committedAt: serverTimestamp(),
        });
        transaction.update(stateRef, { ...plan.nextState, updatedAt: serverTimestamp() });
        transaction.create(receiptRef, { ...plan.receipt, workerUid, committedAt: serverTimestamp() });
        return { ok: true, replayed: false, result: decision.result };
      },
    });
    try { return await recover({ request, identity: { uid: identity.uid, emailVerified: identity.emailVerified } }); }
    catch (error) {
      // Keep native errors internal and the existing callable uncertainty
      // mapping public; never convert a native failure into VERSION_CONFLICT.
      if (error instanceof SessionRecoveryUncertainError && error.cause) throw error.cause;
      throw error;
    }
  };
}
