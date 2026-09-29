import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

await import("../docs/foundation-surface.js");
const contract = globalThis.PSEFoundationSurface;
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function fixture() {
  const hash = (char) => char.repeat(64);
  return {
    schemaVersion: 1,
    kind: "PSE_FOUNDATION_SURFACE",
    surfaceId: "sha256:" + hash("1"),
    sources: {
      truthReportId: "sha256:" + hash("2"),
      graphSnapshotId: "sha256:" + hash("3"),
      truthReportSha256: hash("2"),
      completenessSha256: hash("4"),
      compilerSha256: hash("5")
    },
    authority: "PSE Bible Foundation derived read model",
    managedHosts: [
      { id: "PSE-HOST-ATLAS", name: "Atlas" },
      { id: "PSE-HOST-FORGE", name: "Forge" },
      { id: "PSE-HOST-NEXUS", name: "Nexus" }
    ],
    runtime: {
      truthStatus: "UNKNOWN_NO_ACCEPTANCE",
      acceptanceAvailable: false,
      liveComplete: null
    },
    graph: { nodes: 340, edges: 310, canonicalNodes: 319, externalNodes: 21, unresolved: 145 },
    requirements: { total: 30, satisfied: 0, notSatisfied: 30, byStatus: { REQUIRED: 26, BUILDING: 4 } },
    repositories: { discovered: 21, match: 12, newCandidate: 9, missing: 0, conflict: 0, unknown: 0 },
    completeness: {
      summary: { profiles: 6, completeProfiles: 5, incompleteProfiles: 0, notEvaluatedProfiles: 1 },
      profiles: [
        {
          id: "CANONICAL_HOST",
          status: "COMPLETE",
          evaluated: 3,
          complete: 3,
          incomplete: 0,
          missingCount: 0
        },
        {
          id: "PRODUCTION_SERVICE",
          status: "NOT_EVALUATED",
          evaluated: 0,
          complete: 0,
          incomplete: 0,
          missingCount: 0,
          reason: "authority input unavailable"
        }
      ]
    },
    attention: {
      repositoryCandidates: 9,
      repositoryConflicts: 0,
      graphUnresolved: 145,
      requirementsNotSatisfied: 30,
      runtimeAcceptanceMissing: true,
      runtimeNotLiveComplete: false
    },
    capabilities: {
      runtimeEvidenceAvailable: false,
      hostHealthAvailable: false,
      commandsAvailable: false
    },
    mutationPerformed: false
  };
}

function clone(value) {
  return structuredClone(value);
}

test("validates canonical Foundation Surface and preserves unknown runtime", () => {
  const data = contract.validate(fixture());
  const summary = contract.summarize(data);
  assert.deepEqual(summary.managedHostIDs, ["PSE-HOST-ATLAS", "PSE-HOST-FORGE", "PSE-HOST-NEXUS"]);
  assert.equal(summary.runtimeTruthStatus, "UNKNOWN_NO_ACCEPTANCE");
  assert.equal(summary.hostHealthAvailable, false);
  assert.equal(summary.graphUnresolved, 145);
  assert.equal(summary.repositoryCandidates, 9);
  assert.equal(summary.completeProfiles, 5);
  assert.equal(summary.notEvaluatedProfiles, 1);
});

test("rejects unknown top-level and nested keys", () => {
  const top = fixture();
  top.extra = true;
  assert.throws(() => contract.validate(top), /keys do not match/);

  const nested = fixture();
  nested.runtime.extra = "nope";
  assert.throws(() => contract.validate(nested), /runtime keys/);
});

test("rejects authority drift and malformed source provenance", () => {
  const authority = fixture();
  authority.authority = "consumer recomputed truth";
  assert.throws(() => contract.validate(authority), /authority/);

  const source = fixture();
  source.sources.compilerSha256 = "ABC";
  assert.throws(() => contract.validate(source), /compilerSha256/);
});

test("rejects legacy managed host names and leaked legacy identities", () => {
  const data = fixture();
  data.managedHosts[0] = { id: "PSE-HOST-ATLAS", name: "Mac" };
  assert.throws(() => contract.validate(data), /managed host identity drift/);

  const leaked = fixture();
  leaked.completeness.profiles[1].reason = "VPS";
  assert.throws(() => contract.validate(leaked), /legacy host identity/);
});

test("rejects command capability and ranking fields", () => {
  const commandData = fixture();
  commandData.capabilities.commandsAvailable = true;
  assert.throws(() => contract.validate(commandData), /command capability/);

  const scoreData = fixture();
  scoreData.score = 100;
  assert.throws(() => contract.validate(scoreData), /keys do not match|forbidden Foundation Surface key/);
});

test("rejects invalid numeric fields and completeness status", () => {
  const negative = fixture();
  negative.graph.unresolved = -1;
  assert.throws(() => contract.validate(negative), /non-negative integer/);

  const fractional = fixture();
  fractional.repositories.newCandidate = 1.5;
  assert.throws(() => contract.validate(fractional), /non-negative integer/);

  const status = fixture();
  status.completeness.profiles[0].status = "PERFECT";
  assert.throws(() => contract.validate(status), /profile status/);
});

test("rejects inferred runtime truth when acceptance is absent", () => {
  const data = fixture();
  data.runtime.truthStatus = "LIVE_COMPLETE";
  data.runtime.liveComplete = true;
  data.capabilities.runtimeEvidenceAvailable = true;
  data.capabilities.hostHealthAvailable = true;
  assert.throws(() => contract.validate(data), /runtime truth inferred/);
});

test("accepts typed runtime evidence when acceptance is explicitly available", () => {
  const data = fixture();
  data.runtime = {
    truthStatus: "LIVE_COMPLETE",
    acceptanceAvailable: true,
    liveComplete: true
  };
  data.capabilities.runtimeEvidenceAvailable = true;
  data.capabilities.hostHealthAvailable = true;
  assert.doesNotThrow(() => contract.validate(data));
});

test("public GitHub Pages bootstrap is privacy-gated", () => {
  assert.equal(contract.isPublicBootstrap("cadengl-oss.github.io"), true);
  assert.equal(contract.isPublicBootstrap("omarchy.tail7ba003.ts.net"), false);
});

test("Command Deck guards private Foundation fetch before the fetch call", () => {
  const app = fs.readFileSync(path.join(repoRoot, "docs/app.js"), "utf8");
  const start = app.indexOf("async function loadFoundation()");
  const guard = app.indexOf("isPublicBootstrap(location.hostname)", start);
  const fetchIndex = app.indexOf("fetch(FOUNDATION_API", start);
  assert.ok(start >= 0 && guard > start && fetchIndex > guard);
  assert.match(app, /cache:\s*"no-store"/);
});

test("active system shortcuts use Atlas Forge Nexus", () => {
  const html = fs.readFileSync(path.join(repoRoot, "docs/index.html"), "utf8");
  assert.match(html, /data-preset="atlas".*>Atlas</s);
  assert.match(html, /data-preset="forge".*>Forge</s);
  assert.match(html, /data-preset="nexus".*>Nexus</s);
  assert.doesNotMatch(html, /data-preset="mac"/);
  assert.doesNotMatch(html, /data-preset="omarchy"/);
  assert.doesNotMatch(html, /data-preset="vps"/);
});

test("Foundation contract script loads before app.js", () => {
  const html = fs.readFileSync(path.join(repoRoot, "docs/index.html"), "utf8");
  const contractIndex = html.indexOf("./foundation-surface.js");
  const appIndex = html.indexOf("./app.js");
  assert.ok(contractIndex >= 0 && appIndex > contractIndex);
});

test("service worker caches the Foundation contract", () => {
  const sw = fs.readFileSync(path.join(repoRoot, "docs/sw.js"), "utf8");
  assert.match(sw, /pse-command-deck-v7/);
  assert.match(sw, /\.\/foundation-surface\.js/);
});
