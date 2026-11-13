import assert from "node:assert/strict";
import { test, after } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createRegularizeSessionService } from "../../functions/src/regularize-session-service.js";
import { validateOverdueRegularization } from "../../functions/src/session-domain.js";
import { assertEmulatorEnvironment } from "../../functions/src/emulator-environment.js";
const local = assertEmulatorEnvironment(process.env);
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { Firestore, Timestamp, FieldValue } = require("firebase-admin/firestore");
const app = initializeApp({ projectId: local.projectId, credential: {
  async getAccessToken() { return { access_token: "owner", expires_in: 3600 }; },
} }, "regularize-tests");
const auth = getAuth(app);
const db = new Firestore({ projectId: local.projectId, host: local.firestore, ssl: false,
  credentials: { client_email: "emulator@example.invalid", private_key: "emulator-only-not-a-private-key" } });
after(async () => { await db.terminate(); await deleteApp(app); });
const environment = () => process.env;
const serviceFor = (firestore = db, clock = () => Timestamp.now(), env = environment) => createRegularizeSessionService({
  firestore, environment: env, now: clock, serverTimestamp: () => FieldValue.serverTimestamp(),
  toTimestamp: ({ seconds, nanoseconds }) => new Timestamp(seconds, nanoseconds),
});
const service = serviceFor();
const jsonTime = t => ({ seconds: t.seconds, nanoseconds: t.nanoseconds });
async function actor(companyId, { role = "administrador", verified = true, profile = true } = {}) {
  assertEmulatorEnvironment(process.env);
  const uid = "reg-" + randomUUID(), email = uid + "@example.invalid", password = "Fictional-local-password-35";
  await auth.createUser({ uid, email, password, emailVerified: verified });
  if (profile) await db.doc("users/" + uid).set({ companyId, role });
  const response = await fetch("http://" + local.auth + "/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-emulator-key", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }), signal: AbortSignal.timeout(180000),
  });
  assert.equal(response.status, 200); return { uid, token: (await response.json()).idToken, identity: { uid, emailVerified: verified } };
}
async function fixture({ mode = "accredited_exit", openedAt = Timestamp.fromMillis(Date.now() - 49 * 3600000),
  adminRole = "administrador", adminVerified = true, adminProfile = true, original = true, state = true } = {}) {
  const companyId = "company-" + randomUUID();
  const admin = await actor(companyId, { role: adminRole, verified: adminVerified, profile: adminProfile });
  const worker = await actor(companyId, { role: "trabajador" });
  const entryId = "entry-fixture-" + randomUUID(), exitAt = Timestamp.fromMillis(openedAt.toMillis() + 8 * 3600000);
  await db.doc("companies/" + companyId).create({ name: "Fictional company" });
  await db.doc("companies/" + companyId + "/session_control/config").create({ companyId, writeMode: "backend", epoch: 7, minProtocolVersion: 1 });
  if (original) await db.doc("logs/" + entryId).create({ userId: worker.uid, companyId, tipo: "entrada", timestamp: openedAt, marker: "immutable-original", custom: { source: "fictional" } });
  if (state) await db.doc("companies/" + companyId + "/session_states/" + worker.uid).create({ schemaVersion: 1,
    companyId, userId: worker.uid, status: "open", version: 1, activeEntryId: entryId, openedAt,
    reviewReason: null, lastResolution: null, lastRequestId: null, initializationId: "fictional-init", sourceDigest: "preserved-source" });
  return { companyId, admin, worker, entryId, openedAt, exitAt,
    request: { operation: "regularizeSession", requestId: randomUUID(), companyContext: companyId, expectedStateVersion: 1, expectedEpoch: 7, protocolVersion: 1,
      originalEntryId: entryId, mode, reason: "Salida olvidada; documentación revisada por el administrador.",
      evidenceReference: mode === "accredited_exit" ? "fixture-evidence-35" : null,
      accreditedExitAt: mode === "accredited_exit" ? jsonTime(exitAt) : null } };
}
const stateRef = f => db.doc("companies/" + f.companyId + "/session_states/" + f.worker.uid);
const regRef = f => db.doc("companies/" + f.companyId + "/regularizations/" + f.entryId);
const controlRef = f => db.doc("companies/" + f.companyId + "/session_control/config");
const keyFor = f => createHash("sha256").update(JSON.stringify([1, f.companyId, f.admin.uid, f.request.requestId.toLowerCase()])).digest("hex");
async function call(f, data = f.request, token = f.admin.token, operation = "regularizeSession") {
  const response = await fetch("http://" + local.functions + "/" + local.projectId + "/us-central1/" + operation, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: JSON.stringify({ data }), signal: AbortSignal.timeout(180000),
  });
  return { status: response.status, ...await response.json() };
}
async function effects(f) {
  const [logs, state, regs, receipts] = await Promise.all([db.collection("logs").where("userId", "==", f.worker.uid).get(), stateRef(f).get(),
    db.collection("companies/" + f.companyId + "/regularizations").get(), db.collection("companies/" + f.companyId + "/session_requests").get()]);
  const snapshot = d => ({ id: d.id, data: d.data(), updateTime: d.updateTime });
  return { logs: logs.docs.map(snapshot), state: state.exists ? snapshot(state) : null, regs: regs.docs.map(snapshot), receipts: receipts.docs.map(snapshot) };
}
async function denied(f, code, data = f.request, token = f.admin.token) {
  const before = await effects(f), response = await call(f, data, token);
  assert.equal(response.error?.details?.code, code, JSON.stringify(response)); assert.deepEqual(await effects(f), before); return response;
}
async function directDenied(f, code, clock, data = f.request) {
  const before = await effects(f); await assert.rejects(serviceFor(db, clock)({ data, identity: f.admin.identity }), { code }); assert.deepEqual(await effects(f), before);
}
for (const mode of ["accredited_exit", "unknown_exit"]) test("atomic administrative resolution: " + mode, async () => {
  const f = await fixture({ mode }), before = await effects(f), start = Date.now(), response = await call(f), end = Date.now();
  assert.equal(response.status, 200, JSON.stringify(response)); assert.equal(response.result.ok, true); assert.equal(response.result.replayed, false);
  const e = await effects(f); assert.deepEqual(e.logs, before.logs); assert.equal(e.regs.length, 1); assert.equal(e.receipts.length, 1);
  const reg = e.regs[0].data, receipt = e.receipts[0].data;
  assert.equal(e.regs[0].id, f.entryId); assert.equal(reg.originalEntryId, f.entryId); assert.equal(reg.workerUid, f.worker.uid); assert.equal(reg.companyId, f.companyId);
  assert.equal(reg.adminUid, f.admin.uid); assert.equal(reg.reason, f.request.reason); assert.equal(reg.requestId, f.request.requestId);
  assert.equal(reg.mode, mode); assert.equal(reg.status, mode === "accredited_exit" ? "resolved_known" : "resolved_unknown");
  assert.ok(reg.regularizedAt instanceof Timestamp); assert.ok(reg.regularizedAt.toMillis() >= start && reg.regularizedAt.toMillis() <= end); assert.ok(reg.committedAt instanceof Timestamp);
  assert.equal(reg.effectiveMinutes, mode === "accredited_exit" ? 480 : null);
  if (mode === "accredited_exit") { assert.ok(reg.accreditedExitAt.isEqual(f.exitAt)); assert.equal(reg.evidenceReference, f.request.evidenceReference); }
  else { assert.equal(reg.accreditedExitAt, null); assert.equal(reg.evidenceReference, null); }
  assert.equal(e.state.data.status, "regularized"); assert.equal(e.state.data.version, 2); assert.equal(e.state.data.activeEntryId, null); assert.equal(e.state.data.openedAt, null);
  assert.equal(e.state.data.sourceDigest, "preserved-source"); assert.equal(e.state.data.initializationId, "fictional-init");
  assert.equal(e.state.data.lastResolution.minutes, reg.effectiveMinutes); assert.equal(e.state.data.lastResolution.adminUid, f.admin.uid);
  assert.equal(receipt.actorUid, f.admin.uid); assert.equal(receipt.workerUid, f.worker.uid); assert.equal(receipt.companyId, f.companyId); assert.equal(e.receipts[0].id, keyFor(f));
  assert.deepEqual(receipt.result, response.result.result); assert.equal(receipt.result.minutes, reg.effectiveMinutes); assert.ok(receipt.committedAt instanceof Timestamp);
});
test("anonymous cannot regularize", async () => { const f = await fixture(); await denied(f, "UNAUTHENTICATED", f.request, null); });
test("worker cannot regularize another worker", async () => { const f = await fixture({ adminRole: "trabajador" }); await denied(f, "FORBIDDEN"); });
test("worker cannot regularize their own entry", async () => { const f = await fixture(); await denied(f, "FORBIDDEN", f.request, f.worker.token); });
test("administrator must have verified email", async () => { const f = await fixture({ adminVerified: false }); await denied(f, "EMAIL_NOT_VERIFIED"); });
test("current Auth verification is checked, not just the old token", async () => {
  const f = await fixture(); await auth.updateUser(f.admin.uid, { emailVerified: false }); await denied(f, "EMAIL_NOT_VERIFIED");
});
test("disabled administrator cannot regularize", async () => { const f = await fixture(); await auth.updateUser(f.admin.uid, { disabled: true }); await denied(f, "UNAUTHENTICATED"); });
test("administrator needs a current server profile", async () => { const f = await fixture({ adminProfile: false }); await denied(f, "PROFILE_NOT_FOUND"); });
test("revoked admin role is effective with the same token", async () => {
  const f = await fixture(); await db.doc("users/" + f.admin.uid).update({ role: "trabajador" }); await denied(f, "FORBIDDEN");
});
test("administrator from another company cannot target the entry", async () => {
  const f = await fixture(), foreign = await actor("foreign-company");
  await denied(f, "COMPANY_MISMATCH", f.request, foreign.token);
});
test("forged company assertion cannot override the administrator profile", async () => {
  const f = await fixture(); await denied(f, "COMPANY_MISMATCH", { ...f.request, companyContext: "foreign-company" });
});
test("original belonging to another company is rejected", async () => {
  const f = await fixture(); await db.doc("logs/" + f.entryId).update({ companyId: "foreign-company" }); await denied(f, "COMPANY_MISMATCH");
});
test("current worker must still belong to the company", async () => {
  const f = await fixture(); await db.doc("users/" + f.worker.uid).update({ companyId: "foreign-company" }); await denied(f, "COMPANY_MISMATCH");
});
test("missing worker profile is rejected", async () => {
  const f = await fixture(); await db.doc("users/" + f.worker.uid).delete(); await denied(f, "WORKER_PROFILE_NOT_FOUND");
});
test("state cannot impersonate a different worker", async () => {
  const f = await fixture(); await stateRef(f).update({ userId: "another-worker" }); await denied(f, "REFERENCE_MISMATCH");
});
test("state from another company is rejected", async () => {
  const f = await fixture(); await stateRef(f).update({ companyId: "foreign-company" }); await denied(f, "COMPANY_MISMATCH");
});
test("missing entry is rejected", async () => { const f = await fixture({ original: false }); await denied(f, "REFERENCE_MISMATCH"); });
test("original must be an entry", async () => {
  const f = await fixture(); await db.doc("logs/" + f.entryId).update({ tipo: "salida" }); await denied(f, "REFERENCE_MISMATCH");
});
test("missing state is never silently initialized", async () => { const f = await fixture({ state: false }); await denied(f, "STATE_UNINITIALIZED"); });
test("closed state cannot be regularized", async () => {
  const f = await fixture(); await stateRef(f).update({ status: "idle", activeEntryId: null, openedAt: null }); await denied(f, "NO_OPEN_SESSION");
});
test("existing linked exit blocks a contradictory regularization", async () => {
  const f = await fixture(); await db.collection("logs").add({ tipo: "salida", userId: f.worker.uid, companyId: f.companyId, timestamp: f.exitAt, entradaLogId: f.entryId });
  await denied(f, "ALREADY_CLOSED");
});
test("under 24 hours cannot be regularized", async () => {
  const f = await fixture({ mode: "unknown_exit", openedAt: Timestamp.fromMillis(Date.now() - 3600000) }); await denied(f, "REGULARIZATION_NOT_DUE");
});
test("exactly 24 hours is not overdue", async () => {
  const f = await fixture({ mode: "unknown_exit", openedAt: new Timestamp(1767254400, 0) }); await directDenied(f, "REGULARIZATION_NOT_DUE", () => new Timestamp(1767340800, 0));
});
test("24 hours plus one microsecond permits regularization", async () => {
  const f = await fixture({ mode: "unknown_exit", openedAt: new Timestamp(1767254400, 0) });
  const result = await serviceFor(db, () => new Timestamp(1767340800, 1000))({ data: f.request, identity: f.admin.identity }); assert.equal(result.ok, true); assert.equal(result.result.minutes, null);
});
test("pure eligibility retains the nanosecond boundary", () => {
  const state = { schemaVersion: 1, companyId: "fictional-company", userId: "fictional-worker", status: "open", version: 1,
    activeEntryId: "fictional-entry", openedAt: { seconds: 1767254400, nanoseconds: 0 }, reviewReason: null, lastResolution: null, lastRequestId: null };
  assert.equal(validateOverdueRegularization(state, { seconds: 1767340800, nanoseconds: 0 }).error.code, "REGULARIZATION_NOT_DUE");
  assert.equal(validateOverdueRegularization(state, { seconds: 1767340800, nanoseconds: 1 }).ok, true);
});
test("manual review does not bypass the overdue requirement", async () => {
  const f = await fixture({ mode: "unknown_exit", openedAt: Timestamp.fromMillis(Date.now() - 3600000) });
  await stateRef(f).update({ status: "needs_review", reviewReason: "manual_review" }); await denied(f, "REGULARIZATION_NOT_DUE");
});
for (const reason of ["", "   "]) test("mandatory reason rejected: " + JSON.stringify(reason), async () => { const f = await fixture(); await denied(f, "INVALID_REQUEST", { ...f.request, reason }); });
test("accredited exit requires an evidence reference", async () => { const f = await fixture(); await denied(f, "INVALID_REQUEST", { ...f.request, evidenceReference: " " }); });
test("unknown exit cannot smuggle a date or evidence", async () => {
  const f = await fixture({ mode: "unknown_exit" }); await denied(f, "INVALID_REQUEST", { ...f.request, accreditedExitAt: jsonTime(f.exitAt) });
  await denied(f, "INVALID_REQUEST", { ...f.request, evidenceReference: "unapproved-extra-data" });
});
test("exit before entry is rejected", async () => {
  const f = await fixture(); await denied(f, "INVALID_TIME", { ...f.request, accreditedExitAt: jsonTime(Timestamp.fromMillis(f.openedAt.toMillis() - 1)) });
});
test("exit equal to entry is rejected", async () => { const f = await fixture(); await denied(f, "INVALID_TIME", { ...f.request, accreditedExitAt: jsonTime(f.openedAt) }); });
test("future accredited exit is rejected", async () => {
  const f = await fixture(); await denied(f, "INVALID_TIME", { ...f.request, accreditedExitAt: jsonTime(Timestamp.fromMillis(Date.now() + 3600000)) });
});
test("accredited duration above 24h is rejected", async () => {
  const f = await fixture(); await denied(f, "DURATION_EXCEEDED", { ...f.request, accreditedExitAt: jsonTime(Timestamp.fromMillis(f.openedAt.toMillis() + 86400001)) });
});
test("exactly 1440 accredited minutes are permitted for an overdue incident", async () => {
  const f = await fixture(); const response = await call(f, { ...f.request, accreditedExitAt: jsonTime(Timestamp.fromMillis(f.openedAt.toMillis() + 86400000)) });
  assert.equal(response.result?.result.minutes, 1440, JSON.stringify(response));
});
test("positive sub-minute accreditation is known zero minutes, never null", async () => {
  const f = await fixture(); const response = await call(f, { ...f.request, accreditedExitAt: jsonTime(Timestamp.fromMillis(f.openedAt.toMillis() + 1)) });
  assert.equal(response.result?.result.minutes, 0, JSON.stringify(response)); assert.equal((await regRef(f).get()).data().effectiveMinutes, 0);
});
test("unpersistible evidence precision is rejected without rounding", async () => {
  const f = await fixture(); await denied(f, "INVALID_TIME", { ...f.request, accreditedExitAt: { seconds: f.exitAt.seconds, nanoseconds: 1 } });
});
test("unpersistible server clock has no effects", async () => {
  const f = await fixture({ mode: "unknown_exit" }); await directDenied(f, "INVALID_TIME", () => new Timestamp(Math.floor(Date.now() / 1000), 1));
});
for (const mode of ["accredited_exit", "unknown_exit"]) test("later entry blocks operative reconstruction: " + mode, async () => {
  const f = await fixture({ mode }); await db.collection("logs").add({ tipo: "entrada", userId: f.worker.uid, companyId: f.companyId, timestamp: Timestamp.fromMillis(f.openedAt.toMillis() + 12 * 3600000) });
  await denied(f, "HISTORY_CONFLICT");
});
test("unreferenced later exit remains an ambiguity", async () => {
  const f = await fixture(); await db.collection("logs").add({ tipo: "salida", userId: f.worker.uid, companyId: f.companyId, timestamp: f.exitAt }); await denied(f, "HISTORY_CONFLICT");
});
test("duplicate entry instant is not selected arbitrarily", async () => {
  const f = await fixture(); await db.collection("logs").add({ tipo: "entrada", userId: f.worker.uid, companyId: f.companyId, timestamp: f.openedAt }); await denied(f, "HISTORY_CONFLICT");
});
test("original timestamp must match state including stored microseconds", async () => {
  const f = await fixture(); await db.doc("logs/" + f.entryId).update({ timestamp: new Timestamp(f.openedAt.seconds, f.openedAt.nanoseconds + 1000) }); await denied(f, "REFERENCE_MISMATCH");
});
test("state cannot point at a different entry", async () => {
  const f = await fixture(); await stateRef(f).update({ activeEntryId: "other-entry" }); await denied(f, "REFERENCE_MISMATCH");
});
for (const [field, value] of Object.entries({ uid: "forged", workerUid: "forged", adminUid: "forged", companyId: "forged", role: "administrador", regularizedAt: 1, effectiveMinutes: 0, status: "resolved_known" })) test("protected identity/audit field rejected: " + field, async () => {
  const f = await fixture(); await denied(f, "INVALID_REQUEST", { ...f.request, [field]: value });
});
test("incorrect version is rejected", async () => { const f = await fixture(); await denied(f, "VERSION_CONFLICT", { ...f.request, expectedStateVersion: 0 }); });
test("incorrect epoch is rejected", async () => { const f = await fixture(); await denied(f, "EPOCH_CONFLICT", { ...f.request, expectedEpoch: 6 }); });
for (const writeMode of ["paused", "legacy"]) test("new resolution blocked in " + writeMode + " mode", async () => {
  const f = await fixture(); await controlRef(f).update({ writeMode }); await denied(f, "SERVICE_PAUSED");
});
test("identical retry returns previous resolution without any document change", async () => {
  const f = await fixture(), first = await call(f), before = await effects(f), replay = await call(f);
  assert.equal(replay.result.replayed, true); assert.deepEqual(replay.result.result, first.result.result); assert.deepEqual(await effects(f), before);
});
for (const field of ["reason", "evidenceReference", "accreditedExitAt", "mode"]) test("contradictory same-key retry rejected: " + field, async () => {
  const f = await fixture(); await call(f); let request = { ...f.request };
  if (field === "reason") request.reason = "Different reason";
  if (field === "evidenceReference") request.evidenceReference = "Different evidence";
  if (field === "accreditedExitAt") request.accreditedExitAt = jsonTime(Timestamp.fromMillis(f.exitAt.toMillis() + 1));
  if (field === "mode") Object.assign(request, { mode: "unknown_exit", evidenceReference: null, accreditedExitAt: null });
  await denied(f, "REQUEST_ID_CONFLICT", request);
});
test("double click creates one immutable resolution and one receipt", async () => {
  const f = await fixture(), results = await Promise.all([call(f), call(f)]);
  assert.deepEqual(results.map(r => r.result?.replayed).sort(), [false, true]); assert.deepEqual(results[0].result.result, results[1].result.result);
  const e = await effects(f); assert.equal(e.regs.length, 1); assert.equal(e.receipts.length, 1); assert.equal(e.state.data.version, 2); assert.equal(e.logs.length, 1);
});
test("two administrators proposing contradictory modes commit exactly one resolution", async () => {
  const f = await fixture(), second = await actor(f.companyId), before = await effects(f);
  const results = await Promise.all([call(f), call(f, { ...f.request, requestId: randomUUID(), mode: "unknown_exit", evidenceReference: null, accreditedExitAt: null }, second.token)]);
  assert.equal(results.filter(r => r.result?.ok).length, 1); assert.equal(results.find(r => r.error)?.error.details.code, "VERSION_CONFLICT");
  const e = await effects(f); assert.equal(e.regs.length, 1); assert.equal(e.receipts.length, 1); assert.equal(e.state.data.version, 2); assert.deepEqual(e.logs, before.logs);
  assert.ok([f.admin.uid, second.uid].includes(e.regs[0].data.adminUid));
});
test("same UUID from two admins still yields one resolution", async () => {
  const f = await fixture(), second = await actor(f.companyId), results = await Promise.all([call(f), call(f, f.request, second.token)]);
  assert.equal(results.filter(r => r.result?.ok).length, 1); assert.equal(results.find(r => r.error)?.error.details.code, "VERSION_CONFLICT");
  assert.equal((await effects(f)).regs.length, 1);
});
for (const mode of ["accredited_exit", "unknown_exit"]) test("worker can start and end a new session after " + mode + " without touching the old originals", async () => {
  const f = await fixture({ mode }), before = await effects(f), resolved = await call(f); assert.equal(resolved.result?.ok, true, JSON.stringify(resolved));
  const regularized = await effects(f), base = { requestId: randomUUID(), companyContext: f.companyId, expectedStateVersion: 2, expectedEpoch: 7, protocolVersion: 1 };
  const entry = await call(f, { ...base, operation: "clockIn" }, f.worker.token, "clockIn"); assert.equal(entry.result?.ok, true, JSON.stringify(entry));
  const exit = await call(f, { ...base, requestId: randomUUID(), operation: "clockOut", expectedStateVersion: 3 }, f.worker.token, "clockOut");
  assert.equal(exit.result?.ok, true, JSON.stringify(exit));
  const e = await effects(f); assert.equal(e.logs.length, 3); assert.deepEqual(e.logs.find(d => d.id === f.entryId), before.logs[0]); assert.deepEqual(e.regs, regularized.regs);
  const beforeReplay = await effects(f), replay = await call(f); assert.equal(replay.result.replayed, true); assert.deepEqual(replay.result.result, resolved.result.result); assert.deepEqual(await effects(f), beforeReplay);
});
test("existing canonical resolution is never overwritten", async () => {
  const f = await fixture(); await regRef(f).create({ originalEntryId: f.entryId, marker: "keep" }); await denied(f, "ALREADY_REGULARIZED");
});
test("noncanonical resolution referencing the entry blocks duplicates", async () => {
  const f = await fixture(); await db.collection("companies/" + f.companyId + "/regularizations").add({ originalEntryId: f.entryId, marker: "keep" }); await denied(f, "ALREADY_REGULARIZED");
});
test("real commit failure leaves logs, state, resolution and audit unchanged; retry recovers", async () => {
  const f = await fixture(), before = await effects(f), occupied = db.doc("phase3_test_faults/" + randomUUID()); await occupied.create({ marker: "keep" });
  const wrapper = { projectId: local.projectId, doc: p => db.doc(p), collection: p => db.collection(p), runTransaction: action => db.runTransaction(tx => action({
    get: ref => tx.get(ref), getAll: (...refs) => tx.getAll(...refs), update: (ref, data) => tx.update(ref, data),
    create: (ref, data) => tx.create(ref.path.includes("/session_requests/") ? occupied : ref, data),
  })) };
  await assert.rejects(serviceFor(wrapper)({ data: f.request, identity: f.admin.identity }), e => e.code === 6);
  assert.deepEqual(await effects(f), before); assert.deepEqual((await occupied.get()).data(), { marker: "keep" });
  const retry = await call(f); assert.equal(retry.result?.ok, true, JSON.stringify(retry)); assert.deepEqual((await effects(f)).logs, before.logs);
});
test("history read failure cannot produce a partial resolution", async () => {
  const f = await fixture(), before = await effects(f);
  const wrapper = { projectId: local.projectId, doc: p => db.doc(p), collection: p => db.collection(p), runTransaction: action => db.runTransaction(tx => action({
    get: ref => { if (typeof ref.where === "function") throw new Error("fictional query failure"); return tx.get(ref); }, getAll: (...refs) => tx.getAll(...refs),
    create: () => { throw new Error("unexpected write"); }, update: () => { throw new Error("unexpected write"); },
  })) };
  await assert.rejects(serviceFor(wrapper)({ data: f.request, identity: f.admin.identity }), /fictional query failure/); assert.deepEqual(await effects(f), before);
});
test("confirmed retry works during pause and epoch change", async () => {
  const f = await fixture(), first = await call(f); await controlRef(f).update({ writeMode: "paused", epoch: 8 });
  const replay = await call(f); assert.equal(replay.result.replayed, true); assert.deepEqual(replay.result.result, first.result.result);
});
test("losing admin privileges also prevents replay", async () => {
  const f = await fixture(); await call(f); await db.doc("users/" + f.admin.uid).update({ role: "trabajador" }); await denied(f, "FORBIDDEN");
});
test("wrong environment prevents every adapter call", async () => {
  for (const patch of [{ GCLOUD_PROJECT: "fichad2-piloto" }, { FIRESTORE_EMULATOR_HOST: "remote:443" }]) {
    let touched = false; const execute = serviceFor({ projectId: local.projectId, runTransaction() { touched = true; } }, () => Timestamp.now(), () => ({ ...process.env, ...patch }));
    await assert.rejects(execute({ data: {}, identity: null }), { code: "EMULATOR_ISOLATION" }); assert.equal(touched, false);
  }
});
test("foreign-project instance is rejected before any transaction", async () => {
  let touched = false; const execute = serviceFor({ projectId: "fichad2-piloto", runTransaction() { touched = true; } });
  await assert.rejects(execute({ data: {}, identity: null }), { code: "EMULATOR_ISOLATION" }); assert.equal(touched, false);
});

test("ordinary clockOut racing overdue regularization never creates a contradictory exit", async () => {
  const f = await fixture({ mode: "unknown_exit" }), before = await effects(f);
  const out = { operation: "clockOut", requestId: randomUUID(), companyContext: f.companyId, expectedStateVersion: 1, expectedEpoch: 7, protocolVersion: 1 };
  const [resolution, exit] = await Promise.all([call(f), call(f, out, f.worker.token, "clockOut")]);
  assert.equal(resolution.result?.ok, true, JSON.stringify(resolution)); assert.ok(["REGULARIZATION_REQUIRED", "VERSION_CONFLICT"].includes(exit.error?.details?.code), JSON.stringify(exit));
  const e = await effects(f); assert.deepEqual(e.logs, before.logs); assert.equal(e.regs.length, 1); assert.equal(e.receipts.length, 1);
});

test("foreign administrator with valid own-company context cannot regularize this company's original", async () => {
  const f = await fixture(), foreignCompany = "foreign-" + randomUUID(), foreign = await actor(foreignCompany);
  await db.doc("companies/" + foreignCompany).create({ name: "Fictional foreign company" });
  await db.doc("companies/" + foreignCompany + "/session_control/config").create({ companyId: foreignCompany, writeMode: "backend", epoch: 7, minProtocolVersion: 1 });
  await denied(f, "COMPANY_MISMATCH", { ...f.request, companyContext: foreignCompany }, foreign.token);
  assert.equal((await db.collection("companies/" + foreignCompany + "/session_requests").get()).size, 0);
  assert.equal((await db.collection("companies/" + foreignCompany + "/regularizations").get()).size, 0);
});
