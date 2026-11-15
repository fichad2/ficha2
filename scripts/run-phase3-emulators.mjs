import { spawn } from "node:child_process";
import { createServer, createConnection } from "node:net";
import { mkdtemp, readFile, writeFile, mkdir, symlink, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertEmulatorEnvironment, CREDENTIAL_VARIABLES, LOCAL_PROJECT_ID, LOCAL_HOSTS } from "../functions/src/emulator-environment.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ports = [19099, 18080, 15001, 14400, 14500, 9150];
export function makeIsolatedEnvironment(parent, workspace, nodeDirectory) {
  const env = { ...parent };
  for (const key of [...CREDENTIAL_VARIABLES, "NODE_OPTIONS", "NODE_PATH", "FIREBASE_CONFIG", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"]) delete env[key];
  Object.assign(env, { FICHAD2_LOCAL_ONLY: "true", FUNCTIONS_EMULATOR: "true", GCLOUD_PROJECT: LOCAL_PROJECT_ID,
    GOOGLE_CLOUD_PROJECT: LOCAL_PROJECT_ID, FIREBASE_CONFIG: JSON.stringify({ projectId: LOCAL_PROJECT_ID }),
    FIREBASE_AUTH_EMULATOR_HOST: LOCAL_HOSTS.auth, FIRESTORE_EMULATOR_HOST: LOCAL_HOSTS.firestore,
    FICHAD2_FUNCTIONS_EMULATOR_HOST: LOCAL_HOSTS.functions, XDG_CONFIG_HOME: path.join(workspace, "config"),
    CLOUDSDK_CONFIG: path.join(workspace, "gcloud"), GCE_METADATA_HOST: "127.0.0.1:9", GCE_METADATA_IP: "127.0.0.1",
    FUNCTIONS_DISCOVERY_TIMEOUT: "120", CI: "true", NO_UPDATE_NOTIFIER: "1", FIREBASE_CLI_DISABLE_USAGE_REPORTING: "true", DEBUG: "" });
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  env[pathKey] = nodeDirectory + path.delimiter + (env[pathKey] || "");
  assertEmulatorEnvironment(env);
  return env;
}
export function validateLocalConfiguration(config) {
  if (config.hosting || config.functions?.length !== 1 || config.functions[0].source !== "functions"
    || config.functions[0].runtime !== "nodejs22"
    || JSON.stringify(config.functions[0].predeploy) !== JSON.stringify(["node scripts/block-phase3-deploy.mjs"])) throw new Error("Configuración local de Functions inválida");
  for (const [service, port] of Object.entries({ auth: 19099, firestore: 18080, functions: 15001, hub: 14400, logging: 14500 })) {
    if (config.emulators?.[service]?.host !== "127.0.0.1" || config.emulators[service].port !== port) throw new Error("Destino de emulador inválido: " + service);
  }
  if (config.emulators.ui?.enabled !== false || config.firestore?.rules !== "firestore.phase3-local.rules"
    || JSON.stringify(config.firestore?.predeploy) !== JSON.stringify(["node scripts/block-phase3-deploy.mjs"])) throw new Error("Configuración de emuladores inválida");
}
async function available(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error("Puerto ocupado: " + port + ". No se detiene ningún proceso ajeno.")));
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}
async function isListening(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.once("connect", () => finish(true)); socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}
async function firebaseCli() {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path");
  const candidates = (process.env[pathKey] || "").split(path.delimiter).map((dir) => path.join(dir, "node_modules/firebase-tools/lib/bin/firebase.js"));
  candidates.unshift(path.join(root, "node_modules/firebase-tools/lib/bin/firebase.js"));
  for (const file of candidates) { try { await access(file); return file; } catch {} }
  throw new Error("Firebase CLI no encontrado. Instálalo por separado antes de ejecutar emuladores.");
}
export async function prepareFunctionsSnapshot(workspace) {
  const destination = path.join(workspace, "functions");
  await mkdir(path.join(destination, "src"), { recursive: true });
  for (const name of ["session-domain.js", "emulator-environment.js", "emulator-health.js", "clock-in-service.js", "clock-out-service.js", "regularize-session-service.js", "session-transaction-support.js", "clock-in-callable.js", "session-operation-recovery.js", "index.js"]) {
    await writeFile(path.join(destination, "src", name), await readFile(path.join(root, "functions/src", name)));
  }
  for (const name of ["package.json", "package-lock.json"]) {
    await writeFile(path.join(destination, name), await readFile(path.join(root, "functions", name)));
  }
  await symlink(path.join(root, "functions/node_modules"), path.join(destination, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  // SDK discovery filters custom parent envs. Persist only the two non-secret
  // opt-in flags; project, emulator indicator and SDK hosts still MUST come from env.
  await writeFile(path.join(destination, "emulator-local.json"), JSON.stringify({
    FICHAD2_LOCAL_ONLY: "true", FICHAD2_FUNCTIONS_EMULATOR_HOST: LOCAL_HOSTS.functions,
  }));
  return destination;
}
export async function runEmulators(mode) {
  if (!["test", "start"].includes(mode)) throw new Error("Uso: node scripts/run-phase3-emulators.mjs test|start");
  if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("Este entorno requiere Node 22. No cambia la instalación global de Node.");
  const config = JSON.parse(await readFile(path.join(root, "firebase.emulators.phase3.json"), "utf8"));
  validateLocalConfiguration(config);
  for (const port of ports) await available(port);
  const workspace = await mkdtemp(path.join(tmpdir(), "fichad2-step32-"));
  await prepareFunctionsSnapshot(workspace);
  await mkdir(path.join(workspace, "scripts"));
  await writeFile(path.join(workspace, "scripts/block-phase3-deploy.mjs"), await readFile(path.join(root, "scripts/block-phase3-deploy.mjs")));
  for (const name of ["firestore.rules", "firestore.phase3-local.rules"]) {
    await writeFile(path.join(workspace, name), await readFile(path.join(root, name)));
  }
  await writeFile(path.join(workspace, "firebase.json"), JSON.stringify(config));
  const bootstrap = "import { runPhase3Tests } from " + JSON.stringify(pathToFileURL(path.join(root, "scripts/run-phase3-tests.mjs")).href) + "; await runPhase3Tests();\n";
  await writeFile(path.join(workspace, "run-tests.mjs"), bootstrap);
  const env = makeIsolatedEnvironment(process.env, workspace, path.dirname(process.execPath));
  const args = [await firebaseCli(), mode === "test" ? "emulators:exec" : "emulators:start", "--only", "auth,firestore,functions", "--project", LOCAL_PROJECT_ID, "--config", "firebase.json"];
  if (mode === "test") args.push("node run-tests.mjs");
  console.log("Emuladores locales: " + LOCAL_PROJECT_ID + ". Workspace temporal: " + workspace);
  const child = spawn(process.execPath, args, { cwd: workspace, env, stdio: "inherit", windowsHide: true });
  // On Windows the console delivers Ctrl+C to the shared process group itself.
  const onInterrupt = () => { if (process.platform !== "win32") child.kill("SIGINT"); };
  process.on("SIGINT", onInterrupt);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (value) => resolve(value ?? 1)); });
  process.off("SIGINT", onInterrupt);
  const remaining = [];
  for (const port of ports) if (await isListening(port)) remaining.push(port);
  if (remaining.length) throw new Error("Quedan puertos abiertos tras la parada: " + remaining.join(", "));
  console.log("Parada verificada: todos los puertos del entorno están cerrados.");
  process.exitCode = code;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runEmulators(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
