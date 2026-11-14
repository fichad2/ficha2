import assert from "node:assert/strict";
import { test, after } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createClockOutService } from "../../functions/src/clock-out-service.js";
import { ClockInError } from "../../functions/src/clock-in-service.js";
import { createClockInHandler } from "../../functions/src/clock-in-callable.js";
import { assertEmulatorEnvironment } from "../../functions/src/emulator-environment.js";
const local = assertEmulatorEnvironment(process.env);
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { Firestore, Timestamp, FieldValue } = require("firebase-admin/firestore");
const { HttpsError } = require("firebase-functions/v2/https");
const app = initializeApp({ projectId: local.projectId, credential: {
  async getAccessToken() { return { access_token: "owner", expires_in: 3600 }; },
} }, "clock-out-tests");
const auth = getAuth(app);
const db = new Firestore({ projectId: local.projectId, host: local.firestore, ssl: false,
  credentials: { client_email: "emulator@example.invalid", private_key: "emulator-only-not-a-private-key" } });
after(async () => { await db.terminate(); await deleteApp(app); });
const environment = () => process.env;
const serviceFor = (firestore = db, clock = () => Timestamp.now(), env = environment) => createClockOutService({ firestore, environment: env,
  now: clock, serverTimestamp: () => FieldValue.serverTimestamp() });
const service = serviceFor();
const stateFor = (uid, companyId) => ({ schemaVersion: 1, companyId, userId: uid, status: "idle", version: 0,
  activeEntryId: null, openedAt: null, reviewReason: null, lastResolution: null, lastRequestId: null,
  initializationId: "fictional-initialization", sourceDigest: "fictional-source-preserved" });
async function fixture({ verified = true, profile = true, company = true, state = true, original = true, open = true,
  openedAt = Timestamp.fromMillis(Date.now() - 300000), role = "trabajador" } = {}) {
  assertEmulatorEnvironment(process.env);
  const uid = "out-test-" + randomUUID(), companyId = "company-" + randomUUID();
  const entryId = "entry-fixture-" + randomUUID();
  const email = uid + "@example.invalid", password = "Fictional-local-password-34";
  await auth.createUser({ uid, email, password, emailVerified: verified });
  const writes = [];
  if (profile) writes.push(db.doc("users/" + uid).set({ companyId, role }));
  if (company) writes.push(db.doc("companies/" + companyId).set({ name: "Fictional company" }));
  writes.push(db.doc("companies/" + companyId + "/session_control/config").set({ companyId, writeMode: "backend", epoch: 7, minProtocolVersion: 1 }));
  if (state) writes.push(db.doc("companies/" + companyId + "/session_states/" + uid).set({ ...stateFor(uid, companyId),
    ...(open ? { status: "open", version: 1, activeEntryId: entryId, openedAt } : {}) }));
  if (original && open) writes.push(db.doc("logs/" + entryId).create({ userId: uid, companyId, tipo: "entrada", timestamp: openedAt, marker: "original-unchanged" }));
  await Promise.all(writes);
  const response = await fetch("http://" + local.auth + "/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-emulator-key", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }), signal: AbortSignal.timeout(120000),
  });
  const signedIn = await response.json(); assert.equal(response.status, 200);
  return { uid, companyId, entryId, openedAt, token: signedIn.idToken, identity: { uid, emailVerified: verified },
    request: { operation: "clockOut", requestId: randomUUID(), companyContext: companyId, expectedStateVersion: open ? 1 : 0, expectedEpoch: 7, protocolVersion: 1 } };
}
async function call(f, data = f.request, token = f.token, operation = "clockOut") {
  const response = await fetch("http://" + local.functions + "/" + local.projectId + "/us-central1/" + operation, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: JSON.stringify({ data }), signal: AbortSignal.timeout(120000),
  });
  const body = await response.json(); return { status: response.status, ...body };
}
const keyFor = (f) => createHash("sha256").update(JSON.stringify([1, f.companyId, f.uid, f.request.requestId.toLowerCase()])).digest("hex");
async function effects(f) {
  const [logs, receipts, state] = await Promise.all([db.collection("logs").where("userId", "==", f.uid).get(),
    db.collection("companies/" + f.companyId + "/session_requests").where("actorUid", "==", f.uid).get(), db.doc("companies/" + f.companyId + "/session_states/" + f.uid).get()]);
  return { logs: logs.docs.map(d => ({ id: d.id, ...d.data() })), receipts: receipts.docs.map(d => ({ id: d.id, ...d.data() })), state: state.exists ? state.data() : null };
}
async function denied(f, code, data = f.request, token = f.token) {
  const before = await effects(f); const response = await call(f, data, token);
  assert.equal(response.error?.details?.code, code, JSON.stringify(response));
  assert.deepEqual(await effects(f), before); return response;
}

const stateRef = f => db.doc("companies/" + f.companyId + "/session_states/" + f.uid);
const controlRef = f => db.doc("companies/" + f.companyId + "/session_control/config");
const ns = t => BigInt(t.seconds) * 1000000000n + BigInt(t.nanoseconds);
async function originalSnapshot(f) { const s = await db.doc("logs/" + f.entryId).get(); return { data: s.data(), updateTime: s.updateTime }; }
async function directDenied(f, code, clock) {
  const before = await effects(f), original = await originalSnapshot(f);
  await assert.rejects(serviceFor(db, clock)({ data: f.request, identity: f.identity }), { code });
  assert.deepEqual(await effects(f), before); assert.deepEqual(await originalSnapshot(f), original);
}

// Persist diagnostics in the test reporter/CI log on failure; never write a
// diagnostic file or dump tokens, Auth records, request bodies or SDK stacks.
function diagnosticText(value) {
  return String(value ?? "")
    .replace(/-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?-----END [\w ]*PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[REDACTED]")
    .replace(/((?:password|access_token|refresh_token|idToken|apiKey|private_key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[REDACTED]")
    .slice(0, 1200);
}
function diagnosticError(error) {
  const nativeStatus = Number.isInteger(error?.code) && error.code >= 0 && error.code <= 16;
  return { category: error instanceof ClockInError ? "business"
    : nativeStatus ? error.code === 10 ? "transaction" : "sdk_or_infrastructure"
      : error instanceof Error ? "native_exception" : "unexpected_rejection",
  code: typeof error?.code === "number" ? error.code : typeof error?.code === "string" ? diagnosticText(error.code) : null,
  message: diagnosticText(error?.message ?? "Non-Error rejection"),
  type: diagnosticText(error?.constructor?.name ?? typeof error) };
}
const concurrentSnapshot = f => Promise.allSettled([effects(f), originalSnapshot(f)]);
async function validateConcurrentExit({ f, sameKey, responses, baseline, report,
  readFinal = () => concurrentSnapshot(f) }) {
  // All requests have settled. Read both snapshots BEFORE asserting response
  // codes, and aggregate assertions so one failure cannot hide the final data.
  const snapshots = await readFinal(), failures = [];
  const check = (label, assertion) => {
    try { assertion(); }
    catch (error) { failures.push({ label, message: diagnosticText(error.message) }); }
  };
  const e = snapshots[0].status === "fulfilled" ? snapshots[0].value : null;
  check("effects snapshot available", () => assert.equal(snapshots[0].status, "fulfilled"));
  check("original snapshot available", () => assert.equal(snapshots[1].status, "fulfilled"));
  check("all 20 responses captured", () => assert.equal(responses.length, 20));
  check("request identities", () => assert.equal(new Set(responses.map(r => r.requestId)).size, sameKey ? 1 : 20));
  const winners = responses.filter(r => r.result && !r.result.replayed), winner = winners[0];
  check("exactly one non-replayed success", () => assert.equal(winners.length, 1));
  if (sameKey) check("19 identical-request replays", () => assert.equal(responses.filter(r => r.result?.replayed).length, 19));
  else {
    check("19 distinct-request errors", () => assert.equal(responses.filter(r => r.outcome === "rejected").length, 19));
    // Original expectation retained: native failures are diagnosed, NOT allowed.
    check("distinct-request errors are VERSION_CONFLICT", () => assert.ok(responses
      .filter(r => r.outcome === "rejected").every(r => r.error?.code === "VERSION_CONFLICT")));
  }
  if (e) {
    const exits = e.logs.filter(log => log.tipo === "salida");
    check("exactly one exit", () => assert.equal(exits.length, 1));
    check("exactly one receipt", () => assert.equal(e.receipts.length, 1));
    check("original entry and one exit only", () => assert.equal(e.logs.length, baseline.effects.logs.length + 1));
    check("state version is 2", () => assert.equal(e.state.version, 2));
    check("state is idle", () => assert.equal(e.state.status, "idle"));
    check("active entry cleared", () => assert.equal(e.state.activeEntryId, null));
    check("opening timestamp cleared", () => assert.equal(e.state.openedAt, null));
    check("review reason cleared", () => assert.equal(e.state.reviewReason, null));
    check("no invented resolution", () => assert.equal(e.state.lastResolution, null));
    check("initialization metadata preserved", () => assert.equal(e.state.initializationId, baseline.effects.state.initializationId));
    check("source metadata preserved", () => assert.equal(e.state.sourceDigest, baseline.effects.state.sourceDigest));
    check("winner owns the state", () => assert.equal(e.state.lastRequestId, winner.requestId));
    check("winner owns the receipt", () => assert.equal(e.receipts[0].id, keyFor({ ...f,
      request: { ...f.request, requestId: winner.requestId } })));
    check("receipt agrees with result", () => assert.deepEqual(e.receipts[0].result, winner.result.result));
    check("exit agrees with result", () => assert.equal(exits[0].id, winner.result.result.eventId));
    check("exit references the original", () => assert.equal(exits[0].entradaLogId, f.entryId));
  }
  if (snapshots[1].status === "fulfilled") check("original data and updateTime preserved", () => assert.deepEqual(snapshots[1].value, baseline.original));
  const summary = { requests: responses.length, confirmed: winners.length,
    replayed: responses.filter(r => r.result?.replayed).length,
    errors: responses.filter(r => r.outcome === "rejected").length,
    exits: e?.logs.filter(log => log.tipo === "salida").length ?? null,
    receipts: e?.receipts.length ?? null, status: e?.state?.status ?? null, version: e?.state?.version ?? null };
  if (failures.length) {
    report("CLOCK_OUT_CONCURRENCY_DIAGNOSTIC " + JSON.stringify({ schemaVersion: 1,
      projectId: local.projectId, sameKey, summary, failures,
      snapshotReads: snapshots.map((s, index) => ({ source: index === 0 ? "effects" : "original",
        status: s.status, error: s.status === "rejected" ? diagnosticError(s.reason) : null })),
      responses: responses.map((r, index) => ({ index: index + 1, requestId: r.requestId,
        outcome: r.outcome, result: r.result ? { ok: r.result.ok ?? null, replayed: r.result.replayed ?? null,
          eventId: r.result.result?.eventId ?? null, stateVersion: r.result.result?.stateVersion ?? null,
          status: r.result.result?.status ?? null } : null,
        error: r.outcome === "rejected" ? diagnosticError(r.error) : null })) }));
    throw new AggregateError(failures.map(failure => new Error(failure.label + ": " + failure.message)),
      "Concurrent exit expectations failed: " + failures.map(failure => failure.label).join("; "));
  }
  return summary;
}
test("valid callable closes the active entry atomically and leaves its original bytes/version intact", async () => {
  const f = await fixture(), original = await originalSnapshot(f), before = Date.now();
  const response = await call(f), after = Date.now(); assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.result.ok, true); assert.equal(response.result.replayed, false);
  const e = await effects(f), exits = e.logs.filter(l => l.tipo === "salida");
  assert.equal(e.logs.length, 2); assert.equal(exits.length, 1); assert.equal(e.receipts.length, 1);
  const exit = exits[0]; assert.equal(exit.entradaLogId, f.entryId); assert.equal(exit.id, response.result.result.eventId);
  assert.equal(exit.userId, f.uid); assert.equal(exit.companyId, f.companyId); assert.ok(exit.inicioSesion.isEqual(f.openedAt));
  assert.ok(exit.timestamp.toMillis() >= before && exit.timestamp.toMillis() <= after);
  assert.equal(exit.minutosSesion, Number((ns(exit.timestamp) - ns(f.openedAt)) / 60000000000n));
  assert.deepEqual(response.result.result.exitAt, { seconds: exit.timestamp.seconds, nanoseconds: exit.timestamp.nanoseconds });
  assert.equal(response.result.result.minutes, exit.minutosSesion); assert.equal(response.result.result.originalEntryId, f.entryId);
  assert.equal(e.state.status, "idle"); assert.equal(e.state.version, 2); assert.equal(e.state.activeEntryId, null); assert.equal(e.state.openedAt, null);
  assert.equal(e.state.sourceDigest, "fictional-source-preserved"); assert.equal(e.state.initializationId, "fictional-initialization");
  assert.ok(e.receipts[0].committedAt instanceof Timestamp); assert.deepEqual(e.receipts[0].result, response.result.result);
  assert.deepEqual(await originalSnapshot(f), original);
});
test("idle state refuses an exit without inventing an entry", async () => { const f = await fixture({ open: false }); await denied(f, "NO_OPEN_SESSION"); });
test("missing state is not inferred from a log", async () => { const f = await fixture({ state: false }); await denied(f, "STATE_UNINITIALIZED"); });
test("session above 24h requires administrative regularization without changing logs", async () => {
  const f = await fixture({ openedAt: Timestamp.fromMillis(Date.now() - 86401000) }); await denied(f, "REGULARIZATION_REQUIRED");
});
test("manual review blocks ordinary exit", async () => {
  const f = await fixture(); await stateRef(f).update({ status: "needs_review", reviewReason: "manual_review" }); await denied(f, "REGULARIZATION_REQUIRED");
});
for (const [label, seconds, nanos, expected] of [["exactly 24h", 86400, 0, 1440], ["one microsecond", 0, 1000, 0],
  ["59.999999 seconds", 59, 999999000, 0], ["one minute", 60, 0, 1]]) test("server duration preserves stored precision: " + label, async () => {
  const opened = new Timestamp(1767254400, 0), end = new Timestamp(opened.seconds + seconds, nanos);
  const f = await fixture({ openedAt: opened }), original = await originalSnapshot(f);
  const result = await serviceFor(db, () => end)({ data: f.request, identity: f.identity });
  assert.equal(result.result.minutes, expected); assert.notEqual(result.result.minutes, null);
  const e = await effects(f), exit = e.logs.find(l => l.tipo === "salida");
  assert.ok(exit.timestamp.isEqual(end)); assert.ok(exit.inicioSesion.isEqual(opened)); assert.equal(exit.minutosSesion, expected);
  assert.deepEqual(await originalSnapshot(f), original);
});
test("24h plus one nanosecond is rejected without truncation", async () => {
  const f = await fixture({ openedAt: new Timestamp(1767254400, 1000) }); await directDenied(f, "REGULARIZATION_REQUIRED", () => new Timestamp(1767340800, 1001));
});
test("zero elapsed time is rejected", async () => { const f = await fixture({ openedAt: new Timestamp(1767254400, 0) }); await directDenied(f, "INVALID_TIME", () => f.openedAt); });
test("negative elapsed time is rejected", async () => { const f = await fixture({ openedAt: new Timestamp(1767254400, 1000) }); await directDenied(f, "INVALID_TIME", () => new Timestamp(1767254400, 0)); });
test("clock is checked again after history reads when the session crosses the limit", async () => {
  const f = await fixture({ openedAt: new Timestamp(1767254400, 0) }); let calls = 0;
  await directDenied(f, "REGULARIZATION_REQUIRED", () => ++calls === 1 ? new Timestamp(1767340800, 0) : new Timestamp(1767340800, 1));
  assert.equal(calls, 2);
});
test("unauthenticated exit has no effects", async () => { const f = await fixture(); await denied(f, "UNAUTHENTICATED", f.request, null); });
test("unverified email cannot close a session", async () => { const f = await fixture({ verified: false }); await denied(f, "EMAIL_NOT_VERIFIED"); });
test("verification is rechecked against current Auth, not just the old token", async () => {
  const f = await fixture(); await auth.updateUser(f.uid, { emailVerified: false }); await denied(f, "EMAIL_NOT_VERIFIED");
});
test("disabled user cannot close with an existing token", async () => { const f = await fixture(); await auth.updateUser(f.uid, { disabled: true }); await denied(f, "UNAUTHENTICATED"); });
test("missing profile is rejected", async () => { const f = await fixture({ profile: false }); await denied(f, "PROFILE_NOT_FOUND"); });
test("missing company is rejected", async () => { const f = await fixture({ company: false }); await denied(f, "COMPANY_NOT_FOUND"); });
test("server role is authoritative", async () => { const f = await fixture({ role: "intruder" }); await denied(f, "FORBIDDEN"); });
test("company assertion cannot redirect an exit", async () => { const f = await fixture(); await denied(f, "COMPANY_MISMATCH", { ...f.request, companyContext: "other-company" }); });
test("state cannot belong to another company", async () => { const f = await fixture(); await stateRef(f).update({ companyId: "other-company" }); await denied(f, "COMPANY_MISMATCH"); });
test("state cannot target another worker", async () => { const f = await fixture(); await stateRef(f).update({ userId: "other-user" }); await denied(f, "FORBIDDEN"); });
test("incorrect state version is rejected", async () => { const f = await fixture(); await denied(f, "VERSION_CONFLICT", { ...f.request, expectedStateVersion: 0 }); });
test("incorrect control epoch is rejected", async () => { const f = await fixture(); await denied(f, "EPOCH_CONFLICT", { ...f.request, expectedEpoch: 6 }); });
for (const writeMode of ["legacy", "paused"]) test("no new exit in " + writeMode + " mode", async () => {
  const f = await fixture(); await controlRef(f).update({ writeMode }); await denied(f, "SERVICE_PAUSED");
});
test("missing original entry prevents an ordinary exit", async () => { const f = await fixture({ original: false }); await denied(f, "REFERENCE_MISMATCH"); });
for (const [field, value] of Object.entries({ companyId: "other-company", userId: "other-user", tipo: "salida" })) test("original entry mismatch: " + field, async () => {
  const f = await fixture(); await db.doc("logs/" + f.entryId).update({ [field]: value }); await denied(f, "REFERENCE_MISMATCH");
});
test("original entry timestamp must match openedAt at Firestore precision", async () => {
  const f = await fixture({ openedAt: new Timestamp(1767254400, 1000) }); await db.doc("logs/" + f.entryId).update({ timestamp: new Timestamp(1767254400, 2000) });
  await directDenied(f, "REFERENCE_MISMATCH", () => new Timestamp(1767254460, 1000));
});
test("existing linked exit prevents a second close even with stale open state", async () => {
  const f = await fixture(); await db.collection("logs").add({ tipo: "salida", userId: f.uid, companyId: f.companyId, entradaLogId: f.entryId, timestamp: Timestamp.now() });
  await denied(f, "ALREADY_CLOSED");
});
test("regularized original cannot receive an ordinary exit", async () => {
  const f = await fixture(); await db.doc("companies/" + f.companyId + "/regularizations/" + f.entryId).create({ originalEntryId: f.entryId, workerUid: f.uid, companyId: f.companyId });
  await denied(f, "ALREADY_REGULARIZED");
});
test("noncanonical resolution ID still prevents contradictory closure", async () => {
  const f = await fixture(); await db.collection("companies/" + f.companyId + "/regularizations").add({ originalEntryId: f.entryId, workerUid: f.uid, companyId: f.companyId });
  await denied(f, "ALREADY_REGULARIZED");
});
test("duplicate entry instant is an ambiguity, never silently ignored", async () => {
  const f = await fixture(); await db.collection("logs").add({ tipo: "entrada", userId: f.uid, companyId: f.companyId, timestamp: f.openedAt }); await denied(f, "HISTORY_CONFLICT");
});
test("later entry prevents an overlapping close", async () => {
  const f = await fixture(); await db.collection("logs").add({ tipo: "entrada", userId: f.uid, companyId: f.companyId, timestamp: Timestamp.fromMillis(Date.now() - 60000) }); await denied(f, "HISTORY_CONFLICT");
});
test("unreferenced exit is not paired with the active entry", async () => {
  const f = await fixture(); await db.collection("logs").add({ tipo: "salida", userId: f.uid, companyId: f.companyId, timestamp: Timestamp.now() }); await denied(f, "HISTORY_CONFLICT");
});
test("linked malformed event is rejected", async () => {
  const f = await fixture(); await db.collection("logs").add({ tipo: "entrada", userId: f.uid, companyId: f.companyId, entradaLogId: f.entryId, timestamp: Timestamp.now() }); await denied(f, "HISTORY_CONFLICT");
});
for (const [field, value] of Object.entries({ uid: "other", userId: "other", companyId: "other", timestamp: 1, inicioSesion: 1,
  minutosSesion: 500, entradaLogId: "other-entry", role: "administrador" })) test("client protected field rejected: " + field, async () => {
  const f = await fixture(); await denied(f, "INVALID_REQUEST", { ...f.request, [field]: value });
});
test("exit endpoint does not implement entry", async () => { const f = await fixture(); await denied(f, "INVALID_REQUEST", { ...f.request, operation: "clockIn" }); });
test("identical retry returns the committed result without changing any document", async () => {
  const f = await fixture(), first = await call(f), before = await effects(f), retry = await call(f);
  assert.equal(retry.result.replayed, true); assert.deepEqual(retry.result.result, first.result.result); assert.deepEqual(await effects(f), before);
});
test("contradictory retry cannot reuse the same request ID", async () => { const f = await fixture(); await call(f); await denied(f, "REQUEST_ID_CONFLICT", { ...f.request, expectedStateVersion: 2 }); });
test("double click commits exactly one exit", async () => {
  const f = await fixture(), responses = await Promise.all([call(f), call(f)]);
  assert.deepEqual(responses.map(r => r.result?.replayed).sort(), [false, true]); assert.deepEqual(responses[0].result.result, responses[1].result.result);
  const e = await effects(f); assert.equal(e.logs.filter(l => l.tipo === "salida").length, 1); assert.equal(e.receipts.length, 1); assert.equal(e.state.version, 2);
});
test("two devices with different keys cannot create two exits", async () => {
  const f = await fixture(), responses = await Promise.all([call(f), call(f, { ...f.request, requestId: randomUUID() })]);
  assert.equal(responses.filter(r => r.result?.ok).length, 1); assert.equal(responses.find(r => r.error)?.error.details.code, "VERSION_CONFLICT");
  const e = await effects(f); assert.equal(e.logs.filter(l => l.tipo === "salida").length, 1); assert.equal(e.receipts.length, 1); assert.equal(e.state.version, 2);
});
for (const sameKey of [true, false]) test("20 concurrent exits, same key=" + sameKey, async t => {
  const f = await fixture(), baseline = { effects: await effects(f), original: await originalSnapshot(f) };
  const responses = await Promise.all(Array.from({ length: 20 }, () => {
    const requestId = sameKey ? f.request.requestId : randomUUID();
    return service({ data: { ...f.request, requestId }, identity: f.identity })
      .then(result => ({ requestId, outcome: "fulfilled", result }), error => ({ requestId, outcome: "rejected", error }));
  }));
  const summary = await validateConcurrentExit({ f, sameKey, responses, baseline, report: message => t.diagnostic(message) });
  t.diagnostic("CLOCK_OUT_CONCURRENCY_SUMMARY " + JSON.stringify({ sameKey, ...summary }));
});
test("receipt is recoverable during pause/epoch change", async () => {
  const f = await fixture(), first = await call(f); await controlRef(f).update({ writeMode: "paused", epoch: 8 });
  const retry = await call(f); assert.equal(retry.result.replayed, true); assert.deepEqual(retry.result.result, first.result.result);
});
test("entry -> exit -> new entry works; retry of old exit does not close the new session", async () => {
  const f = await fixture({ open: false });
  const entryRequest = { ...f.request, operation: "clockIn", requestId: randomUUID(), expectedStateVersion: 0 };
  const entry = await call(f, entryRequest, f.token, "clockIn"); assert.equal(entry.result?.ok, true, JSON.stringify(entry));
  f.entryId = entry.result.result.eventId; f.request.expectedStateVersion = 1;
  const original = await originalSnapshot(f), closed = await call(f); assert.equal(closed.result?.ok, true, JSON.stringify(closed));
  const reopened = await call(f, { ...entryRequest, requestId: randomUUID(), expectedStateVersion: 2 }, f.token, "clockIn"); assert.equal(reopened.result?.ok, true);
  const before = await effects(f), replay = await call(f); assert.equal(replay.result.replayed, true); assert.deepEqual(replay.result.result, closed.result.result);
  assert.deepEqual(await effects(f), before); assert.equal(before.state.version, 3); assert.equal(before.state.status, "open"); assert.equal(before.logs.length, 3);
  assert.deepEqual(await originalSnapshot(f), original);
});
test("request ID from a previous entry cannot be reused for exit", async () => {
  const f = await fixture({ open: false }); const entry = await call(f, { ...f.request, operation: "clockIn" }, f.token, "clockIn"); assert.equal(entry.result?.ok, true);
  f.request.expectedStateVersion = 1; await denied(f, "REQUEST_ID_CONFLICT");
});
test("real emulator commit failure rolls back exit, state and receipt; original survives", async () => {
  const f = await fixture(), before = await effects(f), original = await originalSnapshot(f), occupied = db.doc("phase3_test_faults/" + randomUUID()); await occupied.create({ marker: "keep" });
  const wrapper = { projectId: local.projectId, doc: p => db.doc(p), collection: p => db.collection(p), runTransaction: action => db.runTransaction(tx => action({
    get: ref => tx.get(ref), getAll: (...refs) => tx.getAll(...refs), update: (ref, data) => tx.update(ref, data),
    create: (ref, data) => tx.create(ref.path.includes("/session_requests/") ? occupied : ref, data),
  })) };
  await assert.rejects(serviceFor(wrapper)({ data: f.request, identity: f.identity }), e => e.code === 6);
  assert.deepEqual(await effects(f), before); assert.deepEqual(await originalSnapshot(f), original); assert.deepEqual((await occupied.get()).data(), { marker: "keep" });
  const retry = await call(f); assert.equal(retry.result?.ok, true, JSON.stringify(retry));
  const recovered = await effects(f); assert.equal(recovered.logs.filter(l => l.tipo === "salida").length, 1); assert.equal(recovered.receipts.length, 1);
  assert.deepEqual(await originalSnapshot(f), original);
});
test("existing exit ID cannot be overwritten; transaction has no partial effects", async () => {
  const f = await fixture(); await db.doc("logs/exit_" + keyFor(f)).create({ marker: "occupied" });
  const before = await effects(f), original = await originalSnapshot(f), response = await call(f);
  assert.equal(response.error.details.code, "CONFIRMATION_UNAVAILABLE"); assert.deepEqual(await effects(f), before); assert.deepEqual(await originalSnapshot(f), original);
});
test("failed history query is not treated as complete history", async () => {
  const f = await fixture(), before = await effects(f);
  const wrapper = { projectId: local.projectId, doc: p => db.doc(p), collection: p => db.collection(p), runTransaction: action => db.runTransaction(tx => action({
    get: ref => { if (typeof ref.where === "function") throw new Error("fictional query failure"); return tx.get(ref); }, getAll: (...refs) => tx.getAll(...refs),
    update: () => { throw new Error("unexpected write"); }, create: () => { throw new Error("unexpected write"); },
  })) };
  await assert.rejects(serviceFor(wrapper)({ data: f.request, identity: f.identity }), /fictional query failure/); assert.deepEqual(await effects(f), before);
});
test("wrong project or host prevents any Firestore adapter access", async () => {
  for (const patch of [{ GCLOUD_PROJECT: "fichad2-piloto" }, { FIRESTORE_EMULATOR_HOST: "remote:443" }]) {
    let touched = false; const execute = serviceFor({ projectId: local.projectId, runTransaction() { touched = true; } }, () => Timestamp.now(), () => ({ ...process.env, ...patch }));
    await assert.rejects(execute({ data: {}, identity: null }), { code: "EMULATOR_ISOLATION" }); assert.equal(touched, false);
  }
});
test("Firestore adapter for a different project is rejected before any transaction", async () => {
  let touched = false; const execute = serviceFor({ projectId: "fichad2-piloto", runTransaction() { touched = true; } });
  await assert.rejects(execute({ data: {}, identity: null }), { code: "EMULATOR_ISOLATION" }); assert.equal(touched, false);
});

test("previous session ending exactly at this entry does not create a false overlap", async () => {
  const f = await fixture(), previous = "previous-" + randomUUID();
  await db.doc("logs/" + previous).create({ tipo: "entrada", userId: f.uid, companyId: f.companyId, timestamp: Timestamp.fromMillis(f.openedAt.toMillis() - 60000) });
  await db.collection("logs").add({ tipo: "salida", userId: f.uid, companyId: f.companyId, timestamp: f.openedAt, entradaLogId: previous });
  const response = await call(f); assert.equal(response.result?.ok, true, JSON.stringify(response));
  assert.equal((await effects(f)).logs.filter(l => l.tipo === "salida" && l.entradaLogId === f.entryId).length, 1);
});
test("unreferenced exit exactly at opening remains ambiguous", async () => {
  const f = await fixture(); await db.collection("logs").add({ tipo: "salida", userId: f.uid, companyId: f.companyId, timestamp: f.openedAt }); await denied(f, "HISTORY_CONFLICT");
});

for (const [seconds, nanos] of [[0, 1], [59, 999999999]]) test("nonpersistible server timestamp is refused without rounding: " + seconds + ":" + nanos, async () => {
  const f = await fixture({ openedAt: new Timestamp(1767254400, 0) });
  await directDenied(f, "INVALID_TIME", () => new Timestamp(1767254400 + seconds, nanos));
});
test("Firestore storage precision is explicit in the fixture contract", async () => {
  const f = await fixture({ openedAt: new Timestamp(1767254400, 123456789) });
  assert.equal((await stateRef(f).get()).data().openedAt.nanoseconds, 123456000);
  assert.equal((await originalSnapshot(f)).data.timestamp.nanoseconds, 123456000);
});

// Controlled faults use the existing adapter injection. They are simulations,
// not evidence that any particular native error caused the historical failure.
const nativeFault = (code, message) => Object.assign(new Error(message), { code });
const transactionAdapter = runTransaction => ({ projectId: local.projectId,
  doc: p => db.doc(p), collection: p => db.collection(p), runTransaction });
const handlerFor = execute => createClockInHandler({ environment, execute,
  readUser: uid => auth.getUser(uid), HttpsError });
const handlerRequest = async f => ({ data: f.request,
  auth: { uid: f.uid, token: await auth.verifyIdToken(f.token) } });

test("concurrency diagnostic retains unexpected errors and still inspects final effects", async () => {
  const f = await fixture(), baseline = { effects: await effects(f), original: await originalSnapshot(f) };
  const result = await service({ data: f.request, identity: f.identity });
  // Only the winner actually runs here. Synthetic rejected responses exercise
  // the diagnostic path deterministically, without changing its expectations.
  const error = nativeFault(14, 'Authorization: Bearer fictional-secret; password="fictional-password"');
  const responses = [{ requestId: f.request.requestId, outcome: "fulfilled", result },
    ...Array.from({ length: 19 }, () => ({ requestId: randomUUID(), outcome: "rejected", error }))];
  const messages = []; let finalReads = 0;
  await assert.rejects(validateConcurrentExit({ f, sameKey: false, responses, baseline,
    report: message => messages.push(message), readFinal: () => { finalReads++; return concurrentSnapshot(f); } }), AggregateError);
  assert.equal(finalReads, 1); assert.equal(messages.length, 1);
  const diagnostic = JSON.parse(messages[0].slice("CLOCK_OUT_CONCURRENCY_DIAGNOSTIC ".length));
  assert.equal(diagnostic.responses.length, 20); assert.equal(diagnostic.summary.errors, 19);
  assert.equal(diagnostic.summary.exits, 1); assert.equal(diagnostic.summary.receipts, 1);
  assert.equal(diagnostic.summary.version, 2); assert.equal(diagnostic.summary.status, "idle");
  assert.ok(diagnostic.snapshotReads.every(read => read.status === "fulfilled"));
  assert.deepEqual(diagnostic.failures.map(failure => failure.label), ["distinct-request errors are VERSION_CONFLICT"]);
  assert.ok(diagnostic.responses.slice(1).every(response => response.error.code === 14
    && response.error.category === "sdk_or_infrastructure" && response.error.type === "Error"));
  assert.equal(messages[0].includes("fictional-secret"), false);
  assert.equal(messages[0].includes("fictional-password"), false);
  // An unexpected code must not suppress a simultaneous data-integrity error.
  // Alter only the observed DTO in memory, never the emulator's actual state.
  const inconsistent = await concurrentSnapshot(f), inconsistentMessages = [];
  inconsistent[0].value.state = { ...inconsistent[0].value.state, version: 3 };
  await assert.rejects(validateConcurrentExit({ f, sameKey: false, responses, baseline,
    report: message => inconsistentMessages.push(message), readFinal: async () => inconsistent }), AggregateError);
  const both = JSON.parse(inconsistentMessages[0].slice("CLOCK_OUT_CONCURRENCY_DIAGNOSTIC ".length));
  assert.deepEqual(both.failures.map(failure => failure.label), ["distinct-request errors are VERSION_CONFLICT", "state version is 2"]);
  assert.equal((await effects(f)).state.version, 2);
  assert.deepEqual(await originalSnapshot(f), baseline.original);
});

test("concurrency diagnostics do not hide an unavailable final read or skip the original read", async () => {
  const f = await fixture(), baseline = { effects: await effects(f), original: await originalSnapshot(f) };
  const result = await service({ data: f.request, identity: f.identity }), messages = [];
  const responses = [{ requestId: f.request.requestId, outcome: "fulfilled", result },
    ...Array.from({ length: 19 }, () => ({ requestId: randomUUID(), outcome: "rejected",
      error: new ClockInError("VERSION_CONFLICT") }))];
  let originalReads = 0;
  await assert.rejects(validateConcurrentExit({ f, sameKey: false, responses, baseline, report: message => messages.push(message),
    readFinal: () => Promise.allSettled([Promise.reject(nativeFault(14, "fictional final read unavailable")),
      (async () => { originalReads++; return originalSnapshot(f); })()]) }), AggregateError);
  const diagnostic = JSON.parse(messages[0].slice("CLOCK_OUT_CONCURRENCY_DIAGNOSTIC ".length));
  assert.equal(originalReads, 1); assert.equal(diagnostic.summary.exits, null);
  assert.equal(diagnostic.summary.receipts, null); assert.equal(diagnostic.summary.version, null);
  assert.equal(diagnostic.snapshotReads[0].error.code, 14); assert.equal(diagnostic.snapshotReads[1].status, "fulfilled");
  assert.deepEqual(diagnostic.failures.map(failure => failure.label), ["effects snapshot available"]);
  assert.ok(diagnostic.responses.slice(1).every(response => response.error.category === "business"));
});

test("configured SDK transaction retry exhaustion propagates ABORTED and rolls back every staged exit", async () => {
  const f = await fixture(), before = await effects(f), original = await originalSnapshot(f);
  const aborted = nativeFault(10, "fictional ABORTED on every attempt"); let attempts = 0;
  const wrapper = transactionAdapter(action => db.runTransaction(async tx => {
    attempts++; await action(tx); // Real reads and staged writes, never a commit.
    throw aborted;
  }, { maxAttempts: 3 })); // Explicit budget for this fixture only; production is unchanged.
  await assert.rejects(serviceFor(wrapper)({ data: f.request, identity: f.identity }), error => error === aborted && error.code === 10);
  assert.equal(attempts, 3); assert.equal(diagnosticError(aborted).category, "transaction");
  assert.deepEqual(await effects(f), before); assert.deepEqual(await originalSnapshot(f), original);
  const retry = await service({ data: f.request, identity: f.identity });
  assert.equal(retry.replayed, false);
  const committed = await effects(f), replay = await service({ data: f.request, identity: f.identity });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.result, retry.result);
  assert.equal(committed.logs.filter(log => log.tipo === "salida").length, 1);
  assert.equal(committed.receipts.length, 1); assert.equal(committed.state.version, 2);
  assert.deepEqual(await effects(f), committed); assert.deepEqual(await originalSnapshot(f), original);
});

test("one transient SDK exception retries the transaction and commits exactly one exit", async () => {
  const f = await fixture(), original = await originalSnapshot(f); let attempts = 0;
  const unavailable = nativeFault(14, "fictional UNAVAILABLE before first commit");
  const wrapper = transactionAdapter(action => db.runTransaction(async tx => {
    attempts++; const result = await action(tx);
    if (attempts === 1) throw unavailable;
    return result;
  }, { maxAttempts: 3 }));
  const result = await serviceFor(wrapper)({ data: f.request, identity: f.identity });
  assert.equal(attempts, 2); assert.equal(result.replayed, false);
  const committed = await effects(f);
  assert.equal(committed.logs.filter(log => log.tipo === "salida").length, 1);
  assert.equal(committed.receipts.length, 1); assert.equal(committed.state.version, 2);
  assert.equal(committed.receipts[0].id, keyFor(f));
  const replay = await service({ data: f.request, identity: f.identity });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.result, result.result);
  assert.deepEqual(await effects(f), committed); assert.deepEqual(await originalSnapshot(f), original);
});

for (const committedBeforeFailure of [false, true]) test("confirmation unavailable does not assert commit outcome: committed=" + committedBeforeFailure, async () => {
  const f = await fixture(), before = await effects(f), original = await originalSnapshot(f);
  const unavailable = nativeFault(14, "fictional response unavailable"); let committedResult;
  const wrapper = transactionAdapter(async action => {
    if (committedBeforeFailure) {
      committedResult = await db.runTransaction(action); // Actual atomic commit precedes the lost response.
      throw unavailable;
    }
    return db.runTransaction(async tx => { await action(tx); throw unavailable; }, { maxAttempts: 1 });
  });
  await assert.rejects(handlerFor(serviceFor(wrapper))(await handlerRequest(f)), error => {
    assert.equal(error.code, "unavailable"); assert.equal(error.details.code, "CONFIRMATION_UNAVAILABLE");
    assert.equal(error.details.retryable, true); assert.equal(error.details.outcomeUnknown, true);
    return true;
  });
  const afterFailure = await effects(f);
  if (committedBeforeFailure) {
    assert.equal(afterFailure.logs.filter(log => log.tipo === "salida").length, 1);
    assert.equal(afterFailure.receipts.length, 1); assert.equal(afterFailure.state.version, 2);
    assert.equal(afterFailure.state.lastRequestId, f.request.requestId);
  } else assert.deepEqual(afterFailure, before);
  const retry = await service({ data: f.request, identity: f.identity });
  assert.equal(retry.replayed, committedBeforeFailure);
  if (committedBeforeFailure) assert.deepEqual(retry.result, committedResult.result);
  const committed = await effects(f);
  assert.equal(committed.logs.filter(log => log.tipo === "salida").length, 1);
  assert.equal(committed.receipts.length, 1); assert.equal(committed.state.version, 2);
  assert.equal(committed.receipts[0].id, keyFor(f));
  if (committedBeforeFailure) assert.deepEqual(committed, afterFailure);
  const replay = await service({ data: f.request, identity: f.identity });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.result, retry.result);
  assert.deepEqual(await effects(f), committed); assert.deepEqual(await originalSnapshot(f), original);
});

test("business version conflicts remain distinct from native confirmation failures", async () => {
  const f = await fixture(), before = await effects(f), original = await originalSnapshot(f);
  const request = await handlerRequest(f); request.data = { ...f.request, expectedStateVersion: 0 };
  await assert.rejects(handlerFor(service)(request), error => {
    assert.equal(error.code, "failed-precondition"); assert.equal(error.details.code, "VERSION_CONFLICT");
    assert.equal(error.details.retryable, false); assert.equal(error.details.outcomeUnknown, undefined);
    return true;
  });
  assert.deepEqual(await effects(f), before); assert.deepEqual(await originalSnapshot(f), original);
});
