// Internal orchestration only: no SDK, network, clock, storage or service imports.
// Ports are trusted server code, never functions supplied by a client request.
// runTransaction must atomically commit only a fulfilled callback and propagate
// callback failures. A new invocation must start a fresh transaction execution.
// execute must check the receipt, authority, epoch and version INSIDE that
// transaction before staging writes. An absent probe is not a write permit.
export const RECOVERY_LIMITS = Object.freeze({ executions: 2, writeCallbacks: 5, probes: 2 });

export class SessionRecoveryUncertainError extends Error {
  constructor(cause, budget) {
    super("The operation could not be confirmed; retry with the same request identity.", { cause });
    this.name = "SessionRecoveryUncertainError";
    this.code = "CONFIRMATION_UNAVAILABLE";
    this.retryable = true;
    this.outcomeUnknown = true;
    this.budget = Object.freeze({ ...budget });
  }
}

// Normalized domain DTOs are plain data. Reject accessors, prototypes, cycles,
// symbols and non-finite numbers instead of silently losing their information.
function snapshot(value, ancestors = new Set()) {
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || ancestors.has(value)
    || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) {
    throw new TypeError("Recovery requires a plain immutable request DTO.");
  }
  if (Array.isArray(value) && (Object.keys(value).length !== value.length
    || Array.from({ length: value.length }, (_, index) => index).some(index => !Object.hasOwn(value, index)))) {
    throw new TypeError("Sparse or decorated arrays are not request DTOs.");
  }
  ancestors.add(value);
  const copy = Array.isArray(value) ? [] : {};
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("Recovery requires data properties.");
    }
    Object.defineProperty(copy, key, { value: snapshot(descriptor.value, ancestors), enumerable: true });
  }
  if (Array.isArray(value) && copy.length !== value.length) throw new TypeError("Sparse arrays are not request DTOs.");
  ancestors.delete(value);
  return Object.freeze(copy);
}

const closedHistoryRead = error => error instanceof Error && error.code === 3
  && /^(?:3 INVALID_ARGUMENT: )?Transaction is invalid or closed\.$/.test(error.message);

// Input: { identity: authenticated DTO, request: validated domain request DTO }.
// Port signatures:
// runTransaction(async tx => result, {maxAttempts}) -> committed result
// runReadOnlyTransaction(async tx => evidence, {readOnly:true}) -> evidence
// execute({transaction, request: envelope, readHistory}) -> operation result
// readHistory/readConfirmation({transaction, request: envelope}) -> plain evidence
// validateConfirmation({evidence, request}) -> {kind:'absent'} or
//   {kind:'confirmed', result}; throw the original business error for invalid or
//   incompatible receipts. All other outcomes are treated as unknown.
// reauthorize({request}) -> void, or throw; isBusinessError(error) -> boolean.
// Ports must not write outside execute's atomic transaction or swallow callback
// failures. Guards bound admitted work even for a runner ignoring maxAttempts;
// they cannot revoke I/O already performed by a malicious injected dependency.
export function createSessionOperationRecovery(ports) {
  const required = ["runTransaction", "runReadOnlyTransaction", "execute", "readHistory",
    "readConfirmation", "validateConfirmation", "reauthorize", "isBusinessError"];
  for (const name of required) {
    if (typeof ports?.[name] !== "function") throw new TypeError("Missing recovery port: " + name);
  }
  // Capture dependencies once; mutating the caller's ports object cannot switch
  // adapters halfway through a recovery.
  const { runTransaction, runReadOnlyTransaction, execute, readHistory,
    readConfirmation, validateConfirmation, reauthorize, isBusinessError } = ports;

  return async function recover(input) {
    // Snapshot synchronously, before the first await. No epoch/version/UUID update.
    const request = snapshot(input);
    if (!request.identity?.uid || request.identity.emailVerified !== true
      || !["clockOut", "regularizeSession"].includes(request.request?.operation)
      || !request.request.requestId || !request.request.companyContext
      || !Number.isSafeInteger(request.request.expectedStateVersion) || request.request.expectedStateVersion < 0
      || !Number.isSafeInteger(request.request.expectedEpoch) || request.request.expectedEpoch < 0) {
      throw new TypeError("Expected an authenticated, validated session request envelope.");
    }
    const budget = { executions: 0, writeCallbacks: 0, probes: 0 };
    let violation = null;
    const failBudget = () => {
      violation ??= new Error("Recovery adapter exceeded its callback contract.");
      throw violation;
    };
    const uncertain = cause => new SessionRecoveryUncertainError(cause, budget);
    const preserve = error => {
      if (isBusinessError(error)) throw error;
    };

    async function probe() {
      if (budget.probes >= RECOVERY_LIMITS.probes) return { kind: "unknown" };
      budget.probes++;
      let callbacks = 0, active = true;
      try {
        // Auth denial is terminal; infrastructure failures remain uncertain.
        await reauthorize({ request });
        const evidence = await runReadOnlyTransaction(async transaction => {
          if (!active || ++callbacks > 1) failBudget();
          return readConfirmation({ transaction, request });
        }, Object.freeze({ readOnly: true }));
        active = false;
        if (violation || callbacks !== 1) throw violation ?? new Error("Confirmation callback was not executed.");
        // The trusted validator must use the real domain receipt contract and
        // original actor/key/fingerprint, not merely receipt existence.
        const confirmation = await validateConfirmation({ evidence, request });
        if (confirmation?.kind === "confirmed" && Object.hasOwn(confirmation, "result")) return confirmation;
        if (confirmation?.kind === "absent") return confirmation;
        return { kind: "unknown" };
      } catch (error) {
        preserve(error);
        return { kind: "unknown", cause: error };
      } finally {
        active = false;
      }
    }

    while (budget.executions < RECOVERY_LIMITS.executions) {
      let lastCallback = null, active = true, running = false;
      try {
        await reauthorize({ request });
        budget.executions++;
        const result = await runTransaction(async transaction => {
          // Enforce BEFORE calling user work, even if the SDK ignores maxAttempts.
          if (!active || running || violation || budget.writeCallbacks >= RECOVERY_LIMITS.writeCallbacks) failBudget();
          budget.writeCallbacks++;
          running = true;
          const callback = { error: null, readErrors: new WeakSet(), open: true };
          lastCallback = callback;
          try {
            const value = await execute({ transaction, request, readHistory: async () => {
              if (!active || !callback.open) failBudget();
              try { return await readHistory({ transaction, request }); }
              catch (error) {
                if (error instanceof Error) callback.readErrors.add(error);
                throw error;
              }
            } });
            if (violation) throw violation;
            return value;
          } catch (error) {
            callback.error = error;
            throw error;
          } finally {
            callback.open = false;
            running = false;
          }
        }, Object.freeze({ maxAttempts: RECOVERY_LIMITS.writeCallbacks - budget.writeCallbacks }));
        active = false;
        if (violation || !lastCallback || lastCallback.error || running) {
          throw violation ?? new Error("Transaction adapter did not honor its callback.");
        }
        return result;
      } catch (error) {
        active = false;
        preserve(error);
        const confirmed = await probe();
        if (violation) throw uncertain(violation);
        if (confirmed.kind === "confirmed") return { ok: true, replayed: true, result: confirmed.result };
        const provenReadFailure = lastCallback?.error === error && lastCallback.readErrors.has(error);
        if (confirmed.kind === "absent" && provenReadFailure && closedHistoryRead(error)
          && budget.executions < RECOVERY_LIMITS.executions
          && budget.writeCallbacks < RECOVERY_LIMITS.writeCallbacks) {
          // Fresh execution; execute must atomically re-check the receipt again.
          continue;
        }
        throw uncertain(confirmed.cause ?? error);
      } finally {
        active = false;
      }
    }
    throw uncertain(new Error("Recovery execution budget exhausted."));
  };
}
