import { assertEmulatorEnvironment } from "./emulator-environment.js";
import { ClockInError } from "./clock-in-service.js";

const statuses = { UNAUTHENTICATED: "unauthenticated", EMAIL_NOT_VERIFIED: "failed-precondition",
  FORBIDDEN: "permission-denied", COMPANY_MISMATCH: "permission-denied", PROFILE_NOT_FOUND: "failed-precondition",
  COMPANY_NOT_FOUND: "failed-precondition", INVALID_REQUEST: "invalid-argument", REQUEST_ID_CONFLICT: "already-exists",
  EMULATOR_ISOLATION: "failed-precondition" };
export function createClockInHandler({ environment, readUser, execute, HttpsError }) {
  return async (request) => {
    try {
      assertEmulatorEnvironment(environment());
      if (!request.auth?.uid) throw new ClockInError("UNAUTHENTICATED");
      let user;
      try { user = await readUser(request.auth.uid); }
      catch (error) {
        if (["auth/user-not-found", "auth/id-token-revoked", "auth/user-disabled"].includes(error.code)) throw new ClockInError("UNAUTHENTICATED");
        throw error;
      }
      if (user.uid !== request.auth.uid || user.disabled) throw new ClockInError("UNAUTHENTICATED");
      // Check both the token and current Auth record. A stale token needs refresh.
      const emailVerified = user.emailVerified === true && request.auth.token?.email_verified === true;
      const validAfter = Date.parse(user.tokensValidAfterTime);
      if (Number.isFinite(validAfter) && (!Number.isFinite(request.auth.token?.auth_time)
        || request.auth.token.auth_time * 1000 < validAfter)) throw new ClockInError("UNAUTHENTICATED");
      return await execute({ data: request.data, identity: { uid: user.uid, emailVerified } });
    } catch (error) {
      if (error instanceof ClockInError) throw new HttpsError(statuses[error.code] || "failed-precondition", error.message,
        { code: error.code, details: error.details, retryable: error.retryable });
      if (error.code === "EMULATOR_ISOLATION") throw new HttpsError("failed-precondition", "Entorno local no autorizado.", { code: "EMULATOR_ISOLATION", retryable: false });
      // A lost response may follow a successful commit: never claim 'not saved'.
      throw new HttpsError("unavailable", "No se ha podido confirmar el fichaje. Reintenta con la misma solicitud.",
        { code: "CONFIRMATION_UNAVAILABLE", retryable: true, outcomeUnknown: true });
    }
  };
}
