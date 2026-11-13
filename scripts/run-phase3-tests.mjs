import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertEmulatorEnvironment } from "../functions/src/emulator-environment.js";
export async function runPhase3Tests() {
  assertEmulatorEnvironment(process.env);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const tests = ["tests/session-reconstruction.test.mjs", "tests/session-reporting.test.mjs",
    "tests/session-calculation-compatibility.test.mjs", "tests/session-history-integration.test.mjs",
    "tests/session-report-integration.test.mjs", "tests/session-daily-allocation.test.mjs",
    "tests/phase3/session-domain.test.mjs",
    "tests/phase3/backend-environment.test.mjs", "tests/phase3/backend-emulator.test.mjs"];
  // Rules fixtures are cleared before read-only health checks; all use the same demo project.
  for (const [index, batch] of [["tests/firestore.rules.test.mjs"], ["tests/firestore.rules.test.mjs"], tests, ["tests/phase3/clock-in.test.mjs"], ["tests/phase3/clock-out.test.mjs"], ["tests/phase3/regularize-session.test.mjs"], ["tests/phase3/write-modes.test.mjs"]].entries()) {
    const child = spawn(process.execPath, ["--test", "--test-reporter=spec", ...batch], { cwd: root, env: { ...process.env, FICHAD2_RULES_VARIANT: index === 1 ? "phase3" : "original" }, stdio: "inherit", windowsHide: true });
    process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1)); });
    if (process.exitCode) break;
  }
}
