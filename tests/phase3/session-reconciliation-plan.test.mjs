import assert from "node:assert/strict";
import { test } from "node:test";
import { planSessionReconciliation as plan, PLANNING_DECISION } from "../../functions/src/session-reconciliation-plan.js";
import { DOMAIN_VERSION, inspectSessionState, evaluateSessionOperation } from "../../functions/src/session-domain.js";
import { buildSessionView } from "../../src/session-reporting.js";
import { reconstructSessions } from "../../src/session-reconstruction.js";
import { createHash } from "node:crypto";
import { buildReconciliationManifest as manifest, canonicalizeReconciliationValue as canonical,
  RECONCILIATION_ALGORITHM } from "../../functions/src/session-reconciliation-plan.js";

// Invented data only. No SDK, credentials, network, emulator or fixture writes.
const companyId = "fictional-company";
const userId = "fictional-worker";
const at = (seconds, nanoseconds = 0) => ({ seconds, nanoseconds });
const start = at(1_767_254_400, 123000);
const later = (seconds, nanoseconds = start.nanoseconds) => at(start.seconds + seconds, nanoseconds);
const profile = (id = userId) => ({ id, companyId, role: "trabajador" });
const entry = (id = "fictional-entry", uid = userId) => ({ id, companyId, userId: uid, tipo: "entrada", timestamp: start });
const exit = (extra = {}) => ({ id: "fictional-exit", companyId, userId, tipo: "salida",
  timestamp: later(3600), entradaLogId: "fictional-entry", inicioSesion: start, minutosSesion: 60, ...extra });
const idle = (extra = {}) => ({ schemaVersion: 1, companyId, userId, status: "idle", version: 0,
  activeEntryId: null, openedAt: null, reviewReason: null, lastResolution: null, lastRequestId: null, ...extra });
const fixture = (extra = {}) => ({ companyId, evaluatedAt: later(7200),
  complete: { profiles: true, logs: true, states: true, regularizations: true, requests: true },
  profiles: [profile()], logs: [], states: [], regularizations: [], requests: [], ...extra });
const one = input => plan(input).decisions.find(d => d.userId === userId);
const codes = decision => decision.diagnostics.map(d => d.code);
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test("complete empty history is eligible with an idle hint, not a stored state", () => {
  const decision = one(fixture());
  assert.equal(decision.decision, "eligible");
  assert.equal(decision.historyKind, "empty");
  assert.equal(decision.proposedStatus, "idle");
  assert.equal(decision.openEntryId, null);
  for (const field of ["nextState", "writes", "manifest", "digest", "requestId", "minutes"]) assert.equal(Object.hasOwn(decision, field), false);
});
test("an empty complete roster does not invent a worker", () => {
  assert.deepEqual(plan(fixture({ profiles: [] })).decisions, []);
});
test("administrator profiles are included in the same classification", () => {
  assert.equal(one(fixture({ profiles: [{ ...profile(), role: "administrador" }] })).decision, "eligible");
});
test("a referenced coherent closed session yields only an idle hint", () => {
  assert.equal(one(fixture({ logs: [entry(), exit()] })).historyKind, "closed");
  assert.equal(one(fixture({ logs: [entry(), exit()] })).proposedStatus, "idle");
});
test("a real zero-minute closed session remains eligible without changing its duration", () => {
  const input = fixture({ logs: [entry(), exit({ timestamp: later(30), minutosSesion: 0 })] });
  assert.equal(one(input).decision, "eligible"); assert.equal(input.logs[1].minutosSesion, 0);
});
test("an open entry retains its original ID and timestamp precision without inventing an exit", () => {
  const input = fixture({ logs: [entry()] }), before = structuredClone(input);
  assert.equal(one(input).proposedStatus, "open");
  assert.equal(one(input).openEntryId, "fictional-entry");
  assert.deepEqual(input, before); assert.equal(input.logs.length, 1);
});
for (const [seconds, nanos, status, kind] of [
  [86400, start.nanoseconds, "open", "open"],
  [86400, start.nanoseconds + 1, "needs_review", "overdue_open"],
]) test("fixed 24-hour boundary: " + nanos + " nanoseconds", () => {
  const d = one(fixture({ logs: [entry()], evaluatedAt: later(seconds, nanos) }));
  assert.equal(d.decision, "eligible"); assert.equal(d.proposedStatus, status); assert.equal(d.historyKind, kind);
});

for (const source of ["profiles", "logs", "states", "regularizations", "requests"]) {
  test("incomplete " + source + " never authorizes initialization", () => {
    const input = fixture(); input.complete[source] = false;
    const d = one(input); assert.equal(d.decision, "incomplete_source");
    assert.equal(d.proposedStatus, null); assert.ok(codes(d).includes("source_incomplete"));
  });
}
test("an incomplete reference load is not diagnosed as a confirmed orphan", () => {
  const input = fixture({ logs: [exit()] }); input.complete.logs = false;
  assert.equal(one(input).decision, "incomplete_source"); assert.equal(codes(one(input)).includes("entry_not_found"), false);
});
for (const [name, records, code] of [
  ["orphan exit", [exit()], "entry_not_found"],
  ["missing exit reference", [entry(), exit({ entradaLogId: undefined })], "missing_entry_reference"],
  ["duplicate ID", [entry(), entry()], "duplicate_id"],
  ["duplicate event", [entry(), entry("another-entry")], "possible_duplicate_event"],
  ["multiple exits", [entry(), exit(), exit({ id: "another-exit", timestamp: later(3700) })], "multiple_exits"],
  ["consecutive entries", [entry(), { ...entry("next-entry"), timestamp: later(4000) }], "consecutive_entries"],
  ["wrong minutes", [entry(), exit({ minutosSesion: 59 })], "session_minutes_mismatch"],
  ["invalid timestamp", [entry(), exit({ timestamp: null })], "invalid_fields"],
  ["future timestamp", [{ ...entry(), timestamp: later(7201) }], "future_timestamp"],
  ["wrong start", [entry(), exit({ inicioSesion: later(1) })], "session_start_mismatch"],
]) test(name + " is blocked rather than a fabricated needs_review state", () => {
  const d = one(fixture({ logs: records }));
  assert.equal(d.decision, "blocked"); assert.equal(d.proposedStatus, null); assert.equal(d.openEntryId, null);
  assert.ok(codes(d).includes(code)); assert.notEqual(d.proposedStatus, PLANNING_DECISION.BLOCKED);
});
test("cross-worker references block both the exit owner and target entry owner", () => {
  const other = "fictional-colleague";
  const output = plan(fixture({ profiles: [profile(), profile(other)], logs: [entry(), exit({ userId: other })] }));
  assert.equal(output.decisions.length, 2);
  for (const d of output.decisions) { assert.equal(d.decision, "blocked"); assert.ok(codes(d).includes("reference_scope_mismatch")); }
});
test("a foreign-company row is diagnosed, never silently filtered", () => {
  const d = one(fixture({ logs: [{ ...entry(), companyId: "fictional-foreign-company" }] }));
  assert.equal(d.decision, "blocked"); assert.ok(codes(d).includes("company_scope_mismatch"));
});
test("logs without a profile produce a blocked decision for their actual UID", () => {
  const d = one(fixture({ profiles: [], logs: [entry()] }));
  assert.equal(d.decision, "blocked"); assert.ok(codes(d).includes("profile_missing"));
});
test("unattributable logs prevent interpreting other empty histories as proven empty", () => {
  const input = fixture({ logs: [{ ...entry(), userId: undefined }] });
  assert.equal(one(input).decision, "blocked"); assert.ok(plan(input).diagnostics.some(d => d.code === "unattributed_log"));
});
for (const profileRow of [{ ...profile(), role: "intruder" }, { ...profile(), companyId: "fictional-other" }]) {
  test("invalid profile scope/role cannot be eligible: " + profileRow.role, () => {
    assert.equal(one(fixture({ profiles: [profileRow] })).decision, "blocked");
  });
}
test("duplicate profiles are not silently deduplicated", () => {
  const d = one(fixture({ profiles: [profile(), profile()] }));
  assert.equal(d.decision, "blocked"); assert.ok(codes(d).includes("duplicate_profile"));
});
for (const value of [" bad-id", "bad/id", "bad\\id", ".", "x".repeat(129)]) test("unsafe log identifier is not normalized: " + value.length, () => {
  const input = fixture({ logs: [entry(value)] });
  assert.equal(one(input).decision, "blocked"); assert.equal(input.logs[0].id, value);
});

test("existing evolved state and arbitrary metadata cannot replace missing backend trace", () => {
  const input = freeze(fixture({ states: [{ id: userId, data: idle({ version: 8, initializationId: "fictional-init", sourceDigest: "fictional-marker" }) }] }));
  const before = structuredClone(input), d = one(input);
  assert.equal(d.decision, "recovery_required"); assert.equal(d.proposedStatus, null);
  assert.ok(codes(d).includes("backend_version_trace_incomplete")); assert.deepEqual(input, before);
});
for (const patch of [{ status: "blocked" }, { version: -1 }, { userId: "fictional-other" }, { status: "needs_review" }]) {
  test("invalid existing state requires recovery: " + JSON.stringify(patch), () => {
    const input = fixture({ states: [{ id: userId, data: idle(patch) }] });
    const before = structuredClone(input), d = one(input);
    assert.equal(d.decision, "recovery_required"); assert.equal(d.proposedStatus, null); assert.deepEqual(input, before);
  });
}
test("duplicate state documents require recovery without choosing one", () => {
  assert.equal(one(fixture({ states: [{ id: userId, data: idle() }, { id: userId, data: idle() }] })).decision, "recovery_required");
});
test("existing state with raw history conflicts requires a separate reconciliation", () => {
  assert.equal(one(fixture({ states: [{ id: userId, data: idle() }], logs: [exit()] })).decision, "recovery_required");
});
test("a coherent existing open state keeps its identity and precise original anchor", () => {
  const input = freeze(fixture({ logs: [entry()], states: [{ id: userId,
    data: idle({ status: "open", activeEntryId: "fictional-entry", openedAt: start }) }] }));
  assert.equal(one(input).decision, "already_initialized");
  assert.equal(one(input).proposedStatus, null);
});
for (const records of [[], [entry(), exit()]]) test("an existing open state needs an actually open original: " + records.length, () => {
  const input = fixture({ logs: records, states: [{ id: userId,
    data: idle({ status: "open", activeEntryId: "fictional-entry", openedAt: start }) }] });
  assert.equal(one(input).decision, "recovery_required");
});
test("a one-nanosecond state/original discrepancy requires recovery without rounding", () => {
  const input = fixture({ logs: [entry()], states: [{ id: userId, data: idle({ status: "open",
    activeEntryId: "fictional-entry", openedAt: at(start.seconds, start.nanoseconds + 1) }) }] });
  assert.equal(one(input).decision, "recovery_required");
});
test("idle cannot silently conceal an unresolved open entry", () => {
  assert.equal(one(fixture({ logs: [entry()], states: [{ id: userId, data: idle() }] })).decision, "recovery_required");
});
test("an active entry with a prior resolution needs reconciliation, not reinitialization", () => {
  const input = fixture({ logs: [entry()], states: [{ id: userId,
    data: idle({ status: "open", activeEntryId: "fictional-entry", openedAt: start }) }],
  regularizations: [{ id: "fictional-entry", data: { companyId, workerUid: userId } }] });
  assert.equal(one(input).decision, "recovery_required");
});
test("a regularization without a state does not imply idle or a synthetic exit", () => {
  const input = fixture({ logs: [entry()], regularizations: [{ id: "fictional-entry", data: { companyId, workerUid: userId } }] });
  const before = structuredClone(input);
  assert.equal(one(input).decision, "recovery_required"); assert.deepEqual(input, before);
});
for (const operation of ["clockIn", "clockOut", "regularizeSession"]) test("receipt without state requires recovery: " + operation, () => {
  const d = one(fixture({ requests: [{ id: "fictional-receipt", data: {
    companyId, operation, actorUid: operation === "regularizeSession" ? "fictional-admin" : userId,
    ...(operation === "regularizeSession" ? { workerUid: userId } : {}),
  } }] }));
  assert.equal(d.decision, "recovery_required"); assert.ok(codes(d).includes("backend_history_without_state"));
});
test("unassignable backend artifacts prevent fresh initialization", () => {
  assert.equal(one(fixture({ requests: [{ id: "fictional-receipt", data: { companyId } }] })).decision, "recovery_required");
});
test("malformed state documents are not interpreted as absent", () => {
  assert.equal(one(fixture({ states: [{ id: userId, data: null }] })).decision, "recovery_required");
  assert.equal(one(fixture({ states: [null] })).decision, "recovery_required");
});
test("profile missing for an existing state requires recovery rather than overwriting", () => {
  assert.equal(one(fixture({ profiles: [], states: [{ id: userId, data: idle() }] })).decision, "recovery_required");
});

test("deterministic repeated evaluation preserves every original field", () => {
  const input = freeze(fixture({ logs: [{ ...entry(), extra: { untouched: ["fictional", 7] } }, exit()] }));
  const before = structuredClone(input), first = plan(input);
  for (let i = 0; i < 5; i++) assert.deepEqual(plan(input), first);
  assert.deepEqual(input, before);
  first.evaluatedAt.nanoseconds = 1; assert.equal(input.evaluatedAt.nanoseconds, start.nanoseconds);
});
test("the planner does not read wall clock or randomness", () => {
  const input = fixture({ logs: [entry()] }), dateNow = Date.now, random = Math.random;
  try {
    Date.now = () => { throw Error("wall clock forbidden"); };
    Math.random = () => { throw Error("randomness forbidden"); };
    assert.equal(one(input).decision, "eligible");
  } finally { Date.now = dateNow; Math.random = random; }
});
test("independent workers do not inherit another worker's attributable conflict", () => {
  const other = "fictional-colleague";
  const output = plan(fixture({ profiles: [profile(other), profile()], logs: [exit()] }));
  assert.equal(output.decisions.find(d => d.userId === other).decision, "eligible");
  assert.equal(output.decisions.find(d => d.userId === userId).decision, "blocked");
});
test("diagnostic source indexes identify the supplied invalid record", () => {
  const d = one(fixture({ logs: [entry(), exit({ timestamp: null })] }));
  const issue = d.diagnostics.find(x => x.code === "invalid_fields");
  assert.deepEqual(issue.recordIndexes, [1]); assert.deepEqual(issue.recordIds, ["fictional-exit"]);
  assert.deepEqual(issue.fields, ["timestamp"]);
});
for (const mutate of [
  input => { delete input.evaluatedAt; },
  input => { input.evaluatedAt = new Date(0); },
  input => { input.evaluatedAt.nanoseconds = 1e9; },
  input => { input.companyId = " unsafe "; },
  input => { delete input.complete.states; },
  input => { input.complete.logs = "true"; },
  input => { input.logs = null; },
  input => { input.logs = Array(1); },
  input => { input.unsupported = true; },
]) test("invalid explicit input contract is rejected: " + String(mutate), () => {
  const input = fixture(); mutate(input); assert.throws(() => plan(input), TypeError);
});

// 3.7.2: additions below retain the 69 existing 3.7.1 test cases unchanged.
const initialFields = ["schemaVersion", "companyId", "userId", "status", "version",
  "activeEntryId", "openedAt", "reviewReason", "lastResolution", "lastRequestId"].sort();
function assertInitialState(input, expected) {
  const decision = one(input), proposed = decision.proposedState;
  assert.equal(decision.decision, "eligible");
  assert.deepEqual(Object.keys(proposed).sort(), initialFields);
  assert.deepEqual(proposed, idle(expected));
  const checked = inspectSessionState(proposed, input.evaluatedAt);
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.state, proposed);
  assert.equal(proposed.schemaVersion, DOMAIN_VERSION);
  assert.equal(proposed.version, 0);
  return decision;
}
test("3.7.2 complete empty history produces the exact initial idle DTO", () => {
  assertInitialState(freeze(fixture()), {});
});
test("3.7.2 fully closed referenced history produces idle without copying historical minutes", () => {
  const input = freeze(fixture({ logs: [entry(), exit()] }));
  const before = structuredClone(input);
  assertInitialState(input, {});
  assert.deepEqual(input, before);
});
test("3.7.2 one open entry produces a complete open DTO with original ID and instant", () => {
  const input = freeze(fixture({ logs: [entry()] }));
  assertInitialState(input, { status: "open", activeEntryId: "fictional-entry", openedAt: start });
});
test("3.7.2 overdue entry produces needs_review/overdue without resolving the original", () => {
  const input = freeze(fixture({ logs: [entry()], evaluatedAt: later(86401) }));
  const before = structuredClone(input);
  assertInitialState(input, { status: "needs_review", activeEntryId: "fictional-entry",
    openedAt: start, reviewReason: "overdue" });
  assert.deepEqual(input, before); assert.equal(input.logs.length, 1);
});
for (const [offset, delta, expectedStatus] of [
  [86400, -1, "open"], [86400, 0, "open"], [86400, 1, "needs_review"],
]) test("3.7.2 exact age boundary maps full state: " + delta + " nanoseconds", () => {
  const input = fixture({ logs: [entry()], evaluatedAt: later(offset, start.nanoseconds + delta) });
  assertInitialState(input, { status: expectedStatus, activeEntryId: "fictional-entry", openedAt: start,
    reviewReason: expectedStatus === "needs_review" ? "overdue" : null });
});
test("3.7.2 proposal preserves all original nanoseconds in a detached timestamp DTO", () => {
  const original = at(start.seconds, 123456789);
  const input = freeze(fixture({ logs: [{ ...entry(), timestamp: original }] }));
  const proposed = one(input).proposedState;
  assert.deepEqual(proposed.openedAt, original); assert.notEqual(proposed.openedAt, original);
  proposed.openedAt.nanoseconds = 0; assert.equal(original.nanoseconds, 123456789);
  assert.equal(one(input).proposedState.openedAt.nanoseconds, 123456789);
});
for (const milliseconds of [1767254400123, -1]) test("3.7.2 legacy Date instant is preserved without mutating it: " + milliseconds, () => {
  const original = new Date(milliseconds);
  const evaluatedAt = milliseconds < 0 ? at(0) : later(7200);
  const input = fixture({ logs: [{ ...entry(), timestamp: original }], evaluatedAt });
  const before = structuredClone(input), proposed = one(input).proposedState;
  assert.equal(inspectSessionState(proposed, evaluatedAt).ok, true);
  const ns = BigInt(proposed.openedAt.seconds) * 1_000_000_000n + BigInt(proposed.openedAt.nanoseconds);
  assert.equal(ns, BigInt(milliseconds) * 1_000_000n);
  assert.deepEqual(input, before); assert.equal(original.getTime(), milliseconds);
});
test("3.7.2 domain validation blocks a legacy Date outside the supported timestamp range", () => {
  // The reconstructor accepts finite Dates; the actual state contract has tighter bounds.
  const original = new Date(-62135596800001);
  const input = fixture({ logs: [{ ...entry(), timestamp: original }] });
  const before = structuredClone(input), decision = one(input);
  assert.equal(decision.decision, "blocked"); assert.equal(decision.proposedState, null);
  const issue = decision.diagnostics.find(d => d.code === "invalid_initial_state_proposal");
  assert.equal(issue.domainCode, "INVALID_STATE"); assert.deepEqual(issue.recordIds, ["fictional-entry"]);
  assert.deepEqual(input, before);
});
test("3.7.2 valid closed zero-minute history stays idle without inventing any duration field", () => {
  const input = freeze(fixture({ logs: [entry(), exit({ timestamp: later(30), minutosSesion: 0 })] }));
  const proposed = assertInitialState(input, {}).proposedState;
  assert.equal(Object.hasOwn(proposed, "minutes"), false);
  assert.equal(Object.hasOwn(proposed, "minutosSesion"), false);
  assert.equal(input.logs[1].minutosSesion, 0);
});
test("3.7.2 closed legacy history missing saved minutes is not enriched in place", () => {
  const closed = exit(); delete closed.minutosSesion;
  const input = freeze(fixture({ logs: [entry(), closed] }));
  assertInitialState(input, {}); assert.equal(Object.hasOwn(closed, "minutosSesion"), false);
});
test("3.7.2 daily allocation ambiguity does not reopen a coherent closed session", () => {
  const begin = at(Date.parse("2026-07-31T21:59:30Z") / 1000);
  const end = at(Date.parse("2026-07-31T22:01:30Z") / 1000);
  const input = freeze(fixture({ logs: [{ ...entry(), timestamp: begin },
    exit({ timestamp: end, inicioSesion: begin, minutosSesion: 2 })],
  evaluatedAt: at(Date.parse("2026-08-02T00:00:00Z") / 1000) }));
  const reportView = buildSessionView(input.logs, { now: input.evaluatedAt });
  assert.equal(reportView.compatible, false);
  assert.ok(reportView.issues.some(d => d.code === "daily_allocation_ambiguous"));
  assertInitialState(input, {});
});
for (const source of ["profiles", "logs", "states", "regularizations", "requests"]) {
  test("3.7.2 incomplete " + source + " has no complete state proposal", () => {
    const input = fixture(); input.complete[source] = false;
    const decision = one(input);
    assert.equal(decision.decision, "incomplete_source"); assert.equal(decision.proposedState, null);
  });
}
for (const records of [[exit()], [entry(), entry()], [entry(), exit({ minutosSesion: 59 })],
  [entry(), { ...entry("later-entry"), timestamp: later(1) }]]) {
  test("3.7.2 ambiguous history has no persistible proposal: " + records.map(r => r.id).join(","), () => {
    const decision = one(fixture({ logs: records }));
    assert.equal(decision.decision, "blocked"); assert.equal(decision.proposedState, null);
  });
}
for (const stored of [idle({ version: 8 }), idle({ status: "blocked" }), idle({ version: -1 }),
  idle({ status: "open", activeEntryId: "missing-original", openedAt: start, version: 12 })]) {
  test("3.7.2 existing state is never proposed for replacement: " + stored.status + "/" + stored.version, () => {
    const input = freeze(fixture({ states: [{ id: userId, data: stored }] }));
    const before = structuredClone(input), decision = one(input);
    assert.ok(["already_initialized", "recovery_required"].includes(decision.decision));
    assert.equal(decision.proposedState, null); assert.deepEqual(input, before);
  });
}
test("3.7.2 an existing open state with version >0 and missing trace is not reset or replaced", () => {
  const stored = idle({ status: "open", activeEntryId: "fictional-entry", openedAt: start, version: 27 });
  const input = freeze(fixture({ logs: [entry()], states: [{ id: userId, data: stored }] }));
  assert.equal(one(input).decision, "recovery_required"); assert.equal(one(input).proposedState, null);
  assert.equal(stored.version, 27);
});
test("3.7.2 backend history without state cannot receive a fresh version zero", () => {
  const input = fixture({ requests: [{ id: "fictional-receipt", data: { companyId, operation: "clockIn", actorUid: userId } }] });
  const decision = one(input);
  assert.equal(decision.decision, "recovery_required"); assert.equal(decision.proposedState, null);
});
test("3.7.2 multi-person mapping uses only supplied identities and isolates blocked people", () => {
  const other = "fictional-colleague";
  const input = freeze(fixture({ profiles: [profile(other), profile()], logs: [entry("other-entry", other), exit()] }));
  const output = plan(input);
  const valid = output.decisions.find(d => d.userId === other), blocked = output.decisions.find(d => d.userId === userId);
  assert.equal(valid.proposedState.userId, other); assert.equal(valid.proposedState.activeEntryId, "other-entry");
  assert.equal(valid.proposedState.companyId, companyId); assert.equal(valid.proposedState.version, 0);
  assert.equal(blocked.decision, "blocked"); assert.equal(blocked.proposedState, null);
});
test("3.7.2 complete proposals are deterministic and leave all source collections intact", () => {
  const input = freeze(fixture({ logs: [{ ...entry(), extra: { keep: [1, "fictional"] } }] }));
  const before = structuredClone(input), expected = plan(input);
  for (let i = 0; i < 5; i++) assert.deepEqual(plan(input), expected);
  assert.deepEqual(input, before);
  expected.decisions[0].proposedState.openedAt.seconds = 0;
  assert.equal(input.logs[0].timestamp.seconds, start.seconds);
  assert.equal(one(input).proposedState.openedAt.seconds, start.seconds);
});
test("3.7.2 new state proposals use only the explicit evaluation instant", () => {
  const input = fixture({ logs: [entry()] }), dateNow = Date.now, random = Math.random;
  try {
    Date.now = () => { throw Error("wall clock forbidden"); };
    Math.random = () => { throw Error("randomness forbidden"); };
    assertInitialState(input, { status: "open", activeEntryId: "fictional-entry", openedAt: start });
  } finally { Date.now = dateNow; Math.random = random; }
});

// 3.7.3: original 101 cases above are retained; all data below is fictitious.
const manifestSources = ["profiles", "logs", "states", "regularizations", "requests"];
const declaration = input => Object.fromEntries(manifestSources.map(source => [source,
  { kind: "caller_declaration", reference: "fictional-snapshot/" + source, complete: input.complete[source] }]));
const makeManifest = input => manifest(input, declaration(input));
const digestPattern = /^[a-f0-9]{64}$/;

test("3.7.3 complete manifest binds proposals, inventory, declarations and versions", () => {
  const input = freeze(fixture({ logs: [entry()] }));
  const result = makeManifest(input);
  assert.equal(result.schemaVersion, 1); assert.equal(result.algorithmVersion, RECONCILIATION_ALGORITHM);
  assert.equal(result.domainSchemaVersion, DOMAIN_VERSION); assert.equal(result.plannerContractVersion, 1);
  assert.equal(result.companyId, companyId); assert.deepEqual(result.evaluatedAt, input.evaluatedAt);
  assert.equal(result.applicable, true); assert.equal(result.productionAuthorized, false);
  assert.equal(result.scope, "in_memory_review_only"); assert.match(result.planDigest, digestPattern);
  for (const source of manifestSources) {
    assert.match(result.sourceDigests[source], digestPattern);
    assert.equal(result.inventory[source].count, input[source].length);
    assert.equal(result.completeness[source].declaredComplete, true);
    assert.equal(result.completeness[source].evidenceValid, true);
  }
  assert.equal(result.inventory.logs.documents[0].path, "logs/fictional-entry");
  assert.equal(result.planning.decisions[0].proposedState.activeEntryId, "fictional-entry");
  const { planDigest, ...body } = result;
  assert.equal(planDigest, createHash("sha256").update(RECONCILIATION_ALGORITHM + "\n" + canonical(body)).digest("hex"));
});

function permutationFixture() {
  const other = "fictional-colleague";
  return fixture({ profiles: [profile(other), profile()],
    logs: [entry(), exit({ minutosSesion: 59 }), entry("colleague-entry", other)],
    states: [{ id: userId, data: idle() }, { id: other, data: idle() }],
    regularizations: [userId, other].map(uid => ({ id: uid + "-resolution", data: { companyId, workerUid: uid } })),
    requests: [userId, other].map(uid => ({ id: uid + "-receipt", data: { companyId, actorUid: uid, operation: "clockIn" } })) });
}
test("3.7.3 permutations of every source yield byte-identical manifests including diagnostic indexes", () => {
  const input = permutationFixture(), expected = makeManifest(freeze(structuredClone(input)));
  for (const source of manifestSources) {
    const reversed = structuredClone(input); reversed[source].reverse();
    assert.equal(JSON.stringify(makeManifest(reversed)), JSON.stringify(expected));
  }
  const all = structuredClone(input); for (const source of manifestSources) all[source].reverse();
  assert.deepEqual(makeManifest(all), expected);
  assert.equal(expected.applicable, false);
  assert.ok(expected.planning.decisions.some(d => d.decision === "recovery_required"));
});

for (const source of manifestSources) test("3.7.3 any field change in " + source + " changes source/global digest", () => {
  const input = permutationFixture(), original = makeManifest(input), changed = structuredClone(input);
  changed[source][0].previouslyUnknownField = { fictional: "changed", flags: [true, null, 5] };
  const result = makeManifest(changed);
  assert.notEqual(result.sourceDigests[source], original.sourceDigests[source]);
  assert.notEqual(result.planDigest, original.planDigest);
  for (const other of manifestSources.filter(s => s !== source)) assert.equal(result.sourceDigests[other], original.sourceDigests[other]);
});

for (const source of manifestSources) test("3.7.3 repeated identifiers in " + source + " are retained and block applicability", () => {
  const input = permutationFixture(); input[source].push(structuredClone(input[source][0]));
  const result = makeManifest(input), reversed = structuredClone(input); reversed[source].reverse();
  assert.equal(result.inventory[source].count, input[source].length);
  assert.equal(result.inventory[source].documents.length, input[source].length);
  assert.ok(result.diagnostics.some(d => d.code === "duplicate_document_path" && d.source === source));
  assert.equal(result.applicable, false); assert.deepEqual(makeManifest(reversed), result);
  const withoutDuplicate = structuredClone(input); withoutDuplicate[source].pop();
  assert.notEqual(result.sourceDigests[source], makeManifest(withoutDuplicate).sourceDigests[source]);
});

test("3.7.3 conflicting duplicate payloads use canonical content as a stable tie-breaker", () => {
  const input = fixture({ logs: [entry(), { ...entry(), timestamp: later(1) }] });
  const result = makeManifest(input); input.logs.reverse();
  assert.deepEqual(makeManifest(input), result); assert.equal(result.applicable, false);
  assert.notEqual(result.inventory.logs.documents[0].digest, result.inventory.logs.documents[1].digest);
});

test("3.7.3 canonical object property ordering does not depend on insertion order", () => {
  assert.equal(canonical({ z: [null, { b: 2, a: 1 }], a: true }), canonical({ a: true, z: [null, { a: 1, b: 2 }] }));
  const a = fixture({ logs: [entry()] }), b = structuredClone(a);
  b.logs[0] = Object.fromEntries(Object.entries(b.logs[0]).reverse());
  assert.deepEqual(makeManifest(a), makeManifest(b));
});

test("3.7.3 scalar types, absence, null, Date, timestamp DTO and negative zero never alias", () => {
  const values = [{}, { x: null }, { x: 0 }, { x: -0 }, { x: "0" }, { x: false },
    { x: [] }, { x: {} }, { x: new Date(0) }, { x: at(0) }];
  assert.equal(new Set(values.map(canonical)).size, values.length);
  const digests = values.map(extra => makeManifest(fixture({ logs: [{ ...entry(), extra }] })).planDigest);
  assert.equal(new Set(digests).size, values.length);
});

test("3.7.3 array order is significant at every nesting depth", () => {
  const a = fixture({ logs: [{ ...entry(), extra: { list: [1, "x", null] } }] });
  const b = structuredClone(a); b.logs[0].extra.list.reverse();
  assert.notEqual(makeManifest(a).sourceDigests.logs, makeManifest(b).sourceDigests.logs);
  assert.notEqual(makeManifest(a).planDigest, makeManifest(b).planDigest);
});

test("3.7.3 one original nanosecond changes both source and plan digests", () => {
  const a = fixture({ logs: [entry()] }), b = structuredClone(a);
  b.logs[0].timestamp.nanoseconds++;
  assert.notEqual(makeManifest(a).sourceDigests.logs, makeManifest(b).sourceDigests.logs);
  assert.notEqual(makeManifest(a).planDigest, makeManifest(b).planDigest);
  assert.equal(makeManifest(b).planning.decisions[0].proposedState.openedAt.nanoseconds, start.nanoseconds + 1);
});

test("3.7.3 explicit evaluation instant affects global digest but not source digests", () => {
  const a = fixture(), b = structuredClone(a); b.evaluatedAt.nanoseconds++;
  assert.deepEqual(makeManifest(a).sourceDigests, makeManifest(b).sourceDigests);
  assert.notEqual(makeManifest(a).planDigest, makeManifest(b).planDigest);
});

for (const source of manifestSources) test("3.7.3 incomplete " + source + " changes digest and blocks the plan", () => {
  const input = fixture(), before = makeManifest(input); input.complete[source] = false;
  const result = makeManifest(input);
  assert.equal(result.applicable, false); assert.notEqual(result.planDigest, before.planDigest);
  assert.ok(result.diagnostics.some(d => d.code === "source_incomplete" && d.source === source));
  assert.equal(result.planning.decisions[0].decision, "incomplete_source");
  assert.equal(result.planning.decisions[0].proposedState, null);
});

test("3.7.3 absence of evidence cannot certify a complete source", () => {
  const result = manifest(fixture());
  assert.equal(result.applicable, false); assert.match(result.planDigest, digestPattern);
  assert.equal(result.diagnostics.filter(d => d.code === "completeness_evidence_missing_or_mismatched").length, 5);
});

test("3.7.3 evidence reference and mismatched declaration affect the global digest", () => {
  const input = fixture(), evidence = declaration(input), initial = manifest(input, evidence);
  evidence.logs.reference = "fictional-snapshot/revised";
  const changed = manifest(input, evidence); assert.notEqual(changed.planDigest, initial.planDigest);
  evidence.logs.complete = false;
  assert.equal(manifest(input, evidence).applicable, false);
});

for (const [name, value] of [["undefined", undefined], ["NaN", NaN], ["infinity", Infinity],
  ["bigint", 1n], ["function", () => 1], ["symbol", Symbol("fictional")],
  ["invalid date", new Date(NaN)], ["map", new Map()], ["set", new Set()],
  ["typed array", new Uint8Array([1])], ["sparse array", Array(1)]]) {
  test("3.7.3 unsupported " + name + " is diagnosed without claiming a digest or applicability", () => {
    const input = fixture({ logs: [{ ...entry(), extra: value }] });
    const result = makeManifest(input);
    assert.equal(result.applicable, false); assert.equal(result.sourceDigests.logs, null);
    assert.equal(result.planDigest, null); assert.equal(result.planning, null);
    assert.ok(result.diagnostics.some(d => d.code === "non_representable_source" && d.source === "logs"));
    assert.equal(result.inventory.logs.count, 1);
  });
}

test("3.7.3 accessors, hidden properties, symbol keys and cycles are not read or discarded", () => {
  let reads = 0;
  const getter = {}; Object.defineProperty(getter, "value", { enumerable: true, get() { reads++; throw Error("must not run"); } });
  const hidden = {}; Object.defineProperty(hidden, "value", { value: 3 });
  const symbolic = { [Symbol("fictional")]: 3 };
  const cycle = {}; cycle.self = cycle;
  for (const extra of [getter, hidden, symbolic, cycle]) {
    const result = makeManifest(fixture({ logs: [{ ...entry(), extra }] }));
    assert.equal(result.planDigest, null); assert.equal(result.applicable, false);
  }
  assert.equal(reads, 0);
});

test("3.7.3 no toJSON invocation or unsupported custom prototype coercion", () => {
  let calls = 0;
  const extra = { toJSON() { calls++; return null; } };
  assert.equal(makeManifest(fixture({ logs: [{ ...entry(), extra }] })).planDigest, null);
  assert.equal(calls, 0);
  assert.throws(() => canonical(Object.create({ inherited: 7 })), TypeError);
});

test("3.7.3 extra array properties and decorated Dates cannot be silently discarded", () => {
  const arr = [1]; arr.extra = true;
  const date = new Date(0); date.extra = true;
  for (const extra of [arr, date]) assert.equal(makeManifest(fixture({ logs: [{ ...entry(), extra }] })).planDigest, null);
});

test("3.7.3 repeated shared references are values, not cycles, and preserve input immutability", () => {
  const shared = { fictional: [null, 1, true] };
  const input = freeze(fixture({ logs: [{ ...entry(), extra: { a: shared, b: shared } }] }));
  const evidence = freeze(declaration(input)), before = structuredClone(input);
  const first = manifest(input, evidence);
  for (let i = 0; i < 5; i++) assert.equal(JSON.stringify(manifest(input, evidence)), JSON.stringify(first));
  assert.deepEqual(input, before);
  first.evaluatedAt.seconds = 0; first.planning.decisions[0].proposedState.openedAt.seconds = 0;
  first.inventory.logs.documents[0].id = "mutated-output";
  assert.deepEqual(input, before); assert.equal(manifest(input, evidence).applicable, true);
});

test("3.7.3 invalid identifiers retain documents and source digests while blocking planning", () => {
  const input = fixture({ logs: [entry("invalid/path"), entry("invalid/path")] });
  const result = makeManifest(input);
  assert.equal(result.inventory.logs.count, 2); assert.match(result.sourceDigests.logs, digestPattern);
  assert.equal(result.inventory.logs.documents[0].path, null); assert.equal(result.applicable, false);
});

test("3.7.3 unsupported evidence fails closed without executing accessors", () => {
  const evidence = declaration(fixture());
  Object.defineProperty(evidence.logs, "reference", { enumerable: true, get() { throw Error("forbidden"); } });
  const result = manifest(fixture(), evidence);
  assert.equal(result.applicable, false); assert.equal(result.planDigest, null);
  assert.ok(result.diagnostics.some(d => d.code === "invalid_completeness_evidence"));
});

test("3.7.3 manifest hashing never consults clock or randomness", () => {
  const input = fixture(), evidence = declaration(input), now = Date.now, random = Math.random;
  try {
    Date.now = () => { throw Error("forbidden"); }; Math.random = () => { throw Error("forbidden"); };
    assert.match(manifest(input, evidence).planDigest, digestPattern);
  } finally { Date.now = now; Math.random = random; }
});

test("3.7.3 fixed encoding vectors make the typed wire format explicit", () => {
  assert.equal(canonical(null), '["null"]');
  assert.equal(canonical(-0), '["number","-0"]');
  assert.equal(canonical(new Date(-1)), '["date","-1"]');
  assert.equal(canonical({ seconds: 7, nanoseconds: 123456789 }),
    '["object",[["nanoseconds",["number","123456789"]],["seconds",["number","7"]]]]');
});

test("3.7.3 header and evidence object key order do not change serialized manifests", () => {
  const input = fixture({ logs: [entry()] }), original = makeManifest(input);
  input.evaluatedAt = { nanoseconds: input.evaluatedAt.nanoseconds, seconds: input.evaluatedAt.seconds };
  input.complete = Object.fromEntries(Object.entries(input.complete).reverse());
  const evidence = Object.fromEntries(Object.entries(declaration(input)).reverse()
    .map(([source, row]) => [source, Object.fromEntries(Object.entries(row).reverse())]));
  assert.equal(JSON.stringify(manifest(input, evidence)), JSON.stringify(original));
});

for (const source of manifestSources) test("3.7.3 unrepresentable data in " + source + " blocks the entire manifest", () => {
  const input = permutationFixture(); input[source][0].unsupported = undefined;
  const result = makeManifest(input);
  assert.equal(result.sourceDigests[source], null); assert.equal(result.planDigest, null);
  assert.equal(result.planning, null); assert.equal(result.applicable, false);
  assert.equal(result.inventory[source].count, input[source].length);
});

test("3.7.3 excessive nesting is diagnosed deterministically without overflow", () => {
  let extra = null; for (let i = 0; i < 260; i++) extra = { nested: extra };
  const input = fixture({ logs: [{ ...entry(), extra }] });
  const result = makeManifest(input);
  assert.equal(result.planDigest, null);
  assert.ok(result.diagnostics.some(d => d.code === "non_representable_source"));
});

test("3.7.3 identical identifiers in different sources have distinct logical paths", () => {
  const input = fixture({ logs: [entry(userId)] });
  const result = makeManifest(input);
  assert.equal(result.inventory.profiles.documents[0].path, "profiles/" + userId);
  assert.equal(result.inventory.logs.documents[0].path, "logs/" + userId);
  assert.equal(result.applicable, true);
  assert.equal(result.diagnostics.some(d => d.code === "duplicate_document_path"), false);
});

test("3.7.3 a non-data envelope is rejected without evaluating its getter", () => {
  const input = fixture();
  Object.defineProperty(input, "logs", { enumerable: true, get() { throw Error("must not execute"); } });
  assert.throws(() => makeManifest(input), TypeError);
});

test("3.7.3 invalid but representable evidence remains fully bound instead of being discarded", () => {
  const input = fixture(), evidence = declaration(input);
  evidence.unexpectedSource = { fictional: 1 };
  const first = manifest(input, evidence);
  assert.equal(first.applicable, false);
  assert.equal(first.completenessEvidence, canonical(evidence));
  evidence.unexpectedSource.fictional = 2;
  assert.notEqual(manifest(input, evidence).planDigest, first.planDigest);
});

// 3.7.4: trace fixtures are generated by the real pure domain, never a service.
function backendFixture(operations = ["clockIn", "clockOut"], mode = "unknown_exit", bootstrap = false) {
  const input = fixture({ profiles: [profile(), { ...profile("fictional-admin"), role: "administrador" }] });
  let state = idle(), time = start;
  if (bootstrap) {
    input.logs.push(entry());
    state = idle({ status: "open", activeEntryId: "fictional-entry", openedAt: start });
  }
  for (const [i, operation] of operations.entries()) {
    const isReg = operation === "regularizeSession";
    time = at(time.seconds + (isReg ? 86401 : 3600), time.nanoseconds);
    const request = { operation, requestId: "00000000-0000-4000-8000-" + String(i + 1).padStart(12, "0"),
      companyContext: companyId, expectedStateVersion: state.version, expectedEpoch: 1, protocolVersion: 1 };
    if (isReg) Object.assign(request, { originalEntryId: state.activeEntryId, mode,
      reason: "Fictional review only", evidenceReference: mode === "unknown_exit" ? null : "fictional-evidence",
      accreditedExitAt: mode === "unknown_exit" ? null : at(state.openedAt.seconds + 3600, state.openedAt.nanoseconds) });
    const actor = { uid: isReg ? "fictional-admin" : userId, companyId,
      role: isReg ? "administrador" : "trabajador", emailVerified: true };
    const history = { complete: true, entry: input.logs.find(log => log.id === state.activeEntryId),
      exitIds: [], regularizationIds: [], nextEntryAt: null, conflicts: [] };
    const decision = evaluateSessionOperation({ request, actor, state, now: time,
      control: { companyId, writeMode: "backend", epoch: 1, minProtocolVersion: 1 }, history });
    assert.equal(decision.ok, true, JSON.stringify(decision));
    const { type, id: eventId, ...data } = decision.plan.event;
    if (isReg) input.regularizations.push({ id: eventId, data });
    else input.logs.push({ id: eventId, ...data });
    input.requests.push({ id: decision.plan.requestKey, data: { ...decision.plan.receipt, workerUid: userId } });
    state = decision.plan.nextState;
  }
  input.states.push({ id: userId, data: state });
  input.evaluatedAt = at(time.seconds + 1, time.nanoseconds);
  return input;
}
const workerState = input => input.states.find(s => s.id === userId).data;
function assertPreserved(input, expected, kind = undefined) {
  const before = structuredClone(input), decision = one(input);
  assert.equal(decision.decision, expected);
  assert.equal(decision.proposedState, null); assert.equal(decision.proposedStatus, null);
  if (kind) assert.equal(decision.existingStateKind, kind);
  assert.deepEqual(input, before);
  return decision;
}

test("3.7.4 coherent initial idle state is preserved and distinguished from evolved state", () => {
  assertPreserved(freeze(fixture({ states: [{ id: userId, data: idle() }] })), "already_initialized", "initialized");
});
test("3.7.4 coherent initial open state retains exact original anchor", () => {
  assertPreserved(freeze(fixture({ logs: [entry()], states: [{ id: userId,
    data: idle({ status: "open", activeEntryId: "fictional-entry", openedAt: start }) }] })), "already_initialized", "initialized");
});
test("3.7.4 initial needs_review/overdue is preserved without a synthetic resolution", () => {
  assertPreserved(freeze(fixture({ evaluatedAt: later(86401), logs: [entry()], states: [{ id: userId,
    data: idle({ status: "needs_review", activeEntryId: "fictional-entry", openedAt: start, reviewReason: "overdue" }) }] })), "already_initialized", "initialized");
});
test("3.7.4 overdue projection is diagnosed but never written into the stored open state", () => {
  const input = freeze(fixture({ evaluatedAt: later(86401), logs: [entry()], states: [{ id: userId,
    data: idle({ status: "open", activeEntryId: "fictional-entry", openedAt: start }) }] }));
  assert.ok(codes(assertPreserved(input, "already_initialized")).includes("existing_overdue_projection_not_persisted"));
  assert.equal(workerState(input).status, "open");
});
for (const reason of ["overdue", "manual_review", "history_conflict"]) test("3.7.4 unsupported initial review is not certified: " + reason, () => {
  const input = freeze(fixture({ logs: [entry()], states: [{ id: userId,
    data: idle({ status: "needs_review", activeEntryId: "fictional-entry", openedAt: start, reviewReason: reason }) }] }));
  assertPreserved(input, "recovery_required");
});

for (const operations of [["clockIn"], ["clockIn", "clockOut"], ["clockIn", "clockOut", "clockIn"],
  ["clockIn", "clockOut", "clockIn", "clockOut"]]) test("3.7.4 real domain trace verifies evolved " + operations.join("/"), () => {
  const input = freeze(backendFixture(operations));
  assertPreserved(input, "already_initialized", "evolved");
});
test("3.7.4 first backend exit can close a real legacy bootstrap anchor", () => {
  assertPreserved(freeze(backendFixture(["clockOut"], "unknown_exit", true)), "already_initialized", "evolved");
});
for (const mode of ["unknown_exit", "accredited_exit"]) test("3.7.4 coherent regularized state retains logs and real resolution: " + mode, () => {
  const input = freeze(backendFixture(["clockIn", "regularizeSession"], mode));
  assertPreserved(input, "already_initialized", "evolved");
  assert.equal(input.logs.length, 1); assert.equal(input.logs[0].tipo, "entrada");
});
test("3.7.4 evolved overdue open state remains preserved", () => {
  const input = backendFixture(["clockIn"]); input.evaluatedAt.seconds += 86401;
  workerState(input).status = "needs_review"; workerState(input).reviewReason = "overdue";
  assertPreserved(freeze(input), "already_initialized", "evolved");
});

for (const mutate of [
  input => { input.requests = []; },
  input => { workerState(input).lastRequestId = null; },
  input => { workerState(input).version++; },
  input => { input.requests[0].data.result.stateVersion = 9; },
  input => { input.requests[0].data.requestKey = "a".repeat(64); },
  input => { input.requests[0].data.payloadFingerprint = "not-a-digest"; },
  input => { input.requests[0].data.requestId = "invalid-request"; },
  input => { input.requests[0].data.result.status = "idle"; },
  input => { input.requests[0].data.result.eventId = "missing-event"; },
  input => { input.requests[0].data.result.originalEntryId = "missing-entry"; },
  input => { input.requests[0].data.actorUid = "fictional-other"; },
  input => { workerState(input).lastRequestId = "00000000-0000-4000-8000-999999999999"; },
]) test("3.7.4 missing or contradictory backend trace blocks recovery: " + String(mutate), () => {
  const input = backendFixture(["clockIn"]); mutate(input);
  assertPreserved(freeze(input), "recovery_required");
});

test("3.7.4 version-zero state cannot conceal a domain backend event without receipt", () => {
  const input = backendFixture(["clockIn"]); input.requests = [];
  workerState(input).version = 0; workerState(input).lastRequestId = null;
  assert.ok(codes(assertPreserved(freeze(input), "recovery_required")).includes("backend_event_receipt_missing"));
});
test("3.7.4 arbitrary initialization markers do not prove an evolved version", () => {
  const input = fixture({ states: [{ id: userId, data: idle({ version: 7,
    initializationId: "fictional-unverified", sourceDigest: "a".repeat(64) }) }] });
  assertPreserved(freeze(input), "recovery_required", "unverified");
});

for (const source of ["states", "requests", "regularizations"]) test("3.7.4 duplicate " + source + " requires recovery and remains in inventory", () => {
  const input = backendFixture(["clockIn", "regularizeSession"]);
  input[source].push(structuredClone(input[source][0]));
  assertPreserved(freeze(input), "recovery_required");
  const result = makeManifest(input); assert.equal(result.applicable, false);
  assert.equal(result.inventory[source].count, input[source].length);
});
test("3.7.4 a version gap cannot be repaired by adopting a newer receipt", () => {
  const input = backendFixture(["clockIn", "clockOut", "clockIn"]); input.requests.splice(1, 1);
  assertPreserved(freeze(input), "recovery_required");
});
test("3.7.4 receipts assigned to the same state version conflict", () => {
  const input = backendFixture(); input.requests[1].data.result.stateVersion = 1;
  assertPreserved(freeze(input), "recovery_required");
});

for (const mutate of [
  input => { input.states = []; },
  input => { input.regularizations = []; },
  input => { input.requests.pop(); },
  input => { input.regularizations[0].data.originalEntryId = "missing-original"; },
  input => { input.regularizations[0].data.effectiveMinutes = 7; },
  input => { input.regularizations[0].data.adminUid = userId; },
  input => { input.regularizations[0].data.requestId = "00000000-0000-4000-8000-999999999999"; },
  input => { input.regularizations[0].data.regularizedAt = input.logs[0].timestamp; },
  input => { workerState(input).lastResolution.adminUid = "fictional-other-admin"; },
  input => { workerState(input).status = "idle"; workerState(input).lastResolution = null; },
]) test("3.7.4 resolution contradictions or missing state do not synthesize recovery: " + String(mutate), () => {
  const input = backendFixture(["clockIn", "regularizeSession"]); mutate(input);
  assertPreserved(freeze(input), "recovery_required");
});
test("3.7.4 orphan exit receipt and missing log require recovery", () => {
  const input = backendFixture(); input.logs.pop();
  assertPreserved(freeze(input), "recovery_required");
});
test("3.7.4 closed history added after latest backend receipt is not silently adopted", () => {
  const input = backendFixture(), previous = input.logs.at(-1).timestamp;
  input.logs.push({ ...entry(), timestamp: at(previous.seconds + 1, previous.nanoseconds) },
    exit({ timestamp: at(previous.seconds + 61, previous.nanoseconds),
      inicioSesion: at(previous.seconds + 1, previous.nanoseconds), minutosSesion: 1 }));
  input.evaluatedAt.seconds += 100;
  assert.ok(codes(assertPreserved(freeze(input), "recovery_required")).includes("history_after_latest_backend_receipt"));
});
test("3.7.4 cross-worker backend reference blocks both workers", () => {
  const input = backendFixture(["clockIn"]), other = "fictional-colleague";
  input.profiles.push(profile(other)); input.logs[0].userId = other;
  input.states.push({ id: other, data: idle({ status: "open", activeEntryId: input.logs[0].id, openedAt: input.logs[0].timestamp }) });
  for (const d of plan(freeze(input)).decisions.filter(d => d.userId !== "fictional-admin")) {
    assert.equal(d.decision, "recovery_required"); assert.equal(d.proposedState, null);
    assert.ok(codes(d).includes("backend_reference_scope_mismatch"));
  }
});
test("3.7.4 unrelated regularization cannot conceal an unresolved legacy entry", () => {
  const input = backendFixture(["clockIn", "regularizeSession"]);
  workerState(input).lastResolution.originalEntryId = "fictional-other-entry";
  workerState(input).lastResolution.regularizationId = "fictional-other-entry";
  assertPreserved(freeze(input), "recovery_required");
});
test("3.7.4 all five incomplete sources prevent certification of an existing evolved state", () => {
  for (const source of manifestSources) {
    const input = backendFixture(); input.complete[source] = false;
    assertPreserved(freeze(input), "incomplete_source", "unverified");
  }
});
test("3.7.4 unchanged reexecution is deterministic and never emits a replacement proposal", () => {
  const input = freeze(backendFixture(["clockIn", "regularizeSession"], "accredited_exit"));
  const before = structuredClone(input), expected = plan(input), expectedManifest = makeManifest(input);
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(plan(input), expected); assert.equal(JSON.stringify(makeManifest(input)), JSON.stringify(expectedManifest));
  }
  assert.deepEqual(input, before);
  assert.equal(expectedManifest.planning.decisions.find(d => d.userId === userId).proposedState, null);
});
test("3.7.4 manifest retains recovery diagnostics and is stable under every source permutation", () => {
  const input = backendFixture(["clockIn", "regularizeSession"]);
  input.requests[0].data.payloadFingerprint = "invalid";
  const expected = makeManifest(input);
  for (const source of manifestSources) input[source].reverse();
  assert.deepEqual(makeManifest(input), expected); assert.equal(expected.applicable, false);
  assert.ok(expected.planning.decisions.find(d => d.userId === userId).diagnostics.some(d => d.code === "receipt_trace_invalid"));
});

test("3.7.4 duplicate admin profiles cannot certify a regularization trace", () => {
  const input = backendFixture(["clockIn", "regularizeSession"]);
  input.profiles.push({ ...profile("fictional-admin"), role: "administrador" });
  assert.ok(codes(assertPreserved(freeze(input), "recovery_required")).includes("regularization_trace_invalid"));
});
test("3.7.4 otherwise valid legacy logs interleaved with backend activity require recovery", () => {
  const input = backendFixture(["clockIn", "clockOut", "clockIn"]);
  const between = input.logs[1].timestamp.seconds + 1;
  input.logs.push({ ...entry(), timestamp: at(between, start.nanoseconds) },
    exit({ timestamp: at(between + 60, start.nanoseconds), inicioSesion: at(between, start.nanoseconds), minutosSesion: 1 }));
  assert.ok(codes(assertPreserved(freeze(input), "recovery_required")).includes("untracked_log_during_backend_activity"));
});
test("3.7.4 incoherent state and incomplete trace have distinct classifications", () => {
  const invalid = fixture({ states: [{ id: userId, data: idle({ version: -1 }) }] });
  assertPreserved(freeze(invalid), "recovery_required", "incoherent");
  const incomplete = fixture({ states: [{ id: userId, data: idle({ version: 5 }) }] });
  assertPreserved(freeze(incomplete), "recovery_required", "unverified");
});
test("3.7.4 valid evolved manifest is invariant under permutation of all five sources", () => {
  const input = backendFixture(["clockIn", "clockOut", "clockIn", "clockOut"]);
  const expected = makeManifest(freeze(structuredClone(input)));
  assert.equal(expected.applicable, true);
  for (const source of manifestSources) {
    input[source].reverse(); assert.equal(JSON.stringify(makeManifest(input)), JSON.stringify(expected));
  }
});

test("3.7.4 domain backend logs without state or receipts cannot be reinitialized", () => {
  const input = backendFixture(["clockIn"]); input.states = []; input.requests = [];
  const decision = assertPreserved(freeze(input), "recovery_required");
  assert.ok(codes(decision).includes("backend_event_without_state"));
  assert.equal(makeManifest(input).applicable, false);
});

// 3.7.5: integral simulations. Two independent company-scoped memory snapshots;
// never an adapter, database, applicator or concurrency mechanism.
const simulationCompanies = ["fictional-simulation-alpha", "fictional-simulation-beta"];
const simulationTime = at(start.seconds + 200000, 123456789);
function simulationInput(company) {
  return { companyId: company, evaluatedAt: { ...simulationTime },
    complete: Object.fromEntries(manifestSources.map(source => [source, true])),
    profiles: [], logs: [], states: [], regularizations: [], requests: [] };
}
function simulationWorker(input, name, role = "trabajador") {
  const uid = input.companyId + "-" + name;
  input.profiles.push({ id: uid, companyId: input.companyId, role });
  return uid;
}
function simulationEntry(input, uid, age = 3600, suffix = "entry") {
  const record = { id: uid + "-" + suffix, companyId: input.companyId, userId: uid,
    tipo: "entrada", timestamp: at(simulationTime.seconds - age, simulationTime.nanoseconds) };
  input.logs.push(record); return record;
}
function simulationExit(input, anchor, seconds = 1800) {
  const record = { id: anchor.id + "-exit", companyId: input.companyId, userId: anchor.userId,
    tipo: "salida", timestamp: at(anchor.timestamp.seconds + seconds, anchor.timestamp.nanoseconds),
    entradaLogId: anchor.id, inicioSesion: { ...anchor.timestamp }, minutosSesion: Math.floor(seconds / 60) };
  input.logs.push(record); return record;
}
function simulationState(input, uid, extra = {}) {
  input.states.push({ id: uid, data: idle({ companyId: input.companyId, userId: uid, ...extra }) });
}
function simulationBackend(input, uid, operations, mode = "unknown_exit") {
  const adminUid = simulationWorker(input, uid.split(input.companyId + "-")[1] + "-admin", "administrador");
  let state = idle({ companyId: input.companyId, userId: uid });
  let time = at(simulationTime.seconds - 150000, simulationTime.nanoseconds);
  for (const [index, operation] of operations.entries()) {
    const isReg = operation === "regularizeSession";
    time = at(time.seconds + (isReg ? 86401 : 3600), time.nanoseconds);
    const request = { operation, requestId: "10000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"),
      companyContext: input.companyId, expectedStateVersion: state.version, expectedEpoch: 1, protocolVersion: 1 };
    if (isReg) Object.assign(request, { originalEntryId: state.activeEntryId, mode,
      reason: "Fictional integral simulation", evidenceReference: mode === "unknown_exit" ? null : "fictional-integral-evidence",
      accreditedExitAt: mode === "unknown_exit" ? null : at(state.openedAt.seconds + 1800, state.openedAt.nanoseconds) });
    const outcome = evaluateSessionOperation({ request, state, now: time,
      actor: { uid: isReg ? adminUid : uid, companyId: input.companyId,
        role: isReg ? "administrador" : "trabajador", emailVerified: true },
      control: { companyId: input.companyId, writeMode: "backend", epoch: 1, minProtocolVersion: 1 },
      history: { complete: true, entry: input.logs.find(log => log.id === state.activeEntryId),
        exitIds: [], regularizationIds: [], nextEntryAt: null, conflicts: [] } });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    const { type, id: eventId, ...event } = outcome.plan.event;
    if (isReg) input.regularizations.push({ id: eventId, data: event });
    else input.logs.push({ id: eventId, ...event });
    input.requests.push({ id: outcome.plan.requestKey, data: { ...outcome.plan.receipt, workerUid: uid } });
    state = outcome.plan.nextState;
  }
  simulationState(input, uid, state);
}

const simulationScenarios = [
  { name: "empty", decision: "eligible", status: "idle", setup() {} },
  { name: "closed", decision: "eligible", status: "idle", setup(input, uid) { simulationExit(input, simulationEntry(input, uid)); } },
  { name: "recent-open", decision: "eligible", status: "open", setup(input, uid) { simulationEntry(input, uid); } },
  { name: "overdue-open", decision: "eligible", status: "needs_review", setup(input, uid) { simulationEntry(input, uid, 86401); } },
  { name: "multiple-open", decision: "blocked", code: "consecutive_entries", setup(input, uid) {
    simulationEntry(input, uid); simulationEntry(input, uid, 1800, "second-entry");
  } },
  { name: "orphan-exit", decision: "blocked", code: "entry_not_found", setup(input, uid) {
    simulationExit(input, { id: uid + "-absent", userId: uid, timestamp: at(simulationTime.seconds - 3600, simulationTime.nanoseconds) });
  } },
  { name: "duplicate", decision: "blocked", code: "duplicate_id", setup(input, uid) {
    const record = simulationEntry(input, uid); input.logs.push(structuredClone(record));
  } },
  { name: "missing-profile", decision: "blocked", code: "profile_missing", setup(input, uid) {
    input.profiles = input.profiles.filter(p => p.id !== uid); simulationEntry(input, uid);
  } },
  { name: "invalid-profile", decision: "blocked", code: "invalid_profile_role", setup(input, uid) {
    input.profiles.find(p => p.id === uid).role = "fictional-invalid-role";
  } },
  { name: "existing-idle", decision: "already_initialized", setup(input, uid) { simulationState(input, uid); } },
  { name: "evolved", decision: "already_initialized", setup(input, uid) { simulationBackend(input, uid, ["clockIn", "clockOut"]); } },
  { name: "missing-trace", decision: "recovery_required", code: "backend_version_trace_incomplete", setup(input, uid) { simulationState(input, uid, { version: 7 }); } },
  { name: "valid-regularization", decision: "already_initialized", setup(input, uid) { simulationBackend(input, uid, ["clockIn", "regularizeSession"]); } },
  { name: "contradictory-regularization", decision: "recovery_required", code: "regularization_trace_invalid", setup(input, uid) {
    simulationBackend(input, uid, ["clockIn", "regularizeSession"]);
    input.regularizations.find(r => r.data.workerUid === uid).data.effectiveMinutes = 9;
  } },
  { name: "orphan-receipt", decision: "recovery_required", code: "backend_history_without_state", setup(input, uid) {
    simulationBackend(input, uid, ["clockIn"]);
    input.states = input.states.filter(s => s.id !== uid); input.logs = input.logs.filter(l => l.userId !== uid);
  } },
  { name: "administrator-clock", role: "administrador", decision: "eligible", status: "open", setup(input, uid) { simulationEntry(input, uid); } },
];

function assertSimulation(input) {
  const originals = structuredClone(input), encoded = canonical(input);
  freeze(input);
  const result = makeManifest(input);
  assert.deepEqual(input, originals); assert.equal(canonical(input), encoded);
  assert.match(result.planDigest, digestPattern);
  for (const d of result.planning.decisions) {
    if (d.decision === "eligible") {
      assert.equal(input.states.some(s => s.id === d.userId), false);
      const checked = inspectSessionState(d.proposedState, input.evaluatedAt);
      assert.equal(checked.ok, true); assert.deepEqual(checked.state, d.proposedState);
      assert.equal(d.proposedState.version, 0);
      assert.equal(d.proposedState.lastResolution, null); assert.equal(d.proposedState.lastRequestId, null);
      assert.equal(Object.hasOwn(d.proposedState, "minutes"), false);
      if (d.proposedState.activeEntryId !== null) {
        const original = input.logs.find(log => log.id === d.proposedState.activeEntryId);
        assert.equal(original.tipo, "entrada"); assert.equal(original.userId, d.userId);
        assert.deepEqual(d.proposedState.openedAt, original.timestamp);
      }
    } else {
      assert.equal(d.proposedState, null); assert.equal(d.proposedStatus, null);
      if (["blocked", "recovery_required", "incomplete_source"].includes(d.decision)) {
        assert.ok(d.diagnostics.some(diagnostic => diagnostic.blocking));
        assert.equal(result.applicable, false);
      }
    }
  }
  const serialized = JSON.stringify(result);
  for (let iteration = 0; iteration < 3; iteration++) {
    assert.equal(JSON.stringify(makeManifest(input)), serialized);
    const permuted = structuredClone(input);
    for (const source of manifestSources) {
      const list = permuted[source];
      if (iteration === 0) list.reverse();
      else if (list.length > 1) list.push(...list.splice(0, Math.min(iteration, list.length - 1)));
    }
    assert.equal(JSON.stringify(makeManifest(permuted)), serialized);
  }
  assert.deepEqual(input, originals);
  return result;
}

for (const company of simulationCompanies) for (const scenario of simulationScenarios) {
  test("3.7.5 integral " + company + ": " + scenario.name, () => {
    const input = simulationInput(company), uid = simulationWorker(input, scenario.name, scenario.role);
    scenario.setup(input, uid);
    const result = assertSimulation(input), decision = result.planning.decisions.find(d => d.userId === uid);
    assert.equal(decision.decision, scenario.decision);
    if (scenario.status) assert.equal(decision.proposedState.status, scenario.status);
    if (scenario.code) assert.ok(codes(decision).includes(scenario.code), JSON.stringify(decision.diagnostics));
  });
}

function combinedSimulation(company) {
  const input = simulationInput(company);
  for (const scenario of simulationScenarios) {
    const uid = simulationWorker(input, scenario.name, scenario.role); scenario.setup(input, uid);
  }
  return input;
}
for (const company of simulationCompanies) test("3.7.5 combined valid and ambiguous workers in " + company, () => {
  const input = combinedSimulation(company), result = assertSimulation(input);
  for (const scenario of simulationScenarios) {
    const decision = result.planning.decisions.find(d => d.userId === company + "-" + scenario.name);
    assert.equal(decision.decision, scenario.decision, scenario.name);
  }
  assert.equal(result.applicable, false);
  assert.equal(result.planning.decisions.filter(d => d.proposedState !== null
    && simulationScenarios.some(s => d.userId === company + "-" + s.name)).length, 5);
});

test("3.7.5 cross-company references block the contaminated snapshot and leave the other company unchanged", () => {
  const a = simulationInput(simulationCompanies[0]), b = simulationInput(simulationCompanies[1]);
  const aUid = simulationWorker(a, "cross-reference"), bUid = simulationWorker(b, "independent");
  const bEntry = simulationEntry(b, bUid), originalB = assertSimulation(b);
  a.logs.push(structuredClone(bEntry)); // Explicit erroneous foreign row, never silently filtered.
  simulationExit(a, { ...bEntry, userId: aUid });
  const resultA = assertSimulation(a);
  assert.equal(resultA.applicable, false);
  assert.ok(resultA.planning.diagnostics.some(d => d.code === "company_scope_mismatch"));
  assert.equal(JSON.stringify(makeManifest(b)), JSON.stringify(originalB));
  assert.equal(originalB.applicable, true);
});

test("3.7.5 incidents and document changes in one company cannot alter the independent company's manifest", () => {
  const a = combinedSimulation(simulationCompanies[0]), b = combinedSimulation(simulationCompanies[1]);
  const bManifest = assertSimulation(b), aManifest = assertSimulation(a);
  const nextA = structuredClone(a); nextA.logs[0].fictionalEvidence = "changed-in-memory-only";
  const changed = assertSimulation(nextA);
  assert.notEqual(changed.planDigest, aManifest.planDigest);
  assert.notEqual(changed.sourceDigests.logs, aManifest.sourceDigests.logs);
  assert.equal(JSON.stringify(makeManifest(b)), JSON.stringify(bManifest));
});

for (const company of simulationCompanies) for (const source of manifestSources) {
  test("3.7.5 combined incomplete " + source + " cannot be applicable for " + company, () => {
    const input = combinedSimulation(company); input.complete[source] = false;
    const result = assertSimulation(input);
    assert.equal(result.applicable, false);
    assert.ok(result.planning.decisions.every(d => d.decision === "incomplete_source"));
    assert.ok(result.diagnostics.some(d => d.code === "source_incomplete" && d.source === source));
  });
}

for (const source of manifestSources) test("3.7.5 new in-memory " + source + " snapshot invalidates the old integrated digest", () => {
  const input = combinedSimulation(simulationCompanies[0]), original = assertSimulation(input);
  const next = structuredClone(input);
  next[source][0].fictionalRevision = { marker: "new-snapshot", values: [null, false, 1] };
  const revised = assertSimulation(next);
  assert.notEqual(revised.sourceDigests[source], original.sourceDigests[source]);
  assert.notEqual(revised.planDigest, original.planDigest);
  for (const other of manifestSources.filter(s => s !== source)) assert.equal(revised.sourceDigests[other], original.sourceDigests[other]);
  assert.deepEqual(makeManifest(input), original);
});

for (const company of simulationCompanies) test("3.7.5 one nanosecond at 24 hours changes both classification and digest for " + company, () => {
  const input = simulationInput(company), uid = simulationWorker(input, "temporal-boundary");
  simulationEntry(input, uid, 86400);
  const exact = assertSimulation(input);
  assert.equal(exact.planning.decisions[0].proposedState.status, "open");
  const after = structuredClone(input); after.evaluatedAt.nanoseconds++;
  const overdue = assertSimulation(after);
  assert.equal(overdue.planning.decisions[0].proposedState.status, "needs_review");
  assert.equal(overdue.planning.decisions[0].proposedState.reviewReason, "overdue");
  assert.deepEqual(overdue.sourceDigests, exact.sourceDigests);
  assert.notEqual(overdue.planDigest, exact.planDigest);
  const changedSource = structuredClone(input); changedSource.logs[0].timestamp.nanoseconds--;
  const changed = assertSimulation(changedSource);
  assert.notEqual(changed.sourceDigests.logs, exact.sourceDigests.logs);
  assert.equal(changed.planning.decisions[0].proposedState.status, "needs_review");
});

test("3.7.5 multi-worker cross-references block both affected workers but preserve a third worker's proposal", () => {
  const input = simulationInput(simulationCompanies[0]);
  const a = simulationWorker(input, "first"), b = simulationWorker(input, "second"), c = simulationWorker(input, "unaffected");
  const anchor = simulationEntry(input, a);
  simulationEntry(input, a, 1800, "second-entry");
  simulationExit(input, { ...anchor, userId: b });
  const result = assertSimulation(input), byUid = new Map(result.planning.decisions.map(d => [d.userId, d]));
  for (const uid of [a, b]) {
    assert.equal(byUid.get(uid).decision, "blocked");
    assert.ok(codes(byUid.get(uid)).includes("reference_scope_mismatch"));
  }
  assert.equal(byUid.get(c).decision, "eligible"); assert.equal(byUid.get(c).proposedState.status, "idle");
});

for (const company of simulationCompanies) test("3.7.5 known regularization retains only original logs and an accredited duration for " + company, () => {
  const input = simulationInput(company), uid = simulationWorker(input, "accredited");
  simulationBackend(input, uid, ["clockIn", "regularizeSession"], "accredited_exit");
  const result = assertSimulation(input);
  assert.equal(result.planning.decisions.find(d => d.userId === uid).decision, "already_initialized");
  assert.equal(input.logs.length, 1); assert.equal(input.logs[0].tipo, "entrada");
  assert.equal(input.regularizations[0].data.effectiveMinutes, 30);
  assert.equal(result.planning.decisions.find(d => d.userId === uid).proposedState, null);
});

test("3.7.5 later snapshot can add a fictitious worker and entry without changing the earlier snapshot", () => {
  const input = simulationInput(simulationCompanies[0]), firstUid = simulationWorker(input, "original-worker");
  const first = assertSimulation(input), laterInput = structuredClone(input);
  const newUid = simulationWorker(laterInput, "later-worker"); simulationEntry(laterInput, newUid);
  const laterManifest = assertSimulation(laterInput);
  assert.equal(first.planning.decisions.length, 1); assert.equal(laterManifest.planning.decisions.length, 2);
  assert.equal(laterManifest.planning.decisions.find(d => d.userId === newUid).proposedState.status, "open");
  assert.equal(laterManifest.planning.decisions.find(d => d.userId === firstUid).proposedState.status, "idle");
  assert.notEqual(laterManifest.sourceDigests.profiles, first.sourceDigests.profiles);
  assert.notEqual(laterManifest.sourceDigests.logs, first.sourceDigests.logs);
  assert.notEqual(laterManifest.planDigest, first.planDigest);
  assert.deepEqual(makeManifest(input), first);
});

test("3.7.5 processing the two companies in either order gives identical independent results", () => {
  const snapshots = simulationCompanies.map(company => freeze(combinedSimulation(company)));
  const forward = snapshots.map(makeManifest), reverse = [...snapshots].reverse().map(makeManifest).reverse();
  assert.deepEqual(forward, reverse);
  assert.notEqual(forward[0].planDigest, forward[1].planDigest);
  for (const [index, result] of forward.entries()) {
    assert.equal(result.companyId, snapshots[index].companyId);
    assert.ok(result.planning.decisions.every(d => d.userId.startsWith(result.companyId + "-")));
  }
});

test("3.7.5 complete healthy company remains applicable beside a different company with multiple incidents", () => {
  const healthy = simulationInput(simulationCompanies[1]);
  for (const name of ["empty", "closed", "recent-open", "overdue-open", "administrator-clock", "existing-idle", "evolved", "valid-regularization"]) {
    const scenario = simulationScenarios.find(s => s.name === name);
    const uid = simulationWorker(healthy, scenario.name, scenario.role); scenario.setup(healthy, uid);
  }
  const healthyBefore = assertSimulation(healthy);
  assert.equal(healthyBefore.applicable, true);
  const incidentResult = assertSimulation(combinedSimulation(simulationCompanies[0]));
  assert.equal(incidentResult.applicable, false);
  assert.deepEqual(makeManifest(healthy), healthyBefore);
});

test("accredited resolution permits a traced new entry without changing originals", () => {
  const input = freeze(backendFixture(["clockIn", "regularizeSession", "clockIn"], "accredited_exit"));
  const raw = reconstructSessions(input.logs, { now: input.evaluatedAt });
  assert.ok(raw.issues.some(issue => issue.code === "consecutive_entries" && issue.blocking));
  const decision = assertPreserved(input, "already_initialized", "evolved");
  assert.equal(decision.proposedState, null);
  assert.equal(input.logs.length, 2);
  assert.ok(input.logs.every(log => log.tipo === "entrada"));
  const accounted = decision.diagnostics.filter(issue => issue.code === "consecutive_entries_accounted_for");
  assert.equal(accounted.length, 1); assert.equal(accounted[0].blocking, false);
  assert.equal(accounted[0].regularizationId, input.regularizations[0].id);
  assert.equal(accounted[0].receiptId, input.requests[1].id);
  assert.equal(decision.diagnostics.some(issue => issue.blocking), false);
  assert.deepEqual(reconstructSessions(input.logs, { now: input.evaluatedAt }), raw);
  assert.ok(raw.sessions.every(session => session.exit === null));
});

const accreditedReentry = () => backendFixture(["clockIn", "regularizeSession", "clockIn"], "accredited_exit");
for (const [label, operations, bootstrap] of [
  ["subsequent ordinary exit", ["clockIn", "regularizeSession", "clockIn", "clockOut"], false],
  ["two accredited resolutions", ["clockIn", "regularizeSession", "clockIn", "regularizeSession", "clockIn"], false],
  ["original legacy bootstrap", ["regularizeSession", "clockIn"], true],
]) test("accredited boundaries preserve an evolved state: " + label, () => {
  const input = freeze(backendFixture(operations, "accredited_exit", bootstrap));
  const decision = assertPreserved(input, "already_initialized", "evolved");
  assert.equal(decision.diagnostics.filter(d => d.code === "consecutive_entries_accounted_for").length,
    operations.filter(operation => operation === "regularizeSession").length);
});

test("accredited boundary permits a new entry exactly at regularization time", () => {
  const input = accreditedReentry(), timestamp = { ...input.regularizations[0].data.regularizedAt };
  input.logs[1].timestamp = timestamp; workerState(input).openedAt = { ...timestamp };
  assertPreserved(freeze(input), "already_initialized", "evolved");
});

test("accredited boundary preserves an existing overdue needs_review state without replacement", () => {
  const input = accreditedReentry(), state = workerState(input);
  input.evaluatedAt = at(state.openedAt.seconds + 86401, state.openedAt.nanoseconds);
  state.status = "needs_review"; state.reviewReason = "overdue";
  assertPreserved(freeze(input), "already_initialized", "evolved");
  assert.equal(state.status, "needs_review"); assert.equal(state.version, 3);
});

for (const [label, mutate] of [
  ["pending resolution", input => { input.regularizations[0].data.status = "pending"; }],
  ["missing resolution", input => { input.regularizations = []; }],
  ["missing regularization receipt", input => { input.requests.splice(1, 1); }],
  ["missing next-entry receipt", input => { input.requests.pop(); }],
  ["wrong original reference", input => { input.regularizations[0].data.originalEntryId = "fictional-missing"; }],
  ["wrong resolution document ID", input => { input.regularizations[0].id = "fictional-wrong-resolution"; }],
  ["wrong worker", input => { input.regularizations[0].data.workerUid = "fictional-foreign-worker"; }],
  ["wrong company", input => { input.regularizations[0].data.companyId = "fictional-foreign-company"; }],
  ["non-admin actor", input => { input.regularizations[0].data.adminUid = userId; }],
  ["incorrect stored duration", input => { input.regularizations[0].data.effectiveMinutes++; }],
  ["receipt reference mismatch", input => { input.requests[1].data.result.originalEntryId = "fictional-missing"; }],
  ["receipt status mismatch", input => { input.requests[1].data.result.status = "idle"; }],
  ["unverifiable receipt fingerprint", input => { input.requests[1].data.payloadFingerprint = "invalid"; }],
  ["incomplete version trace", input => { workerState(input).version++; }],
  ["incompatible idle state", input => {
    Object.assign(workerState(input), { status: "idle", activeEntryId: null, openedAt: null });
  }],
  ["new entry before regularization", input => {
    const time = input.regularizations[0].data.regularizedAt;
    input.logs[1].timestamp = at(time.seconds - 1, time.nanoseconds);
    workerState(input).openedAt = { ...input.logs[1].timestamp };
  }],
  ["new entry overlaps credited duration", input => {
    const time = input.regularizations[0].data.accreditedExitAt;
    input.logs[1].timestamp = at(time.seconds - 1, time.nanoseconds);
    workerState(input).openedAt = { ...input.logs[1].timestamp };
  }],
]) test("accredited evidence cannot clear ambiguity: " + label, () => {
  const input = accreditedReentry(); mutate(input);
  const decision = assertPreserved(freeze(input), "recovery_required");
  assert.ok(decision.diagnostics.some(d => d.blocking));
  assert.equal(codes(decision).includes("consecutive_entries_accounted_for"), false);
  assert.equal(makeManifest(input).applicable, false);
});

for (const contradictory of [false, true]) test("duplicate accredited resolutions remain blocked: contradictory=" + contradictory, () => {
  const input = accreditedReentry(), duplicate = structuredClone(input.regularizations[0]);
  if (contradictory) { duplicate.data.accreditedExitAt.seconds += 60; duplicate.data.effectiveMinutes++; }
  input.regularizations.push(duplicate);
  const decision = assertPreserved(freeze(input), "recovery_required");
  assert.ok(codes(decision).includes("duplicate_backend_document"));
  assert.equal(codes(decision).includes("consecutive_entries_accounted_for"), false);
  assert.equal(makeManifest(input).inventory.regularizations.count, 2);
});

test("duplicate accredited receipt remains blocked without selecting a winner", () => {
  const input = accreditedReentry(); input.requests.push(structuredClone(input.requests[1]));
  const decision = assertPreserved(freeze(input), "recovery_required");
  assert.ok(codes(decision).includes("duplicate_backend_document"));
  assert.equal(makeManifest(input).applicable, false);
});

test("unknown-duration regularization does not establish an accredited boundary", () => {
  const input = freeze(backendFixture(["clockIn", "regularizeSession", "clockIn"], "unknown_exit"));
  const decision = assertPreserved(input, "recovery_required");
  assert.ok(codes(decision).includes("consecutive_entries"));
  assert.equal(codes(decision).includes("consecutive_entries_accounted_for"), false);
  assert.equal(input.regularizations[0].data.effectiveMinutes, null);
  assert.equal(input.regularizations[0].data.accreditedExitAt, null);
});

test("a valid accredited trace never recreates an absent operational state", () => {
  const input = accreditedReentry(); input.states = [];
  assertPreserved(freeze(input), "recovery_required");
});

test("a new entry without an accredited resolution keeps raw consecutive entries blocked", () => {
  const logs = [entry(), { ...entry("fictional-next-entry"), timestamp: later(1) }];
  const input = fixture({ logs, states: [{ id: userId, data: idle({ status: "open",
    activeEntryId: "fictional-next-entry", openedAt: later(1) }) }] });
  const decision = assertPreserved(freeze(input), "recovery_required");
  assert.ok(codes(decision).includes("consecutive_entries"));
});

test("accredited evidence cannot suppress a different raw history blocker", () => {
  const input = accreditedReentry();
  input.logs.push({ ...exit(), id: "fictional-orphan-exit", timestamp: { ...input.evaluatedAt },
    entradaLogId: "fictional-missing-original" });
  const decision = assertPreserved(freeze(input), "recovery_required");
  assert.ok(codes(decision).includes("entry_not_found"));
  assert.equal(codes(decision).includes("consecutive_entries_accounted_for"), false);
});

test("accredited resolution plus an actual exit for the same original remains contradictory", () => {
  const input = accreditedReentry(), original = input.logs[0], resolution = input.regularizations[0].data;
  input.logs.push({ id: "fictional-extra-exit", companyId, userId, tipo: "salida",
    timestamp: { ...resolution.accreditedExitAt }, entradaLogId: original.id,
    inicioSesion: { ...original.timestamp }, minutosSesion: resolution.effectiveMinutes });
  const decision = assertPreserved(freeze(input), "recovery_required");
  assert.ok(codes(decision).includes("regularization_trace_invalid"));
});

for (const source of manifestSources) test("incomplete " + source + " cannot establish an accredited boundary", () => {
  const input = accreditedReentry(); input.complete[source] = false;
  assertPreserved(freeze(input), "incomplete_source");
  assert.equal(makeManifest(input).applicable, false);
});

test("accredited manifest is deterministic under source permutations and leaves every source intact", () => {
  const input = freeze(backendFixture(["clockIn", "regularizeSession", "clockIn", "regularizeSession", "clockIn"], "accredited_exit"));
  const before = structuredClone(input), manifest = makeManifest(input);
  assert.equal(manifest.applicable, true);
  assert.equal(manifest.planning.decisions.find(d => d.userId === userId).proposedState, null);
  for (let i = 0; i < 12; i++) {
    const permuted = structuredClone(input);
    for (const [index, source] of manifestSources.entries()) {
      if ((i + index) % 2) permuted[source].reverse();
      if (permuted[source].length > 1) permuted[source].push(...permuted[source].splice(0, i % permuted[source].length));
    }
    assert.equal(JSON.stringify(makeManifest(permuted)), JSON.stringify(manifest));
  }
  manifest.planning.decisions.find(d => d.userId === userId).diagnostics.length = 0;
  assert.deepEqual(input, before);
  assert.ok(makeManifest(input).planning.decisions.find(d => d.userId === userId).diagnostics
    .some(d => d.code === "consecutive_entries_accounted_for"));
});

test("accredited traces remain independent between companies", () => {
  const snapshots = simulationCompanies.map(company => {
    const input = simulationInput(company), uid = simulationWorker(input, "accredited-reentry");
    simulationBackend(input, uid, ["clockIn", "regularizeSession", "clockIn"], "accredited_exit");
    return input;
  });
  const second = makeManifest(freeze(snapshots[1]));
  assert.equal(second.applicable, true);
  const first = makeManifest(freeze(snapshots[0])); assert.equal(first.applicable, true);
  const changed = structuredClone(snapshots[0]); changed.regularizations[0].data.status = "pending";
  assert.equal(makeManifest(changed).applicable, false);
  assert.deepEqual(makeManifest(snapshots[1]), second);
});

test("foreign-company accredited evidence never clears a consecutive-entry blocker", () => {
  const input = accreditedReentry(); input.regularizations[0].data.companyId = "fictional-foreign-company";
  const decision = assertPreserved(freeze(input), "recovery_required");
  assert.ok(codes(decision).includes("company_scope_mismatch"));
  assert.equal(codes(decision).includes("consecutive_entries_accounted_for"), false);
});

test("one nanosecond before regularization is not a valid next-entry boundary", () => {
  const input = accreditedReentry(), time = input.regularizations[0].data.regularizedAt;
  input.logs[1].timestamp = at(time.seconds, time.nanoseconds - 1);
  workerState(input).openedAt = { ...input.logs[1].timestamp };
  const decision = assertPreserved(freeze(input), "recovery_required");
  assert.ok(codes(decision).includes("backend_transition_trace_conflict"));
  assert.equal(codes(decision).includes("consecutive_entries_accounted_for"), false);
});

test("one accredited boundary cannot conceal another untraced open entry", () => {
  const input = accreditedReentry();
  input.logs.push({ ...entry("fictional-untraced-entry"), timestamp: { ...input.evaluatedAt } });
  const decision = assertPreserved(freeze(input), "recovery_required");
  assert.ok(codes(decision).includes("untracked_log_during_backend_activity"));
  assert.equal(codes(decision).includes("consecutive_entries_accounted_for"), false);
  assert.equal(input.logs.length, 3);
});
