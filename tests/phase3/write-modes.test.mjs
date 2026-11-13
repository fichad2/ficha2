import assert from "node:assert/strict";
import { test, after } from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, query, where, setDoc, updateDoc, deleteDoc,
  serverTimestamp, writeBatch, disableNetwork, enableNetwork, documentId } from "firebase/firestore";
import { assertEmulatorEnvironment } from "../../functions/src/emulator-environment.js";
import { validateLocalConfiguration } from "../../scripts/run-phase3-emulators.mjs";

// Guard before any SDK instance, rule upload, Authentication or Firestore access.
const local = assertEmulatorEnvironment(process.env);
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { Firestore, Timestamp } = require("firebase-admin/firestore");
const app = initializeApp({ projectId: local.projectId, credential: {
  async getAccessToken() { return { access_token: "owner", expires_in: 3600 }; },
} }, "write-mode-tests");
const auth = getAuth(app);
const db = new Firestore({ projectId: local.projectId, host: local.firestore, ssl: false,
  credentials: { client_email: "emulator@example.invalid", private_key: "emulator-only-not-a-private-key" } });
const env = await initializeTestEnvironment({ projectId: local.projectId,
  firestore: { host: "127.0.0.1", port: 18080,
    rules: readFileSync(new URL("../../firestore.phase3-local.rules", import.meta.url), "utf8") } });
after(async () => { await env.cleanup(); await db.terminate(); await deleteApp(app); });

const ref = (f, suffix) => db.doc("companies/" + f.companyId + "/" + suffix);
const control = f => ref(f, "session_control/config");
const client = (f, role = "worker", verified = true) => env.authenticatedContext(f[role], {
  email: f[role] + "@example.invalid", email_verified: verified,
}).firestore();
const log = (f, type = "entrada") => ({ userId: f.worker, companyId: f.companyId,
  tipo: type, timestamp: serverTimestamp(), ...(type === "salida" ? {
    entradaLogId: f.entryId, inicioSesion: new Date(Date.now() - 3600000), minutosSesion: 60,
  } : {}) });
async function fixture(mode = "legacy") {
  assertEmulatorEnvironment(process.env);
  const id = randomUUID(), f = { companyId: "mode-company-" + id, worker: "mode-worker-" + id,
    colleague: "mode-colleague-" + id, admin: "mode-admin-" + id,
    foreignWorker: "mode-foreign-worker-" + id, foreignAdmin: "mode-foreign-admin-" + id,
    foreignCompany: "mode-foreign-company-" + id, entryId: "mode-entry-" + id };
  const batch = db.batch();
  batch.create(db.doc("companies/" + f.companyId), { name: "Fictional local company" });
  for (const role of ["worker", "colleague", "admin", "foreignWorker", "foreignAdmin"]) {
    batch.create(db.doc("users/" + f[role]), { companyId: role.startsWith("foreign") ? f.foreignCompany : f.companyId,
      role: role.toLowerCase().endsWith("admin") ? "administrador" : "trabajador" });
  }
  if (mode !== null) batch.create(control(f), { companyId: f.companyId, writeMode: mode, epoch: 1, minProtocolVersion: 1 });
  batch.create(db.doc("logs/" + f.entryId), { userId: f.worker, companyId: f.companyId,
    tipo: "entrada", timestamp: Timestamp.fromMillis(Date.now() - 3600000) });
  for (const uid of [f.worker, f.colleague]) {
    batch.create(ref(f, "session_states/" + uid), { companyId: f.companyId, userId: uid, status: "idle" });
    batch.create(ref(f, "regularizations/" + uid), { companyId: f.companyId, workerUid: uid });
    batch.create(ref(f, "session_requests/" + uid), { companyId: f.companyId, actorUid: uid });
  }
  await batch.commit(); return f;
}

test("only alternate local configuration references the candidate rules", () => {
  const config = JSON.parse(readFileSync(new URL("../../firebase.emulators.phase3.json", import.meta.url)));
  validateLocalConfiguration(config); assert.equal(config.firestore.rules, "firestore.phase3-local.rules");
  const invalid = structuredClone(config); invalid.firestore.rules = "firestore.rules";
  assert.throws(() => validateLocalConfiguration(invalid));
  const unguarded = structuredClone(config); unguarded.firestore.predeploy = [];
  assert.throws(() => validateLocalConfiguration(unguarded));
  const production = JSON.parse(readFileSync(new URL("../../firebase.json", import.meta.url)));
  assert.notEqual(production.firestore?.rules, "firestore.phase3-local.rules");
});
for (const mode of [null, "legacy", "paused", "backend"]) {
  for (const type of ["entrada", "salida"]) test(`old client ${type}: ${mode ?? "missing control = legacy"}`, async () => {
    const f = await fixture(mode), write = setDoc(doc(client(f), "logs/new-" + randomUUID()), log(f, type));
    await (mode === null || mode === "legacy" ? assertSucceeds(write) : assertFails(write));
  });
  test(`immutable originals and ordinary reads in ${mode ?? "missing control"}`, async () => {
    const f = await fixture(mode), worker = client(f), admin = client(f, "admin");
    await assertSucceeds(getDoc(doc(worker, "logs/" + f.entryId)));
    await assertSucceeds(getDocs(query(collection(worker, "logs"), where("companyId", "==", f.companyId), where("userId", "==", f.worker))));
    await assertSucceeds(getDocs(query(collection(admin, "logs"), where("companyId", "==", f.companyId))));
    await assertFails(getDoc(doc(client(f, "foreignAdmin"), "logs/" + f.entryId)));
    await assertFails(getDoc(doc(client(f, "colleague"), "logs/" + f.entryId)));
    for (const who of [worker, admin]) {
      await assertFails(updateDoc(doc(who, "logs/" + f.entryId), { tipo: "salida" }));
      await assertFails(deleteDoc(doc(who, "logs/" + f.entryId)));
    }
  });
}
for (const patch of [{ writeMode: "other" }, { companyId: "wrong-company" }, { epoch: -1 },
  { epoch: 1.5 }, { minProtocolVersion: 0 }, { minProtocolVersion: "1" }]) {
  test("malformed control fails closed: " + JSON.stringify(patch), async () => {
    const f = await fixture(); await control(f).update(patch);
    await assertFails(setDoc(doc(client(f), "logs/new-" + randomUUID()), log(f)));
  });
}
test("partial control fails closed instead of falling back to legacy", async () => {
  const f = await fixture(); await control(f).set({ writeMode: "legacy" });
  await assertFails(setDoc(doc(client(f), "logs/new-" + randomUUID()), log(f)));
});
for (const role of ["worker", "admin"]) test(role + " cannot install the first control document", async () => {
  const f = await fixture(null);
  await assertFails(setDoc(doc(client(f, role), control(f).path), {
    companyId: f.companyId, writeMode: "backend", epoch: 1, minProtocolVersion: 1,
  }));
  assert.equal((await control(f).get()).exists, false);
});
for (const mode of ["legacy", "paused", "backend"]) for (const role of ["worker", "admin"]) {
  test(`${role} cannot create, update or delete internal documents in ${mode}`, async () => {
    const f = await fixture(mode), c = client(f, role);
    for (const suffix of ["session_states/" + f.worker, "regularizations/" + f.worker,
      "session_requests/" + f.worker, "session_control/config"]) {
      const path = "companies/" + f.companyId + "/" + suffix;
      await assertFails(setDoc(doc(c, path + "-new"), { companyId: f.companyId, userId: f.worker, writeMode: "legacy" }));
      await assertFails(updateDoc(doc(c, path), { writeMode: "legacy" }));
      await assertFails(deleteDoc(doc(c, path)));
    }
    for (const name of ["session_states", "regularizations", "session_requests", "session_control"]) {
      await assertFails(setDoc(doc(c, name + "/forged"), { companyId: f.companyId }));
      await assertFails(setDoc(doc(c, "companies/" + f.foreignCompany + "/" + name + "/forged"), { companyId: f.foreignCompany }));
    }
  });
}
for (const mode of ["legacy", "paused", "backend"]) test("tenant-scoped internal reads in " + mode, async () => {
  const f = await fixture(mode);
  for (const [name, field] of [["session_states", "userId"], ["regularizations", "workerUid"], ["session_requests", "actorUid"]]) {
    const path = "companies/" + f.companyId + "/" + name;
    await assertSucceeds(getDoc(doc(client(f), path + "/" + f.worker)));
    await assertSucceeds(getDocs(query(collection(client(f), path), where("companyId", "==", f.companyId), where(field, "==", f.worker), ...(name === "session_states" ? [where(documentId(), "==", f.worker)] : []))));
    await assertSucceeds(getDocs(query(collection(client(f, "admin"), path), where("companyId", "==", f.companyId))));
    await assertFails(getDoc(doc(client(f), path + "/" + f.colleague)));
    await assertFails(getDocs(collection(client(f), path)));
    for (const role of ["foreignAdmin", "foreignWorker"]) await assertFails(getDoc(doc(client(f, role), path + "/" + f.worker)));
    await assertFails(getDoc(doc(client(f, "worker", false), path + "/" + f.worker)));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), path + "/" + f.worker)));
    await assertFails(getDocs(collection(client(f, "admin"), name)));
  }
  for (const role of ["worker", "admin"]) await assertSucceeds(getDoc(doc(client(f, role), control(f).path)));
  await assertFails(getDoc(doc(client(f, "foreignAdmin"), control(f).path)));
  await assertFails(getDoc(doc(client(f), "companies/" + f.companyId + "/session_control/other")));
});
test("corrupt internal tenant and state identity cannot expose another company", async () => {
  const f = await fixture();
  for (const name of ["session_states", "regularizations", "session_requests"]) {
    await ref(f, name + "/" + f.worker).update({ companyId: f.foreignCompany });
    for (const role of ["worker", "admin", "foreignAdmin"]) await assertFails(getDoc(doc(client(f, role), ref(f, name + "/" + f.worker).path)));
  }
  await ref(f, "session_states/" + f.worker).set({ companyId: f.companyId, userId: f.colleague });
  await assertFails(getDoc(doc(client(f), ref(f, "session_states/" + f.worker).path)));
});
test("atomic batch cannot change control and inject an old-client log", async () => {
  const f = await fixture("backend"), c = client(f, "admin"), batch = writeBatch(c), id = "batch-" + randomUUID();
  batch.update(doc(c, control(f).path), { writeMode: "legacy" });
  batch.set(doc(c, "logs/" + id), { ...log(f), userId: f.admin });
  await assertFails(batch.commit()); assert.equal((await control(f).get()).data().writeMode, "backend");
  assert.equal((await db.doc("logs/" + id).get()).exists, false);
});
for (const mode of ["paused", "backend"]) test("offline old-client write is rejected after transition to " + mode, async () => {
  const f = await fixture("legacy"), c = client(f), id = "offline-" + randomUUID();
  await disableNetwork(c);
  const pending = setDoc(doc(c, "logs/" + id), log(f));
  const rejected = assertFails(pending); // Attach rejection handler before reconnecting.
  await control(f).update({ writeMode: mode, epoch: 2 });
  await enableNetwork(c); await rejected;
  assert.equal((await db.doc("logs/" + id).get()).exists, false);
});

// Real Auth emulator tokens + HTTP callable transport, not mocked domain decisions.
async function authenticate(f, role) {
  const uid = f[role], email = uid + "@example.invalid", password = "Fictional-local-password-36";
  await auth.createUser({ uid, email, password, emailVerified: true });
  const response = await fetch("http://" + local.auth + "/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-emulator-key", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }), signal: AbortSignal.timeout(180000),
  });
  assert.equal(response.status, 200); return (await response.json()).idToken;
}
async function operationFixture(operation, mode) {
  const f = await fixture(mode), isReg = operation === "regularizeSession", isEntry = operation === "clockIn";
  const openedAt = Timestamp.fromMillis(Date.now() - (isReg ? 49 : 1) * 3600000);
  if (isEntry) await db.doc("logs/" + f.entryId).delete();
  else await db.doc("logs/" + f.entryId).update({ timestamp: openedAt });
  await ref(f, "session_states/" + f.worker).set({ schemaVersion: 1, companyId: f.companyId, userId: f.worker,
    status: isEntry ? "idle" : "open", version: 1, activeEntryId: isEntry ? null : f.entryId,
    openedAt: isEntry ? null : openedAt, reviewReason: null, lastResolution: null, lastRequestId: null });
  // Read fixtures are not resolutions/receipts for this operation.
  await Promise.all([ref(f, "regularizations/" + f.worker).delete(), ref(f, "session_requests/" + f.worker).delete()]);
  f.token = await authenticate(f, isReg ? "admin" : "worker");
  f.data = { operation, requestId: randomUUID(), companyContext: f.companyId,
    expectedStateVersion: 1, expectedEpoch: 1, protocolVersion: 1, ...(isReg ? {
      originalEntryId: f.entryId, mode: "unknown_exit", reason: "Incidencia ficticia documentada en emulador.",
      evidenceReference: null, accreditedExitAt: null,
    } : {}) };
  return f;
}
async function call(f) {
  const response = await fetch("http://" + local.functions + "/" + local.projectId + "/us-central1/" + f.data.operation, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + f.token },
    body: JSON.stringify({ data: f.data }), signal: AbortSignal.timeout(180000),
  });
  return { status: response.status, ...await response.json() };
}
async function effects(f) {
  const snapshots = await Promise.all([db.collection("logs").where("companyId", "==", f.companyId).get(),
    ref(f, "session_states/" + f.worker).get(),
    db.collection("companies/" + f.companyId + "/regularizations").get(),
    db.collection("companies/" + f.companyId + "/session_requests").get()]);
  const data = d => ({ path: d.ref.path, data: d.data(), updateTime: d.updateTime });
  return snapshots.map(s => s.docs ? s.docs.map(data).sort((a, b) => a.path.localeCompare(b.path)) : data(s));
}
for (const operation of ["clockIn", "clockOut", "regularizeSession"]) {
  for (const mode of ["legacy", "paused", "backend"]) test(`real callable ${operation} in ${mode} with candidate rules loaded`, async () => {
    const f = await operationFixture(operation, mode), before = await effects(f), result = await call(f);
    if (mode === "backend") {
      assert.equal(result.result?.ok, true, JSON.stringify(result)); assert.equal(result.result.replayed, false);
      const receipt = await db.collection("companies/" + f.companyId + "/session_requests").get();
      assert.equal(receipt.size, 2); // One unrelated colleague fixture + one new receipt.
      await assertFails(setDoc(doc(client(f), "logs/forged-" + randomUUID()), log(f)));
      if (operation === "regularizeSession") {
        assert.equal(result.result.result.minutes, null);
        assert.deepEqual((await effects(f))[0], before[0]);
        await assertSucceeds(getDoc(doc(client(f), "companies/" + f.companyId + "/regularizations/" + f.entryId)));
      }
    } else {
      assert.equal(result.error?.details?.code, "SERVICE_PAUSED", JSON.stringify(result));
      assert.deepEqual(await effects(f), before);
    }
  });
  for (const mode of ["legacy", "paused"]) test(`${operation} receipt recovery in ${mode} performs no writes`, async () => {
    const f = await operationFixture(operation, "backend"), first = await call(f);
    assert.equal(first.result?.ok, true, JSON.stringify(first));
    await control(f).update({ writeMode: mode, epoch: 2 });
    const before = await effects(f), replay = await call(f);
    assert.equal(replay.result?.replayed, true, JSON.stringify(replay));
    assert.deepEqual(replay.result.result, first.result.result); assert.deepEqual(await effects(f), before);
    f.data.requestId = randomUUID(); const fresh = await call(f);
    assert.equal(fresh.error?.details?.code, "SERVICE_PAUSED", JSON.stringify(fresh));
    assert.deepEqual(await effects(f), before);
  });
  test(`${operation} cannot fall back to direct writes with missing control`, async () => {
    const f = await operationFixture(operation, null), before = await effects(f), result = await call(f);
    assert.equal(result.error?.details?.code, "INVALID_CONTROL", JSON.stringify(result));
    assert.deepEqual(await effects(f), before);
  });
}

for (const operation of ["clockIn", "clockOut", "regularizeSession"]) test(operation + " pause barrier excludes further new commits", async () => {
  const f = await operationFixture(operation, "backend");
  const [result] = await Promise.all([call(f), control(f).update({ writeMode: "paused", epoch: 2 })]);
  assert.ok(result.result?.ok || ["SERVICE_PAUSED", "EPOCH_CONFLICT"].includes(result.error?.details?.code), JSON.stringify(result));
  const before = await effects(f);
  f.data.requestId = randomUUID();
  const afterPause = await call(f);
  assert.equal(afterPause.error?.details?.code, "SERVICE_PAUSED", JSON.stringify(afterPause));
  assert.deepEqual(await effects(f), before);
});
