import assert from "node:assert/strict";
import { test, after } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createRegularizeSessionService } from "../../functions/src/regularize-session-service.js";
import { ClockInError } from "../../functions/src/clock-in-service.js";
import { createRegularizeSessionHandler } from "../../functions/src/clock-in-callable.js";
import { validateOverdueRegularization } from "../../functions/src/session-domain.js";
import { assertEmulatorEnvironment } from "../../functions/src/emulator-environment.js";
const local = assertEmulatorEnvironment(process.env);
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { Firestore, Timestamp, FieldValue } = require("firebase-admin/firestore");
const { HttpsError } = require("firebase-functions/v2/https");
const app = initializeApp({ projectId: local.projectId, credential: {
  async getAccessToken() { return { access_token: "owner", expires_in: 3600 }; },
} }, "regularize-tests");
const auth = getAuth(app);
const db = new Firestore({ projectId: local.projectId, host: local.firestore, ssl: false,
  credentials: { client_email: "emulator@example.invalid", private_key: "emulator-only-not-a-private-key" } });
after(async () => { await db.terminate(); await deleteApp(app); });
const environment = () => process.env;
const serviceFor = (firestore = db, clock = () => Timestamp.now(), env = environment) => {
  const execute = createRegularizeSessionService({ firestore, environment: env, now: clock,
    serverTimestamp: () => FieldValue.serverTimestamp(),
    toTimestamp: ({ seconds, nanoseconds }) => new Timestamp(seconds, nanoseconds) });
  return input => execute({ ...input, reauthorize: input.reauthorize ?? (async identity => {
    const user = await auth.getUser(identity.uid);
    if (user.uid !== identity.uid || user.disabled) throw new ClockInError("UNAUTHENTICATED");
    if (!user.emailVerified) throw new ClockInError("EMAIL_NOT_VERIFIED");
  }) });
};
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

// Reporter-only diagnostics: never dump request bodies, tokens, Auth records,
// reasons, evidence or document payloads (including assertion diffs).
function diagnosticText(value) {
  return String(value ?? "")
    .replace(/-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?-----END [\w ]*PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]*(?=$|[^\w-])/g, "[REDACTED]")
    .replace(/((?:password|access_token|refresh_token|idToken|apiKey|private_key|reason|evidenceReference)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[REDACTED]")
    .slice(0, 1200);
}
function diagnosticError(error) {
  const callable = error?.kind === "callable_response" || error instanceof HttpsError;
  const code = callable ? error.details?.code ?? error.code : error?.code;
  const nativeStatus = Number.isInteger(code) && code >= 0 && code <= 16;
  return { category: code === "CONFIRMATION_UNAVAILABLE" ? "uncertain_confirmation"
    : error instanceof ClockInError || callable ? "business"
      : nativeStatus ? code === 10 ? "transaction" : "sdk_or_infrastructure" : "native_exception",
    code: typeof code === "number" ? code : typeof code === "string" ? diagnosticText(code) : null,
    message: diagnosticText(error?.message ?? "Non-Error rejection"),
    type: callable && !(error instanceof Error) ? "CallableHttpError" : diagnosticText(error?.constructor?.name ?? typeof error),
    outcomeUnknown: code === "CONFIRMATION_UNAVAILABLE" ? error.details?.outcomeUnknown === true : nativeStatus };
}
async function captureConcurrentResponse({ label, actorUid, request, run }) {
  const captured = { label, actorUid, requestId: request.requestId, operation: request.operation,
    outcome: "rejected", result: null, error: null, httpStatus: null };
  try {
    const response = await run(); captured.httpStatus = response.status ?? null;
    if (response.error) captured.error = { ...response.error, kind: "callable_response" };
    else { captured.outcome = "fulfilled"; captured.result = response.result; }
  } catch (error) { captured.error = error; }
  return captured;
}
async function originalSnapshot(f) {
  const document = await db.doc("logs/" + f.entryId).get();
  return { data: document.data(), updateTime: document.updateTime };
}
const concurrentBaseline = async f => ({ effects: await effects(f), original: await originalSnapshot(f) });
async function validateConcurrentRegularization({ f, scenario, responses, baseline, report,
  readEffects = () => effects(f), readOriginal = () => originalSnapshot(f) }) {
  // Independent settled reads happen before any expectation. A rejected/sync
  // throwing read or unexpected response cannot suppress the other snapshot.
  const snapshots = await Promise.allSettled([Promise.resolve().then(readEffects), Promise.resolve().then(readOriginal)]);
  const failures = [], check = (label, assertion) => {
    try { assertion(); }
    catch (error) { failures.push({ label, type: diagnosticText(error.constructor.name), message: "Assertion failed: " + label }); }
  };
  const e = snapshots[0].status === "fulfilled" ? snapshots[0].value : null;
  const winners = responses.filter(r => r.result?.ok === true && r.result.replayed === false), winner = winners[0];
  const rejected = responses.filter(r => r.outcome === "rejected");
  check("effects snapshot available", () => assert.equal(snapshots[0].status, "fulfilled"));
  check("original snapshot available", () => assert.equal(snapshots[1].status, "fulfilled"));
  check("both concurrent responses captured", () => assert.equal(responses.length, 2));
  check("request UUID identities", () => assert.equal(new Set(responses.map(r => r.requestId)).size,
    ["same_uuid_admins", "double_click"].includes(scenario) ? 1 : 2));
  check("actor identities", () => assert.equal(new Set(responses.map(r => r.actorUid)).size, scenario === "double_click" ? 1 : 2));
  check("exactly one non-replayed success", () => assert.equal(winners.length, 1));
  check("winner is a regularization", () => assert.equal(winner.operation, "regularizeSession"));
  if (scenario === "double_click") {
    check("no rejected double click", () => assert.equal(rejected.length, 0));
    check("one identical replay", () => {
      assert.equal(responses.filter(r => r.result?.replayed === true).length, 1);
      assert.deepEqual(responses[0].result.result, responses[1].result.result);
    });
  } else {
    check("exactly one rejected response", () => assert.equal(rejected.length, 1));
    // Preserve the original code expectations. Native/uncertain failures are
    // reported and fail this check; they are never converted into conflicts.
    check(scenario === "clock_out_race" ? "ordinary exit is refused" : "losing response is VERSION_CONFLICT", () => {
      const error = diagnosticError(rejected[0]?.error);
      if (scenario === "clock_out_race") {
        assert.equal(rejected[0].operation, "clockOut");
        assert.ok(["REGULARIZATION_REQUIRED", "VERSION_CONFLICT"].includes(error.code));
      } else assert.equal(error.code, "VERSION_CONFLICT");
    });
  }
  if (e) {
    check("original logs and updateTimes preserved", () => assert.deepEqual(e.logs, baseline.effects.logs));
    check("exactly one resolution", () => assert.equal(e.regs.length, 1));
    check("exactly one receipt", () => assert.equal(e.receipts.length, 1));
    check("state is regularized at version 2", () => { assert.equal(e.state.data.status, "regularized"); assert.equal(e.state.data.version, 2); });
    check("active state fields cleared", () => {
      assert.equal(e.state.data.activeEntryId, null); assert.equal(e.state.data.openedAt, null); assert.equal(e.state.data.reviewReason, null);
    });
    check("state scope and initialization preserved", () => {
      assert.equal(e.state.id, f.worker.uid); assert.equal(e.state.data.userId, f.worker.uid); assert.equal(e.state.data.companyId, f.companyId);
      assert.equal(e.state.data.initializationId, baseline.effects.state.data.initializationId);
      assert.equal(e.state.data.sourceDigest, baseline.effects.state.data.sourceDigest);
    });
    check("resolution belongs to original and winning administrator", () => {
      const reg = e.regs[0]; assert.equal(reg.id, f.entryId); assert.equal(reg.data.originalEntryId, f.entryId);
      assert.equal(reg.data.workerUid, f.worker.uid); assert.equal(reg.data.companyId, f.companyId);
      assert.equal(reg.data.adminUid, winner.actorUid); assert.equal(reg.data.requestId, winner.requestId);
      assert.equal(reg.data.mode, winner.result.result.mode); assert.equal(reg.data.effectiveMinutes, winner.result.result.minutes);
      assert.equal(reg.data.status, reg.data.mode === "accredited_exit" ? "resolved_known" : "resolved_unknown");
    });
    check("receipt identity and result agree with winner", () => {
      const receipt = e.receipts[0];
      assert.equal(receipt.id, keyFor({ ...f, admin: { uid: winner.actorUid }, request: { ...f.request, requestId: winner.requestId } }));
      assert.equal(receipt.data.actorUid, winner.actorUid); assert.equal(receipt.data.workerUid, f.worker.uid); assert.equal(receipt.data.companyId, f.companyId);
      assert.equal(receipt.data.requestId, winner.requestId); assert.equal(receipt.data.operation, "regularizeSession");
      assert.deepEqual(receipt.data.result, winner.result.result);
      assert.equal(receipt.data.result.eventId, f.entryId); assert.equal(receipt.data.result.originalEntryId, f.entryId);
      assert.equal(receipt.data.result.stateVersion, 2); assert.equal(receipt.data.result.status, "regularized");
    });
    check("state resolution agrees with immutable resolution", () => {
      const state = e.state.data, reg = e.regs[0].data, resolution = state.lastResolution;
      assert.equal(state.lastRequestId, winner.requestId); assert.equal(resolution.regularizationId, f.entryId);
      assert.equal(resolution.originalEntryId, f.entryId); assert.equal(resolution.adminUid, winner.actorUid);
      assert.equal(resolution.mode, reg.mode); assert.equal(resolution.minutes, reg.effectiveMinutes);
      assert.deepEqual(jsonTime(resolution.regularizedAt), jsonTime(reg.regularizedAt));
      assert.deepEqual(resolution.exitAt === null ? null : jsonTime(resolution.exitAt), reg.accreditedExitAt === null ? null : jsonTime(reg.accreditedExitAt));
    });
    check("all three effects share one commit", () => {
      assert.deepEqual(e.state.updateTime, e.regs[0].updateTime); assert.deepEqual(e.state.updateTime, e.receipts[0].updateTime);
      assert.deepEqual(e.regs[0].data.committedAt, e.receipts[0].data.committedAt); assert.deepEqual(e.state.data.updatedAt, e.regs[0].data.committedAt);
    });
  }
  if (snapshots[1].status === "fulfilled") check("independent original preserved", () => assert.deepEqual(snapshots[1].value, baseline.original));
  const summary = { requests: responses.length, confirmed: winners.length, errors: rejected.length,
    replayed: responses.filter(r => r.result?.replayed === true).length, resolutions: e?.regs.length ?? null,
    receipts: e?.receipts.length ?? null, logs: e?.logs.length ?? null, status: e?.state?.data.status ?? null, version: e?.state?.data.version ?? null };
  if (failures.length) {
    report("REGULARIZATION_CONCURRENCY_DIAGNOSTIC " + JSON.stringify({ schemaVersion: 1, projectId: local.projectId, scenario, summary, failures,
      snapshotReads: snapshots.map((s, i) => ({ source: i ? "original" : "effects", status: s.status,
        error: s.status === "rejected" ? diagnosticError(s.reason) : null })),
      responses: responses.map(r => ({ label: diagnosticText(r.label), requestId: diagnosticText(r.requestId), operation: r.operation,
        outcome: r.outcome, httpStatus: r.httpStatus, result: r.result ? { ok: r.result.ok, replayed: r.result.replayed,
          operation: r.result.result?.operation, stateVersion: r.result.result?.stateVersion, status: r.result.result?.status } : null,
        error: r.error ? diagnosticError(r.error) : null,
        // A missing receipt in this read is an observation, not a general claim
        // that a transport failure means the operation never committed.
        receiptObserved: e ? e.receipts.some(d => d.id === keyFor({ ...f, admin: { uid: r.actorUid }, request: { ...f.request, requestId: r.requestId } })) : null })) }));
    throw new AggregateError(failures.map(failure => new Error(failure.message)), "Concurrent regularization expectations failed: " + failures.map(failure => failure.label).join("; "));
  }
  return summary;
}
for (const mode of ["accredited_exit", "unknown_exit"]) test("atomic administrative resolution: " + mode, async () => {
  const f = await fixture({ mode }), before = await effects(f), response = await call(f);
  assert.equal(response.status, 200, JSON.stringify(response)); assert.equal(response.result.ok, true); assert.equal(response.result.replayed, false);
  const e = await effects(f); assert.deepEqual(e.logs, before.logs); assert.equal(e.regs.length, 1); assert.equal(e.receipts.length, 1);
  const reg = e.regs[0].data, receipt = e.receipts[0].data;
  assert.equal(e.regs[0].id, f.entryId); assert.equal(reg.originalEntryId, f.entryId); assert.equal(reg.workerUid, f.worker.uid); assert.equal(reg.companyId, f.companyId);
  assert.equal(reg.adminUid, f.admin.uid); assert.equal(reg.reason, f.request.reason); assert.equal(reg.requestId, f.request.requestId);
  assert.equal(reg.mode, mode); assert.equal(reg.status, mode === "accredited_exit" ? "resolved_known" : "resolved_unknown");
  // Process wall clocks need not agree. Exact clock provenance/precision is
  // covered by the injected-clock tests below; HTTP retains temporal coherence.
  assert.ok(reg.regularizedAt instanceof Timestamp); assert.ok(reg.committedAt instanceof Timestamp);
  assert.deepEqual(jsonTime(e.state.data.lastResolution.regularizedAt), jsonTime(reg.regularizedAt));
  assert.deepEqual(reg.committedAt, receipt.committedAt);
  assert.deepEqual(e.state.data.updatedAt, reg.committedAt);
  assert.deepEqual(e.state.updateTime, e.regs[0].updateTime);
  assert.deepEqual(e.state.updateTime, e.receipts[0].updateTime);
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
test("double click creates one immutable resolution and one receipt", async t => {
  const f = await fixture(), baseline = await concurrentBaseline(f);
  const responses = await Promise.all([1, 2].map(i => captureConcurrentResponse({ label: "double-click-" + i,
    actorUid: f.admin.uid, request: f.request, run: () => call(f) })));
  const summary = await validateConcurrentRegularization({ f, scenario: "double_click", responses, baseline, report: message => t.diagnostic(message) });
  t.diagnostic("REGULARIZATION_CONCURRENCY_SUMMARY " + JSON.stringify({ scenario: "double_click", ...summary }));
});
test("two administrators proposing contradictory modes commit exactly one resolution", async t => {
  const f = await fixture(), second = await actor(f.companyId), baseline = await concurrentBaseline(f);
  const alternate = { ...f.request, requestId: randomUUID(), mode: "unknown_exit", evidenceReference: null, accreditedExitAt: null };
  const responses = await Promise.all([
    captureConcurrentResponse({ label: "administrator-1", actorUid: f.admin.uid, request: f.request, run: () => call(f) }),
    captureConcurrentResponse({ label: "administrator-2", actorUid: second.uid, request: alternate, run: () => call(f, alternate, second.token) }),
  ]);
  const summary = await validateConcurrentRegularization({ f, scenario: "contradictory_admins", responses, baseline, report: message => t.diagnostic(message) });
  t.diagnostic("REGULARIZATION_CONCURRENCY_SUMMARY " + JSON.stringify({ scenario: "contradictory_admins", ...summary }));
});
test("same UUID from two admins still yields one resolution", async t => {
  const f = await fixture(), second = await actor(f.companyId), baseline = await concurrentBaseline(f);
  const responses = await Promise.all([
    captureConcurrentResponse({ label: "administrator-1", actorUid: f.admin.uid, request: f.request, run: () => call(f) }),
    captureConcurrentResponse({ label: "administrator-2", actorUid: second.uid, request: f.request, run: () => call(f, f.request, second.token) }),
  ]);
  const summary = await validateConcurrentRegularization({ f, scenario: "same_uuid_admins", responses, baseline, report: message => t.diagnostic(message) });
  t.diagnostic("REGULARIZATION_CONCURRENCY_SUMMARY " + JSON.stringify({ scenario: "same_uuid_admins", ...summary }));
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

test("ordinary clockOut racing overdue regularization never creates a contradictory exit", async t => {
  const f = await fixture({ mode: "unknown_exit" }), baseline = await concurrentBaseline(f);
  const out = { operation: "clockOut", requestId: randomUUID(), companyContext: f.companyId, expectedStateVersion: 1, expectedEpoch: 7, protocolVersion: 1 };
  const responses = await Promise.all([
    captureConcurrentResponse({ label: "administrator", actorUid: f.admin.uid, request: f.request, run: () => call(f) }),
    captureConcurrentResponse({ label: "worker", actorUid: f.worker.uid, request: out, run: () => call(f, out, f.worker.token, "clockOut") }),
  ]);
  const summary = await validateConcurrentRegularization({ f, scenario: "clock_out_race", responses, baseline, report: message => t.diagnostic(message) });
  t.diagnostic("REGULARIZATION_CONCURRENCY_SUMMARY " + JSON.stringify({ scenario: "clock_out_race", ...summary }));
});

test("foreign administrator with valid own-company context cannot regularize this company's original", async () => {
  const f = await fixture(), foreignCompany = "foreign-" + randomUUID(), foreign = await actor(foreignCompany);
  await db.doc("companies/" + foreignCompany).create({ name: "Fictional foreign company" });
  await db.doc("companies/" + foreignCompany + "/session_control/config").create({ companyId: foreignCompany, writeMode: "backend", epoch: 7, minProtocolVersion: 1 });
  await denied(f, "COMPANY_MISMATCH", { ...f.request, companyContext: foreignCompany }, foreign.token);
  assert.equal((await db.collection("companies/" + foreignCompany + "/session_requests").get()).size, 0);
  assert.equal((await db.collection("companies/" + foreignCompany + "/regularizations").get()).size, 0);
});

// Faults below use only the existing dependency injection. They exercise real
// emulator transactions, with deterministic faults at explicit boundaries;
// they do not explain the cause of any historical SDK/emulator failure.
const nativeFault = (code, message) => Object.assign(new Error(message), { code });
// Confirmation probes are distinct read-only operations. Existing write-fault
// fixtures preserve their exact expectations and do not count probes as writes.
const transactionAdapter = (runTransaction, { confirmationFailure } = {}) => ({ projectId: local.projectId,
  doc: p => db.doc(p), collection: p => db.collection(p), runTransaction: (action, options) => {
    if (options?.readOnly) {
      if (confirmationFailure) throw confirmationFailure;
      return db.runTransaction(action, options);
    }
    return runTransaction(action, options);
  } });
const handlerFor = execute => createRegularizeSessionHandler({ environment, execute,
  readUser: uid => auth.getUser(uid), HttpsError });
const handlerRequest = async f => ({ data: f.request,
  auth: { uid: f.admin.uid, token: await auth.verifyIdToken(f.admin.token) } });
async function assertRecoveredRegularization(f, baseline, expectedReplay, committedResult) {
  const retry = await service({ data: f.request, identity: f.admin.identity });
  assert.equal(retry.replayed, expectedReplay);
  if (committedResult) assert.deepEqual(retry.result, committedResult.result);
  const committed = await effects(f);
  assert.deepEqual(committed.logs, baseline.effects.logs);
  assert.equal(committed.regs.length, 1); assert.equal(committed.regs[0].id, f.entryId);
  assert.equal(committed.regs[0].data.adminUid, f.admin.uid); assert.equal(committed.regs[0].data.requestId, f.request.requestId);
  assert.equal(committed.receipts.length, 1); assert.equal(committed.receipts[0].id, keyFor(f));
  assert.deepEqual(committed.receipts[0].data.result, retry.result);
  assert.equal(committed.state.data.status, "regularized"); assert.equal(committed.state.data.version, 2);
  assert.equal(committed.state.data.lastRequestId, f.request.requestId); assert.equal(committed.state.data.activeEntryId, null);
  assert.equal(committed.state.data.initializationId, baseline.effects.state.data.initializationId);
  assert.equal(committed.state.data.sourceDigest, baseline.effects.state.data.sourceDigest);
  const replay = await service({ data: f.request, identity: f.admin.identity });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.result, retry.result);
  assert.deepEqual(await effects(f), committed); assert.deepEqual(await originalSnapshot(f), baseline.original);
  return committed;
}
async function diagnosticFixture(error) {
  const f = await fixture(), second = await actor(f.companyId), baseline = await concurrentBaseline(f);
  const winner = await captureConcurrentResponse({ label: "administrator-1", actorUid: f.admin.uid, request: f.request,
    run: async () => ({ result: await service({ data: f.request, identity: f.admin.identity }) }) });
  // Only the winner runs a business operation. The rejected response is a DTO
  // for exercising the validator, not a claim about a real concurrent call.
  const loser = await captureConcurrentResponse({ label: "administrator-2", actorUid: second.uid, request: f.request,
    run: async () => { if (error instanceof Error) throw error; return error; } });
  return { f, baseline, responses: [winner, loser] };
}
const readDiagnostic = message => JSON.parse(message.slice("REGULARIZATION_CONCURRENCY_DIAGNOSTIC ".length));

test("regularization diagnostics redact signed and unsigned emulator tokens without dumping payloads", () => {
  const unsigned = Buffer.from('{"alg":"none"}').toString("base64url") + "."
    + Buffer.from('{"sub":"fictional-diagnostic-user"}').toString("base64url") + ".";
  const signed = unsigned + "fictional-signature";
  const key = "-----BEGIN PRIVATE KEY-----\nfictional-key\n-----END PRIVATE KEY-----";
  const sanitized = diagnosticError(nativeFault(3, "Fictional tokens: " + unsigned + " " + signed + " " + key));
  assert.equal(sanitized.message.includes(unsigned), false); assert.equal(sanitized.message.includes(signed), false);
  assert.equal(sanitized.message.includes("fictional-key"), false); assert.equal(sanitized.code, 3);
  assert.equal(sanitized.type, "Error"); assert.equal(diagnosticText("x".repeat(2000)).length, 1200);
});

test("regularization diagnostics retain native errors, redact secrets and still detect inconsistent effects", async () => {
  const { f, baseline, responses } = await diagnosticFixture(nativeFault(3,
    'Transaction is invalid or closed. Bearer fictional-secret; password="fictional-password"; evidenceReference="fictional-evidence"; reason="fictional-reason"; fictional-person@example.invalid'));
  const messages = []; let effectsReads = 0, originalReads = 0;
  await assert.rejects(validateConcurrentRegularization({ f, scenario: "same_uuid_admins", responses, baseline,
    report: m => messages.push(m), readEffects: () => { effectsReads++; return effects(f); },
    readOriginal: () => { originalReads++; return originalSnapshot(f); } }), AggregateError);
  assert.equal(effectsReads, 1); assert.equal(originalReads, 1);
  const diagnostic = readDiagnostic(messages[0]);
  assert.deepEqual(diagnostic.failures.map(d => d.label), ["losing response is VERSION_CONFLICT"]);
  assert.equal(diagnostic.responses.length, 2); assert.equal(diagnostic.responses[1].error.code, 3);
  assert.equal(diagnostic.responses[1].error.type, "Error"); assert.equal(diagnostic.responses[1].error.category, "sdk_or_infrastructure");
  assert.equal(diagnostic.responses[1].receiptObserved, false);
  assert.equal(diagnostic.summary.resolutions, 1); assert.equal(diagnostic.summary.receipts, 1);
  assert.equal(diagnostic.summary.status, "regularized"); assert.equal(diagnostic.summary.version, 2);
  for (const secret of ["fictional-secret", "fictional-password", "fictional-evidence", "fictional-reason", "fictional-person@example.invalid"]) assert.equal(messages[0].includes(secret), false);
  // Corrupt only detached observations. Assertion diffs must never dump them.
  const observed = await effects(f); observed.state.data.version = 3;
  observed.logs[0].data.confidential = "fictional-record-secret";
  await assert.rejects(validateConcurrentRegularization({ f, scenario: "same_uuid_admins", responses, baseline,
    report: m => messages.push(m), readEffects: async () => observed }), AggregateError);
  const simultaneous = readDiagnostic(messages[1]);
  assert.ok(simultaneous.failures.some(d => d.label === "losing response is VERSION_CONFLICT"));
  assert.ok(simultaneous.failures.some(d => d.label === "state is regularized at version 2"));
  assert.ok(simultaneous.failures.some(d => d.label === "original logs and updateTimes preserved"));
  assert.equal(messages[1].includes("fictional-record-secret"), false);
  assert.equal((await effects(f)).state.data.version, 2); assert.deepEqual(await originalSnapshot(f), baseline.original);
});

test("regularization diagnostics distinguish callable uncertainty without claiming a definitive failure", async () => {
  const { f, baseline, responses } = await diagnosticFixture({ status: 503,
    error: { status: "UNAVAILABLE", message: "Fictional confirmation unavailable", details: {
      code: "CONFIRMATION_UNAVAILABLE", retryable: true, outcomeUnknown: true } } });
  const messages = [];
  await assert.rejects(validateConcurrentRegularization({ f, scenario: "same_uuid_admins", responses, baseline,
    report: m => messages.push(m) }), AggregateError);
  const diagnostic = readDiagnostic(messages[0]), error = diagnostic.responses[1].error;
  assert.equal(error.code, "CONFIRMATION_UNAVAILABLE"); assert.equal(error.category, "uncertain_confirmation");
  assert.equal(error.type, "CallableHttpError"); assert.equal(error.outcomeUnknown, true);
  assert.equal(diagnostic.responses[1].httpStatus, 503); assert.equal(diagnostic.responses[1].receiptObserved, false);
  assert.deepEqual(diagnostic.failures.map(d => d.label), ["losing response is VERSION_CONFLICT"]);
  assert.ok(diagnostic.snapshotReads.every(s => s.status === "fulfilled"));
});

for (const unavailable of ["effects", "original"]) test("regularization final reads remain independent when unavailable: " + unavailable, async () => {
  const { f, baseline, responses } = await diagnosticFixture(new ClockInError("VERSION_CONFLICT"));
  const messages = []; let effectsReads = 0, originalReads = 0;
  await assert.rejects(validateConcurrentRegularization({ f, scenario: "same_uuid_admins", responses, baseline,
    report: m => messages.push(m), readEffects: () => {
      effectsReads++; if (unavailable === "effects") throw nativeFault(14, "Fictional effects read unavailable"); return effects(f);
    }, readOriginal: () => {
      originalReads++; return unavailable === "original" ? Promise.reject(nativeFault(14, "Fictional original read unavailable")) : originalSnapshot(f);
    } }), AggregateError);
  assert.equal(effectsReads, 1); assert.equal(originalReads, 1);
  const diagnostic = readDiagnostic(messages[0]);
  assert.deepEqual(diagnostic.failures.map(d => d.label), [unavailable + " snapshot available"]);
  assert.equal(diagnostic.snapshotReads.find(s => s.source === unavailable).error.code, 14);
  assert.equal(diagnostic.snapshotReads.find(s => s.source !== unavailable).status, "fulfilled");
  assert.equal(diagnostic.summary.resolutions, unavailable === "effects" ? null : 1);
  assert.equal(diagnostic.responses[1].error.category, "business");
});

test("controlled regularization closed transaction propagates native code 3 and leaves no partial writes", async () => {
  const f = await fixture(), baseline = await concurrentBaseline(f), closed = nativeFault(3, "Transaction is invalid or closed.");
  let attempts = 0;
  const wrapper = transactionAdapter(action => db.runTransaction(async tx => {
    attempts++; await action(tx); throw closed; // Staged writes are rolled back, never committed.
  }, { maxAttempts: 3 }));
  const execute = serviceFor(wrapper);
  await assert.rejects(execute({ data: f.request, identity: f.admin.identity }), error => error === closed && error.code === 3);
  assert.equal(attempts, 1); assert.deepEqual(await effects(f), baseline.effects);
  await assert.rejects(handlerFor(execute)(await handlerRequest(f)), error => {
    assert.equal(error.code, "unavailable"); assert.equal(error.details.code, "CONFIRMATION_UNAVAILABLE");
    assert.equal(error.details.outcomeUnknown, true); return true;
  });
  assert.equal(attempts, 2); assert.deepEqual(await effects(f), baseline.effects);
  await assertRecoveredRegularization(f, baseline, false);
});

test("controlled regularization transient SDK error retries once and creates one immutable resolution", async () => {
  const f = await fixture(), baseline = await concurrentBaseline(f); let attempts = 0;
  const wrapper = transactionAdapter(action => db.runTransaction(async tx => {
    attempts++; const result = await action(tx);
    if (attempts === 1) throw nativeFault(14, "Fictional transient UNAVAILABLE");
    return result;
  }, { maxAttempts: 3 }));
  const result = await serviceFor(wrapper)({ data: f.request, identity: f.admin.identity });
  assert.equal(attempts, 2); assert.equal(result.replayed, false);
  await assertRecoveredRegularization(f, baseline, true, result);
});

test("controlled regularization retry exhaustion rolls back all staged resolutions", async () => {
  const f = await fixture(), baseline = await concurrentBaseline(f), aborted = nativeFault(10, "Fictional ABORTED on every attempt");
  let attempts = 0;
  const wrapper = transactionAdapter(action => db.runTransaction(async tx => {
    attempts++; await action(tx); throw aborted;
  }, { maxAttempts: 3 }));
  await assert.rejects(serviceFor(wrapper)({ data: f.request, identity: f.admin.identity }), error => error === aborted && error.code === 10);
  assert.equal(attempts, 3); assert.equal(diagnosticError(aborted).category, "transaction");
  assert.deepEqual(await effects(f), baseline.effects); assert.deepEqual(await originalSnapshot(f), baseline.original);
  await assertRecoveredRegularization(f, baseline, false);
});

for (const committedBeforeFailure of [false, true]) test("controlled regularization uncertain confirmation, committed=" + committedBeforeFailure, async () => {
  const f = await fixture(), baseline = await concurrentBaseline(f), unavailable = nativeFault(14, "Fictional lost confirmation");
  let committedResult;
  const wrapper = transactionAdapter(async action => {
    if (committedBeforeFailure) { committedResult = await db.runTransaction(action); throw unavailable; }
    return db.runTransaction(async tx => { await action(tx); throw unavailable; }, { maxAttempts: 1 });
  }, { confirmationFailure: unavailable });
  await assert.rejects(handlerFor(serviceFor(wrapper))(await handlerRequest(f)), error => {
    assert.equal(error.code, "unavailable"); assert.equal(error.details.code, "CONFIRMATION_UNAVAILABLE");
    assert.equal(error.details.retryable, true); assert.equal(error.details.outcomeUnknown, true); return true;
  });
  const afterFailure = await effects(f);
  if (committedBeforeFailure) {
    assert.equal(afterFailure.regs.length, 1); assert.equal(afterFailure.receipts.length, 1); assert.equal(afterFailure.state.data.version, 2);
    assert.deepEqual(afterFailure.logs, baseline.effects.logs);
  } else assert.deepEqual(afterFailure, baseline.effects);
  const committed = await assertRecoveredRegularization(f, baseline, committedBeforeFailure, committedResult);
  if (committedBeforeFailure) assert.deepEqual(committed, afterFailure);
});

test("controlled regularization business conflicts remain distinct from uncertain confirmations", async () => {
  const f = await fixture(), baseline = await concurrentBaseline(f), request = await handlerRequest(f);
  request.data = { ...f.request, expectedStateVersion: 0 };
  await assert.rejects(handlerFor(service)(request), error => {
    assert.equal(error.code, "failed-precondition"); assert.equal(error.details.code, "VERSION_CONFLICT");
    assert.equal(error.details.retryable, false); assert.equal(error.details.outcomeUnknown, undefined); return true;
  });
  assert.deepEqual(await effects(f), baseline.effects); assert.deepEqual(await originalSnapshot(f), baseline.original);
});

// Integration faults are deterministic boundary injections. Actual reads,
// rollback and atomic effects remain those of the isolated Firestore emulator.
function recoveryAdapter({ historyErrors = [], beforeCommitErrors = [], afterCommitErrors = [],
  beforeProbe, beforeExecution, onFailure, confirmationError } = {}) {
  const observed = { executions: 0, probes: 0, callbacks: 0, maxAttempts: [], transactions: [], nativeIds: [] };
  const adapter = transactionAdapter(async (action, options) => {
    observed.executions++;
    observed.maxAttempts.push(options.maxAttempts);
    if (beforeExecution) await beforeExecution(observed.executions);
    try {
      const result = await db.runTransaction(async tx => {
        observed.callbacks++;
        observed.transactions.push(tx);
        let failed = false;
        const value = await action({
          getAll: (...refs) => tx.getAll(...refs),
          get: async ref => {
            if (typeof ref.where === "function" && !failed && historyErrors.length) {
              failed = true;
              const id = await tx._transactionIdPromise; // Test-only observation.
              observed.nativeIds.push(Buffer.from(id).toString("base64"));
              throw historyErrors.shift();
            }
            return tx.get(ref);
          },
          create: (ref, data) => tx.create(ref, data), update: (ref, data) => tx.update(ref, data),
        });
        const error = beforeCommitErrors.shift();
        if (error) throw error;
        return value;
      }, options);
      const error = afterCommitErrors.shift();
      if (error) throw error;
      return result;
    } catch (error) {
      if (onFailure) await onFailure(error, observed.executions);
      throw error;
    }
  });
  const run = adapter.runTransaction;
  adapter.runTransaction = async (action, options) => {
    if (options.readOnly) {
      observed.probes++;
      if (beforeProbe) await beforeProbe(observed.probes);
      if (confirmationError) throw confirmationError;
    }
    return run(action, options);
  };
  return { adapter, observed };
}
const closedHistory = () => Object.assign(nativeFault(3, "3 INVALID_ARGUMENT: Transaction is invalid or closed."), {
  cause: nativeFault(10, "Fictional ABORTED before streaming retry"),
});
const invokeRecovery = async (f, adapter) => handlerFor(serviceFor(adapter))(await handlerRequest(f));

async function verifyRecovery(f, execute, { code = null, changed = false, replayed = false,
  winningAdmin = f.admin, compareEffects } = {}) {
  const baseline = await concurrentBaseline(f);
  const outcome = await execute().then(value => ({ value }), error => ({ error }));
  const snapshots = await Promise.allSettled([effects(f), originalSnapshot(f)]), failures = [];
  const check = (label, assertion) => { try { assertion(); } catch { failures.push(label); } };
  check("effects readable", () => assert.equal(snapshots[0].status, "fulfilled"));
  check("original readable", () => assert.equal(snapshots[1].status, "fulfilled"));
  check("response", () => {
    if (code !== null) assert.equal(outcome.error?.details?.code ?? outcome.error?.code, code);
    else { assert.equal(outcome.error, undefined); assert.equal(outcome.value.ok, true); assert.equal(outcome.value.replayed, replayed); }
  });
  if (snapshots[1].status === "fulfilled") check("original preserved", () => assert.deepEqual(snapshots[1].value, baseline.original));
  if (snapshots[0].status === "fulfilled") {
    const e = snapshots[0].value;
    check("all original logs and updateTimes preserved, no invented exit", () => assert.deepEqual(e.logs, baseline.effects.logs));
    if (compareEffects) check("exact externally seeded fixture preserved", () => compareEffects(e));
    else if (!changed) check("no partial effects", () => assert.deepEqual(e, baseline.effects));
    else {
      check("one resolution", () => assert.equal(e.regs.length, 1));
      check("one receipt", () => assert.equal(e.receipts.length, 1));
      check("one state transition", () => { assert.equal(e.state.data.version, 2); assert.equal(e.state.data.status, "regularized"); });
      check("scope and metadata", () => {
        assert.equal(e.state.data.userId, f.worker.uid); assert.equal(e.state.data.companyId, f.companyId);
        assert.equal(e.state.data.initializationId, baseline.effects.state.data.initializationId);
        assert.equal(e.state.data.sourceDigest, baseline.effects.state.data.sourceDigest);
      });
      check("resolution identity", () => {
        const r = e.regs[0]; assert.equal(r.id, f.entryId); assert.equal(r.data.originalEntryId, f.entryId);
        assert.equal(r.data.adminUid, winningAdmin.uid); assert.equal(r.data.workerUid, f.worker.uid);
        assert.equal(r.data.companyId, f.companyId); assert.equal(r.data.requestId, f.request.requestId);
        assert.equal(r.data.reason, f.request.reason); assert.equal(r.data.mode, f.request.mode);
      });
      check("complete receipt identity", () => {
        const r = e.receipts[0]; assert.equal(r.id, keyFor({ ...f, admin: winningAdmin }));
        assert.equal(r.data.actorUid, winningAdmin.uid); assert.equal(r.data.workerUid, f.worker.uid);
        assert.equal(r.data.operation, f.request.operation); assert.equal(r.data.requestId, f.request.requestId);
        assert.equal(r.data.companyId, f.companyId); assert.equal(r.data.result.originalEntryId, f.entryId);
        assert.equal(r.data.result.stateVersion, 2);
      });
      check("dates and accreditation preserved", () => {
        const r = e.regs[0].data, time = r.accreditedExitAt === null ? null : jsonTime(r.accreditedExitAt);
        assert.deepEqual(time, f.request.accreditedExitAt); assert.equal(r.evidenceReference, f.request.evidenceReference);
        assert.deepEqual(e.state.data.lastResolution.exitAt === null ? null : jsonTime(e.state.data.lastResolution.exitAt), time);
        assert.equal(r.effectiveMinutes, f.request.mode === "accredited_exit" ? 480 : null);
      });
      check("three atomic effects", () => {
        assert.deepEqual(e.state.updateTime, e.regs[0].updateTime); assert.deepEqual(e.state.updateTime, e.receipts[0].updateTime);
        assert.deepEqual(e.regs[0].data.committedAt, e.receipts[0].data.committedAt);
        assert.deepEqual(e.state.data.updatedAt, e.regs[0].data.committedAt);
      });
    }
  }
  if (failures.length) throw new AggregateError(failures.map(label => new Error(label)),
    "REGULARIZATION_RECOVERY_DIAGNOSTIC " + JSON.stringify({ failures,
      error: outcome.error ? diagnosticError(outcome.error) : null,
      result: outcome.value ? { ok: outcome.value.ok, replayed: outcome.value.replayed } : null,
      effects: snapshots[0].status === "fulfilled" ? { resolutions: snapshots[0].value.regs.length,
        receipts: snapshots[0].value.receipts.length, logs: snapshots[0].value.logs.length,
        version: snapshots[0].value.state?.data.version } : null,
      snapshotReads: snapshots.map(s => s.status) }));
  return outcome;
}

for (const mode of ["accredited_exit", "unknown_exit"]) {
  test("recovery: ABORTED -> INVALID_ARGUMENT starts a fresh regularization, " + mode, async () => {
    const f = await fixture({ mode }), request = structuredClone(f.request);
    const { adapter, observed } = recoveryAdapter({ historyErrors: [closedHistory()] });
    await verifyRecovery(f, () => serviceFor(adapter)({ data: f.request, identity: f.admin.identity }), { changed: true });
    assert.equal(observed.executions, 2); assert.equal(observed.probes, 1);
    assert.deepEqual(observed.maxAttempts, [5, 4]); assert.notEqual(observed.transactions[0], observed.transactions[1]);
    assert.deepEqual(f.request, request);
    const before = await effects(f), retry = await service({ data: f.request, identity: f.admin.identity });
    const final = await effects(f);
    assert.equal(retry.replayed, true); assert.deepEqual(final, before);
  });

  test("recovery: lost response after actual commit replays one resolution, " + mode, async () => {
    const f = await fixture({ mode });
    const { adapter, observed } = recoveryAdapter({ afterCommitErrors: [nativeFault(14, "Fictional lost commit response")] });
    await verifyRecovery(f, () => invokeRecovery(f, adapter), { changed: true, replayed: true });
    assert.equal(observed.executions, 1); assert.equal(observed.probes, 1);
  });

  test("recovery: failed confirmation read after commit remains uncertain, " + mode, async () => {
    const f = await fixture({ mode });
    const { adapter, observed } = recoveryAdapter({ afterCommitErrors: [nativeFault(14, "Fictional lost response")],
      confirmationError: nativeFault(14, "Fictional receipt read failure") });
    await verifyRecovery(f, () => invokeRecovery(f, adapter), { code: "CONFIRMATION_UNAVAILABLE", changed: true });
    assert.equal(observed.executions, 1);
    const before = await effects(f), replay = await service({ data: f.request, identity: f.admin.identity });
    const after = await effects(f); assert.equal(replay.replayed, true); assert.deepEqual(after, before);
  });

  test("recovery: uncertain before commit exhausts SDK retries without partial effects, " + mode, async () => {
    const f = await fixture({ mode });
    const { adapter, observed } = recoveryAdapter({ beforeCommitErrors: Array.from({ length: 5 }, () => nativeFault(14, "Fictional UNAVAILABLE")) });
    await verifyRecovery(f, () => invokeRecovery(f, adapter), { code: "CONFIRMATION_UNAVAILABLE" });
    assert.equal(observed.executions, 1); assert.equal(observed.callbacks, 5); assert.equal(observed.probes, 1);
  });
}

test("recovery: two closed histories have distinct native IDs and stop at two executions", async () => {
  const f = await fixture();
  const { adapter, observed } = recoveryAdapter({ historyErrors: [closedHistory(), closedHistory()] });
  await verifyRecovery(f, () => serviceFor(adapter)({ data: f.request, identity: f.admin.identity }), { code: 3 });
  assert.equal(observed.executions, 2); assert.equal(observed.probes, 2);
  assert.equal(observed.nativeIds.length, 2); assert.notEqual(observed.nativeIds[0], observed.nativeIds[1]);
});

test("recovery: commit-origin closed error cannot enable a regularization restart", async () => {
  const f = await fixture();
  const { adapter, observed } = recoveryAdapter({ beforeCommitErrors: [closedHistory()] });
  await verifyRecovery(f, () => serviceFor(adapter)({ data: f.request, identity: f.admin.identity }), { code: 3 });
  assert.equal(observed.executions, 1);
});

test("recovery: unrelated native code 3 from history is not retried", async () => {
  const f = await fixture();
  const { adapter, observed } = recoveryAdapter({ historyErrors: [nativeFault(3, "Fictional invalid query argument")] });
  await verifyRecovery(f, () => serviceFor(adapter)({ data: f.request, identity: f.admin.identity }), { code: 3 });
  assert.equal(observed.executions, 1);
});

test("recovery: five shared callbacks include SDK attempts on both complete executions", async () => {
  const f = await fixture();
  const { adapter, observed } = recoveryAdapter({ historyErrors: [nativeFault(10, "Fictional ABORTED"), nativeFault(10, "Fictional ABORTED"),
    closedHistory(), nativeFault(10, "Fictional ABORTED"), nativeFault(10, "Fictional ABORTED")] });
  await verifyRecovery(f, () => serviceFor(adapter)({ data: f.request, identity: f.admin.identity }), { code: 10 });
  assert.equal(observed.callbacks, 5); assert.equal(observed.executions, 2); assert.equal(observed.probes, 2);
  assert.deepEqual(observed.maxAttempts, [5, 2]);
});

test("recovery: unreadable confirmation blocks a fresh execution even after a known read closure", async () => {
  const f = await fixture();
  const { adapter, observed } = recoveryAdapter({ historyErrors: [closedHistory()], confirmationError: nativeFault(14, "Fictional read unavailable") });
  await verifyRecovery(f, () => invokeRecovery(f, adapter), { code: "CONFIRMATION_UNAVAILABLE" });
  assert.equal(observed.executions, 1);
});

for (const [label, change, code] of [
  ["revoked role", f => db.doc("users/" + f.admin.uid).update({ role: "trabajador" }), "FORBIDDEN"],
  ["changed company", f => db.doc("users/" + f.admin.uid).update({ companyId: "fictional-other-company" }), "COMPANY_MISMATCH"],
  ["disabled Auth", f => auth.updateUser(f.admin.uid, { disabled: true }), "UNAUTHENTICATED"],
  ["revoked email", f => auth.updateUser(f.admin.uid, { emailVerified: false }), "EMAIL_NOT_VERIFIED"],
  ["changed epoch", f => controlRef(f).update({ epoch: 8 }), "EPOCH_CONFLICT"],
  ["paused mode", f => controlRef(f).update({ writeMode: "paused" }), "SERVICE_PAUSED"],
  ["legacy mode", f => controlRef(f).update({ writeMode: "legacy" }), "SERVICE_PAUSED"],
]) test("recovery: " + label + " prevents a new resolution", async () => {
  const f = await fixture();
  const { adapter, observed } = recoveryAdapter({ historyErrors: [closedHistory()], onFailure: () => change(f) });
  await verifyRecovery(f, () => invokeRecovery(f, adapter), { code });
  assert.equal(observed.executions, 1);
});

for (const writeMode of ["paused", "legacy"]) test("recovery: valid committed receipt survives " + writeMode + " and epoch change", async () => {
  const f = await fixture();
  const { adapter } = recoveryAdapter({ afterCommitErrors: [nativeFault(14, "Fictional lost response")],
    beforeProbe: () => controlRef(f).update({ writeMode, epoch: 8 }) });
  await verifyRecovery(f, () => invokeRecovery(f, adapter), { changed: true, replayed: true });
});

test("recovery: a corrupt receipt is rejected without replacing it or creating a resolution", async () => {
  const f = await fixture(); let injected;
  const { adapter, observed } = recoveryAdapter({ historyErrors: [closedHistory()], beforeProbe: async () => {
    await db.doc("companies/" + f.companyId + "/session_requests/" + keyFor(f)).create({ corrupt: true });
    injected = await effects(f);
  } });
  await verifyRecovery(f, () => invokeRecovery(f, adapter), { code: "INVALID_RECEIPT", compareEffects: e => assert.deepEqual(e, injected) });
  assert.equal(observed.executions, 1);
});

test("recovery: genuine incompatible receipt preserves REQUEST_ID_CONFLICT and its exact effects", async () => {
  const f = await fixture(); let injected;
  const { adapter, observed } = recoveryAdapter({ historyErrors: [closedHistory()], beforeProbe: async () => {
    await service({ data: { ...f.request, reason: "Different fictional reviewed reason" }, identity: f.admin.identity });
    injected = await effects(f);
  } });
  await verifyRecovery(f, () => invokeRecovery(f, adapter), { code: "REQUEST_ID_CONFLICT", compareEffects: e => assert.deepEqual(e, injected) });
  assert.equal(observed.executions, 1);
});

test("recovery: another admin's same UUID receipt cannot confirm the losing administrator", async () => {
  const f = await fixture(), second = await actor(f.companyId);
  const { adapter, observed } = recoveryAdapter({ historyErrors: [closedHistory()], beforeProbe: () => service({ data: f.request, identity: second.identity }) });
  await verifyRecovery(f, () => invokeRecovery(f, adapter), { code: "VERSION_CONFLICT", changed: true, winningAdmin: second });
  assert.notEqual(keyFor(f), keyFor({ ...f, admin: second }));
  assert.equal(observed.executions, 2);
});

test("recovery: absent probe followed by the same actor's commit replays without duplicate effects", async () => {
  const f = await fixture();
  const { adapter, observed } = recoveryAdapter({ historyErrors: [closedHistory()], beforeExecution: async execution => {
    if (execution === 2) await service({ data: f.request, identity: f.admin.identity });
  } });
  await verifyRecovery(f, () => invokeRecovery(f, adapter), { changed: true, replayed: true });
  assert.equal(observed.executions, 2);
});

test("recovery: a real state-version change cannot refresh the original request", async () => {
  const f = await fixture(); let injected;
  const { adapter, observed } = recoveryAdapter({ historyErrors: [closedHistory()], beforeExecution: async execution => {
    if (execution === 2) { await stateRef(f).update({ version: 2 }); injected = await effects(f); }
  } });
  await verifyRecovery(f, () => invokeRecovery(f, adapter), { code: "VERSION_CONFLICT", compareEffects: e => assert.deepEqual(e, injected) });
  assert.equal(f.request.expectedStateVersion, 1); assert.equal(observed.executions, 2);
});

test("recovery: actor, UUID, epoch, reason, evidence and accredited date are detached from caller mutation", async () => {
  const f = await fixture(), data = structuredClone(f.request), identity = { ...f.admin.identity };
  const { adapter } = recoveryAdapter({ historyErrors: [closedHistory()], beforeExecution: execution => {
    if (execution === 1) {
      identity.uid = "fictional-other-administrator"; data.requestId = randomUUID();
      data.expectedStateVersion = 99; data.expectedEpoch = 99; data.companyContext = "fictional-other-company";
      data.reason = "Altered fictional reason"; data.evidenceReference = "altered-evidence"; data.accreditedExitAt.seconds++;
    }
  } });
  await verifyRecovery(f, () => serviceFor(adapter)({ data, identity }), { changed: true });
});

test("recovery: original token revocation claims are reauthorized before probing", async () => {
  const f = await fixture(), request = await handlerRequest(f);
  const { adapter, observed } = recoveryAdapter({ historyErrors: [closedHistory()] });
  let reads = 0;
  const handler = createRegularizeSessionHandler({ environment, execute: serviceFor(adapter), HttpsError,
    readUser: async uid => {
      const user = await auth.getUser(uid);
      return ++reads >= 3 ? { ...user, tokensValidAfterTime: new Date((request.auth.token.auth_time + 1) * 1000).toISOString() } : user;
    } });
  await verifyRecovery(f, () => handler(request), { code: "UNAUTHENTICATED" });
  assert.equal(reads, 3); assert.equal(observed.probes, 0);
});

test("recovery: absent trusted Auth capability prevents automatic recovery", async () => {
  const f = await fixture();
  const { adapter, observed } = recoveryAdapter({ historyErrors: [closedHistory()] });
  const execute = createRegularizeSessionService({ firestore: adapter, environment, now: () => Timestamp.now(),
    serverTimestamp: () => FieldValue.serverTimestamp(), toTimestamp: ({ seconds, nanoseconds }) => new Timestamp(seconds, nanoseconds) });
  const handler = handlerFor(input => execute({ data: input.data, identity: input.identity }));
  await verifyRecovery(f, async () => handler(await handlerRequest(f)), { code: "CONFIRMATION_UNAVAILABLE" });
  assert.equal(observed.executions, 1); assert.equal(observed.probes, 0);
});

for (let round = 1; round <= 3; round++) for (const scenario of ["same_uuid_admins", "double_click"]) {
  test("recovery concurrency repeat " + round + ": " + scenario, async t => {
    const f = await fixture(), second = scenario === "double_click" ? f.admin : await actor(f.companyId);
    const baseline = await concurrentBaseline(f);
    const responses = await Promise.all([
      captureConcurrentResponse({ label: "administrator-1", actorUid: f.admin.uid, request: f.request, run: () => call(f) }),
      captureConcurrentResponse({ label: "administrator-2", actorUid: second.uid, request: f.request, run: () => call(f, f.request, second.token) }),
    ]);
    const summary = await validateConcurrentRegularization({ f, scenario, responses, baseline, report: message => t.diagnostic(message) });
    t.diagnostic("REGULARIZATION_RECOVERY_REPEAT " + JSON.stringify({ round, scenario, ...summary }));
  });
}

// All decision-clock values here are fixed, server-injected and exactly
// representable as Firestore microseconds. Never replace Date.now/Timestamp.now
// globally or infer ordering against the emulator's independent commit clock.
function assertExactRegularizedAt(snapshot, expected) {
  const actual = snapshot.regs[0].data.regularizedAt;
  assert.ok(actual instanceof Timestamp);
  assert.deepEqual(jsonTime(actual), jsonTime(expected));
  assert.deepEqual(jsonTime(snapshot.state.data.lastResolution.regularizedAt), jsonTime(expected));
}

for (const mode of ["accredited_exit", "unknown_exit"]) {
  test("temporal: exact injected regularizedAt and later replay preserve all dates: " + mode, async () => {
    // Millisecond-aligned opening retains the fixture's exact eight-hour exit.
    const opened = new Timestamp(1767254400, 123000000);
    const fixed = new Timestamp(1767430800, 987654000); // More than 49h later; full microsecond precision.
    const later = new Timestamp(fixed.seconds + 3600, fixed.nanoseconds);
    const f = await fixture({ mode, openedAt: opened });
    await verifyRecovery(f, () => serviceFor(db, () => fixed)({ data: f.request, identity: f.admin.identity }), { changed: true });
    const committed = await effects(f);
    assertExactRegularizedAt(committed, fixed);
    // Equality of entire snapshots includes every document's updateTime and
    // original logs, not just the returned result or the regularization date.
    await verifyRecovery(f, () => serviceFor(db, () => later)({ data: f.request, identity: f.admin.identity }), { replayed: true });
    const replayed = await effects(f);
    assertExactRegularizedAt(replayed, fixed);
    assert.deepEqual(replayed, committed);
  });

  test("temporal: only the confirmed attempt's regularizedAt persists: " + mode, async () => {
    const opened = new Timestamp(1767254400, 123000000);
    const abortedAt = new Timestamp(1767430800, 123456000);
    const confirmedAt = new Timestamp(1767430801, 987654000);
    const f = await fixture({ mode, openedAt: opened });
    let attempts = 0;
    const adapter = transactionAdapter((action, options) => db.runTransaction(async tx => {
      attempts++;
      const result = await action(tx);
      if (attempts === 1) throw nativeFault(10, "Fictional temporal ABORTED after staged writes");
      return result;
    }, options));
    const clock = () => attempts === 1 ? abortedAt : confirmedAt;
    await verifyRecovery(f, () => serviceFor(adapter, clock)({ data: f.request, identity: f.admin.identity }), { changed: true });
    const committed = await effects(f);
    assert.equal(attempts, 2);
    assertExactRegularizedAt(committed, confirmedAt);
    assert.notDeepEqual(jsonTime(committed.regs[0].data.regularizedAt), jsonTime(abortedAt));
  });
}
