import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertEmulatorEnvironment, LOCAL_PROJECT_ID, LOCAL_HOSTS, CREDENTIAL_VARIABLES } from "../../functions/src/emulator-environment.js";
import { createHealthHandler, PROBE_MARKER } from "../../functions/src/emulator-health.js";
import { makeIsolatedEnvironment, validateLocalConfiguration, prepareFunctionsSnapshot } from "../../scripts/run-phase3-emulators.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const env = () => ({ FICHAD2_LOCAL_ONLY: "true", FUNCTIONS_EMULATOR: "true", GCLOUD_PROJECT: LOCAL_PROJECT_ID,
  GOOGLE_CLOUD_PROJECT: LOCAL_PROJECT_ID, FIREBASE_CONFIG: JSON.stringify({ projectId: LOCAL_PROJECT_ID }),
  FIREBASE_AUTH_EMULATOR_HOST: LOCAL_HOSTS.auth, FIRESTORE_EMULATOR_HOST: LOCAL_HOSTS.firestore,
  FICHAD2_FUNCTIONS_EMULATOR_HOST: LOCAL_HOSTS.functions });

test("only the pinned demo project and loopback endpoints are accepted", () => {
  assert.equal(assertEmulatorEnvironment(env()).projectId, LOCAL_PROJECT_ID);
});
for (const patch of [{ FICHAD2_LOCAL_ONLY: undefined }, { FUNCTIONS_EMULATOR: undefined },
  { GCLOUD_PROJECT: "fichad2-piloto" }, { GOOGLE_CLOUD_PROJECT: "another-project" },
  { GCLOUD_PROJECT: undefined, GOOGLE_CLOUD_PROJECT: undefined }, { FIREBASE_CONFIG: "invalid" },
  { FIREBASE_CONFIG: JSON.stringify({ projectId: "fichad2-piloto" }) },
  { FIREBASE_CONFIG: JSON.stringify({ projectId: LOCAL_PROJECT_ID, private_key: "fake-not-real" }) },
  { FIREBASE_AUTH_EMULATOR_HOST: undefined }, { FIRESTORE_EMULATOR_HOST: undefined },
  { FICHAD2_FUNCTIONS_EMULATOR_HOST: undefined }, { FIRESTORE_EMULATOR_HOST: "firestore.googleapis.com:443" },
  { FIREBASE_AUTH_EMULATOR_HOST: "0.0.0.0:19099" }, { FICHAD2_FUNCTIONS_EMULATOR_HOST: "127.0.0.1:5001" },
  { FIRESTORE_EMULATOR_HOST: "http://127.0.0.1:18080" }]) {
  test("unsafe environment rejected: " + Object.keys(patch).join(","), () => {
    assert.throws(() => assertEmulatorEnvironment({ ...env(), ...patch }), { code: "EMULATOR_ISOLATION" });
  });
}
for (const key of CREDENTIAL_VARIABLES) test("real-credential variable is rejected: " + key, () => {
  assert.throws(() => assertEmulatorEnvironment({ ...env(), [key]: "fake-value-not-a-real-credential" }), { code: "EMULATOR_ISOLATION" });
});
test("launcher removes credentials and preloads and isolates CLI account storage", () => {
  const parent = Object.fromEntries(CREDENTIAL_VARIABLES.map((key) => [key, "fake-value"]));
  Object.assign(parent, { NODE_OPTIONS: "--import untrusted", NODE_PATH: "untrusted", FIREBASE_CONFIG: "real", PATH: "old" });
  const isolated = makeIsolatedEnvironment(parent, "temporary-workspace", "node-runtime");
  for (const key of [...CREDENTIAL_VARIABLES, "NODE_OPTIONS", "NODE_PATH"]) assert.equal(isolated[key], undefined);
  assert.equal(parent.GOOGLE_APPLICATION_CREDENTIALS, "fake-value");
  assert.match(isolated.XDG_CONFIG_HOME, /temporary-workspace/);
  assert.equal(assertEmulatorEnvironment(isolated).projectId, LOCAL_PROJECT_ID);
});
test("dedicated configuration preserves deploy block and local destinations", () => {
  const config = JSON.parse(readFileSync(new URL("../../firebase.emulators.phase3.json", import.meta.url)));
  validateLocalConfiguration(config);
  for (const service of ["auth", "firestore", "functions", "hub", "logging"]) {
    const changed = structuredClone(config); changed.emulators[service].host = "0.0.0.0";
    assert.throws(() => validateLocalConfiguration(changed));
  }
  const changed = structuredClone(config); changed.functions[0].predeploy = [];
  assert.throws(() => validateLocalConfiguration(changed));
});
test("backend package is private, ESM and has only the two pinned direct SDK dependencies", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../functions/package.json", import.meta.url)));
  assert.equal(pkg.private, true); assert.equal(pkg.type, "module"); assert.equal(pkg.engines.node, "22");
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["firebase-admin", "firebase-functions"]);
  for (const version of Object.values(pkg.dependencies)) assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(Object.keys(pkg.scripts).some((key) => /deploy/.test(key)), false);
});
test("entry point refuses loading before SDK initialization outside emulators", () => {
  const childEnv = { ...process.env };
  for (const key of [...Object.keys(env()), ...CREDENTIAL_VARIABLES, "NODE_OPTIONS", "NODE_PATH"]) delete childEnv[key];
  const child = spawnSync(process.execPath, ["functions/src/index.js"], { cwd: root, env: childEnv, encoding: "utf8", timeout: 120000, windowsHide: true });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /Entorno local no autorizado/);
});
test("predeploy guard always exits with failure, without invoking Firebase CLI", () => {
  const child = spawnSync(process.execPath, ["scripts/block-phase3-deploy.mjs"], { cwd: root, encoding: "utf8", timeout: 120000, windowsHide: true });
  assert.equal(child.status, 1); assert.match(child.stderr, /Despliegue bloqueado/);
});
function harness(overrides = {}) {
  const calls = [];
  const response = { status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  const run = createHealthHandler({ environment: env,
    verifyToken: async () => { calls.push("verify"); return { uid: "fictional" }; },
    readUser: async () => { calls.push("user"); return { uid: "fictional", disabled: false }; },
    readProbe: async () => { calls.push("firestore"); return { marker: PROBE_MARKER }; }, ...overrides });
  return { run, response, calls, request: { method: "GET", get: () => "Bearer fictional-emulator-token" } };
}
test("diagnostic reads Authentication and Firestore, reusing only domain metadata", async () => {
  const h = harness(); await h.run(h.request, h.response);
  assert.equal(h.response.statusCode, 200); assert.deepEqual(h.calls, ["verify", "user", "firestore"]);
  assert.equal(h.response.body.domainVersion, 1);
  assert.equal(Object.hasOwn(h.response.body, "uid"), false);
});
test("runtime misconfiguration blocks all SDK calls before handling a request", async () => {
  const h = harness({ environment: () => ({ ...env(), FIRESTORE_EMULATOR_HOST: "remote:443" }) });
  await h.run(h.request, h.response); assert.equal(h.response.statusCode, 503); assert.deepEqual(h.calls, []);
});
test("diagnostic rejects mutation methods and unauthenticated calls without reading data", async () => {
  for (const request of [{ method: "POST", get: () => "" }, { method: "GET", get: () => "" }]) {
    const h = harness(); await h.run(request, h.response); assert.ok([401, 405].includes(h.response.statusCode)); assert.deepEqual(h.calls, []);
  }
});
test("invalid auth never reaches Firestore", async () => {
  const h = harness({ verifyToken: async () => { throw new Error("fictional auth failure"); } });
  await h.run(h.request, h.response); assert.equal(h.response.statusCode, 401); assert.deepEqual(h.calls, []);
});
test("missing fixture and unavailable Firestore are not reported as success", async () => {
  for (const readProbe of [async () => null, async () => { throw new Error("local failure"); }]) {
    const h = harness({ readProbe }); await h.run(h.request, h.response); assert.equal(h.response.statusCode, 503);
  }
});

test("temporary source snapshot pins local flags and preserves the domain byte for byte", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "fichad2-snapshot-test-"));
  const destination = await prepareFunctionsSnapshot(workspace);
  assert.deepEqual(await readFile(path.join(destination, "src/session-domain.js")), readFileSync(new URL("../../functions/src/session-domain.js", import.meta.url)));
  assert.deepEqual(JSON.parse(await readFile(path.join(destination, "emulator-local.json"), "utf8")), {
    FICHAD2_LOCAL_ONLY: "true", FICHAD2_FUNCTIONS_EMULATOR_HOST: "127.0.0.1:15001",
  });
});

test("runtime can require the guarded ESM entry synchronously and exposes only the diagnostic and the three session callables", () => {
  const isolated = makeIsolatedEnvironment(process.env, tmpdir(), path.dirname(process.execPath));
  const code = 'const m=require("./functions/src/index.js"); if(typeof m.emulatorHealth!=="function" || typeof m.clockIn!=="function" || typeof m.clockOut!=="function" || typeof m.regularizeSession!=="function" || JSON.stringify(Object.keys(m).filter(k=>!k.startsWith("__")).sort())!==JSON.stringify(["clockIn","clockOut","emulatorHealth","regularizeSession"])) process.exit(2); console.log("LOCAL_ENTRY_READY");';
  const child = spawnSync(process.execPath, ["--input-type=commonjs", "-e", code], {
    cwd: root, env: isolated, encoding: "utf8", timeout: 120000, windowsHide: true,
  });
  assert.equal(child.status, 0);
  assert.match(child.stdout, /LOCAL_ENTRY_READY/);
});
