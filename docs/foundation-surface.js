(function (global) {
  "use strict";

  const EXPECTED_AUTHORITY = "PSE Bible Foundation derived read model";
  const EXPECTED_HOSTS = Object.freeze([
    Object.freeze({ id: "PSE-HOST-ATLAS", name: "Atlas" }),
    Object.freeze({ id: "PSE-HOST-FORGE", name: "Forge" }),
    Object.freeze({ id: "PSE-HOST-NEXUS", name: "Nexus" })
  ]);
  const PROFILE_STATUSES = new Set(["COMPLETE", "INCOMPLETE", "NOT_EVALUATED"]);
  const FORBIDDEN_KEYS = new Set([
    "command", "commands", "shell", "token", "password",
    "credential", "credentials", "secret",
    "score", "grade", "tier", "percentage"
  ]);
  const LEGACY_IDENTITY_TOKENS = ['"Mac"', '"Omarchy"', '"VPS"', '"OMARCHY"'];

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function fail(message) {
    throw new Error(message);
  }

  function assertObject(value, label) {
    if (!isObject(value)) fail(label + " must be an object");
    return value;
  }

  function assertExactKeys(value, expected, label) {
    const object = assertObject(value, label);
    const actual = Object.keys(object).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length ||
        actual.some((key, index) => key !== wanted[index])) {
      fail(label + " keys do not match Foundation Surface v1");
    }
    return object;
  }

  function assertString(value, label) {
    if (typeof value !== "string" || value.length === 0) fail(label + " must be a non-empty string");
  }

  function assertBoolean(value, label) {
    if (typeof value !== "boolean") fail(label + " must be a boolean");
  }

  function assertNullableBoolean(value, label) {
    if (value !== null && typeof value !== "boolean") fail(label + " must be boolean or null");
  }

  function assertNonNegativeInt(value, label) {
    if (!Number.isInteger(value) || value < 0) fail(label + " must be a non-negative integer");
  }

  function isRawSHA256(value) {
    return /^[0-9a-f]{64}$/.test(String(value || ""));
  }

  function isSHA256ID(value) {
    return /^sha256:[0-9a-f]{64}$/.test(String(value || ""));
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

  function validateSources(value) {
    const sources = assertExactKeys(value, [
      "truthReportId", "graphSnapshotId", "truthReportSha256",
      "completenessSha256", "compilerSha256"
    ], "sources");
    if (!isSHA256ID(sources.truthReportId)) fail("invalid truthReportId");
    if (!isSHA256ID(sources.graphSnapshotId)) fail("invalid graphSnapshotId");
    for (const key of ["truthReportSha256", "completenessSha256", "compilerSha256"]) {
      if (!isRawSHA256(sources[key])) fail("invalid " + key);
    }
  }

  function validateManagedHosts(value) {
    if (!Array.isArray(value) || value.length !== EXPECTED_HOSTS.length) fail("managed host set drift");
    value.forEach((host, index) => {
      assertExactKeys(host, ["id", "name"], "managedHosts[" + index + "]");
      const expected = EXPECTED_HOSTS[index];
      if (host.id !== expected.id || host.name !== expected.name) fail("managed host identity drift");
    });
  }

  function validateRuntime(value) {
    const runtime = assertExactKeys(value, [
      "truthStatus", "acceptanceAvailable", "liveComplete"
    ], "runtime");
    assertString(runtime.truthStatus, "runtime.truthStatus");
    assertBoolean(runtime.acceptanceAvailable, "runtime.acceptanceAvailable");
    assertNullableBoolean(runtime.liveComplete, "runtime.liveComplete");
    return runtime;
  }

  function validateCountObject(value, keys, label) {
    const object = assertExactKeys(value, keys, label);
    keys.forEach((key) => assertNonNegativeInt(object[key], label + "." + key));
    return object;
  }

  function validateRequirements(value) {
    const requirements = assertExactKeys(value, [
      "total", "satisfied", "notSatisfied", "byStatus"
    ], "requirements");
    ["total", "satisfied", "notSatisfied"].forEach((key) => {
      assertNonNegativeInt(requirements[key], "requirements." + key);
    });
    const byStatus = assertObject(requirements.byStatus, "requirements.byStatus");
    for (const [key, count] of Object.entries(byStatus)) {
      assertString(key, "requirements.byStatus key");
      assertNonNegativeInt(count, "requirements.byStatus." + key);
    }
  }

  function validateCompleteness(value) {
    const completeness = assertExactKeys(value, ["summary", "profiles"], "completeness");
    validateCountObject(completeness.summary, [
      "profiles", "completeProfiles", "incompleteProfiles", "notEvaluatedProfiles"
    ], "completeness.summary");
    if (!Array.isArray(completeness.profiles)) fail("completeness.profiles must be an array");
    completeness.profiles.forEach((profile, index) => {
      const keys = [
        "id", "status", "evaluated", "complete", "incomplete", "missingCount"
      ];
      if (isObject(profile) && Object.prototype.hasOwnProperty.call(profile, "reason")) keys.push("reason");
      const row = assertExactKeys(profile, keys, "completeness.profiles[" + index + "]");
      assertString(row.id, "completeness profile id");
      if (!PROFILE_STATUSES.has(row.status)) fail("invalid completeness profile status");
      ["evaluated", "complete", "incomplete", "missingCount"].forEach((key) => {
        assertNonNegativeInt(row[key], "completeness profile " + key);
      });
      if (Object.prototype.hasOwnProperty.call(row, "reason")) {
        assertString(row.reason, "completeness profile reason");
      }
    });
  }

  function validateAttention(value) {
    const attention = assertExactKeys(value, [
      "repositoryCandidates", "repositoryConflicts", "graphUnresolved",
      "requirementsNotSatisfied", "runtimeAcceptanceMissing", "runtimeNotLiveComplete"
    ], "attention");
    ["repositoryCandidates", "repositoryConflicts", "graphUnresolved", "requirementsNotSatisfied"]
      .forEach((key) => assertNonNegativeInt(attention[key], "attention." + key));
    assertBoolean(attention.runtimeAcceptanceMissing, "attention.runtimeAcceptanceMissing");
    assertBoolean(attention.runtimeNotLiveComplete, "attention.runtimeNotLiveComplete");
  }

  function validateCapabilities(value) {
    const capabilities = assertExactKeys(value, [
      "runtimeEvidenceAvailable", "hostHealthAvailable", "commandsAvailable"
    ], "capabilities");
    assertBoolean(capabilities.runtimeEvidenceAvailable, "capabilities.runtimeEvidenceAvailable");
    assertBoolean(capabilities.hostHealthAvailable, "capabilities.hostHealthAvailable");
    if (capabilities.commandsAvailable !== false) fail("command capability must remain false");
    return capabilities;
  }

  function validate(payload) {
    const surface = assertExactKeys(payload, [
      "schemaVersion", "kind", "surfaceId", "sources", "authority",
      "managedHosts", "runtime", "graph", "requirements", "repositories",
      "completeness", "attention", "capabilities", "mutationPerformed"
    ], "Foundation Surface");

    walk(surface);

    if (surface.schemaVersion !== 1) fail("unsupported Foundation Surface schema");
    if (surface.kind !== "PSE_FOUNDATION_SURFACE") fail("invalid Foundation Surface kind");
    if (!isSHA256ID(surface.surfaceId)) fail("invalid Foundation Surface ID");
    if (surface.authority !== EXPECTED_AUTHORITY) fail("invalid Foundation Surface authority");
    if (surface.mutationPerformed !== false) fail("Foundation Surface mutation flag violated");

    validateSources(surface.sources);
    validateManagedHosts(surface.managedHosts);
    const runtime = validateRuntime(surface.runtime);
    validateCountObject(surface.graph, [
      "nodes", "edges", "canonicalNodes", "externalNodes", "unresolved"
    ], "graph");
    validateRequirements(surface.requirements);
    validateCountObject(surface.repositories, [
      "discovered", "match", "newCandidate", "missing", "conflict", "unknown"
    ], "repositories");
    validateCompleteness(surface.completeness);
    validateAttention(surface.attention);
    const capabilities = validateCapabilities(surface.capabilities);

    if (runtime.acceptanceAvailable === false) {
      if (runtime.truthStatus !== "UNKNOWN_NO_ACCEPTANCE" ||
          runtime.liveComplete !== null ||
          capabilities.runtimeEvidenceAvailable !== false ||
          capabilities.hostHealthAvailable !== false) {
        fail("runtime truth inferred without acceptance");
      }
    }

    const serialized = JSON.stringify(surface);
    for (const token of LEGACY_IDENTITY_TOKENS) {
      if (serialized.includes(token)) fail("legacy host identity leaked into Foundation Surface");
    }

    return surface;
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
