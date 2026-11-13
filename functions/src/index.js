import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { assertEmulatorEnvironment } from "./emulator-environment.js";
import { createRegularizeSessionService } from "./regularize-session-service.js";
import { createClockOutService } from "./clock-out-service.js";
import { createClockInService } from "./clock-in-service.js";
import { createClockInHandler } from "./clock-in-callable.js";
import { createHealthHandler } from "./emulator-health.js";

// Fail before importing/initializing Firebase SDKs unless all destinations are
// pinned to the demo project and loopback. This entry point is NOT deployable.
let localFlags = {};
try {
  const parsed = JSON.parse(readFileSync(new URL("../emulator-local.json", import.meta.url), "utf8"));
  if (Object.keys(parsed).length === 2 && parsed.FICHAD2_LOCAL_ONLY === "true"
    && parsed.FICHAD2_FUNCTIONS_EMULATOR_HOST === "127.0.0.1:15001") localFlags = Object.freeze(parsed);
} catch { /* No opt-in file outside the launcher's temporary snapshot. */ }
const environment = () => ({ ...localFlags, ...process.env });
const local = assertEmulatorEnvironment(environment());
const require = createRequire(import.meta.url);
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { Firestore, Timestamp, FieldValue } = require("firebase-admin/firestore");

// Emulator-only credentials: never applicationDefault(), cert() or real keys.
const app = initializeApp({ projectId: local.projectId, credential: {
  async getAccessToken() { return { access_token: "owner", expires_in: 3600 }; },
} }, "fichad2-local-only");
const auth = getAuth(app);
// The public Firestore constructor avoids Admin SDK's ADC/certificate factory.
// ssl:false uses the emulator's owner header; the invalid dummy credential is
// explicit so a library fallback cannot discover credentials from the machine.
const firestore = new Firestore({ projectId: local.projectId, host: local.firestore, ssl: false,
  credentials: { client_email: "emulator@example.invalid", private_key: "emulator-only-not-a-private-key" } });

export const emulatorHealth = onRequest({ region: "us-central1", maxInstances: 1 }, createHealthHandler({
  environment,
  verifyToken: (token) => auth.verifyIdToken(token),
  readUser: (uid) => auth.getUser(uid),
  readProbe: async () => {
    const snapshot = await firestore.doc("phase3_local_diagnostics/readiness").get();
    return snapshot.exists ? snapshot.data() : null;
  },
}));

const executeClockIn = createClockInService({ firestore, environment, now: () => Timestamp.now(),
  serverTimestamp: () => FieldValue.serverTimestamp() });
export const clockIn = onCall({ region: "us-central1", maxInstances: 1 }, createClockInHandler({
  environment, readUser: (uid) => auth.getUser(uid), execute: executeClockIn, HttpsError,
}));

const executeClockOut = createClockOutService({ firestore, environment, now: () => Timestamp.now(),
  serverTimestamp: () => FieldValue.serverTimestamp() });
// Entry and exit share the existing authentication/error adapter.
export const clockOut = onCall({ region: "us-central1", maxInstances: 1 }, createClockInHandler({
  environment, readUser: (uid) => auth.getUser(uid), execute: executeClockOut, HttpsError,
}));

const executeRegularizeSession = createRegularizeSessionService({ firestore, environment, now: () => Timestamp.now(),
  serverTimestamp: () => FieldValue.serverTimestamp(), toTimestamp: ({ seconds, nanoseconds }) => new Timestamp(seconds, nanoseconds) });
export const regularizeSession = onCall({ region: "us-central1", maxInstances: 1 }, createClockInHandler({
  environment, readUser: (uid) => auth.getUser(uid), execute: executeRegularizeSession, HttpsError,
}));
