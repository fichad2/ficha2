import assert from "node:assert/strict";
import { test, after } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createClockInService, ClockInError } from "../../functions/src/clock-in-service.js";
import { createClockInHandler } from "../../functions/src/clock-in-callable.js";
import { assertEmulatorEnvironment } from "../../functions/src/emulator-environment.js";
const local = assertEmulatorEnvironment(process.env);
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { Firestore, Timestamp, FieldValue } = require("firebase-admin/firestore");
const app = initializeApp({ projectId: local.projectId, credential: {
  async getAccessToken() { return { access_token: "owner", expires_in: 3600 }; },
} }, "clock-in-tests");
const auth = getAuth(app);
const db = new Firestore({ projectId: local.projectId, host: local.firestore, ssl: false,
  credentials: { client_email: "emulator@example.invalid", private_key: "emulator-only-not-a-private-key" } });
after(async () => { await db.terminate(); await deleteApp(app); });
const environment = () => process.env;
const serviceFor = (firestore = db, env = environment) => createClockInService({ firestore, environment: env,
  now: () => Timestamp.now(), serverTimestamp: () => FieldValue.serverTimestamp() });
const service = serviceFor();
const stateFor = (uid, companyId) => ({ schemaVersion: 1, companyId, userId: uid, status: "idle", version: 0,
  activeEntryId: null, openedAt: null, reviewReason: null, lastResolution: null, lastRequestId: null,
  initializationId: "fictional-initialization", sourceDigest: "fictional-source-preserved" });
async function fixture({ verified = true, profile = true, company = true, state = true, role = "trabajador" } = {}) {
  assertEmulatorEnvironment(process.env);
  const uid = "test-" + randomUUID(), companyId = "company-" + randomUUID();
  const email = uid + "@example.invalid", password = "Fictional-local-password-33";
  await auth.createUser({ uid, email, password, emailVerified: verified });
  const writes = [];
  if (profile) writes.push(db.doc("users/" + uid).set({ companyId, role }));
  if (company) writes.push(db.doc("companies/" + companyId).set({ name: "Fictional company" }));
  writes.push(db.doc("companies/" + companyId + "/session_control/config").set({ companyId, writeMode: "backend", epoch: 7, minProtocolVersion: 1, note: "trusted metadata" }));
  if (state) writes.push(db.doc("companies/" + companyId + "/session_states/" + uid).set(stateFor(uid, companyId)));
  await Promise.all(writes);
  const response = await fetch("http://" + local.auth + "/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-emulator-key", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }), signal: AbortSignal.timeout(120000),
  });
  const signedIn = await response.json(); assert.equal(response.status, 200);
  return { uid, companyId, token: signedIn.idToken, identity: { uid, emailVerified: verified },
    request: { operation: "clockIn", requestId: randomUUID(), companyContext: companyId, expectedStateVersion: 0, expectedEpoch: 7, protocolVersion: 1 } };
}
async function call(f, data = f.request, token = f.token) {
  const response = await fetch("http://" + local.functions + "/" + local.projectId + "/us-central1/clockIn", {
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
test("valid callable atomically creates one original log, state and receipt using server time", async () => {
  const f = await fixture(); const before = Date.now(); const response = await call(f); const after = Date.now();
  assert.equal(response.status, 200); assert.equal(response.result.ok, true); assert.equal(response.result.replayed, false);
  const e = await effects(f); assert.equal(e.logs.length, 1); assert.equal(e.receipts.length, 1);
  assert.deepEqual(Object.keys(e.logs[0]).sort(), ["companyId", "id", "timestamp", "tipo", "userId"]);
  assert.equal(e.logs[0].id, response.result.result.eventId); assert.equal(e.logs[0].companyId, f.companyId);
  assert.equal(e.logs[0].tipo, "entrada"); assert.ok(e.logs[0].timestamp.toMillis() >= before && e.logs[0].timestamp.toMillis() <= after);
  assert.equal(e.state.status, "open"); assert.equal(e.state.version, 1); assert.equal(e.state.activeEntryId, e.logs[0].id);
  assert.ok(e.state.openedAt.isEqual(e.logs[0].timestamp)); assert.equal(e.state.sourceDigest, "fictional-source-preserved");
  assert.equal(e.state.initializationId, "fictional-initialization"); assert.ok(e.state.updatedAt instanceof Timestamp);
  assert.ok(e.receipts[0].committedAt instanceof Timestamp); assert.equal(e.receipts[0].id, keyFor(f));
  assert.deepEqual(e.receipts[0].result, response.result.result);
});
test("anonymous callable is rejected without writes", async () => { const f = await fixture(); await denied(f, "UNAUTHENTICATED", f.request, null); });
test("invalid token is rejected by callable authentication", async () => {
  const f = await fixture(); const response = await call(f, f.request, "invalid-local-token");
  assert.equal(response.error.status, "UNAUTHENTICATED"); assert.equal((await effects(f)).logs.length, 0);
});
test("unverified email is rejected", async () => { const f = await fixture({ verified: false }); await denied(f, "EMAIL_NOT_VERIFIED"); });
test("server verification alone does not accept a stale unverified token", async () => {
  const f = await fixture({ verified: false }); await auth.updateUser(f.uid, { emailVerified: true }); await denied(f, "EMAIL_NOT_VERIFIED");
});
test("current Auth record can revoke email verification despite an old verified token", async () => {
  const f = await fixture(); await auth.updateUser(f.uid, { emailVerified: false }); await denied(f, "EMAIL_NOT_VERIFIED");
});
test("disabled worker cannot clock in with an existing token", async () => {
  const f = await fixture(); await auth.updateUser(f.uid, { disabled: true }); await denied(f, "UNAUTHENTICATED");
});
test("missing server profile is rejected", async () => { const f = await fixture({ profile: false }); await denied(f, "PROFILE_NOT_FOUND"); });
test("missing company is rejected", async () => { const f = await fixture({ company: false }); await denied(f, "COMPANY_NOT_FOUND"); });
test("company context cannot override the current server profile", async () => {
  const f = await fixture(); await denied(f, "COMPANY_MISMATCH", { ...f.request, companyContext: "other-company" });
});
test("server role is authoritative", async () => { const f = await fixture({ role: "intruder" }); await denied(f, "FORBIDDEN"); });
test("state from another company cannot be used", async () => {
  const f = await fixture(); await db.doc("companies/" + f.companyId + "/session_states/" + f.uid).update({ companyId: "other-company" }); await denied(f, "COMPANY_MISMATCH");
});
test("state for another worker cannot be used", async () => {
  const f = await fixture(); await db.doc("companies/" + f.companyId + "/session_states/" + f.uid).update({ userId: "other-user" }); await denied(f, "FORBIDDEN");
});
test("absent state is never silently initialized", async () => { const f = await fixture({ state: false }); await denied(f, "STATE_UNINITIALIZED"); });
test("already open session prevents a new entry", async () => {
  const f = await fixture(); await call(f); f.request = { ...f.request, requestId: randomUUID(), expectedStateVersion: 1 }; await denied(f, "SESSION_ALREADY_OPEN");
});
test("session explicitly awaiting review prevents entry", async () => {
  const f = await fixture(); await db.doc("companies/" + f.companyId + "/session_states/" + f.uid).update({ status: "needs_review", activeEntryId: "fictional-old-entry", openedAt: Timestamp.now(), reviewReason: "manual_review" });
  await denied(f, "REGULARIZATION_REQUIRED");
});
test("open session older than 24 hours requires review without modifying its original", async () => {
  const f = await fixture(); await db.doc("companies/" + f.companyId + "/session_states/" + f.uid).update({ status: "open", activeEntryId: "fictional-old-entry", openedAt: Timestamp.fromMillis(Date.now() - 86400001) });
  await denied(f, "REGULARIZATION_REQUIRED");
});
test("incorrect expected version is rejected", async () => { const f = await fixture(); await denied(f, "VERSION_CONFLICT", { ...f.request, expectedStateVersion: 5 }); });
test("incorrect epoch is rejected", async () => { const f = await fixture(); await denied(f, "EPOCH_CONFLICT", { ...f.request, expectedEpoch: 6 }); });
for (const mode of ["paused", "legacy"]) test("new entry is blocked in " + mode + " mode", async () => {
  const f = await fixture(); await db.doc("companies/" + f.companyId + "/session_control/config").update({ writeMode: mode }); await denied(f, "SERVICE_PAUSED");
});
test("missing control fails closed", async () => {
  const f = await fixture(); await db.doc("companies/" + f.companyId + "/session_control/config").delete(); await denied(f, "INVALID_CONTROL");
});
for (const [field, value] of Object.entries({ uid: "other-user", userId: "other-user", companyId: "other-company", role: "administrador", timestamp: 1, minutes: 5 })) test("client protected field rejected: " + field, async () => {
  const f = await fixture(); await denied(f, "INVALID_REQUEST", { ...f.request, [field]: value });
});
for (const operation of ["clockOut", "regularizeSession"]) test("entry endpoint does not implement " + operation, async () => {
  const f = await fixture(); await denied(f, "INVALID_REQUEST", { ...f.request, operation });
});
test("identical retry returns committed result without any document changes", async () => {
  const f = await fixture(); const first = await call(f); const before = await effects(f); const retry = await call(f);
  assert.equal(retry.result.replayed, true); assert.deepEqual(retry.result.result, first.result.result); assert.deepEqual(await effects(f), before);
});
test("same request ID with a contradictory version is rejected", async () => {
  const f = await fixture(); await call(f); await denied(f, "REQUEST_ID_CONFLICT", { ...f.request, expectedStateVersion: 1 });
});
test("UUID normalization keeps retries stable", async () => {
  const f = await fixture(); const first = await call(f); const retry = await call(f, { ...f.request, requestId: f.request.requestId.toUpperCase() });
  assert.equal(retry.result.replayed, true); assert.deepEqual(retry.result.result, first.result.result); assert.equal((await effects(f)).logs.length, 1);
});
test("confirmed retry remains valid during pause and after epoch change", async () => {
  const f = await fixture(); const first = await call(f);
  await db.doc("companies/" + f.companyId + "/session_control/config").update({ writeMode: "paused", epoch: 8 });
  const retry = await call(f); assert.equal(retry.result.replayed, true); assert.deepEqual(retry.result.result, first.result.result); assert.equal((await effects(f)).logs.length, 1);
});
test("changed company profile cannot recover or write another company's receipt", async () => {
  const f = await fixture(); await call(f); await db.doc("users/" + f.uid).update({ companyId: "new-company" }); await denied(f, "COMPANY_MISMATCH");
});
test("two simultaneous clicks with same ID commit once and replay once", async () => {
  const f = await fixture(); const responses = await Promise.all([call(f), call(f)]);
  assert.deepEqual(responses.map(r => r.result?.replayed).sort(), [false, true]);
  assert.deepEqual(responses[0].result.result, responses[1].result.result);
  const e = await effects(f); assert.equal(e.logs.length, 1); assert.equal(e.receipts.length, 1); assert.equal(e.state.version, 1);
});
test("two devices with distinct request IDs cannot open two sessions", async () => {
  const f = await fixture(); const responses = await Promise.all([call(f), call(f, { ...f.request, requestId: randomUUID() })]);
  assert.equal(responses.filter(r => r.result?.ok).length, 1); assert.equal(responses.find(r => r.error)?.error.details.code, "VERSION_CONFLICT");
  const e = await effects(f); assert.equal(e.logs.length, 1); assert.equal(e.receipts.length, 1); assert.equal(e.state.version, 1);
});
test("20 concurrent independent requests produce exactly one entry", async () => {
  const f = await fixture(); const decisions = await Promise.all(Array.from({ length: 20 }, () => service({ data: { ...f.request, requestId: randomUUID() }, identity: f.identity }).then(r => ({ ok: true, result: r }), e => ({ ok: false, code: e.code }))));
  assert.equal(decisions.filter(r => r.ok).length, 1); assert.ok(decisions.filter(r => !r.ok).every(r => r.code === "VERSION_CONFLICT"));
  const e = await effects(f); assert.equal(e.logs.length, 1); assert.equal(e.receipts.length, 1); assert.equal(e.state.version, 1);
});
test("real emulator commit failure rolls back log and state with no partial writes", async () => {
  const f = await fixture(); const before = await effects(f); const occupied = db.doc("phase3_test_faults/" + randomUUID()); await occupied.create({ marker: "keep" });
  const wrapper = { projectId: local.projectId, doc: p => db.doc(p), runTransaction: action => db.runTransaction(tx => action({
    get: ref => tx.get(ref), getAll: (...refs) => tx.getAll(...refs), update: (ref, data) => tx.update(ref, data),
    create: (ref, data) => tx.create(ref.path.includes("/session_requests/") ? occupied : ref, data),
  })) };
  await assert.rejects(serviceFor(wrapper)({ data: f.request, identity: f.identity }), e => e.code === 6);
  assert.deepEqual(await effects(f), before); assert.deepEqual((await occupied.get()).data(), { marker: "keep" });
});
test("existing deterministic log ID cannot be overwritten and aborts state and receipt", async () => {
  const f = await fixture(); const ref = db.doc("logs/entry_" + keyFor(f)); await ref.create({ userId: f.uid, companyId: f.companyId, tipo: "entrada", timestamp: Timestamp.fromMillis(1), marker: "original" });
  const before = await effects(f); const response = await call(f); assert.equal(response.error.details.code, "CONFIRMATION_UNAVAILABLE"); assert.deepEqual(await effects(f), before);
});
test("corrupt receipt cannot be treated as success", async () => {
  const f = await fixture(); await db.doc("companies/" + f.companyId + "/session_requests/" + keyFor(f)).create({ marker: "invalid" }); await denied(f, "INVALID_RECEIPT");
});
test("wrong project environment prevents any adapter access", async () => {
  let touched = false; const firestore = { projectId: local.projectId, doc() { touched = true; }, runTransaction() { touched = true; } };
  const execute = serviceFor(firestore, () => ({ ...process.env, GCLOUD_PROJECT: "fichad2-piloto" }));
  await assert.rejects(execute({ data: {}, identity: null }), { code: "EMULATOR_ISOLATION" }); assert.equal(touched, false);
});
test("Firestore instance from another project is rejected before any access", async () => {
  let touched = false; const execute = serviceFor({ projectId: "fichad2-piloto", runTransaction() { touched = true; } });
  await assert.rejects(execute({ data: {}, identity: null }), { code: "EMULATOR_ISOLATION" }); assert.equal(touched, false);
});
test("non-loopback runtime prevents Auth and Firestore access", async () => {
  let touched = false; class HttpError extends Error { constructor(status, message, details) { super(message); this.details = details; } }
  const handler = createClockInHandler({ environment: () => ({ ...process.env, FIRESTORE_EMULATOR_HOST: "remote:443" }),
    readUser: async () => { touched = true; }, execute: async () => { touched = true; }, HttpsError: HttpError });
  await assert.rejects(handler({ auth: { uid: "fictional" } }), e => e.details.code === "EMULATOR_ISOLATION"); assert.equal(touched, false);
});
test("uncertain commit produces a retryable message, never a false confirmation", async () => {
  class HttpError extends Error { constructor(status, message, details) { super(message); this.status = status; this.details = details; } }
  const handler = createClockInHandler({ environment, readUser: async () => ({ uid: "fictional", disabled: false, emailVerified: true }),
    execute: async () => { throw new Error("fictional transport interruption"); }, HttpsError: HttpError });
  await assert.rejects(handler({ auth: { uid: "fictional", token: { email_verified: true } }, data: {} }), e => e.status === "unavailable" && e.details.outcomeUnknown && e.details.retryable);
});

test("malformed request ID is rejected before creating a receipt", async () => {
  const f = await fixture(); await denied(f, "INVALID_REQUEST", { ...f.request, requestId: "not-a-uuid" });
});
test("unsupported protocol is rejected", async () => {
  const f = await fixture(); await denied(f, "UNSUPPORTED_PROTOCOL", { ...f.request, protocolVersion: 2 });
});
test("20 simultaneous identical requests share one immutable receipt", async () => {
  const f = await fixture(); const responses = await Promise.all(Array.from({ length: 20 }, () => service({ data: f.request, identity: f.identity })));
  assert.equal(responses.filter(r => !r.replayed).length, 1); assert.equal(responses.filter(r => r.replayed).length, 19);
  for (const r of responses) assert.deepEqual(r.result, responses[0].result);
  const e = await effects(f); assert.equal(e.logs.length, 1); assert.equal(e.receipts.length, 1); assert.equal(e.state.version, 1);
});
test("token refresh after email verification allows entry", async () => {
  const f = await fixture({ verified: false }); await auth.updateUser(f.uid, { emailVerified: true });
  // Obtain a new ID token from the emulator, without changing the account's credentials.
  const customToken = await auth.createCustomToken(f.uid);
  const response = await fetch("http://" + local.auth + "/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-emulator-key", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: customToken, returnSecureToken: true }), signal: AbortSignal.timeout(120000),
  });
  assert.equal(response.status, 200); f.token = (await response.json()).idToken;
  const entry = await call(f); assert.equal(entry.result?.ok, true, JSON.stringify(entry)); assert.equal((await effects(f)).logs.length, 1);
});

test("control cannot redirect an operation to another company", async () => {
  const f = await fixture(); await db.doc("companies/" + f.companyId + "/session_control/config").update({ companyId: "other-company" }); await denied(f, "COMPANY_MISMATCH");
});
test("invalid server company identifier fails before constructing document paths", async () => {
  const f = await fixture(); await db.doc("users/" + f.uid).update({ companyId: "invalid/company" }); await denied(f, "FORBIDDEN");
});
