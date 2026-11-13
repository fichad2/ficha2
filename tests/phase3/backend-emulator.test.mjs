import assert from "node:assert/strict";
import { test, before } from "node:test";
import { assertEmulatorEnvironment } from "../../functions/src/emulator-environment.js";
import { PROBE_MARKER } from "../../functions/src/emulator-health.js";
const local = assertEmulatorEnvironment(process.env);
const endpoint = "http://" + local.functions + "/" + local.projectId + "/us-central1/emulatorHealth";
const document = "http://" + local.firestore + "/v1/projects/" + local.projectId + "/databases/(default)/documents/phase3_local_diagnostics/readiness";
const owner = { authorization: "Bearer owner", "content-type": "application/json" };
let token;
async function request(url, options = {}) { return fetch(url, { ...options, signal: AbortSignal.timeout(180000) }); }
before(async () => {
  const signup = await request("http://" + local.auth + "/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-local-key", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "step32-fictional@example.invalid", password: "fictional-local-password-123", returnSecureToken: true }),
  });
  assert.equal(signup.status, 200, "Local Authentication fixture creation failed");
  token = (await signup.json()).idToken;
  assert.equal(typeof token, "string", "Local token missing");
  const seed = await request(document, { method: "PATCH", headers: owner, body: JSON.stringify({ fields: { marker: { stringValue: PROBE_MARKER } } }) });
  assert.equal(seed.status, 200, "Local Firestore fixture creation failed");
});
test("Functions starts and reads the Auth and Firestore emulators with a real local token", async () => {
  const response = await request(endpoint, { headers: { authorization: "Bearer " + token } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, projectId: local.projectId, domainVersion: 1, authConnected: true, firestoreConnected: true });
});
test("unauthenticated requests and write methods are rejected by the running emulator", async () => {
  assert.equal((await request(endpoint)).status, 401);
  assert.equal((await request(endpoint, { method: "POST", headers: { authorization: "Bearer " + token } })).status, 405);
});
test("repeated diagnostics do not modify the fixture or create business records", async () => {
  const before = await (await request(document, { headers: owner })).json();
  for (let i = 0; i < 2; i++) assert.equal((await request(endpoint, { headers: { authorization: "Bearer " + token } })).status, 200);
  const after = await (await request(document, { headers: owner })).json();
  assert.deepEqual(after, before);
  const base = "http://" + local.firestore + "/v1/projects/" + local.projectId + "/databases/(default)/documents/";
  for (const collection of ["logs", "session_states", "regularizations", "session_requests", "companies"]) {
    const response = await request(base.slice(0, -1) + ":runQuery", { method: "POST", headers: owner,
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: collection, allDescendants: true }] } }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).filter((row) => row.document).length, 0);
  }
});
