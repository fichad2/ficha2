const MINUTE_NS = 60_000_000_000n;
const DAY_NS = 1440n * MINUTE_NS;
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// No Firebase dependency. Keep nanoseconds for ordering and reference validation;
// converting Firestore timestamps to Date first would lose that precision.
function instant(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? BigInt(value.getTime()) * 1_000_000n : null;
  }
  if (!value || typeof value !== "object") return null;
  const { seconds, nanoseconds } = value;
  if (!Number.isSafeInteger(seconds) || !Number.isInteger(nanoseconds)
    || nanoseconds < 0 || nanoseconds >= 1_000_000_000
    || seconds < -62135596800 || seconds > 253402300799) return null;
  return BigInt(seconds) * 1_000_000_000n + BigInt(nanoseconds);
}

/**
 * Reconstruct an entire supplied history, without I/O, mutation or inferred pairs.
 * Records have {id, userId, companyId, tipo, timestamp, entradaLogId?,
 * inicioSesion?, minutosSesion?}. timestamp/inicioSesion accept Date or Firestore
 * {seconds, nanoseconds}; strings and unresolved serverTimestamp sentinels are invalid.
 * Pass {now: Date|Timestamp} to detect future records and overdue open entries.
 * Without now there is no wall-clock-dependent analysis.
 *
 * Only an explicit, unique, coherent entradaLogId confirms a closed session.
 * "open" means no validated exit in the supplied data, not proof that no exit
 * exists elsewhere. A group with canReconstruct=false must not drive unblocking.
 * Original objects/IDs are retained, including rejected and ambiguous records.
 * Results refer to input objects; callers should treat both as read-only.
 */
export function reconstructSessions(records, { now } = {}) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  const nowNs = now === undefined ? null : instant(now);
  if (now !== undefined && nowNs === null) throw new TypeError("now must be a valid Date or Timestamp");

  const issues = [];
  const rows = records.map((record, index) => ({ record, index, valid: true }));
  const groups = new Map();
  const byId = new Map();
  const issue = (code, affected, details = {}, blocking = true) => {
    issues.push({ code, logIds: affected.map((r) => r.record?.id ?? null),
      recordIndexes: affected.map((r) => r.index), blocking, ...details });
    if (blocking) for (const row of affected) {
      if (row.group) row.group.canReconstruct = false;
    }
  };

  for (const row of rows) {
    const record = row.record;
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      row.valid = false;
      issue("invalid_record", [row]);
      continue;
    }
    if (nonempty(record.userId) && nonempty(record.companyId)) {
      const key = JSON.stringify([record.companyId, record.userId]);
      if (!groups.has(key)) groups.set(key, {
        companyId: record.companyId, userId: record.userId, canReconstruct: true, rows: [],
      });
      row.group = groups.get(key);
      row.group.rows.push(row);
    }
    const invalidFields = ["id", "userId", "companyId"].filter((key) => !nonempty(record[key]));
    if (!["entrada", "salida"].includes(record.tipo)) invalidFields.push("tipo");
    row.time = instant(record.timestamp);
    if (row.time === null) invalidFields.push("timestamp");
    if (invalidFields.length) {
      row.valid = false;
      issue("invalid_fields", [row], { fields: invalidFields });
    }
    if (nonempty(record.id)) {
      if (!byId.has(record.id)) byId.set(record.id, []);
      byId.get(record.id).push(row);
    }
    if (nowNs !== null && row.time !== null && row.time > nowNs) {
      row.valid = false;
      issue("future_timestamp", [row]);
    }
  }

  // Quarantine every occurrence of a repeated document ID, even if identical.
  for (const matches of byId.values()) if (matches.length > 1) {
    issue("duplicate_id", matches);
    for (const row of matches) row.valid = false;
  }

  // Distinct IDs with the same actor, type and exact instant are suspicious.
  // Do not silently deduplicate or select one as the authentic event.
  const events = new Map();
  for (const row of rows.filter((r) => r.valid)) {
    const key = JSON.stringify([row.record.companyId, row.record.userId,
      row.record.tipo, row.time.toString()]);
    if (!events.has(key)) events.set(key, []);
    events.get(key).push(row);
  }
  for (const matches of events.values()) if (matches.length > 1) {
    issue("possible_duplicate_event", matches);
    for (const row of matches) row.valid = false;
  }

  const entries = rows.filter((r) => r.valid && r.record.tipo === "entrada")
    .sort((a, b) => compare(a.record.companyId, b.record.companyId)
      || compare(a.record.userId, b.record.userId) || compare(a.time, b.time)
      || compare(a.record.id, b.record.id));
  const linked = new Map(entries.map((entry) => [entry, []]));
  const consumedExits = new Set();
  for (const exit of rows.filter((r) => r.valid && r.record.tipo === "salida")) {
    const ref = exit.record.entradaLogId;
    if (!nonempty(ref)) {
      issue("missing_entry_reference", [exit]);
      continue;
    }
    const targets = byId.get(ref);
    if (!targets) {
      issue("entry_not_found", [exit], { entradaLogId: ref });
      continue;
    }
    if (targets.length !== 1) {
      issue("ambiguous_entry_reference", [exit], { entradaLogId: ref });
      continue;
    }
    const entry = targets[0];
    if (entry.record.tipo !== "entrada") {
      issue("reference_not_entry", [exit], { entradaLogId: ref });
      continue;
    }
    if (entry.record.companyId !== exit.record.companyId || entry.record.userId !== exit.record.userId) {
      issue("reference_scope_mismatch", [exit], { entradaLogId: ref });
      continue;
    }
    if (!linked.has(entry)) {
      issue("invalid_entry_reference", [exit], { entradaLogId: ref });
      continue;
    }
    linked.get(entry).push(exit);
  }

  const sessions = [];
  const sessionByEntry = new Map();
  for (const entry of entries) {
    const candidates = linked.get(entry);
    const session = {
      entry: entry.record, exit: null, companyId: entry.record.companyId,
      userId: entry.record.userId, status: "open", minutes: null,
      relatedExitIds: candidates.map((r) => r.record.id).sort(),
      isOver24Hours: false,
    };
    if (candidates.length > 1) {
      session.status = "conflict";
      issue("multiple_exits", [entry, ...candidates]);
    } else if (candidates.length === 1) {
      const exit = candidates[0];
      let coherent = true;
      const reject = (code) => { coherent = false; issue(code, [entry, exit]); };
      if (exit.time <= entry.time) reject("exit_not_after_entry");
      if (Object.hasOwn(exit.record, "inicioSesion")) {
        const savedStart = instant(exit.record.inicioSesion);
        if (savedStart !== entry.time) {
          // App.jsx writes inicioSesion through Timestamp.toDate(), which loses
          // sub-millisecond precision. Recognize that known representation only;
          // keep original timestamps for ordering and duration calculations.
          const asDate = (entry.time / 1_000_000n) * 1_000_000n;
          if (savedStart !== null && savedStart === asDate) {
            issue("session_start_precision_loss", [entry, exit], {}, false);
          } else reject("session_start_mismatch");
        }
      }
      const duration = exit.time - entry.time;
      const minutes = duration >= 0n ? Number(duration / MINUTE_NS) : null;
      if (Object.hasOwn(exit.record, "minutosSesion")
        && (!Number.isInteger(exit.record.minutosSesion) || exit.record.minutosSesion < 0
          || exit.record.minutosSesion !== minutes)) reject("session_minutes_mismatch");
      if (duration > DAY_NS) reject("session_exceeds_24_hours");
      if (coherent) {
        session.exit = exit.record;
        session.status = "closed";
        session.minutes = minutes;
        consumedExits.add(exit);
      } else session.status = "conflict";
    } else if (nowNs !== null && nowNs - entry.time > DAY_NS) {
      session.isOver24Hours = true;
      issue("overdue_open_session", [entry], {}, false);
    }
    sessions.push(session);
    sessionByEntry.set(entry, session);
  }

  // Explicit references can reveal overlapping/consecutive sessions; never repair
  // them by closing an earlier entry at the next entry's timestamp.
  for (const group of groups.values()) {
    const ordered = group.rows.filter((r) => sessionByEntry.has(r))
      .sort((a, b) => compare(a.time, b.time));
    for (let i = 0; i < ordered.length - 1; i++) {
      const previous = ordered[i];
      const next = ordered[i + 1];
      const session = sessionByEntry.get(previous);
      if (session.status !== "closed") issue("consecutive_entries", [previous, next]);
      else if (instant(session.exit.timestamp) > next.time) issue("overlapping_sessions", [previous, next]);
    }
  }

  const entryRows = new Set(entries);
  const resultGroups = [...groups.values()].map((group) => ({
    companyId: group.companyId, userId: group.userId, canReconstruct: group.canReconstruct,
    status: !group.canReconstruct ? "needs_review"
      : group.rows.some((r) => sessionByEntry.get(r)?.status === "open")
        ? "open" : "closed",
  }));
  return {
    records: [...records], sessions, issues, groups: resultGroups,
    canReconstruct: !issues.some((i) => i.blocking),
    unresolvedLogs: rows.filter((r) => !entryRows.has(r) && !consumedExits.has(r)).map((r) => r.record),
  };
}
