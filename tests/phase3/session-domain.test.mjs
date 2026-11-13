import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateSessionOperation as evaluate, validateSessionRequest as validate, inspectSessionState as inspect,
  SESSION_STATUS, ERROR_MESSAGES } from "../../functions/src/session-domain.js";
import { reconstructSessions } from "../../src/session-reconstruction.js";
import { buildSharedReport } from "../../src/session-reporting.js";

const at = (iso) => new Date(iso);
const t = (seconds, nanoseconds = 0) => ({ seconds, nanoseconds });
const start = t(Date.parse("2026-01-01T08:00:00Z") / 1000);
const later = (seconds, nanos = 0) => t(start.seconds + seconds, nanos);
const actor = { uid: "fake-worker", companyId: "fake-company", role: "trabajador", emailVerified: true };
const admin = { ...actor, uid: "fake-admin", role: "administrador" };
const request = (operation = "clockIn", extra = {}) => ({ operation,
  requestId: "11111111-1111-4111-8111-111111111111", companyContext: actor.companyId,
  expectedStateVersion: 7, expectedEpoch: 3, protocolVersion: 1, ...extra });
const regularize = (extra = {}) => request("regularizeSession", {
  originalEntryId: "fake-entry", mode: "unknown_exit", reason: "Olvido declarado y revisado",
  accreditedExitAt: null, evidenceReference: null, ...extra });
const idle = () => ({ schemaVersion: 1, companyId: actor.companyId, userId: actor.uid, status: "idle",
  version: 7, activeEntryId: null, openedAt: null, reviewReason: null, lastResolution: null, lastRequestId: null });
const open = (extra = {}) => ({ ...idle(), status: "open", activeEntryId: "fake-entry", openedAt: start, ...extra });
const history = (extra = {}) => ({ complete: true,
  entry: { id: "fake-entry", tipo: "entrada", companyId: actor.companyId, userId: actor.uid, timestamp: start },
  exitIds: [], regularizationIds: [], nextEntryAt: null, conflicts: [], ...extra });
const context = (extra = {}) => ({ request: request(), actor, state: idle(), now: later(3600),
  control: { companyId: actor.companyId, writeMode: "backend", epoch: 3, minProtocolVersion: 1 }, ...extra });
const exitContext = (extra = {}) => context({ request: request("clockOut"), state: open(), history: history(), ...extra });
const regContext = (extra = {}) => exitContext({ request: regularize(), actor: admin, now: later(86400 * 5), ...extra });
function error(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
  assert.equal(result.error.message, ERROR_MESSAGES[code]);
  assert.equal(result.error.retryable, false);
  assert.equal(Object.hasOwn(result, "plan"), false);
}
const freeze = (v) => { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };

test("idle -> open creates a deterministic proposal and preserves request identity", () => {
  const input = freeze(context());
  const before = structuredClone(input);
  const a = evaluate(input);
  assert.equal(a.ok, true);
  assert.equal(a.replayed, false);
  assert.equal(a.plan.nextState.status, SESSION_STATUS.OPEN);
  assert.equal(a.plan.nextState.version, 8);
  assert.equal(a.plan.expectedStateVersion, 7);
  assert.equal(a.plan.expectedEpoch, 3);
  assert.equal(a.plan.nextState.activeEntryId, a.plan.event.id);
  assert.deepEqual(a.plan.event.timestamp, later(3600));
  assert.equal(a.result.minutes, null);
  assert.equal(a.plan.receipt.requestId, input.request.requestId);
  assert.match(a.plan.requestKey, /^[a-f0-9]{64}$/);
  assert.deepEqual(a, evaluate(input));
  assert.deepEqual(input, before);
});

test("an administrator can clock only their own ordinary session", () => {
  const s = { ...idle(), userId: admin.uid };
  assert.equal(evaluate(context({ actor: admin, state: s })).ok, true);
  error(evaluate(context({ actor: admin })), "FORBIDDEN");
});

test("open -> idle uses exactly the supplied instant for stored duration and exit", () => {
  const r = evaluate(exitContext());
  assert.equal(r.ok, true);
  assert.equal(r.plan.nextState.status, "idle");
  assert.equal(r.plan.nextState.activeEntryId, null);
  assert.equal(r.plan.nextState.openedAt, null);
  assert.equal(r.plan.event.entradaLogId, "fake-entry");
  assert.deepEqual(r.plan.event.inicioSesion, start);
  assert.deepEqual(r.plan.event.timestamp, later(3600));
  assert.equal(r.plan.event.minutosSesion, 60);
  assert.equal(r.result.minutes, 60);
});

for (const [seconds, nanos, expected] of [[0, 1, 0], [30, 0, 0], [59, 999999999, 0], [60, 0, 1], [86400, 0, 1440]]) {
  test('ordinary duration boundary ' + seconds + ' seconds / ' + nanos + ' nanoseconds', () => {
    const r = evaluate(exitContext({ now: later(seconds, nanos) }));
    assert.equal(r.ok, true);
    assert.equal(r.result.minutes, expected);
  });
}

for (const now of [later(0), later(-1)]) {
  test('reject non-positive duration at ' + now.seconds, () => error(evaluate(exitContext({ now })), "INVALID_TIME"));
}

test("open becomes needs_review after exactly 24 hours plus one nanosecond without mutation", () => {
  const s = freeze(open());
  assert.equal(inspect(s, later(86400)).state.status, "open");
  const projected = inspect(s, later(86400, 1));
  assert.equal(projected.state.status, "needs_review");
  assert.equal(projected.state.reviewReason, "overdue");
  assert.equal(projected.state.version, 7);
  assert.equal(s.status, "open");
  error(evaluate(exitContext({ now: later(86400, 1) })), "REGULARIZATION_REQUIRED");
  error(evaluate(context({ state: s, now: later(86400, 1) })), "REGULARIZATION_REQUIRED");
});

test("open refuses a second entry before the overdue boundary", () => error(evaluate(context({ state: open() })), "SESSION_ALREADY_OPEN"));
test("idle refuses exit and regularization", () => {
  error(evaluate(exitContext({ state: idle() })), "NO_OPEN_SESSION");
  error(evaluate(regContext({ state: idle() })), "NO_OPEN_SESSION");
});
test("a manually pending session cannot be closed by an ordinary exit", () => {
  error(evaluate(exitContext({ state: open({ status: "needs_review", reviewReason: "manual_review" }) })), "REGULARIZATION_REQUIRED");
});

test("same-company admin resolves unknown exit with null time/minutes and no exit log", () => {
  const input = freeze(regContext());
  const before = structuredClone(input);
  const r = evaluate(input);
  assert.equal(r.ok, true);
  assert.equal(r.plan.event.type, "regularization");
  assert.equal(r.plan.event.status, "resolved_unknown");
  assert.equal(r.plan.event.accreditedExitAt, null);
  assert.equal(r.plan.event.effectiveMinutes, null);
  assert.equal(Object.hasOwn(r.plan.event, "tipo"), false);
  assert.equal(Object.hasOwn(r.plan.event, "timestamp"), false);
  assert.equal(r.plan.event.originalEntryId, "fake-entry");
  assert.equal(r.plan.event.adminUid, admin.uid);
  assert.equal(r.plan.nextState.status, "regularized");
  assert.equal(r.plan.nextState.activeEntryId, null);
  assert.equal(r.plan.nextState.lastResolution.minutes, null);
  assert.equal(r.plan.nextState.lastResolution.exitAt, null);
  assert.equal(r.result.minutes, null);
  assert.deepEqual(input, before);
});

test("an explicit needs_review state can be regularized when its original entry is coherent", () => {
  const r = evaluate(regContext({ state: open({ status: "needs_review", reviewReason: "overdue" }) }));
  assert.equal(r.ok, true);
  assert.equal(r.plan.nextState.status, "regularized");
});

test("accredited exit keeps its actual date, reason and responsible admin distinct from regularization time", () => {
  const r = evaluate(regContext({ request: regularize({ mode: "accredited_exit", accreditedExitAt: later(3600),
    evidenceReference: " Parte firmado ficticio ", reason: " Motivo acreditado " }) }));
  assert.equal(r.ok, true);
  assert.equal(r.plan.event.effectiveMinutes, 60);
  assert.deepEqual(r.plan.event.accreditedExitAt, later(3600));
  assert.deepEqual(r.plan.event.regularizedAt, later(86400 * 5));
  assert.equal(r.plan.event.reason, "Motivo acreditado");
  assert.equal(r.plan.event.evidenceReference, "Parte firmado ficticio");
  assert.equal(r.plan.event.status, "resolved_known");
  assert.equal(r.plan.nextState.lastResolution.minutes, 60);
});

test("accredited zero minutes and unknown minutes are distinct", () => {
  const known = evaluate(regContext({ request: regularize({ mode: "accredited_exit", accreditedExitAt: later(30), evidenceReference: "Documento ficticio" }) }));
  const unknown = evaluate(regContext());
  assert.equal(known.result.minutes, 0);
  assert.equal(unknown.result.minutes, null);
  assert.equal(known.plan.event.status, "resolved_known");
  assert.equal(unknown.plan.event.status, "resolved_unknown");
});

test("regularized -> open starts a new session without modifying the original resolution", () => {
  const resolved = evaluate(regContext());
  const before = structuredClone(resolved);
  const next = evaluate(context({ state: resolved.plan.nextState, now: later(86400 * 6),
    request: request("clockIn", { expectedStateVersion: 8, requestId: "22222222-2222-4222-8222-222222222222" }) }));
  assert.equal(next.ok, true);
  assert.equal(next.plan.nextState.status, "open");
  assert.equal(next.plan.nextState.version, 9);
  assert.notEqual(next.plan.event.id, "fake-entry");
  assert.equal(next.plan.nextState.lastResolution, null);
  assert.deepEqual(resolved, before);
});

test("regularized refuses another exit or another regularization with a fresh request", () => {
  const state = evaluate(regContext()).plan.nextState;
  error(evaluate(exitContext({ state, now: later(86400 * 6), request: request("clockOut", { expectedStateVersion: 8 }) })), "ALREADY_REGULARIZED");
  error(evaluate(regContext({ state, request: regularize({ expectedStateVersion: 8 }) })), "ALREADY_REGULARIZED");
});

for (const badActor of [actor, { ...admin, companyId: "other-company" }]) {
  test('regularization rejects actor ' + badActor.role + '/' + badActor.companyId, () => {
    error(evaluate(regContext({ actor: badActor })), badActor.role === "trabajador" ? "FORBIDDEN" : "COMPANY_MISMATCH");
  });
}

test("admin cannot regularize state or entry belonging to another company", () => {
  error(evaluate(regContext({ state: open({ companyId: "other-company" }) })), "COMPANY_MISMATCH");
  error(evaluate(regContext({ history: history({ entry: { ...history().entry, companyId: "other-company" } }) })), "REFERENCE_MISMATCH");
});
test("ordinary requests cannot target another worker", () => {
  error(evaluate(context({ state: { ...idle(), userId: "other-worker" } })), "FORBIDDEN");
  error(evaluate(exitContext({ state: open({ userId: "other-worker" }) })), "FORBIDDEN");
});

for (const [change, code] of [[{ actor: null }, "UNAUTHENTICATED"], [{ actor: { ...actor, emailVerified: false } }, "EMAIL_NOT_VERIFIED"],
  [{ actor: { ...actor, role: "superadmin" } }, "FORBIDDEN"], [{ actor: { ...actor, companyId: null } }, "FORBIDDEN"]]) {
  test('reject authentication context ' + JSON.stringify(change), () => error(evaluate(context(change)), code));
}

for (const mode of ["legacy", "paused"]) test('no new effects in mode ' + mode, () => {
  error(evaluate(context({ control: { ...context().control, writeMode: mode } })), "SERVICE_PAUSED");
});
test("control must be complete and belong to the actor company", () => {
  error(evaluate(context({ control: null })), "INVALID_CONTROL");
  error(evaluate(context({ control: { ...context().control, companyId: "other-company" } })), "COMPANY_MISMATCH");
});
test("state version and cutover epoch must both match", () => {
  error(evaluate(context({ request: request("clockIn", { expectedStateVersion: 6 }) })), "VERSION_CONFLICT");
  error(evaluate(context({ request: request("clockIn", { expectedEpoch: 2 }) })), "EPOCH_CONFLICT");
});
test("protocol guards reject unsupported or newly obsolete clients", () => {
  error(evaluate(context({ request: request("clockIn", { protocolVersion: 2 }) })), "UNSUPPORTED_PROTOCOL");
  error(evaluate(context({ control: { ...context().control, minProtocolVersion: 2 } })), "UNSUPPORTED_PROTOCOL");
});

for (const value of [null, undefined]) test('missing state is never implicitly idle: ' + value, () => error(evaluate(context({ state: value })), "STATE_UNINITIALIZED"));
for (const patch of [{ status: "closed" }, { version: -1 }, { version: 7.5 }, { version: Number.MAX_SAFE_INTEGER },
  { activeEntryId: "unexpected" }, { openedAt: start }, { reviewReason: "overdue" }, { schemaVersion: 2 }, { lastRequestId: "x" }]) {
  test('reject inconsistent idle state ' + JSON.stringify(patch), () => error(evaluate(context({ state: { ...idle(), ...patch } })), "INVALID_STATE"));
}
test("open requires an original entry ID, timestamp and no conflicting resolution", () => {
  for (const patch of [{ activeEntryId: null }, { openedAt: null }, { lastResolution: {} }, { reviewReason: "overdue" }])
    error(evaluate(exitContext({ state: open(patch) })), "INVALID_STATE");
});
test("invalid or future state timestamps are not repaired", () => {
  error(evaluate(exitContext({ now: "2026-01-01T09:00:00Z" })), "INVALID_TIME");
  error(evaluate(exitContext({ state: open({ openedAt: later(3601) }) })), "INVALID_TIME");
});

for (const h of [undefined, null, {}, history({ complete: false }), history({ exitIds: null })]) {
  test('incomplete history ' + JSON.stringify(h), () => error(evaluate(exitContext({ history: h })), "HISTORY_INCOMPLETE"));
}
for (const patch of [{ id: "another-entry" }, { userId: "another-worker" }, { tipo: "salida" }, { timestamp: later(0, 1) }]) {
  test('exact entry reference ' + JSON.stringify(patch), () => error(evaluate(exitContext({ history: history({ entry: { ...history().entry, ...patch } }) })), "REFERENCE_MISMATCH"));
}
test("an originalEntryId mismatch cannot regularize another session", () => error(evaluate(regContext({ request: regularize({ originalEntryId: "other-entry" }) })), "REFERENCE_MISMATCH"));
test("a prior exit or resolution blocks a new closure", () => {
  for (const input of [exitContext(), regContext()]) {
    error(evaluate({ ...input, history: history({ exitIds: ["previous-exit"] }) }), "ALREADY_CLOSED");
    error(evaluate({ ...input, history: history({ regularizationIds: ["previous-resolution"] }) }), "ALREADY_REGULARIZED");
  }
});
test("known conflicts cannot be regularized away", () => {
  error(evaluate(regContext({ history: history({ conflicts: ["overlap"] }) })), "HISTORY_CONFLICT");
  error(evaluate(regContext({ state: open({ status: "needs_review", reviewReason: "history_conflict" }) })), "HISTORY_CONFLICT");
});

for (const [end, code] of [[later(0), "INVALID_TIME"], [later(-1), "INVALID_TIME"], [later(86401), "DURATION_EXCEEDED"]]) {
  test('accredited exit boundary ' + end.seconds, () => error(evaluate(regContext({ request: regularize({ mode: "accredited_exit", accreditedExitAt: end, evidenceReference: "Prueba ficticia" }) })), code));
}
test("future accredited exit is rejected even below 24 hours", () => {
  error(evaluate(regContext({ now: later(3600), request: regularize({ mode: "accredited_exit", accreditedExitAt: later(3601), evidenceReference: "Prueba ficticia" }) })), "INVALID_TIME");
});
test("accredited closing cannot overlap a later entry; equal boundaries remain valid", () => {
  const input = regContext({ request: regularize({ mode: "accredited_exit", accreditedExitAt: later(3600), evidenceReference: "Prueba ficticia" }) });
  error(evaluate({ ...input, history: history({ nextEntryAt: later(3599) }) }), "HISTORY_CONFLICT");
  assert.equal(evaluate({ ...input, history: history({ nextEntryAt: later(3600) }) }).ok, true);
  error(evaluate(regContext({ history: history({ nextEntryAt: later(7200) }) })), "HISTORY_CONFLICT");
});

for (const patch of [{ reason: " " }, { reason: "x".repeat(1001) }, { mode: "automatic" }, { originalEntryId: "" },
  { mode: "unknown_exit", accreditedExitAt: later(3600) }, { mode: "unknown_exit", evidenceReference: "conflicting" },
  { mode: "accredited_exit", accreditedExitAt: later(3600), evidenceReference: null },
  { mode: "accredited_exit", accreditedExitAt: later(3600), evidenceReference: "x".repeat(501) },
  { mode: "accredited_exit", accreditedExitAt: "2026-01-01T09:00:00+01:00", evidenceReference: "Prueba" },
  { mode: "accredited_exit", accreditedExitAt: { seconds: start.seconds, nanoseconds: 1e9 }, evidenceReference: "Prueba" }]) {
  test('regularization contract rejects ' + JSON.stringify(patch).slice(0, 100), () => error(validate(regularize(patch)), "INVALID_REQUEST"));
}
for (const patch of [{ requestId: "" }, { requestId: "predictable" }, { requestId: null }, { expectedStateVersion: -1 },
  { expectedStateVersion: "7" }, { expectedEpoch: 1.5 }, { expectedStateVersion: Number.MAX_SAFE_INTEGER }, { companyContext: "../other" },
  { role: "administrador" }, { userId: "someone-else" }, { minutosSesion: 300 }, { timestamp: start }]) {
  test('request contract rejects ' + JSON.stringify(patch), () => error(validate(request("clockIn", patch)), "INVALID_REQUEST"));
}
for (const invalid of [undefined, null, [], "x", 1, {}, { operation: "delete" }]) {
  test('malformed request ' + JSON.stringify(invalid), () => error(validate(invalid), "INVALID_REQUEST"));
}
test("non-object evaluator arguments return structured errors", () => {
  for (const invalid of [null, [], "x", 1]) error(evaluate(invalid), "INVALID_REQUEST");
  error(evaluate(), "INVALID_REQUEST");
});

test("normalization is semantic, stable across property order and UUID letter case", () => {
  const a = request("clockIn", { requestId: "abcdefab-abcd-4abc-8abc-abcdefabcdef" });
  const b = Object.fromEntries(Object.entries(a).reverse());
  b.requestId = b.requestId.toUpperCase();
  assert.equal(evaluate(context({ request: a })).plan.requestKey, evaluate(context({ request: b })).plan.requestKey);
  assert.equal(evaluate(context({ request: a })).plan.payloadFingerprint, evaluate(context({ request: b })).plan.payloadFingerprint);
});
test("stable IDs are scoped by company and actor, not by device time", () => {
  const a = evaluate(context());
  const b = evaluate(context({ now: later(7200) }));
  const c = evaluate(context({ actor: { ...actor, uid: "other-worker" }, state: { ...idle(), userId: "other-worker" } }));
  const d = evaluate(context({ actor: { ...actor, companyId: "other-company" }, state: { ...idle(), companyId: "other-company" },
    request: request("clockIn", { companyContext: "other-company" }), control: { ...context().control, companyId: "other-company" } }));
  assert.equal(a.plan.event.id, b.plan.event.id);
  assert.notEqual(a.plan.requestKey, c.plan.requestKey);
  assert.notEqual(a.plan.requestKey, d.plan.requestKey);
});
test("a committed receipt replays after time, mode, epoch and state version change without proposing writes", () => {
  const first = evaluate(context());
  const next = evaluate(context({ receipt: freeze(first.plan.receipt), state: null, now: later(7200),
    control: { ...context().control, writeMode: "paused", epoch: 4, minProtocolVersion: 2 } }));
  assert.equal(next.ok, true);
  assert.equal(next.replayed, true);
  assert.equal(next.plan, null);
  assert.deepEqual(next.result, first.result);
});
test("same request ID with different expected version or operation is a conflict", () => {
  const receipt = evaluate(context()).plan.receipt;
  error(evaluate(context({ receipt, request: request("clockIn", { expectedStateVersion: 8 }) })), "REQUEST_ID_CONFLICT");
  error(evaluate(exitContext({ receipt })), "REQUEST_ID_CONFLICT");
});
test("same regularization request ID cannot change reason, mode or accredited time", () => {
  const first = evaluate(regContext());
  for (const patch of [{ reason: "Otra razón" }, { mode: "accredited_exit", accreditedExitAt: later(3600), evidenceReference: "Otro parte" }])
    error(evaluate(regContext({ receipt: first.plan.receipt, request: regularize(patch) })), "REQUEST_ID_CONFLICT");
});
test("receipt from another actor or company never authorizes a replay", () => {
  const receipt = evaluate(context()).plan.receipt;
  for (const patch of [{ actorUid: "other-worker" }, { companyId: "other-company" }, { requestKey: "wrong" }, { result: {} }])
    error(evaluate(context({ receipt: { ...receipt, ...patch } })), "INVALID_RECEIPT");
});
test("replay still requires verified identity and administrator authorization", () => {
  const receipt = evaluate(regContext()).plan.receipt;
  error(evaluate(regContext({ receipt, actor: { ...admin, emailVerified: false } })), "EMAIL_NOT_VERIFIED");
  error(evaluate(regContext({ receipt, actor: { ...admin, role: "trabajador" } })), "FORBIDDEN");
});
test("a second device with a distinct request and stale version cannot produce another plan", () => {
  const first = evaluate(context());
  error(evaluate(context({ state: first.plan.nextState,
    request: request("clockIn", { requestId: "22222222-2222-4222-8222-222222222222" }) })), "VERSION_CONFLICT");
});
test("output mutation cannot mutate the input or a previously stored receipt", () => {
  const input = context();
  const first = evaluate(input);
  first.plan.nextState.companyId = "tampered";
  assert.equal(input.state.companyId, actor.companyId);
  const receipt = evaluate(regContext()).plan.receipt;
  const replay = evaluate(regContext({ receipt }));
  replay.result.exitAt = "tampered";
  assert.equal(receipt.result.exitAt, null);
});
test("all decisions are JSON-serializable and contain no BigInt or unresolved timestamps", () => {
  for (const input of [context(), exitContext(), regContext()]) {
    const result = evaluate(input);
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  }
});

test("ordinary event plans are compatible with phases 1/2 without modifying those modules", () => {
  const entryPlan = evaluate(context({ now: start }));
  const entry = entryPlan.plan.event;
  const s = entryPlan.plan.nextState;
  const closing = evaluate(exitContext({ state: s, request: request("clockOut", { expectedStateVersion: 8,
    requestId: "22222222-2222-4222-8222-222222222222" }), history: history({ entry }), now: later(3600) }));
  assert.equal(closing.ok, true);
  const records = [entry, closing.plan.event];
  const reconstructed = reconstructSessions(records, { now: later(7200) });
  assert.equal(reconstructed.canReconstruct, true);
  assert.equal(reconstructed.sessions[0].minutes, 60);
  const report = buildSharedReport(records, [{ id: actor.uid, companyId: actor.companyId }], { now: later(7200) });
  assert.equal(report.ready, true);
  assert.equal(report.period.knownMinutes, 60);
  assert.equal(report.inspectionRows[0].entradaLogId, entry.id);
  assert.equal(report.inspectionRows[0].salidaLogId, closing.plan.event.id);
});

test("DST uses elapsed instants, independently of repeated local hour labels", () => {
  for (const [begin, end] of [["2026-03-29T00:30:00Z", "2026-03-29T01:30:00Z"],
    ["2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z"]]) {
    const timestamp = at(begin);
    const r = evaluate(exitContext({ state: open({ openedAt: timestamp }), now: at(end),
      history: history({ entry: { ...history().entry, timestamp } }) }));
    assert.equal(r.ok, true);
    assert.equal(r.result.minutes, 60);
  }
});


test("accredited duration allows 24 hours exactly and rejects one extra nanosecond", () => {
  const known = (end) => regContext({ request: regularize({ mode: "accredited_exit", accreditedExitAt: end, evidenceReference: "Prueba ficticia" }) });
  assert.equal(evaluate(known(later(86400))).result.minutes, 1440);
  error(evaluate(known(later(86400, 1))), "DURATION_EXCEEDED");
});
test("nanosecond entry precision survives closure and phase-1 reconstruction", () => {
  const timestamp = later(0, 999999999);
  const r = evaluate(exitContext({ state: open({ openedAt: timestamp }), now: later(60, 999999998),
    history: history({ entry: { ...history().entry, timestamp } }) }));
  assert.equal(r.ok, true);
  assert.equal(r.result.minutes, 0);
  assert.deepEqual(r.plan.event.inicioSesion, timestamp);
  assert.equal(reconstructSessions([{ ...history().entry, timestamp }, r.plan.event]).canReconstruct, true);
});
test("receipts for ordinary exit and accredited regularization replay without new effects", () => {
  for (const input of [exitContext(), regContext({ request: regularize({ mode: "accredited_exit", accreditedExitAt: later(3600), evidenceReference: "Prueba ficticia" }) })]) {
    const first = evaluate(input);
    const replay = evaluate({ ...input, state: first.plan.nextState, now: later(86400 * 6), receipt: first.plan.receipt });
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.plan, null);
    assert.deepEqual(replay.result, first.result);
  }
});
test("malformed regularized state never unlocks the next session", () => {
  const resolved = evaluate(regContext()).plan.nextState;
  for (const patch of [{ minutes: 0 }, { exitAt: start }, { mode: "automatic" }, { regularizationId: "wrong-entry" }, { regularizedAt: null }]) {
    error(evaluate(context({ now: later(86400 * 6), state: { ...resolved, lastResolution: { ...resolved.lastResolution, ...patch } },
      request: request("clockIn", { expectedStateVersion: 8 }) })), "INVALID_STATE");
  }
});
test("regularization timestamp in the future does not unlock the next session", () => {
  const resolved = evaluate(regContext()).plan.nextState;
  error(evaluate(context({ state: resolved, now: later(86400 * 4), request: request("clockIn", { expectedStateVersion: 8 }) })), "INVALID_TIME");
});
test("tampered successful receipt result is rejected", () => {
  const receipt = evaluate(exitContext()).plan.receipt;
  for (const patch of [{ minutes: null }, { exitAt: null }, { status: "open" }, { stateVersion: 9 }, { eventId: "another-exit" }])
    error(evaluate(exitContext({ receipt: { ...receipt, result: { ...receipt.result, ...patch } } })), "INVALID_RECEIPT");
});

test("a supposedly confirmed later entry cannot have a timestamp in the future", () => {
  error(evaluate(regContext({ now: later(3600), history: history({ nextEntryAt: later(7200) }),
    request: regularize({ mode: "accredited_exit", accreditedExitAt: later(1800), evidenceReference: "Prueba ficticia" }) })), "HISTORY_CONFLICT");
});
