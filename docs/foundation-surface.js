(function (global) {
  "use strict";

  const EXPECTED_HOSTS = Object.freeze([
    Object.freeze({ id: "PSE-HOST-ATLAS", name: "Atlas" }),
    Object.freeze({ id: "PSE-HOST-FORGE", name: "Forge" }),
    Object.freeze({ id: "PSE-HOST-NEXUS", name: "Nexus" })
  ]);
  const AUTHORITY = "PSE Bible Foundation derived read model";
  const PROFILE_STATUSES = new Set(["COMPLETE", "INCOMPLETE", "NOT_EVALUATED"]);
  const FORBIDDEN_KEYS = new Set([
    "command", "commands", "shell", "token", "password",
    "credential", "credentials", "secret",
    "score", "grade", "tier", "percentage"
  ]);

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function fail(message) {
    throw new Error(message);
  }

  function walk(value) {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(String(key).toLowerCase())) {
        fail("forbidden Foundation Surface key: " + key);
      }
      walk(child);
    }
  }

  function exactObject(value, allowed, path) {
    if (!isObject(value)) fail(path + " must be an object");
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) fail("unknown Foundation Surface key: " + path + "." + key);
    }
    return value;
  }

  function requireKeys(value, required, path) {
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        fail("missing Foundation Surface key: " + path + "." + key);
      }
    }
  }

  function nonnegativeInteger(value, path) {
    if (!Number.isInteger(value) || value < 0) fail(path + " must be a nonnegative integer");
    return value;
  }

  function booleanValue(value, path) {
    if (typeof value !== "boolean") fail(path + " must be boolean");
    return value;
  }

  function stringValue(value, path) {
    if (typeof value !== "string" || !value.length) fail(path + " must be a non-empty string");
    return value;
  }

  function nullableBoolean(value, path) {
    if (value !== null && typeof value !== "boolean") fail(path + " must be boolean or null");
    return value;
  }

  function isSHA256ID(value) {
    return /^sha256:[0-9a-f]{64}$/.test(String(value || ""));
  }

  function isSHA256(value) {
    return /^[0-9a-f]{64}$/.test(String(value || ""));
  }

  function validate(payload) {
    if (!isObject(payload)) fail("Foundation Surface must be an object");
    walk(payload);

    const rootKeys = [
      "schemaVersion", "kind", "surfaceId", "sources", "authority",
      "managedHosts", "runtime", "graph", "requirements", "repositories",
      "completeness", "attention", "capabilities", "mutationPerformed"
    ];
    exactObject(payload, rootKeys, "$");
    requireKeys(payload, rootKeys, "$");

    if (payload.schemaVersion !== 1) fail("unsupported Foundation Surface schema");
    if (payload.kind !== "PSE_FOUNDATION_SURFACE") fail("invalid Foundation Surface kind");
    if (!isSHA256ID(payload.surfaceId)) fail("invalid Foundation Surface ID");
    if (payload.authority !== AUTHORITY) fail("invalid Foundation Surface authority");
    if (payload.mutationPerformed !== false) fail("Foundation Surface mutation flag violated");

    const sources = exactObject(payload.sources, [
      "truthReportId", "graphSnapshotId", "truthReportSha256",
      "completenessSha256", "compilerSha256"
    ], "$.sources");
    requireKeys(sources, [
      "truthReportId", "graphSnapshotId", "truthReportSha256",
      "completenessSha256", "compilerSha256"
    ], "$.sources");
    if (!isSHA256ID(sources.truthReportId)) fail("invalid truthReportId");
    if (!isSHA256ID(sources.graphSnapshotId)) fail("invalid graphSnapshotId");
    for (const key of ["truthReportSha256", "completenessSha256", "compilerSha256"]) {
      if (!isSHA256(sources[key])) fail("invalid " + key);
    }

    const hosts = Array.isArray(payload.managedHosts) ? payload.managedHosts : fail("managedHosts must be an array");
    if (hosts.length !== EXPECTED_HOSTS.length) fail("managed host set drift");
    for (let index = 0; index < EXPECTED_HOSTS.length; index += 1) {
      const actual = exactObject(hosts[index], ["id", "name"], "$.managedHosts[" + index + "]");
      requireKeys(actual, ["id", "name"], "$.managedHosts[" + index + "]");
      const expected = EXPECTED_HOSTS[index];
      if (actual.id !== expected.id || actual.name !== expected.name) fail("managed host identity drift");
    }

    const runtime = exactObject(payload.runtime, ["truthStatus", "acceptanceAvailable", "liveComplete"], "$.runtime");
    requireKeys(runtime, ["truthStatus", "acceptanceAvailable", "liveComplete"], "$.runtime");
    stringValue(runtime.truthStatus, "$.runtime.truthStatus");
    booleanValue(runtime.acceptanceAvailable, "$.runtime.acceptanceAvailable");
    nullableBoolean(runtime.liveComplete, "$.runtime.liveComplete");

    const graph = exactObject(payload.graph, ["nodes", "edges", "canonicalNodes", "externalNodes", "unresolved"], "$.graph");
    requireKeys(graph, ["nodes", "edges", "canonicalNodes", "externalNodes", "unresolved"], "$.graph");
    for (const key of ["nodes", "edges", "canonicalNodes", "externalNodes", "unresolved"]) {
      nonnegativeInteger(graph[key], "$.graph." + key);
    }

    const requirements = exactObject(payload.requirements, ["total", "satisfied", "notSatisfied", "byStatus"], "$.requirements");
    requireKeys(requirements, ["total", "satisfied", "notSatisfied", "byStatus"], "$.requirements");
    for (const key of ["total", "satisfied", "notSatisfied"]) {
      nonnegativeInteger(requirements[key], "$.requirements." + key);
    }
    const byStatus = exactObject(requirements.byStatus, Object.keys(requirements.byStatus || {}), "$.requirements.byStatus");
    for (const [status, count] of Object.entries(byStatus)) {
      nonnegativeInteger(count, "$.requirements.byStatus." + status);
    }

    const repositories = exactObject(payload.repositories, ["discovered", "match", "newCandidate", "missing", "conflict", "unknown"], "$.repositories");
    requireKeys(repositories, ["discovered", "match", "newCandidate", "missing", "conflict", "unknown"], "$.repositories");
    for (const key of ["discovered", "match", "newCandidate", "missing", "conflict", "unknown"]) {
      nonnegativeInteger(repositories[key], "$.repositories." + key);
    }

    const completeness = exactObject(payload.completeness, ["summary", "profiles"], "$.completeness");
    requireKeys(completeness, ["summary", "profiles"], "$.completeness");
    const summary = exactObject(completeness.summary, ["profiles", "completeProfiles", "incompleteProfiles", "notEvaluatedProfiles"], "$.completeness.summary");
    requireKeys(summary, ["profiles", "completeProfiles", "incompleteProfiles", "notEvaluatedProfiles"], "$.completeness.summary");
    for (const key of ["profiles", "completeProfiles", "incompleteProfiles", "notEvaluatedProfiles"]) {
      nonnegativeInteger(summary[key], "$.completeness.summary." + key);
    }
    if (!Array.isArray(completeness.profiles)) fail("$.completeness.profiles must be an array");
    completeness.profiles.forEach((profile, index) => {
      const item = exactObject(profile, ["id", "status", "evaluated", "complete", "incomplete", "missingCount", "reason"], "$.completeness.profiles[" + index + "]");
      requireKeys(item, ["id", "status", "evaluated", "complete", "incomplete", "missingCount"], "$.completeness.profiles[" + index + "]");
      stringValue(item.id, "$.completeness.profiles[" + index + "].id");
      if (!PROFILE_STATUSES.has(item.status)) fail("invalid completeness profile status");
      for (const key of ["evaluated", "complete", "incomplete", "missingCount"]) {
        nonnegativeInteger(item[key], "$.completeness.profiles[" + index + "]." + key);
      }
      if (Object.prototype.hasOwnProperty.call(item, "reason")) {
        stringValue(item.reason, "$.completeness.profiles[" + index + "].reason");
      }
    });

    const attention = exactObject(payload.attention, [
      "repositoryCandidates", "repositoryConflicts", "graphUnresolved",
      "requirementsNotSatisfied", "runtimeAcceptanceMissing", "runtimeNotLiveComplete"
    ], "$.attention");
    requireKeys(attention, [
      "repositoryCandidates", "repositoryConflicts", "graphUnresolved",
      "requirementsNotSatisfied", "runtimeAcceptanceMissing", "runtimeNotLiveComplete"
    ], "$.attention");
    for (const key of ["repositoryCandidates", "repositoryConflicts", "graphUnresolved", "requirementsNotSatisfied"]) {
      nonnegativeInteger(attention[key], "$.attention." + key);
    }
    booleanValue(attention.runtimeAcceptanceMissing, "$.attention.runtimeAcceptanceMissing");
    booleanValue(attention.runtimeNotLiveComplete, "$.attention.runtimeNotLiveComplete");

    const capabilities = exactObject(payload.capabilities, ["runtimeEvidenceAvailable", "hostHealthAvailable", "commandsAvailable"], "$.capabilities");
    requireKeys(capabilities, ["runtimeEvidenceAvailable", "hostHealthAvailable", "commandsAvailable"], "$.capabilities");
    booleanValue(capabilities.runtimeEvidenceAvailable, "$.capabilities.runtimeEvidenceAvailable");
    booleanValue(capabilities.hostHealthAvailable, "$.capabilities.hostHealthAvailable");
    if (capabilities.commandsAvailable !== false) fail("command capability must remain false");

    if (runtime.acceptanceAvailable === false) {
      if (runtime.truthStatus !== "UNKNOWN_NO_ACCEPTANCE" ||
          runtime.liveComplete !== null ||
          capabilities.runtimeEvidenceAvailable !== false ||
          capabilities.hostHealthAvailable !== false) {
        fail("runtime truth inferred without acceptance");
      }
    }

    return payload;
  }

  function summarize(payload) {
    const data = validate(payload);
    return Object.freeze({
      surfaceId: data.surfaceId,
      runtimeTruthStatus: data.runtime.truthStatus,
      managedHostIDs: data.managedHosts.map((host) => host.id),
      graphUnresolved: data.graph.unresolved,
      repositoryCandidates: data.repositories.newCandidate,
      requirementsNotSatisfied: data.requirements.notSatisfied,
      completeProfiles: data.completeness.summary.completeProfiles,
      notEvaluatedProfiles: data.completeness.summary.notEvaluatedProfiles,
      runtimeEvidenceAvailable: data.capabilities.runtimeEvidenceAvailable,
      hostHealthAvailable: data.capabilities.hostHealthAvailable
    });
  }

  function isPublicBootstrap(hostname) {
    return String(hostname || "").toLowerCase() === "cadengl-oss.github.io";
  }

  global.PSEFoundationSurface = Object.freeze({
    EXPECTED_HOSTS,
    validate,
    summarize,
    isPublicBootstrap
  });
})(typeof window !== "undefined" ? window : globalThis);
