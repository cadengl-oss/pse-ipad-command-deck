(function (global) {
  "use strict";

  const EXPECTED_HOSTS = Object.freeze([
    Object.freeze({ id: "PSE-HOST-ATLAS", name: "Atlas" }),
    Object.freeze({ id: "PSE-HOST-FORGE", name: "Forge" }),
    Object.freeze({ id: "PSE-HOST-NEXUS", name: "Nexus" })
  ]);
  const FORBIDDEN_KEYS = new Set([
    "command", "commands", "shell", "token", "password",
    "credential", "credentials", "secret",
    "score", "grade", "tier", "percentage"
  ]);

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function walk(value) {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(String(key).toLowerCase())) {
        throw new Error("forbidden Foundation Surface key: " + key);
      }
      walk(child);
    }
  }

  function isSHA256ID(value) {
    return /^sha256:[0-9a-f]{64}$/.test(String(value || ""));
  }

  function validate(payload) {
    if (!isObject(payload)) throw new Error("Foundation Surface must be an object");
    walk(payload);
    if (payload.schemaVersion !== 1) throw new Error("unsupported Foundation Surface schema");
    if (payload.kind !== "PSE_FOUNDATION_SURFACE") throw new Error("invalid Foundation Surface kind");
    if (!isSHA256ID(payload.surfaceId)) throw new Error("invalid Foundation Surface ID");
    if (payload.mutationPerformed !== false) throw new Error("Foundation Surface mutation flag violated");

    const hosts = Array.isArray(payload.managedHosts) ? payload.managedHosts : [];
    if (hosts.length !== EXPECTED_HOSTS.length) throw new Error("managed host set drift");
    for (let index = 0; index < EXPECTED_HOSTS.length; index += 1) {
      const actual = hosts[index] || {};
      const expected = EXPECTED_HOSTS[index];
      if (actual.id !== expected.id || actual.name !== expected.name) {
        throw new Error("managed host identity drift");
      }
    }

    const runtime = isObject(payload.runtime) ? payload.runtime : {};
    const capabilities = isObject(payload.capabilities) ? payload.capabilities : {};
    if (capabilities.commandsAvailable !== false) throw new Error("command capability must remain false");
    if (runtime.acceptanceAvailable === false) {
      if (runtime.truthStatus !== "UNKNOWN_NO_ACCEPTANCE" ||
          runtime.liveComplete !== null ||
          capabilities.runtimeEvidenceAvailable !== false ||
          capabilities.hostHealthAvailable !== false) {
        throw new Error("runtime truth inferred without acceptance");
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
      graphUnresolved: Number(data.graph?.unresolved || 0),
      repositoryCandidates: Number(data.repositories?.newCandidate || 0),
      requirementsNotSatisfied: Number(data.requirements?.notSatisfied || 0),
      completeProfiles: Number(data.completeness?.summary?.completeProfiles || 0),
      notEvaluatedProfiles: Number(data.completeness?.summary?.notEvaluatedProfiles || 0),
      runtimeEvidenceAvailable: Boolean(data.capabilities?.runtimeEvidenceAvailable),
      hostHealthAvailable: Boolean(data.capabilities?.hostHealthAvailable)
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
