import { assertEmulatorEnvironment } from "./emulator-environment.js";
import { DOMAIN_VERSION } from "./session-domain.js";
export const PROBE_MARKER = "fichad2-phase3-local-fixture-v1";

// Read-only diagnostic. Dependency injection permits isolation tests without SDKs.
export function createHealthHandler({ environment, verifyToken, readUser, readProbe }) {
  return async (req, res) => {
    let config;
    try { config = assertEmulatorEnvironment(environment()); }
    catch { return res.status(503).json({ ok: false, code: "EMULATOR_ISOLATION" }); }
    if (req.method !== "GET") return res.status(405).json({ ok: false, code: "METHOD_NOT_ALLOWED" });
    const header = req.get("authorization") || "";
    if (!header.startsWith("Bearer ") || !header.slice(7)) return res.status(401).json({ ok: false, code: "AUTH_REQUIRED" });
    let user;
    try {
      const token = await verifyToken(header.slice(7));
      user = await readUser(token.uid);
      if (!user || user.uid !== token.uid || user.disabled) throw new Error("Invalid local user");
    } catch { return res.status(401).json({ ok: false, code: "INVALID_LOCAL_AUTH" }); }
    try {
      const probe = await readProbe();
      if (!probe || probe.marker !== PROBE_MARKER) return res.status(503).json({ ok: false, code: "PROBE_NOT_READY" });
      return res.status(200).json({ ok: true, projectId: config.projectId, domainVersion: DOMAIN_VERSION,
        authConnected: true, firestoreConnected: true });
    } catch { return res.status(503).json({ ok: false, code: "LOCAL_FIRESTORE_UNAVAILABLE" }); }
  };
}
