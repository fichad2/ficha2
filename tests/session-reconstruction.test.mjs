import assert from "node:assert/strict";
import { test } from "node:test";
import { reconstructSessions } from "../src/session-reconstruction.js";

// Entirely fictitious data. No SDK, credentials, network or real company records.
const at = (hour, day = 1) => new Date(Date.UTC(2026, 0, day, hour));
const entry = (id = "entry-a", overrides = {}) => ({
  id, companyId: "company-a", userId: "worker-a", tipo: "entrada", timestamp: at(8), ...overrides,
});
const exit = (id = "exit-a", overrides = {}) => ({
  id, companyId: "company-a", userId: "worker-a", tipo: "salida", timestamp: at(12),
  entradaLogId: "entry-a", inicioSesion: at(8), minutosSesion: 240, ...overrides,
});
const codes = (result) => result.issues.map((issue) => issue.code);
const hasIssue = (records, code, options) => {
  const result = reconstructSessions(records, options);
  assert.ok(codes(result).includes(code), `Expected ${code}, got ${codes(result)}`);
  assert.equal(result.canReconstruct, false);
  assert.deepEqual(result.records, records);
  return result;
};

test("empty history is valid and has no inferred session", () => {
  assert.deepEqual(reconstructSessions([]), {
    records: [], sessions: [], issues: [], groups: [], canReconstruct: true, unresolvedLogs: [],
  });
});

test("explicit references reconstruct out-of-order history without mutation", () => {
  const records = [exit(), entry()];
  const before = structuredClone(records);
  records.forEach(Object.freeze);
  Object.freeze(records);
  const result = reconstructSessions(records);
  assert.equal(result.canReconstruct, true);
  assert.equal(result.sessions[0].status, "closed");
  assert.equal(result.sessions[0].minutes, 240);
  assert.equal(result.sessions[0].entry, records[1]);
  assert.equal(result.sessions[0].exit, records[0]);
  assert.deepEqual(result.unresolvedLogs, []);
  assert.deepEqual(records, before);
});

test("an unmatched entry remains open with unknown minutes", () => {
  const result = reconstructSessions([entry()]);
  assert.equal(result.sessions[0].status, "open");
  assert.equal(result.sessions[0].exit, null);
  assert.equal(result.sessions[0].minutes, null);
  assert.equal(result.groups[0].status, "open");
});

test("a missing reference never falls back to the only open entry", () => {
  const records = [entry(), exit("exit-a", { entradaLogId: undefined })];
  const result = hasIssue(records, "missing_entry_reference");
  assert.equal(result.sessions[0].status, "open");
  assert.equal(result.groups[0].status, "needs_review");
  assert.deepEqual(result.unresolvedLogs, [records[1]]);
});

test("orphan exit names the missing entry", () => {
  const result = hasIssue([exit()], "entry_not_found");
  assert.equal(result.sessions.length, 0);
  assert.equal(result.issues[0].entradaLogId, "entry-a");
});

test("a bad reference is not replaced by a nearby entry", () => {
  const result = hasIssue([entry(), exit("exit-a", { entradaLogId: "missing" })], "entry_not_found");
  assert.equal(result.sessions[0].exit, null);
});

for (const field of ["companyId", "userId"]) {
  test(`references cannot cross ${field}`, () => {
    const result = hasIssue([entry(), exit("exit-a", { [field]: "other" })], "reference_scope_mismatch");
    assert.equal(result.sessions[0].exit, null);
    assert.equal(result.unresolvedLogs.length, 1);
  });
}

test("a reference to another exit is invalid", () => {
  hasIssue([exit("exit-a"), exit("exit-b", { timestamp: at(13), entradaLogId: "exit-a" })], "reference_not_entry");
});

test("repeated document IDs quarantine every occurrence", () => {
  const a = entry();
  const result = hasIssue([a, { ...a }, exit()], "duplicate_id");
  assert.ok(codes(result).includes("ambiguous_entry_reference"));
  assert.equal(result.sessions.length, 0);
  assert.equal(result.unresolvedLogs.length, 3);
  assert.deepEqual(result.issues[0].recordIndexes, [0, 1]);
});

test("conflicting repeated IDs do not select a winner", () => {
  const result = hasIssue([entry(), exit("entry-a")], "duplicate_id");
  assert.equal(result.sessions.length, 0);
});

test("distinct entry IDs at the same exact instant are possible duplicates", () => {
  const result = hasIssue([entry(), entry("entry-b"), exit()], "possible_duplicate_event");
  assert.ok(codes(result).includes("invalid_entry_reference"));
  assert.equal(result.sessions.length, 0);
  assert.equal(result.unresolvedLogs.length, 3);
});

test("distinct exit IDs at the same instant are retained, not deduplicated", () => {
  const result = hasIssue([entry(), exit(), exit("exit-b")], "possible_duplicate_event");
  assert.equal(result.sessions[0].exit, null);
  assert.equal(result.unresolvedLogs.length, 2);
});

test("two exits for one entry are contradictory, even at different times", () => {
  const result = hasIssue([entry(), exit(), exit("exit-b", { timestamp: at(13), minutosSesion: 300 })], "multiple_exits");
  assert.equal(result.sessions[0].status, "conflict");
  assert.equal(result.sessions[0].exit, null);
  assert.deepEqual(result.sessions[0].relatedExitIds, ["exit-a", "exit-b"]);
  assert.equal(result.unresolvedLogs.length, 2);
});

for (const hour of [7, 8]) {
  test(`exit at ${hour}:00 cannot close an 08:00 entry`, () => {
    const result = hasIssue([entry(), exit("exit-a", { timestamp: at(hour) })], "exit_not_after_entry");
    assert.equal(result.sessions[0].status, "conflict");
    assert.equal(result.sessions[0].exit, null);
  });
}

test("inicioSesion must match the actual referenced timestamp", () => {
  hasIssue([entry(), exit("exit-a", { inicioSesion: at(9) })], "session_start_mismatch");
});

for (const minutes of [-1, 239, 240.5, "240", null]) {
  test(`inconsistent saved minutes (${JSON.stringify(minutes)}) are reported`, () => {
    hasIssue([entry(), exit("exit-a", { minutosSesion: minutes })], "session_minutes_mismatch");
  });
}

test("legacy exits with an explicit reference can omit derived metadata", () => {
  const oldExit = exit();
  delete oldExit.inicioSesion;
  delete oldExit.minutosSesion;
  const result = reconstructSessions([entry(), oldExit]);
  assert.equal(result.canReconstruct, true);
  assert.equal(result.sessions[0].minutes, 240);
});

for (const timestamp of [null, undefined, "2026-01-01T08:00:00Z", new Date(NaN),
  { seconds: 1 }, { seconds: 1, nanoseconds: -1 }, { seconds: 1, nanoseconds: 1e9 },
  { seconds: 1.5, nanoseconds: 0 }, { seconds: 253402300800, nanoseconds: 0 }]) {
  test(`invalid/unresolved timestamp is retained and quarantined: ${String(timestamp)}`, () => {
    const result = hasIssue([entry("entry-a", { timestamp }), exit()], "invalid_fields");
    assert.ok(codes(result).includes("invalid_entry_reference"));
    assert.equal(result.sessions.length, 0);
    assert.equal(result.unresolvedLogs.length, 2);
  });
}

for (const field of ["id", "companyId", "userId", "tipo"]) {
  test(`invalid ${field} does not create a session`, () => {
    const result = hasIssue([entry("entry-a", { [field]: " " })], "invalid_fields");
    assert.equal(result.sessions.length, 0);
    assert.equal(result.unresolvedLogs.length, 1);
  });
}

test("non-records are retained with indexes rather than crashing", () => {
  const result = hasIssue([null, 7, [], undefined], "invalid_record");
  assert.equal(result.unresolvedLogs.length, 4);
  assert.deepEqual(result.issues.map((i) => i.recordIndexes[0]), [0, 1, 2, 3]);
});

test("nanosecond precision distinguishes two instants within a millisecond", () => {
  const first = { seconds: 1767254400, nanoseconds: 1 };
  const second = { seconds: 1767254400, nanoseconds: 2 };
  const result = reconstructSessions([
    exit("exit-a", { timestamp: second, inicioSesion: first, minutosSesion: 0 }),
    entry("entry-a", { timestamp: first }),
  ]);
  assert.equal(result.canReconstruct, true);
  assert.equal(result.sessions[0].status, "closed");
  assert.equal(result.sessions[0].minutes, 0);
});

test("nanosecond mismatch in inicioSesion is not hidden by Date rounding", () => {
  hasIssue([
    entry("entry-a", { timestamp: { seconds: 1767254400, nanoseconds: 1 } }),
    exit("exit-a", { inicioSesion: { seconds: 1767254400, nanoseconds: 2 } }),
  ], "session_start_mismatch");
});

for (const representation of ["Date", "stored Timestamp"]) {
  test(`recognizes the current client's millisecond inicioSesion (${representation})`, () => {
    const timestamp = { seconds: 1767254400, nanoseconds: 1 };
    const inicioSesion = representation === "Date" ? new Date(1767254400000)
      : { seconds: 1767254400, nanoseconds: 0 };
    const result = reconstructSessions([
      entry("entry-a", { timestamp }),
      exit("exit-a", { timestamp: { seconds: 1767258000, nanoseconds: 1 },
        inicioSesion, minutosSesion: 60 }),
    ]);
    assert.equal(result.canReconstruct, true);
    assert.equal(result.sessions[0].status, "closed");
    assert.equal(result.sessions[0].minutes, 60);
    assert.equal(result.sessions[0].entry.timestamp, timestamp);
    assert.deepEqual(codes(result), ["session_start_precision_loss"]);
  });
}

test("consecutive entries remain separate; neither is closed implicitly", () => {
  const result = hasIssue([entry(), entry("entry-b", { timestamp: at(9) })], "consecutive_entries");
  assert.deepEqual(result.sessions.map((s) => s.status), ["open", "open"]);
  assert.ok(result.sessions.every((s) => s.exit === null));
});

test("explicit pairs that overlap are retained but the group needs review", () => {
  const result = hasIssue([
    entry(), entry("entry-b", { timestamp: at(9) }), exit(),
    exit("exit-b", { entradaLogId: "entry-b", inicioSesion: at(9), timestamp: at(13) }),
  ], "overlapping_sessions");
  assert.deepEqual(result.sessions.map((s) => s.exit.id), ["exit-a", "exit-b"]);
  assert.equal(result.groups[0].status, "needs_review");
});

test("a next entry exactly at the previous exit is not an overlap", () => {
  const result = reconstructSessions([
    entry(), exit(), entry("entry-b", { timestamp: at(12) }),
  ]);
  assert.equal(result.canReconstruct, true);
  assert.deepEqual(result.sessions.map((s) => s.status), ["closed", "open"]);
});

test("analysis clock detects future records", () => {
  const result = hasIssue([entry()], "future_timestamp", { now: at(7) });
  assert.equal(result.sessions.length, 0);
});

test("24 hours is the exact open-session boundary", () => {
  const a = entry();
  const boundary = at(8, 2);
  const exact = reconstructSessions([a], { now: boundary });
  const overdue = reconstructSessions([a], { now: new Date(boundary.getTime() + 1) });
  assert.equal(exact.sessions[0].isOver24Hours, false);
  assert.equal(overdue.sessions[0].isOver24Hours, true);
  assert.equal(overdue.canReconstruct, true);
  assert.deepEqual(codes(overdue), ["overdue_open_session"]);
  assert.equal(overdue.sessions[0].minutes, null);
});

test("closed duration at 24 hours is allowed; above it is flagged without truncation", () => {
  const result = reconstructSessions([entry(), exit("exit-a", { timestamp: at(8, 2), minutosSesion: 1440 })]);
  assert.equal(result.canReconstruct, true);
  assert.equal(result.sessions[0].minutes, 1440);
  const tooLong = hasIssue([entry(), exit("exit-a", { timestamp: at(9, 2), minutosSesion: 1500 })], "session_exceeds_24_hours");
  assert.equal(tooLong.sessions[0].minutes, null);
  assert.equal(tooLong.records[1].minutosSesion, 1500);
});

test("analysis never reads the current clock implicitly", () => {
  const result = reconstructSessions([entry()]);
  assert.equal(result.sessions[0].isOver24Hours, false);
  assert.deepEqual(result.issues, []);
});

test("one worker's inconsistent data does not invalidate another worker's group", () => {
  const result = reconstructSessions([
    entry(), exit(),
    exit("orphan", { userId: "worker-b", entradaLogId: "missing" }),
    entry("other-company", { companyId: "company-b" }),
  ]);
  assert.equal(result.canReconstruct, false);
  assert.equal(result.groups.find((g) => g.companyId === "company-a" && g.userId === "worker-a").canReconstruct, true);
  assert.equal(result.groups.find((g) => g.userId === "worker-b").canReconstruct, false);
  assert.equal(result.groups.find((g) => g.companyId === "company-b").status, "open");
});

test("every permutation of two explicit sessions reconstructs the same pairs", () => {
  const records = [entry(), exit(), entry("entry-b", { timestamp: at(13) }),
    exit("exit-b", { entradaLogId: "entry-b", inicioSesion: at(13), timestamp: at(17) })];
  const permutations = (items) => items.length === 0 ? [[]]
    : items.flatMap((item, i) => permutations(items.filter((_, j) => i !== j)).map((rest) => [item, ...rest]));
  for (const permutation of permutations(records)) {
    const result = reconstructSessions(permutation);
    assert.equal(result.canReconstruct, true);
    assert.deepEqual(result.sessions.map((s) => [s.entry.id, s.exit.id, s.minutes]),
      [["entry-a", "exit-a", 240], ["entry-b", "exit-b", 240]]);
  }
});

test("a fictitious 79-record history retains every ID and exactly one open entry", () => {
  const records = [];
  for (let day = 1; day <= 40; day++) {
    records.push(entry(`fictional-entry-${day}`, { timestamp: at(8, day) }));
    if (day < 40) records.push(exit(`fictional-exit-${day}`, {
      entradaLogId: `fictional-entry-${day}`, timestamp: at(12, day), inicioSesion: at(8, day),
    }));
  }
  const before = structuredClone(records);
  const result = reconstructSessions([...records].reverse(), { now: at(9, 42) });
  assert.equal(result.canReconstruct, true);
  assert.equal(result.records.length, 79);
  assert.equal(result.sessions.length, 40);
  assert.equal(result.sessions.filter((s) => s.status === "closed").length, 39);
  const open = result.sessions.filter((s) => s.status === "open");
  assert.equal(open.length, 1);
  assert.equal(open[0].entry.id, "fictional-entry-40");
  assert.equal(open[0].isOver24Hours, true);
  assert.equal(open[0].minutes, null);
  const retainedIds = result.sessions.flatMap((s) => [s.entry.id, ...(s.exit ? [s.exit.id] : [])]);
  assert.deepEqual(retainedIds.sort(), records.map((r) => r.id).sort());
  assert.deepEqual(records, before);
});

test("invalid API arguments fail explicitly", () => {
  assert.throws(() => reconstructSessions(null), TypeError);
  assert.throws(() => reconstructSessions([], { now: "today" }), TypeError);
  assert.throws(() => reconstructSessions([], { now: null }), TypeError);
});
