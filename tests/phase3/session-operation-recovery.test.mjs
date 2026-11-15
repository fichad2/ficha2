import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionOperationRecovery, RECOVERY_LIMITS, SessionRecoveryUncertainError }
  from "../../functions/src/session-operation-recovery.js";
import { evaluateSessionOperation } from "../../functions/src/session-domain.js";

class BusinessError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const native = (code = 3, message = "Transaction is invalid or closed.") => Object.assign(new Error(message), { code });
const originalTime = { seconds: 1767254400, nanoseconds: 123000 };
const envelope = (operation = "clockOut", uid = operation === "clockOut" ? "fake-worker" : "fake-admin") => ({
  identity: { uid, emailVerified: true },
  request: { operation, requestId: "11111111-1111-4111-8111-111111111111", companyContext: "fake-company",
    expectedStateVersion: 7, expectedEpoch: 3, protocolVersion: 1,
    ...(operation === "regularizeSession" ? { originalEntryId: "fake-entry", mode: "unknown_exit",
      reason: "Fictional reviewed omission", accreditedExitAt: null, evidenceReference: null } : {}) },
});
const key = input => input.identity.uid + "/" + input.request.requestId;

// Atomic in-memory fake. No imports of services, adapters, SDKs or emulators.
// It repeats callbacks on ABORTED, models a lost response after commit and checks
// receipt/version inside each callback, independently of confirmation probes.
function fixture(operation = "clockOut") {
  const input = envelope(operation);
  const store = {
    control: { companyId: "fake-company", writeMode: "backend", epoch: 3, minProtocolVersion: 1 },
    state: { schemaVersion: 1, companyId: "fake-company", userId: "fake-worker", status: "open", version: 7,
      activeEntryId: "fake-entry", openedAt: originalTime, reviewReason: null, lastResolution: null, lastRequestId: null },
    logs: [{ id: "fake-entry", tipo: "entrada", companyId: "fake-company", userId: "fake-worker", timestamp: originalTime }],
    receipts: {}, resolutions: [],
  };
  const initial = structuredClone(store);
  const calls = { transactions: [], probes: [], auth: [], requests: [], rpc: [], validation: 0, bodies: 0, history: 0 };
  const faults = { callbacks: [], commits: [], reads: [], confirmations: [], auth: [], beforeExecute: null, beforeProbe: null };
  let sequence = 0;
  const context = (request, db, receipt = db.receipts[key(request)] ?? null) => ({
    request: request.request,
    actor: { uid: request.identity.uid, emailVerified: true, companyId: "fake-company",
      role: request.request.operation === "clockOut" ? "trabajador" : "administrador" },
    control: db.control,
    state: db.state, receipt, now: { seconds: originalTime.seconds + (operation === "clockOut" ? 3600 : 3 * 86400),
      nanoseconds: originalTime.nanoseconds },
    history: { complete: true, entry: db.logs[0], exitIds: [], regularizationIds: [], nextEntryAt: null, conflicts: [] },
  });
  const checked = decision => {
    if (!decision.ok) throw new BusinessError(decision.error.code);
    return decision;
  };
  const ports = {
    isBusinessError: error => error instanceof BusinessError,
    reauthorize: async ({ request }) => {
      calls.auth.push(request);
      const error = faults.auth.shift();
      if (error) throw error;
    },
    runTransaction: async (callback, options) => {
      const execution = { options, ids: [], callbacks: 0 };
      calls.transactions.push(execution);
      for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
        const tx = { id: ++sequence, db: structuredClone(store), pending: null };
        execution.ids.push(tx.id);
        execution.callbacks++;
        try {
          const result = await callback(tx);
          const error = faults.commits.shift();
          if (error?.before) throw error.before;
          if (tx.pending) {
            if (tx.db.state.version !== store.state.version) throw native(10, "ABORTED");
            const { plan, request } = tx.pending;
            // Apply a single atomic batch; the original log is never changed.
            store.state = structuredClone(plan.nextState);
            store.receipts[key(request)] = structuredClone(plan.receipt);
            if (operation === "clockOut") store.logs.push(structuredClone(plan.event));
            else store.resolutions.push(structuredClone(plan.event));
          }
          if (error?.after) throw error.after;
          return result;
        } catch (error) {
          if (error.code !== 10 || attempt + 1 >= options.maxAttempts) throw error;
        }
      }
    },
    execute: async ({ transaction, request, readHistory }) => {
      calls.bodies++;
      calls.requests.push(request);
      if (faults.beforeExecute) await faults.beforeExecute({ transaction, request });
      const error = faults.callbacks.shift();
      if (error) throw error;
      // A valid receipt wins before any new-state or history processing.
      if (transaction.db.receipts[key(request)]) {
        const replay = checked(evaluateSessionOperation(context(request, transaction.db)));
        return { ok: true, replayed: true, result: replay.result };
      }
      await readHistory();
      const decision = checked(evaluateSessionOperation(context(request, transaction.db)));
      transaction.pending = { plan: decision.plan, request };
      return { ok: true, replayed: false, result: decision.result };
    },
    readHistory: async ({ transaction }) => {
      calls.history++;
      const error = faults.reads.shift();
      if (error?.sequence) {
        for (const code of error.sequence) calls.rpc.push({ transactionId: transaction.id, code });
        throw native(error.sequence.at(-1));
      }
      if (error) throw error;
      return structuredClone(transaction.db.logs);
    },
    runReadOnlyTransaction: async (callback, options) => {
      calls.probes.push(options);
      if (faults.beforeProbe) await faults.beforeProbe();
      return callback({ id: ++sequence, db: structuredClone(store) });
    },
    readConfirmation: async ({ transaction }) => {
      const error = faults.confirmations.shift();
      if (error) throw error;
      return transaction.db;
    },
    validateConfirmation: ({ evidence, request }) => {
      calls.validation++;
      const receipt = evidence.receipts[key(request)];
      if (!receipt) return { kind: "absent" };
      const decision = checked(evaluateSessionOperation(context(request, evidence, receipt)));
      assert.equal(decision.replayed, true);
      return { kind: "confirmed", result: decision.result };
    },
  };
  const recover = overrides => createSessionOperationRecovery({ ...ports, ...overrides });
  const effects = (count = 1) => {
    assert.deepEqual(store.logs[0], initial.logs[0]);
    assert.equal(store.state.version, 7 + count);
    assert.equal(Object.keys(store.receipts).length, count);
    assert.equal(store.logs.length, operation === "clockOut" ? 1 + count : 1);
    assert.equal(store.resolutions.length, operation === "regularizeSession" ? count : 0);
    if (count === 0) assert.deepEqual(store.state, initial.state);
  };
  return { input, store, initial, calls, faults, ports, recover, effects, context };
}

const unknown = async promise => {
  const error = await promise.then(() => assert.fail("Expected uncertainty"), error => error);
  assert.ok(error instanceof SessionRecoveryUncertainError);
  assert.equal(error.code, "CONFIRMATION_UNAVAILABLE");
  assert.equal(error.outcomeUnknown, true);
  assert.equal(error.retryable, true);
  return error;
};

for (const operation of ["clockOut", "regularizeSession"]) {
  test(operation + ": normal execution does not probe or restart", async () => {
    const f = fixture(operation);
    const result = await f.recover()(f.input);
    assert.equal(result.replayed, false);
    assert.equal(f.calls.transactions.length, 1);
    assert.equal(f.calls.probes.length, 0);
    f.effects();
  });

  test(operation + ": ABORTED -> closed INVALID_ARGUMENT in a history read restarts fresh", async () => {
    const f = fixture(operation);
    f.faults.reads.push({ sequence: [10, 3] });
    const result = await f.recover()(f.input);
    assert.equal(result.replayed, false);
    assert.equal(f.calls.transactions.length, 2);
    assert.deepEqual(f.calls.transactions.map(t => t.options.maxAttempts), [5, 4]);
    assert.notEqual(f.calls.transactions[0].ids[0], f.calls.transactions[1].ids[0]);
    assert.equal(f.calls.probes.length, 1);
    assert.deepEqual(f.calls.rpc.map(r => r.code), [10, 3]);
    assert.equal(new Set(f.calls.rpc.map(r => r.transactionId)).size, 1);
    assert.ok(f.calls.requests.every(request => request === f.calls.requests[0]));
    assert.deepEqual(f.calls.requests[0], f.input);
    f.effects();
  });

  test(operation + ": lost response after commit is confirmed with no second execution", async () => {
    const f = fixture(operation);
    f.faults.commits.push({ after: native(14, "Response lost") });
    const result = await f.recover()(f.input);
    assert.equal(result.replayed, true);
    assert.equal(f.calls.transactions.length, 1);
    f.effects();
    assert.deepEqual(await f.recover()(f.input), result);
    f.effects();
  });

  test(operation + ": commit error with closed message cannot masquerade as a read error", async () => {
    const f = fixture(operation);
    f.faults.commits.push({ before: native() });
    await unknown(f.recover()(f.input));
    assert.equal(f.calls.transactions.length, 1);
    f.effects(0);
  });

  test(operation + ": absent probe followed by late confirmation replays inside the fresh transaction", async () => {
    const f = fixture(operation);
    f.faults.reads.push(native());
    const base = f.ports.runTransaction;
    let runs = 0;
    const execute = f.recover({ runTransaction: async (...args) => {
      if (++runs === 2) {
        // Models another execution committing after the absence observation.
        await f.ports.runTransaction(tx => f.ports.execute({ transaction: tx,
          request: f.input, readHistory: async () => [] }), { maxAttempts: 1 });
      }
      return base(...args);
    } });
    const result = await execute(f.input);
    assert.equal(result.replayed, true);
    f.effects();
  });

  test(operation + ": persistent history closure allows only two executions and two probes", async () => {
    const f = fixture(operation);
    f.faults.reads.push(native(), native(), native());
    const error = await unknown(f.recover()(f.input));
    assert.deepEqual(error.budget, { executions: 2, writeCallbacks: 2, probes: 2 });
    assert.equal(f.calls.transactions.length, 2);
    assert.equal(f.calls.probes.length, 2);
    f.effects(0);
  });

  for (const code of ["VERSION_CONFLICT", "INVALID_RECEIPT", "REQUEST_ID_CONFLICT", "FORBIDDEN", "EPOCH_CONFLICT"]) {
    test(operation + ": preserves business error " + code + " by identity", async () => {
      const f = fixture(operation), error = new BusinessError(code);
      f.faults.callbacks.push(error);
      await assert.rejects(f.recover()(f.input), actual => actual === error);
      assert.equal(f.calls.transactions.length, 1);
      assert.equal(f.calls.probes.length, 0);
      f.effects(0);
    });
  }

  test(operation + ": confirmation read failure prevents automatic restart", async () => {
    const f = fixture(operation);
    f.faults.reads.push(native());
    f.faults.confirmations.push(native(14, "Fictional receipt read unavailable"));
    const error = await unknown(f.recover()(f.input));
    assert.equal(error.cause.code, 14);
    assert.equal(f.calls.transactions.length, 1);
    f.effects(0);
  });

  test(operation + ": corrupt receipt never becomes success or a restart", async () => {
    const f = fixture(operation);
    f.faults.reads.push(native());
    f.faults.beforeProbe = () => { f.store.receipts[key(f.input)] = { corrupt: true }; };
    await assert.rejects(f.recover()(f.input), { code: "INVALID_RECEIPT" });
    assert.equal(f.calls.transactions.length, 1);
    assert.deepEqual(f.store.state, f.initial.state);
    assert.deepEqual(f.store.logs, f.initial.logs);
  });

  test(operation + ": incompatible valid receipt retains REQUEST_ID_CONFLICT", async () => {
    const f = fixture(operation);
    const other = structuredClone(f.input);
    other.request.expectedStateVersion = 6;
    const db = structuredClone(f.store);
    db.state.version = 6;
    const result = evaluateSessionOperation(f.context(other, db));
    assert.equal(result.ok, true);
    f.faults.reads.push(native());
    f.faults.beforeProbe = () => { f.store.receipts[key(f.input)] = result.plan.receipt; };
    await assert.rejects(f.recover()(f.input), { code: "REQUEST_ID_CONFLICT" });
    assert.equal(f.calls.transactions.length, 1);
    assert.deepEqual(f.store.logs, f.initial.logs);
  });

  test(operation + ": denied reauthorization after closure stops before confirmation reads", async () => {
    const f = fixture(operation);
    f.faults.reads.push(native());
    f.faults.auth.push(null, new BusinessError("FORBIDDEN"));
    await assert.rejects(f.recover()(f.input), { code: "FORBIDDEN" });
    assert.equal(f.calls.probes.length, 0);
    f.effects(0);
  });

  test(operation + ": epoch change on fresh execution does not rewrite the original epoch", async () => {
    const f = fixture(operation);
    f.faults.reads.push(native());
    f.faults.beforeProbe = () => { f.store.control.epoch = 4; };
    f.faults.beforeExecute = ({ request }) => {
      assert.equal(request.request.expectedEpoch, 3);
    };
    await assert.rejects(f.recover()(f.input), { code: "EPOCH_CONFLICT" });
    f.effects(0);
  });

  test(operation + ": confirmed receipt survives a newer epoch and newer state without overwriting either", async () => {
    const f = fixture(operation);
    const first = await f.recover()(f.input);
    f.store.control.epoch = 4;
    f.store.control.writeMode = "paused";
    f.store.state.version = 99;
    const saved = structuredClone(f.store);
    f.faults.callbacks.push(native(14, "Response unavailable"));
    const replay = await f.recover()(f.input);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, first.result);
    assert.deepEqual(f.store, saved);
  });

  test(operation + ": lost commit response and unreadable receipt remains uncertain despite committed data", async () => {
    const f = fixture(operation);
    f.faults.commits.push({ after: native(14, "Lost commit response") });
    f.faults.confirmations.push(native(14, "Receipt read failed"));
    await unknown(f.recover()(f.input));
    f.effects();
    assert.equal(f.calls.transactions.length, 1);
    const replay = await f.recover()(f.input);
    assert.equal(replay.replayed, true);
    f.effects();
  });

  test(operation + ": reauthorization denied between an absent probe and restart is terminal", async () => {
    const f = fixture(operation);
    f.faults.reads.push(native());
    f.faults.auth.push(null, null, new BusinessError("FORBIDDEN"));
    await assert.rejects(f.recover()(f.input), { code: "FORBIDDEN" });
    assert.equal(f.calls.transactions.length, 1);
    assert.equal(f.calls.probes.length, 1);
    f.effects(0);
  });
}

for (const error of [native(3, "Invalid field"), native(), native(14, "Unavailable"), native(4, "Deadline exceeded")]) {
  test("unattributed error is never automatically retried: " + error.code + " " + error.message, async () => {
    const f = fixture();
    f.faults.callbacks.push(error);
    await unknown(f.recover()(f.input));
    assert.equal(f.calls.transactions.length, 1);
    f.effects(0);
  });
}

test("history code 3 with an unrelated message is not recoverable", async () => {
  const f = fixture();
  f.faults.reads.push(native(3, "Invalid query"));
  await unknown(f.recover()(f.input));
  assert.equal(f.calls.transactions.length, 1);
});

test("standard gRPC code prefix is accepted only for the exact proven history signature", async () => {
  const f = fixture();
  f.faults.reads.push(native(3, "3 INVALID_ARGUMENT: Transaction is invalid or closed."));
  await f.recover()(f.input);
  assert.equal(f.calls.transactions.length, 2);
  f.effects();
});

test("global callback budget spans both executions, with real work stopped at five", async () => {
  const f = fixture();
  f.faults.callbacks.push(native(10, "ABORTED"), native(10, "ABORTED"));
  f.faults.reads.push(native());
  f.faults.commits.push({ before: native(10, "ABORTED") }, { before: native(10, "ABORTED") });
  const error = await unknown(f.recover()(f.input));
  assert.equal(f.calls.bodies, 5);
  assert.deepEqual(f.calls.transactions.map(t => t.options.maxAttempts), [5, 2]);
  assert.deepEqual(error.budget, { executions: 2, writeCallbacks: 5, probes: 2 });
  f.effects(0);
});

test("five ABORTED callbacks exhaust the total budget without an extra execution", async () => {
  const f = fixture();
  f.faults.callbacks.push(...Array.from({ length: 5 }, () => native(10, "ABORTED")));
  const error = await unknown(f.recover()(f.input));
  assert.equal(f.calls.bodies, 5);
  assert.equal(f.calls.transactions.length, 1);
  assert.equal(error.budget.writeCallbacks, 5);
  f.effects(0);
});

test("an SDK port ignoring maxAttempts cannot run a sixth write-capable body", async () => {
  const f = fixture();
  let rejected = 0;
  const runTransaction = async callback => {
    for (let index = 0; index < 9; index++) {
      try { await callback({ db: structuredClone(f.store), pending: null }); }
      catch { rejected++; }
    }
    return { forged: true }; // Even swallowing the guard cannot manufacture success.
  };
  f.faults.callbacks.push(...Array.from({ length: 5 }, () => native(10, "ABORTED")));
  const error = await unknown(f.recover({ runTransaction })(f.input));
  assert.equal(f.calls.bodies, 5);
  assert.equal(rejected, 9);
  assert.equal(error.budget.writeCallbacks, 5);
  f.effects(0);
});

test("a read-only port cannot execute the confirmation body twice", async () => {
  const f = fixture();
  f.faults.reads.push(native());
  let reads = 0;
  const error = await unknown(f.recover({
    runReadOnlyTransaction: async callback => {
      await callback({ db: f.store });
      try { await callback({ db: f.store }); } catch { /* maliciously swallowed */ }
      return f.store;
    },
    readConfirmation: async ({ transaction }) => { reads++; return transaction.db; },
  })(f.input));
  assert.equal(reads, 1);
  assert.equal(error.budget.probes, 1);
  assert.equal(f.calls.transactions.length, 1);
});

test("ignored SDK budget on the second execution still cannot admit a sixth callback", async () => {
  const f = fixture();
  f.faults.reads.push(native());
  const base = f.ports.runTransaction;
  let runs = 0, blocked = 0;
  await unknown(f.recover({ runTransaction: async (callback, options) => {
    if (++runs === 1) return base(callback, options);
    assert.equal(options.maxAttempts, 4);
    for (let index = 0; index < 8; index++) {
      try { await callback({ db: structuredClone(f.store) }); }
      catch { blocked++; }
    }
    return { forged: true };
  }, execute: async args => {
    if (runs === 1) return f.ports.execute(args);
    f.calls.bodies++;
    throw native(10, "ABORTED");
  } })(f.input));
  assert.equal(runs, 2);
  assert.equal(f.calls.bodies, 5);
  assert.equal(blocked, 8);
  f.effects(0);
});

test("parallel callbacks in one execution are rejected before a second body starts", async () => {
  const f = fixture();
  let bodies = 0;
  await unknown(f.recover({ runTransaction: async callback => {
    await Promise.allSettled([callback({}), callback({})]);
    return { forged: true };
  }, execute: async () => { bodies++; return { ok: true }; } })(f.input));
  assert.equal(bodies, 1);
  f.effects(0);
});

test("a port returning success without invoking the callback cannot manufacture confirmation", async () => {
  const f = fixture();
  await unknown(f.recover({ runTransaction: async () => ({ forged: true }) })(f.input));
  assert.equal(f.calls.bodies, 0);
  f.effects(0);
});

test("a stale callback capability cannot execute work after its run completes", async () => {
  const f = fixture();
  let retained;
  const base = f.ports.runTransaction;
  await f.recover({ runTransaction: (callback, options) => { retained = callback; return base(callback, options); } })(f.input);
  await assert.rejects(retained({ db: f.store }), /callback contract/);
  assert.equal(f.calls.bodies, 1);
  f.effects();
});

test("a stale history capability cannot make reads after callback completion", async () => {
  const f = fixture();
  let retained;
  const base = f.ports.execute;
  await f.recover({ execute: args => { retained = args.readHistory; return base(args); } })(f.input);
  await assert.rejects(retained(), /callback contract/);
  assert.equal(f.calls.history, 1);
});

test("request is deeply detached and frozen before authorization awaits", async () => {
  const f = fixture(), before = structuredClone(f.input);
  const promise = f.recover()(f.input);
  f.input.identity.uid = "fake-other";
  f.input.request.expectedEpoch = 99;
  await promise;
  assert.deepEqual(f.calls.requests[0], before);
  assert.ok(Object.isFrozen(f.calls.requests[0]));
  assert.ok(Object.isFrozen(f.calls.requests[0].request));
  assert.throws(() => { f.calls.requests[0].request.expectedStateVersion = 99; }, TypeError);
  f.effects();
});

test("provenance cannot leak from a previous invocation using the same Error object", async () => {
  const f = fixture(), error = native(), recover = f.recover();
  f.faults.reads.push(error, error);
  await unknown(recover(f.input));
  const prior = f.calls.transactions.length;
  f.faults.callbacks.push(error);
  await unknown(recover(f.input));
  assert.equal(f.calls.transactions.length, prior + 1);
  f.effects(0);
});

test("commit rethrowing a previously swallowed history error is not a proven callback failure", async () => {
  const f = fixture(), error = native();
  f.faults.reads.push(error);
  f.faults.commits.push({ before: error });
  await unknown(f.recover({ execute: async args => {
    try { await args.readHistory(); } catch { /* deliberately swallowed */ }
    return { ok: true };
  } })(f.input));
  assert.equal(f.calls.transactions.length, 1);
});

test("unknown confirmation response shape never authorizes a restart", async () => {
  const f = fixture();
  f.faults.reads.push(native());
  await unknown(f.recover({ validateConfirmation: () => ({ exists: false }) })(f.input));
  assert.equal(f.calls.transactions.length, 1);
});

test("two admins with the same UUID have distinct receipts and one atomic resolution", async () => {
  const f = fixture("regularizeSession"), second = envelope("regularizeSession", "fake-admin-two");
  const results = await Promise.allSettled([f.recover()(f.input), f.recover()(second)]);
  // Inspect effects unconditionally, before asserting response codes.
  f.effects();
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.deepEqual(results.filter(r => r.status === "rejected").map(r => r.reason.code), ["VERSION_CONFLICT"]);
});

test("twenty distinct concurrent exits yield one effect and nineteen real version conflicts", async () => {
  const f = fixture();
  const requests = Array.from({ length: 20 }, (_, index) => {
    const input = envelope();
    input.request.requestId = (index + 1).toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111";
    return input;
  });
  const results = await Promise.allSettled(requests.map(input => f.recover()(input)));
  f.effects();
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 19);
  assert.ok(results.filter(r => r.status === "rejected").every(r => r.reason.code === "VERSION_CONFLICT"));
});

test("same identity concurrently replays one receipt without duplicated writes", async () => {
  const f = fixture();
  const results = await Promise.all([f.recover()(f.input), f.recover()(f.input)]);
  f.effects();
  assert.equal(results.filter(r => r.replayed).length, 1);
  assert.deepEqual(results[0].result, results[1].result);
});

test("limits are immutable and all trusted ports are mandatory", () => {
  assert.deepEqual(RECOVERY_LIMITS, { executions: 2, writeCallbacks: 5, probes: 2 });
  assert.ok(Object.isFrozen(RECOVERY_LIMITS));
  for (const name of Object.keys(fixture().ports)) {
    const ports = fixture().ports;
    delete ports[name];
    assert.throws(() => createSessionOperationRecovery(ports), TypeError);
  }
});

test("non-data payloads are rejected without invoking transaction ports", async () => {
  const cyclic = {}; cyclic.self = cyclic;
  for (const bad of [new Date(), { value: undefined }, { value: NaN }, cyclic, [1, , 3],
    { get value() { throw new Error("getter"); } }]) {
    const f = fixture();
    await assert.rejects(f.recover()({ ...f.input, extra: bad }), TypeError);
    assert.equal(f.calls.transactions.length, 0);
  }
});
