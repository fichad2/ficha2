import { createHash } from "node:crypto";
import { reconstructSessions } from "../../src/session-reconstruction.js";
import { DOMAIN_VERSION, inspectSessionState, SESSION_STATUS } from "./session-domain.js";

export const RECONCILIATION_CONTRACT_VERSION = 1;
export const PLANNING_DECISION = Object.freeze({
  ELIGIBLE: "eligible", BLOCKED: "blocked", INCOMPLETE_SOURCE: "incomplete_source",
  ALREADY_INITIALIZED: "already_initialized", RECOVERY_REQUIRED: "recovery_required",
});

const sources = ["profiles", "logs", "states", "regularizations", "requests"];
const stateFields = ["schemaVersion", "companyId", "userId", "status", "version",
  "activeEntryId", "openedAt", "reviewReason", "lastResolution", "lastRequestId"];
const object = value => value !== null && typeof value === "object"
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = value => typeof value === "string" && value.length > 0 && value.length <= 128
  && value.trim() === value && !/[\/\\\x00-\x1f\x7f]/.test(value) && ![".", ".."].includes(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
// Called only after reconstruction/domain validation, without changing either source.
const instantNs = value => value instanceof Date ? BigInt(value.getTime()) * 1_000_000n
  : BigInt(value.seconds) * 1_000_000_000n + BigInt(value.nanoseconds);
function copyOriginalTimestamp(value) {
  // Project an accepted legacy Date explicitly to the domain timestamp DTO.
  // Preserve its exact instant, including negative milliseconds; never read now.
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    const seconds = Math.floor(milliseconds / 1000);
    return { seconds, nanoseconds: (milliseconds - seconds * 1000) * 1_000_000 };
  }
  return { seconds: value.seconds, nanoseconds: value.nanoseconds };
}
const exactKeys = (value, keys) => object(value) && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const timestamp = value => exactKeys(value, ["seconds", "nanoseconds"])
  && Number.isSafeInteger(value.seconds) && value.seconds >= -62135596800 && value.seconds <= 253402300799
  && Number.isInteger(value.nanoseconds) && value.nanoseconds >= 0 && value.nanoseconds < 1e9;
const dense = value => Array.isArray(value) && Object.keys(value).length === value.length
  && Object.keys(value).every((key, index) => key === String(index));
const sorted = diagnostics => [...diagnostics].sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
function diagnostic(code, source, recordIndexes = [], recordIds = [], blocking = true) {
  return { code, source, recordIndexes: [...recordIndexes].sort((a, b) => a - b),
    recordIds: [...recordIds].sort(compare), blocking };
}

// Same logical, company-scoped identity used by the manifest inventory. No
// ownership is inferred from arbitrary metadata or from an admin's signature.
const documentPath = (source, document) => object(document) && id(document.id) ? source + "/" + document.id : null;
function inspectDocumentIdentityConflicts(input) {
  const documents = [], byPath = new Map(), dependents = new Map();
  const receiptPath = (actor, requestId, companyId) => id(actor) && uuid(requestId) && companyId === input.companyId
    ? "requests/" + createHash("sha256").update(JSON.stringify([DOMAIN_VERSION, companyId, actor, requestId])).digest("hex") : null;
  for (const source of sources) for (const [index, document] of input[source].entries()) {
    const path = documentPath(source, document);
    if (path === null) continue; // Existing invalid/unattributed-data guards remain authoritative.
    const node = { source, index, id: document.id, path, owners: new Set(), subjectRefs: new Set(), dependencies: new Set(), identityRefs: new Set(), mismatches: [] };
    const data = ["profiles", "logs"].includes(source) ? document : object(document.data) ? document.data : {};
    node.companyId = id(data.companyId) ? data.companyId : null;
    const owner = uid => { if (id(uid)) node.owners.add(uid); };
    const reference = (collection, key, subject = true) => {
      if (!id(key)) return;
      const target = collection + "/" + key;
      if (target === path) return; // A matching self-identity is not another subject.
      node.dependencies.add(target); if (subject) node.subjectRefs.add(target);
    };
    const requestDependency = (actor, requestId) => {
      const target = receiptPath(actor, requestId, data.companyId);
      if (target) node.dependencies.add(target);
      return target;
    };
    if (source === "profiles") owner(document.id);
    if (source === "logs") {
      owner(data.userId);
      if (data.tipo === "salida") reference("logs", data.entradaLogId);
    }
    if (source === "states") {
      owner(document.id); owner(data.userId);
      if (id(data.userId) && document.id !== data.userId) {
        node.mismatches.push("data.userId"); node.identityRefs.add("states/" + data.userId);
      }
      reference("profiles", document.id, false);
      reference("logs", data.activeEntryId);
      if (object(data.lastResolution)) {
        reference("logs", data.lastResolution.originalEntryId);
        reference("regularizations", data.lastResolution.regularizationId);
      }
      // UUIDs are actor-scoped. An unrelated worker reusing an admin's UUID
      // does not depend on that admin's receipt or its conflicting outcome.
      requestDependency(data.status === SESSION_STATUS.REGULARIZED ? data.lastResolution?.adminUid : document.id, data.lastRequestId);
    }
    if (source === "regularizations") {
      owner(data.workerUid);
      reference("logs", document.id); reference("logs", data.originalEntryId);
      reference("profiles", data.adminUid, false);
      requestDependency(data.adminUid, data.requestId);
      if (id(data.originalEntryId) && document.id !== data.originalEntryId) {
        node.mismatches.push("data.originalEntryId"); node.identityRefs.add("regularizations/" + data.originalEntryId);
      }
    }
    if (source === "requests") {
      const ordinary = ["clockIn", "clockOut"].includes(data.operation), regularize = data.operation === "regularizeSession";
      if (ordinary) {
        owner(data.actorUid); owner(data.workerUid);
        if (id(data.workerUid) && id(data.actorUid) && data.workerUid !== data.actorUid) node.mismatches.push("data.workerUid");
      } else if (regularize) owner(data.workerUid);
      reference("profiles", data.actorUid, false);
      if (ordinary || regularize) {
        reference("logs", data.result?.originalEntryId); reference("logs", data.result?.eventId);
        if (regularize) reference("regularizations", data.result?.originalEntryId);
      }
      if (id(data.requestKey)) {
        reference("requests", data.requestKey);
        if (document.id !== data.requestKey) {
          node.mismatches.push("data.requestKey"); node.identityRefs.add("requests/" + data.requestKey);
        }
      }
      const expected = data.schemaVersion === DOMAIN_VERSION ? requestDependency(data.actorUid, data.requestId) : null;
      if (expected && expected !== path) {
        node.subjectRefs.add(expected);
        node.identityRefs.add(expected);
        node.mismatches.push("request_identity");
      }
    }
    documents.push(node);
    if (!byPath.has(path)) byPath.set(path, []);
    byPath.get(path).push(node);
    for (const dependency of node.dependencies) {
      if (!dependents.has(dependency)) dependents.set(dependency, []);
      dependents.get(dependency).push(node);
    }
  }
  const ownersOf = node => {
    const result = new Set(), visited = new Set(), pending = [node];
    while (pending.length) {
      const current = pending.pop(); if (visited.has(current)) continue;
      visited.add(current); for (const uid of current.owners) result.add(uid);
      for (const ref of current.subjectRefs) pending.push(...(byPath.get(ref) ?? []));
    }
    return result;
  };
  const conflicts = [];
  const conflict = (code, path, nodes, fields = [], aliases = []) => {
    const related = new Set(nodes), paths = new Set(), pending = [path, ...aliases];
    while (pending.length) {
      const current = pending.pop(); if (paths.has(current)) continue;
      paths.add(current);
      for (const node of byPath.get(current) ?? []) related.add(node);
      for (const dependent of dependents.get(current) ?? []) {
        related.add(dependent); pending.push(dependent.path);
      }
    }
    const affected = new Set(), recovery = new Set(); let unattributed = false;
    for (const node of related) {
      const owners = ownersOf(node); if (!owners.size) unattributed = true;
      for (const uid of owners) {
        affected.add(uid);
        if (["states", "regularizations", "requests"].includes(node.source)) recovery.add(uid);
      }
    }
    const d = { ...diagnostic(code, nodes[0].source, nodes.map(node => node.index), [nodes[0].id]),
      companyId: input.companyId, path, count: nodes.length,
      declaredCompanyIds: [...new Set(nodes.map(node => node.companyId).filter(value => value !== null))].sort(compare),
      affectedUserIds: [...affected].sort(compare), relatedPaths: [...paths].sort(compare), unattributed };
    if (fields.length) d.fields = [...new Set(fields)].sort(compare);
    conflicts.push({ diagnostic: d, recoveryUserIds: recovery });
  };
  for (const [path, nodes] of byPath) if (nodes.length > 1) conflict("duplicate_document_path", path, nodes);
  for (const node of documents) {
    // Only subject references participate in ownership checks; authorizers are
    // dependencies, not owners of another person's employment session.
    if ([...ownersOf(node)].some(uid => !node.owners.has(uid))) node.mismatches.push("subject_reference_scope");
    if (node.mismatches.length) conflict("document_identity_mismatch", node.path, [node], node.mismatches, node.identityRefs);
  }
  return conflicts;
}

const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const hexDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const receiptResultFields = ["operation", "eventId", "originalEntryId", "stateVersion", "status", "minutes", "exitAt", "mode"];
const validInstant = value => value instanceof Date ? Number.isFinite(value.getTime()) : timestamp(value);
const sameInstant = (a, b) => validInstant(a) && validInstant(b) && instantNs(a) === instantNs(b);

// Observational trace validation only. Never replay operations or return a
// replacement state. Unknown/missing evidence is a recovery requirement.
// The original request body/epoch is not stored in receipts: payloadFingerprint
// can be shape-checked, not recomputed or authenticated by this local planner.
function inspectExistingTrace(input, person, core, owned) {
  const diagnostics = [];
  const issue = (code, source, index = null, recordId = person.uid, blocking = true) => {
    diagnostics.push(diagnostic(code, source, index === null ? [] : [index], [recordId], blocking));
  };
  const ownLogs = input.logs.filter(log => log.userId === person.uid);
  const original = entryId => ownLogs.find(log => log.id === entryId && log.tipo === "entrada");
  const regs = person.artifacts.filter(a => a.source === "regularizations");
  const receipts = person.artifacts.filter(a => a.source === "requests");
  const resolutions = new Map(), operations = [];
  for (const source of ["regularizations", "requests"]) {
    const counts = new Map();
    for (const artifact of person.artifacts.filter(a => a.source === source)) counts.set(artifact.id, (counts.get(artifact.id) ?? 0) + 1);
    for (const [recordId, count] of counts) if (count > 1) issue("duplicate_backend_document", source, null, recordId);
  }
  for (const artifact of regs) {
    const reg = input.regularizations[artifact.index].data, entry = original(reg.originalEntryId);
    const resolution = { regularizationId: artifact.id, originalEntryId: reg.originalEntryId,
      mode: reg.mode, minutes: reg.effectiveMinutes, exitAt: reg.accreditedExitAt,
      regularizedAt: reg.regularizedAt, adminUid: reg.adminUid };
    const projected = { ...core, status: SESSION_STATUS.REGULARIZED, activeEntryId: null,
      openedAt: null, reviewReason: null, lastResolution: resolution };
    const checked = inspectSessionState(projected, input.evaluatedAt);
    const known = reg.mode === "accredited_exit";
    const admins = input.profiles.filter(p => p.id === reg.adminUid);
    const admin = admins.length === 1 && admins[0].companyId === input.companyId && admins[0].role === "administrador";
    let valid = reg.schemaVersion === DOMAIN_VERSION && entry && checked.ok && admin
      && uuid(reg.requestId) && timestamp(reg.regularizedAt)
      && typeof reg.reason === "string" && reg.reason.trim().length > 0 && reg.reason.length <= 1000
      && (known ? typeof reg.evidenceReference === "string" && reg.evidenceReference.trim().length > 0
        && reg.evidenceReference.length <= 500 && timestamp(reg.accreditedExitAt)
        : reg.evidenceReference === null && reg.accreditedExitAt === null)
      && reg.status === (known ? "resolved_known" : "resolved_unknown");
    if (valid) {
      const start = instantNs(entry.timestamp), resolved = instantNs(reg.regularizedAt);
      valid = resolved - start > 86_400_000_000_000n
        && !ownLogs.some(log => log.tipo === "salida" && log.entradaLogId === entry.id);
      if (known) {
        const end = instantNs(reg.accreditedExitAt), duration = end - start;
        valid &&= duration > 0n && duration <= 86_400_000_000_000n && end <= resolved
          && reg.effectiveMinutes === Number(duration / 60_000_000_000n)
          && !ownLogs.some(log => log.tipo === "entrada" && log.id !== entry.id
            && instantNs(log.timestamp) > start && instantNs(log.timestamp) < end);
      } else valid &&= !ownLogs.some(log => log.tipo === "entrada" && log.id !== entry.id && instantNs(log.timestamp) > start);
    }
    if (!valid) issue("regularization_trace_invalid", "regularizations", artifact.index, artifact.id);
    else resolutions.set(artifact.id, { data: reg, resolution });
  }
  for (const artifact of receipts) {
    const receipt = input.requests[artifact.index].data, r = receipt.result;
    const isEntry = receipt.operation === "clockIn", isExit = receipt.operation === "clockOut";
    const isReg = receipt.operation === "regularizeSession";
    let valid = receipt.schemaVersion === DOMAIN_VERSION && uuid(receipt.requestId) && id(receipt.actorUid)
      && hexDigest(receipt.requestKey) && receipt.requestKey === artifact.id && hexDigest(receipt.payloadFingerprint)
      && receipt.requestKey === createHash("sha256").update(JSON.stringify([
        DOMAIN_VERSION, input.companyId, receipt.actorUid, receipt.requestId,
      ])).digest("hex") && exactKeys(r, receiptResultFields) && r.operation === receipt.operation
      && Number.isSafeInteger(r.stateVersion) && r.stateVersion > 0 && r.stateVersion <= core.version
      && (isEntry || isExit || isReg) && id(r.eventId) && id(r.originalEntryId);
    let effectiveAt = null;
    const entry = valid ? original(r.originalEntryId) : null;
    if (valid && (isEntry || isExit)) {
      const event = ownLogs.find(log => log.id === r.eventId);
      valid = receipt.actorUid === person.uid && (receipt.workerUid === undefined || receipt.workerUid === person.uid)
        && entry && event && r.eventId === (isEntry ? "entry_" : "exit_") + receipt.requestKey
        && event.tipo === (isEntry ? "entrada" : "salida") && r.mode === null
        && r.status === (isEntry ? SESSION_STATUS.OPEN : SESSION_STATUS.IDLE);
      if (valid && isEntry) valid = r.originalEntryId === event.id && r.minutes === null && r.exitAt === null;
      if (valid && isExit) valid = event.entradaLogId === entry.id && timestamp(r.exitAt)
        && sameInstant(event.timestamp, r.exitAt) && sameInstant(event.inicioSesion, entry.timestamp)
        && Number.isSafeInteger(r.minutes) && r.minutes >= 0 && r.minutes <= 1440
        && r.minutes === Number((instantNs(event.timestamp) - instantNs(entry.timestamp)) / 60_000_000_000n)
        && (event.minutosSesion === undefined || event.minutosSesion === r.minutes);
      if (valid) effectiveAt = copyOriginalTimestamp(event.timestamp);
    } else if (valid && isReg) {
      const resolution = resolutions.get(r.originalEntryId);
      valid = entry && resolution && (receipt.workerUid === undefined || receipt.workerUid === person.uid)
        && resolution.data.requestId === receipt.requestId && resolution.data.adminUid === receipt.actorUid
        && r.eventId === r.originalEntryId && r.status === SESSION_STATUS.REGULARIZED
        && r.mode === resolution.data.mode && r.minutes === resolution.data.effectiveMinutes
        && (r.exitAt === null ? resolution.data.accreditedExitAt === null
          : timestamp(r.exitAt) && sameInstant(r.exitAt, resolution.data.accreditedExitAt));
      if (valid) effectiveAt = copyOriginalTimestamp(resolution.data.regularizedAt);
    }
    if (!valid || !effectiveAt || instantNs(effectiveAt) > instantNs(input.evaluatedAt)) {
      issue("receipt_trace_invalid", "requests", artifact.index, artifact.id);
    } else operations.push({ receipt, result: r, effectiveAt });
  }
  operations.sort((a, b) => a.result.stateVersion - b.result.stateVersion || compare(a.receipt.requestKey, b.receipt.requestKey));
  for (const log of ownLogs) if (/^(entry|exit)_[0-9a-f]{64}$/.test(log.id)
    && !operations.some(op => op.result.eventId === log.id)) issue("backend_event_receipt_missing", "logs", input.logs.indexOf(log), log.id);
  if (core.version === 0) {
    if (core.lastRequestId !== null || core.lastResolution !== null || person.artifacts.length) issue("initial_state_has_backend_activity", "states");
    if (["manual_review", "history_conflict"].includes(core.reviewReason)) issue("initial_review_provenance_missing", "states");
  } else {
    // All supplied sources claim completeness. Missing version receipts are not
    // inferred from the current version or arbitrary initialization metadata.
    if (core.lastRequestId === null || operations.length !== core.version
      || operations.some((op, index) => op.result.stateVersion !== index + 1)) {
      issue("backend_version_trace_incomplete", "requests");
    }
    for (let i = 1; i < operations.length; i++) {
      const previous = operations[i - 1], next = operations[i];
      const prevOpen = previous.result.operation === "clockIn";
      if (instantNs(previous.effectiveAt) > instantNs(next.effectiveAt)
        || (prevOpen ? next.result.operation === "clockIn" || next.result.originalEntryId !== previous.result.originalEntryId
          : next.result.operation !== "clockIn")) issue("backend_transition_trace_conflict", "requests");
    }
    const last = operations.at(-1);
    if (!last) issue("state_latest_receipt_missing", "requests");
    else if (last.receipt.requestId !== core.lastRequestId || last.result.stateVersion !== core.version
      || (last.result.status === SESSION_STATUS.OPEN
        ? ![SESSION_STATUS.OPEN, SESSION_STATUS.NEEDS_REVIEW].includes(core.status)
          || core.activeEntryId !== last.result.originalEntryId || !sameInstant(core.openedAt, last.effectiveAt)
        : last.result.status !== core.status)) issue("state_latest_receipt_mismatch", "states");
    if (last && ownLogs.some(log => instantNs(log.timestamp) > instantNs(last.effectiveAt))) issue("history_after_latest_backend_receipt", "logs");
    const first = operations[0];
    if (first && ownLogs.some(log => instantNs(log.timestamp) >= instantNs(first.effectiveAt)
      && !operations.some(op => op.result.eventId === log.id))) issue("untracked_log_during_backend_activity", "logs");
    // Manual review has no supported domain operation/receipt to explain it.
    if (["manual_review", "history_conflict"].includes(core.reviewReason)) issue("review_provenance_missing", "states");
  }
  for (const [entryId, resolution] of resolutions) {
    if (!operations.some(op => op.result.operation === "regularizeSession" && op.result.originalEntryId === entryId)) {
      issue("regularization_receipt_missing", "regularizations", null, entryId);
    }
    if (core.status === SESSION_STATUS.REGULARIZED && core.lastResolution?.originalEntryId === entryId
      && canonicalizeReconciliationValue(core.lastResolution) !== canonicalizeReconciliationValue(resolution.resolution)) {
      issue("state_resolution_mismatch", "states");
    }
  }
  if (core.status === SESSION_STATUS.REGULARIZED && !resolutions.has(core.lastResolution.originalEntryId)) issue("state_resolution_missing", "states");
  const unresolved = owned.filter(s => s.status === "open" && !resolutions.has(s.entry.id));
  const active = [SESSION_STATUS.OPEN, SESSION_STATUS.NEEDS_REVIEW].includes(core.status);
  if (active && core.reviewReason === "overdue" && instantNs(input.evaluatedAt) - instantNs(core.openedAt) <= 86_400_000_000_000n) issue("review_not_overdue", "states");
  if (active ? unresolved.length !== 1 || unresolved[0].entry.id !== core.activeEntryId : unresolved.length !== 0) issue("unresolved_history_state_mismatch", "states");
  if (!diagnostics.some(d => d.blocking)) issue(core.version === 0 ? "existing_initial_state_verified" : "existing_backend_trace_verified", "states", null, person.uid, false);
  const missingEvidence = new Set(["backend_version_trace_incomplete", "state_latest_receipt_missing",
    "regularization_receipt_missing", "state_resolution_missing", "initial_review_provenance_missing", "review_provenance_missing"]);
  const blockers = diagnostics.filter(d => d.blocking);
  // A raw adjacency can be accounted for only by a fully verified preserved
  // backend trace. These are references to existing evidence, never synthetic
  // exits, reconstructed states or replacements for the raw history verdict.
  const accreditedBoundaries = [];
  if (!blockers.length) for (let i = 0; i < operations.length - 1; i++) {
    const operation = operations[i], next = operations[i + 1];
    if (operation.result.operation !== "regularizeSession" || operation.result.mode !== "accredited_exit"
      || next.result.operation !== "clockIn") continue;
    const previousId = operation.result.originalEntryId, nextId = next.result.originalEntryId;
    const resolution = resolutions.get(previousId), nextEntry = original(nextId);
    if (!resolution || !nextEntry || previousId === nextId
      || instantNs(resolution.data.accreditedExitAt) > instantNs(nextEntry.timestamp)
      || instantNs(resolution.data.regularizedAt) > instantNs(nextEntry.timestamp)) continue;
    // Require unique evidence for this exception. This does not reclassify
    // unrelated global duplicates (handled separately by the manifest).
    if (input.regularizations.filter(doc => doc?.id === previousId).length !== 1
      || [operation, next].some(op => input.requests.filter(doc => doc?.id === op.receipt.requestKey).length !== 1)) continue;
    accreditedBoundaries.push({ previousEntryId: previousId, nextEntryId: nextId,
      regularizationId: previousId, receiptId: operation.receipt.requestKey });
  }
  return { diagnostics, kind: blockers.length ? blockers.some(d => !missingEvidence.has(d.code)) ? "incoherent" : "unverified"
    : core.version === 0 ? "initialized" : "evolved", accreditedBoundaries };
}

/**
 * Pure, company-scoped classification/proposals and observed trace checks;
 * no SDK, I/O, clock reads, randomness or persistence. Receipt identity hashes
 * follow the domain contract; manifest generation remains a separate API.
 * The caller supplies plain trusted DTOs:
 * {
 *   companyId, evaluatedAt: {seconds, nanoseconds},
 *   complete: {profiles: boolean, logs: boolean, states: boolean,
 *              regularizations: boolean, requests: boolean},
 *   profiles: [{id: userId, companyId, role}],
 *   logs: [{id, companyId, userId, tipo, timestamp, ...originalFields}],
 *   states: [{id: userId, data: {...storedState}}],
 *   regularizations: [{id, data: {companyId, workerUid, ...originalFields}}],
 *   requests: [{id, data: {companyId, operation, actorUid, workerUid?, ...originalFields}}]
 * }
 * Completeness flags are assertions from a future trusted loader, not evidence
 * established here and never authorizations supplied by a browser.
 *
 * Contract errors throw TypeError. Data problems produce diagnostics/decisions.
 * Missing profiles, unassignable data and foreign-company rows are not discarded.
 * Any incomplete collection prevents eligible, including an empty logs array.
 *
 * proposedStatus/openEntryId remain classification hints. Only eligible NEW
 * states receive a complete proposedState DTO validated by inspectSessionState.
 * It is not a committed state, a write plan or proof of source completeness.
 * blocked is a planning decision, never a session status. Every other decision
 * has proposedState=null, including already_initialized: existing states are
 * never returned as replacement proposals and their versions are never reset.
 * Proposed timestamps are detached {seconds, nanoseconds} DTOs. Original DTOs
 * retain every nanosecond; legacy Dates retain their exact millisecond instant.
 * already_initialized requires a coherent initial state or a complete observed
 * backend receipt/version/event trace. It does not certify external provenance,
 * initialization manifests or original request payloads. Existing states are
 * never returned as replacement proposals, including overdue projections.
 * Raw consecutive-entry issues may be explicitly accounted for by a unique,
 * verified accredited-resolution/next-entry receipt boundary. All other raw
 * blockers remain effective; neither logs nor reconstruction results change.
 * Document identity conflicts reach their owners and dependent proofs. Scoped
 * conflicts also appear in top-level diagnostics with affectedUserIds; they
 * do not automatically attach to unrelated people. Unattributable data and
 * foreign-company rows retain the existing whole-input fail-closed guards.
 *
 * The same DTOs and fixed evaluatedAt produce the same output. Diagnostic indexes
 * refer to the supplied array positions; no input record is reordered or changed.
 */
export function planSessionReconciliation(input) {
  if (!exactKeys(input, ["companyId", "evaluatedAt", "complete", ...sources])
    || !id(input.companyId) || !timestamp(input.evaluatedAt)
    || !exactKeys(input.complete, sources)
    || !sources.every(source => typeof input.complete[source] === "boolean" && dense(input[source]))) {
    throw new TypeError("Expected explicit company, fixed timestamp, five completeness flags and dense source arrays.");
  }
  const complete = sources.every(source => input.complete[source]);
  const people = new Map(), globalDiagnostics = [], documentDiagnostics = [];
  let globalBlocked = false, globalRecovery = false;
  const person = uid => {
    if (!people.has(uid)) people.set(uid, { uid, profiles: [], states: [], artifacts: [], diagnostics: [], documentRecovery: false });
    return people.get(uid);
  };
  const global = (code, source, index, recordId, recovery = false) => {
    globalDiagnostics.push(diagnostic(code, source, [index], id(recordId) ? [recordId] : []));
    globalBlocked = true;
    globalRecovery ||= recovery;
  };

  for (const [index, profile] of input.profiles.entries()) {
    if (!object(profile) || !id(profile.id)) {
      global("unattributed_profile", "profiles", index, profile?.id);
      continue;
    }
    const p = person(profile.id);
    p.profiles.push(profile);
    if (profile.companyId !== input.companyId) global("company_scope_mismatch", "profiles", index, profile.id);
    if (!["trabajador", "administrador"].includes(profile.role)) {
      p.diagnostics.push(diagnostic("invalid_profile_role", "profiles", [index], [profile.id]));
    }
  }
  for (const [index, log] of input.logs.entries()) {
    if (!object(log) || !id(log.userId)) global("unattributed_log", "logs", index, log?.id);
    else person(log.userId);
    if (!object(log) || log.companyId !== input.companyId) global("company_scope_mismatch", "logs", index, log?.id);
    if (object(log) && !id(log.id) && id(log.userId)) {
      person(log.userId).diagnostics.push(diagnostic("invalid_log_id", "logs", [index]));
    }
  }
  for (const [index, document] of input.states.entries()) {
    if (!object(document) || !id(document.id)) {
      global("unattributed_state", "states", index, document?.id, true);
      continue;
    }
    person(document.id).states.push(document);
    if (!object(document.data) || document.data.companyId !== input.companyId) {
      global("company_scope_mismatch", "states", index, document.id, true);
    }
  }
  for (const source of ["regularizations", "requests"]) {
    for (const [index, document] of input[source].entries()) {
      const data = object(document) && object(document.data) ? document.data : null;
      const uid = source === "regularizations" ? data?.workerUid
        : data?.operation === "regularizeSession" ? data?.workerUid
          : ["clockIn", "clockOut"].includes(data?.operation) ? data.actorUid : null;
      if (!id(document?.id) || !id(uid)) {
        global("unattributed_backend_artifact", source, index, document?.id, true);
        continue;
      }
      person(uid).artifacts.push({ source, index, id: document.id });
      if (data.companyId !== input.companyId) global("company_scope_mismatch", source, index, document.id, true);
    }
  }

  // A cross-worker backend reference undermines both sides; do not let the
  // target worker be independently certified using an apparently empty trace.
  for (const p of [...people.values()]) for (const artifact of p.artifacts) {
    const data = input[artifact.source][artifact.index].data;
    const references = artifact.source === "regularizations" ? [data.originalEntryId]
      : [data.result?.originalEntryId, data.result?.eventId];
    for (const log of input.logs) if (references.includes(log?.id) && id(log?.userId) && log.userId !== p.uid) {
      const d = diagnostic("backend_reference_scope_mismatch", artifact.source, [artifact.index], [artifact.id]);
      p.diagnostics.push(d); person(log.userId).diagnostics.push(d);
    }
  }

  // Never diagnose a missing reference as a confirmed conflict in a partial load.
  const history = complete ? reconstructSessions(input.logs, { now: input.evaluatedAt }) : null;
  if (history) for (const issue of history.issues) {
    const d = diagnostic(issue.code, "logs", issue.recordIndexes,
      issue.logIds.filter(value => typeof value === "string"), issue.blocking);
    if (issue.fields) d.fields = [...issue.fields].sort(compare);
    if (issue.entradaLogId) d.entryReference = issue.entradaLogId;
    const affected = new Set();
    for (const index of issue.recordIndexes) {
      const uid = input.logs[index]?.userId;
      if (id(uid)) affected.add(uid);
    }
    // A cross-person exit also invalidates confidence in its target entry owner.
    if (issue.entradaLogId) for (const log of input.logs) {
      if (log?.id === issue.entradaLogId && id(log.userId)) affected.add(log.userId);
    }
    for (const uid of affected) person(uid).diagnostics.push(d);
    if (!affected.size) globalDiagnostics.push(d);
  }
  if (!complete) for (const source of sources) if (!input.complete[source]) {
    globalDiagnostics.push(diagnostic("source_incomplete", source));
  }

  for (const { diagnostic: d, recoveryUserIds } of inspectDocumentIdentityConflicts(input)) {
    if (d.unattributed) {
      globalDiagnostics.push(d); globalBlocked = true;
      if (["states", "regularizations", "requests"].includes(d.source)) globalRecovery = true;
    } else documentDiagnostics.push(d);
    for (const uid of d.affectedUserIds) {
      const p = person(uid); if (!d.unattributed) p.diagnostics.push(d);
      p.documentRecovery ||= recoveryUserIds.has(uid);
      // Preserve the prior backend-duplicate diagnostic contract as well.
      if (d.code === "duplicate_document_path" && ["regularizations", "requests"].includes(d.source)) {
        p.diagnostics.push(diagnostic("duplicate_backend_document", d.source, [], d.recordIds));
      }
      if (d.code === "duplicate_document_path" && d.source === "profiles") {
        for (const artifact of p.artifacts.filter(a => a.source === "regularizations")) {
          if (d.recordIds.includes(input.regularizations[artifact.index].data.adminUid)) {
            p.diagnostics.push(diagnostic("regularization_trace_invalid", "regularizations", [artifact.index], [artifact.id]));
          }
        }
      }
    }
  }

  const decisions = [...people.values()].sort((a, b) => compare(a.uid, b.uid)).map(p => {
    const diagnostics = [...p.diagnostics, ...globalDiagnostics];
    const backendLogs = input.logs.filter(log => log?.userId === p.uid && /^(entry|exit)_[0-9a-f]{64}$/.test(log.id));
    if (!p.states.length && backendLogs.length) diagnostics.push(diagnostic("backend_event_without_state", "logs",
      backendLogs.map(log => input.logs.indexOf(log)), backendLogs.map(log => log.id)));
    let existingStateKind = p.states.length ? complete ? "incoherent" : "unverified" : null;
    const result = (decision, historyKind = null, proposedStatus = null, openEntryId = null, proposedState = null) => ({
      userId: p.uid, decision, historyKind, proposedStatus, openEntryId, proposedState, existingStateKind,
      diagnostics: sorted(diagnostics),
    });
    const eligible = (historyKind, status, entry = null) => {
      const proposed = {
        schemaVersion: DOMAIN_VERSION, companyId: input.companyId, userId: p.uid,
        status, version: 0, activeEntryId: entry?.id ?? null,
        openedAt: entry ? copyOriginalTimestamp(entry.timestamp) : null,
        reviewReason: status === SESSION_STATUS.NEEDS_REVIEW ? "overdue" : null,
        lastResolution: null, lastRequestId: null,
      };
      const checked = inspectSessionState(proposed, input.evaluatedAt);
      // Do not silently accept a domain projection that disagrees with the plan.
      if (!checked.ok || checked.state.status !== status || checked.state.reviewReason !== proposed.reviewReason
        || (entry && instantNs(checked.state.openedAt) !== instantNs(entry.timestamp))) {
        const d = diagnostic("invalid_initial_state_proposal", "logs",
          entry ? [input.logs.indexOf(entry)] : [], entry ? [entry.id] : []);
        d.domainCode = checked.ok ? "PROJECTION_MISMATCH" : checked.error.code;
        diagnostics.push(d);
        return result(PLANNING_DECISION.BLOCKED);
      }
      return result(PLANNING_DECISION.ELIGIBLE, historyKind, status, entry?.id ?? null, checked.state);
    };
    if (!complete) return result(PLANNING_DECISION.INCOMPLETE_SOURCE);
    if (p.profiles.length !== 1) diagnostics.push(diagnostic(
      p.profiles.length ? "duplicate_profile" : "profile_missing", "profiles", [], [p.uid]));
    if (globalRecovery) return result(PLANNING_DECISION.RECOVERY_REQUIRED);
    // Defer ONLY raw adjacencies for one existing state, long enough to check
    // its complete backend trace. New-state planning never gets this exception.
    const deferredAdjacencies = new Set(p.states.length === 1
      ? diagnostics.filter(d => d.blocking && d.source === "logs" && d.code === "consecutive_entries") : []);
    if (globalBlocked || diagnostics.some(d => d.blocking && !deferredAdjacencies.has(d))) {
      return result(p.states.length || p.artifacts.length || backendLogs.length || p.documentRecovery
        ? PLANNING_DECISION.RECOVERY_REQUIRED : PLANNING_DECISION.BLOCKED);
    }
    if (p.states.length) {
      if (p.states.length !== 1) {
        diagnostics.push(diagnostic("duplicate_state", "states", [], [p.uid]));
        return result(PLANNING_DECISION.RECOVERY_REQUIRED);
      }
      const stored = p.states[0].data;
      const core = Object.fromEntries(stateFields.map(field => [field, stored[field]]));
      const inspected = inspectSessionState(core, input.evaluatedAt);
      if (stored.userId !== p.uid || !inspected.ok) {
        existingStateKind = "incoherent";
        diagnostics.push(diagnostic("invalid_existing_state", "states", [], [p.uid]));
        return result(PLANNING_DECISION.RECOVERY_REQUIRED);
      }
      const owned = history.sessions.filter(s => s.companyId === input.companyId && s.userId === p.uid);
      const active = [SESSION_STATUS.OPEN, SESSION_STATUS.NEEDS_REVIEW].includes(core.status);
      const anchor = owned.find(s => s.entry.id === core.activeEntryId);
      const hasResolutions = p.artifacts.some(a => a.source === "regularizations");
      // Minimal contradictions only. Effective history/provenance remain a later step.
      if ((active && (!anchor || anchor.status !== "open"
        || instantNs(anchor.entry.timestamp) !== instantNs(inspected.state.openedAt)))
        || (!hasResolutions && core.status === SESSION_STATUS.IDLE && owned.some(s => s.status === "open"))) {
        diagnostics.push(diagnostic("existing_state_history_mismatch", "states", [], [p.uid]));
        return result(PLANNING_DECISION.RECOVERY_REQUIRED);
      }
      if (active && p.artifacts.some(a => a.source === "regularizations"
        && (a.id === core.activeEntryId
          || input.regularizations[a.index].data.originalEntryId === core.activeEntryId))) {
        diagnostics.push(diagnostic("existing_active_entry_has_resolution", "states", [], [p.uid]));
        return result(PLANNING_DECISION.RECOVERY_REQUIRED);
      }
      const trace = inspectExistingTrace(input, p, core, owned);
      existingStateKind = trace.kind;
      diagnostics.push(...trace.diagnostics);
      if (!trace.diagnostics.some(d => d.blocking)) for (const issue of deferredAdjacencies) {
        const proof = trace.accreditedBoundaries.find(boundary => issue.recordIds.length === 2
          && issue.recordIds.includes(boundary.previousEntryId) && issue.recordIds.includes(boundary.nextEntryId));
        if (proof) diagnostics[diagnostics.indexOf(issue)] = { ...issue,
          code: "consecutive_entries_accounted_for", blocking: false,
          regularizationId: proof.regularizationId, receiptId: proof.receiptId };
      }
      if (diagnostics.some(d => d.blocking)) {
        if (["initialized", "evolved"].includes(existingStateKind)) existingStateKind = "incoherent";
        return result(PLANNING_DECISION.RECOVERY_REQUIRED);
      }
      if (inspected.state.status !== core.status) diagnostics.push(diagnostic("existing_overdue_projection_not_persisted", "states", [], [p.uid], false));
      diagnostics.push(diagnostic("existing_state_preserved_not_reconciled", "states", [], [p.uid], false));
      return result(PLANNING_DECISION.ALREADY_INITIALIZED);
    }
    if (p.artifacts.length) {
      for (const artifact of p.artifacts) diagnostics.push(diagnostic("backend_history_without_state",
        artifact.source, [artifact.index], [artifact.id]));
      return result(PLANNING_DECISION.RECOVERY_REQUIRED);
    }
    const sessions = history.sessions.filter(s => s.companyId === input.companyId && s.userId === p.uid);
    const open = sessions.filter(s => s.status === "open");
    if (open.length > 1) {
      diagnostics.push(diagnostic("multiple_open_entries", "logs", [], open.map(s => s.entry.id)));
      return result(PLANNING_DECISION.BLOCKED);
    }
    if (open.length === 1) {
      const overdue = open[0].isOver24Hours;
      return eligible(overdue ? "overdue_open" : "open",
        overdue ? SESSION_STATUS.NEEDS_REVIEW : SESSION_STATUS.OPEN, open[0].entry);
    }
    return eligible(sessions.length ? "closed" : "empty", SESSION_STATUS.IDLE);
  });
  return { contractVersion: RECONCILIATION_CONTRACT_VERSION, companyId: input.companyId,
    evaluatedAt: { ...input.evaluatedAt }, sourceComplete: complete,
    decisions, diagnostics: sorted([...globalDiagnostics, ...documentDiagnostics]) };
}

export const RECONCILIATION_MANIFEST_SCHEMA = 1;
export const RECONCILIATION_ALGORITHM = "fichad2-reconciliation/3.7.4-v3";

/**
 * Versioned, typed canonical encoding, NOT ordinary JSON serialization.
 * Object key order is irrelevant; array order is significant. No toJSON/getter
 * is invoked. Dates retain their type and exact milliseconds; timestamp DTOs
 * retain their original fields/nanoseconds. Null, missing, -0 and scalar types
 * cannot alias. Unsupported values fail closed rather than being dropped.
 */
export function canonicalizeReconciliationValue(value) {
  const ancestors = new Set();
  const reject = () => { throw new TypeError("Non-representable reconciliation value"); };
  const encode = v => {
    if (v === null) return ["null"];
    if (typeof v === "string" || typeof v === "boolean") return [typeof v, v];
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return reject();
      return ["number", Object.is(v, -0) ? "-0" : String(v)];
    }
    // Explicit depth bound makes oversized nested DTOs fail with a diagnostic,
    // rather than relying on an engine-dependent stack overflow threshold.
    if (typeof v !== "object" || ancestors.has(v) || ancestors.size >= 256) return reject();
    ancestors.add(v);
    try {
      const keys = Reflect.ownKeys(v);
      if (Object.getPrototypeOf(v) === Date.prototype) {
        const ms = Date.prototype.getTime.call(v);
        if (keys.length || !Number.isFinite(ms)) return reject();
        return ["date", String(ms)];
      }
      if (keys.some(key => typeof key !== "string")) return reject();
      const descriptors = Object.getOwnPropertyDescriptors(v);
      if (Array.isArray(v)) {
        if (Object.getPrototypeOf(v) !== Array.prototype || keys.length !== v.length + 1) return reject();
        const values = [];
        for (let i = 0; i < v.length; i++) {
          const d = descriptors[String(i)];
          if (!d || !d.enumerable || !Object.hasOwn(d, "value")) return reject();
          values.push(encode(d.value));
        }
        return ["array", values];
      }
      if (!object(v)) return reject();
      return [Object.getPrototypeOf(v) === null ? "null_prototype_object" : "object",
        keys.sort(compare).map(key => {
          const d = descriptors[key];
          if (!d.enumerable || !Object.hasOwn(d, "value")) return reject();
          return [key, encode(d.value)];
        })];
    } finally { ancestors.delete(v); }
  };
  return JSON.stringify(encode(value));
}

const canonicalDigest = value => createHash("sha256")
  .update(RECONCILIATION_ALGORITHM + "\n" + canonicalizeReconciliationValue(value), "utf8").digest("hex");

/**
 * Pure manifest API; the original planner API keeps its arrival-index contract.
 * input has precisely the planner contract. evidence is a five-source map of
 * {kind: "caller_declaration", reference: nonempty string, complete: boolean}.
 * These are caller assertions, never proof of an atomic or exhaustive snapshot.
 * Missing/mismatched evidence blocks local applicability. No SDK or I/O occurs.
 *
 * Paths below are logical source/id paths, NOT inferred Firestore locations.
 * Repeated paths are retained, counted and blocked, even for identical data.
 * Canonical indexes in planning diagnostics refer to the sorted inventory.
 * planDigest covers the entire manifest except itself, including evidence and
 * all diagnostics. If a value cannot be represented, digests for that source
 * and the whole plan are null: no hash is claimed for a lossy substitute.
 * applicable only means eligible for subsequent LOCAL review; it grants no
 * write/production authorization, concurrency guarantee or provenance proof.
 * Only trusted in-memory DTOs are supported; hostile Proxies are out of scope.
 */
export function buildReconciliationManifest(input, evidence = {}) {
  // Inspect the envelope without evaluating accessor properties.
  const fields = ["companyId", "evaluatedAt", "complete", ...sources];
  const envelope = Object.getOwnPropertyDescriptors(input ?? {});
  if (!object(input) || !exactKeys(input, fields)
    || fields.some(key => !Object.hasOwn(envelope[key], "value"))) {
    throw new TypeError("Expected the explicit planner input envelope with data properties");
  }
  // Header must be fully representable before reading its properties.
  canonicalizeReconciliationValue([input.companyId, input.evaluatedAt, input.complete]);
  if (!id(input.companyId) || !timestamp(input.evaluatedAt) || !exactKeys(input.complete, sources)
    || !sources.every(source => typeof input.complete[source] === "boolean" && Array.isArray(input[source]))) {
    throw new TypeError("Invalid manifest header or source collections");
  }
  const diagnostics = [], inventory = {}, sourceDigests = {}, ordered = {};
  const completeness = {};
  let representable = true;
  let evidenceRepresentable = true;
  try { canonicalizeReconciliationValue(evidence); }
  catch { evidenceRepresentable = false; representable = false; }
  const evidenceMapValid = evidenceRepresentable && object(evidence)
    && Reflect.ownKeys(evidence).every(key => sources.includes(key));
  if (!evidenceMapValid) diagnostics.push({ code: "invalid_completeness_evidence", source: "evidence", blocking: true });
  for (const source of sources) {
    // Detached canonical text protects the declaration without embedding mutable
    // references or copying confidential document payloads into this manifest.
    const declaration = evidenceMapValid && Object.hasOwn(evidence, source) ? evidence[source] : null;
    const validEvidence = exactKeys(declaration, ["kind", "reference", "complete"])
      && declaration.kind === "caller_declaration" && typeof declaration.reference === "string"
      && declaration.reference.trim().length > 0 && declaration.complete === input.complete[source];
    completeness[source] = { declaredComplete: input.complete[source],
      evidence: declaration === null ? null : canonicalizeReconciliationValue(declaration),
      evidenceValid: validEvidence };
    if (!validEvidence) diagnostics.push({ code: "completeness_evidence_missing_or_mismatched", source, blocking: true });
    if (!input.complete[source]) diagnostics.push({ code: "source_incomplete", source, blocking: true });
    try {
      // Validate whole collection first (including holes/extra properties), then
      // sort by logical ID/path and the entire typed payload as a tie-breaker.
      canonicalizeReconciliationValue(input[source]);
      const rows = input[source].map(document => {
        const documentId = object(document) && id(document.id) ? document.id : null;
        return { document, documentId, path: documentPath(source, document),
          canonical: canonicalizeReconciliationValue(document) };
      }).sort((a, b) => compare(a.path ?? "", b.path ?? "") || compare(a.canonical, b.canonical));
      inventory[source] = { count: rows.length, documents: rows.map((row, canonicalIndex) => ({
        canonicalIndex, id: row.documentId, path: row.path, digest: canonicalDigest(row.document),
      })) };
      const paths = new Map();
      for (const row of rows) {
        if (row.path === null) continue;
        paths.set(row.path, (paths.get(row.path) ?? 0) + 1);
      }
      for (const [path, count] of paths) if (count > 1) {
        diagnostics.push({ code: "duplicate_document_path", source, path, count, blocking: true });
      }
      ordered[source] = rows.map(row => row.document);
      sourceDigests[source] = canonicalDigest({ source, documents: ordered[source] });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      representable = false;
      sourceDigests[source] = null;
      inventory[source] = { count: input[source].length, documents: null };
      diagnostics.push({ code: "non_representable_source", source, blocking: true });
    }
  }
  const evaluatedAt = { seconds: input.evaluatedAt.seconds, nanoseconds: input.evaluatedAt.nanoseconds };
  const planning = representable ? planSessionReconciliation({
    companyId: input.companyId, evaluatedAt, complete: input.complete, ...ordered,
  }) : null;
  const applicable = representable && diagnostics.length === 0
    && !planning.diagnostics.some(d => d.blocking)
    && planning.decisions.every(d => [PLANNING_DECISION.ELIGIBLE, PLANNING_DECISION.ALREADY_INITIALIZED].includes(d.decision));
  const manifest = {
    schemaVersion: RECONCILIATION_MANIFEST_SCHEMA, algorithmVersion: RECONCILIATION_ALGORITHM,
    plannerContractVersion: RECONCILIATION_CONTRACT_VERSION, domainSchemaVersion: DOMAIN_VERSION,
    companyId: input.companyId, evaluatedAt,
    scope: "in_memory_review_only", productionAuthorized: false,
    completenessEvidence: evidenceRepresentable ? canonicalizeReconciliationValue(evidence) : null,
    completeness, sourceDigests, inventory, planning,
    diagnostics: sorted(diagnostics), applicable,
  };
  return { ...manifest, planDigest: representable ? canonicalDigest(manifest) : null };
}
