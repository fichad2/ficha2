export const LOCAL_PROJECT_ID = "demo-fichad2-phase3";
export const LOCAL_HOSTS = Object.freeze({ auth: "127.0.0.1:19099", firestore: "127.0.0.1:18080", functions: "127.0.0.1:15001" });
export const CREDENTIAL_VARIABLES = Object.freeze(["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_TOKEN", "GOOGLE_AUTH_ACCESS_TOKEN", "CLOUDSDK_AUTH_ACCESS_TOKEN", "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE"]);
export function assertEmulatorEnvironment(env) {
  const reject = (field) => { const error = new Error("Entorno local no autorizado: " + field); error.code = "EMULATOR_ISOLATION"; throw error; };
  if (!env || env.FICHAD2_LOCAL_ONLY !== "true" || env.FUNCTIONS_EMULATOR !== "true") reject("localOnly");
  const projects = [env.GCLOUD_PROJECT, env.GOOGLE_CLOUD_PROJECT].filter((v) => v !== undefined);
  if (!projects.length || projects.some((v) => v !== LOCAL_PROJECT_ID)) reject("projectId");
  if (env.FIREBASE_CONFIG !== undefined) {
    let config;
    try { config = JSON.parse(env.FIREBASE_CONFIG); } catch { reject("firebaseConfig"); }
    if (!config || config.projectId !== LOCAL_PROJECT_ID || config.private_key || config.credential || config.client_email) reject("firebaseConfig");
  }
  for (const field of CREDENTIAL_VARIABLES) if (env[field]) reject(field);
  for (const [field, expected] of [["FIREBASE_AUTH_EMULATOR_HOST", LOCAL_HOSTS.auth],
    ["FIRESTORE_EMULATOR_HOST", LOCAL_HOSTS.firestore], ["FICHAD2_FUNCTIONS_EMULATOR_HOST", LOCAL_HOSTS.functions]]) {
    if (env[field] !== expected) reject(field);
  }
  return Object.freeze({ projectId: LOCAL_PROJECT_ID, ...LOCAL_HOSTS });
}
