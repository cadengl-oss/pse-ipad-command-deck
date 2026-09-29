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
      truthReportSha256: hash("4"),
      completenessSha256: hash("5"),
      compilerSha256: hash("6")
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
        { id: "CANONICAL_HOST", status: "COMPLETE", evaluated: 3, complete: 3, incomplete: 0, missingCount: 0 },
        { id: "PRODUCTION_SERVICE", status: "NOT_EVALUATED", evaluated: 0, complete: 0, incomplete: 0, missingCount: 0, reason: "authority input unavailable" }
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

test("validates canonical Foundation Surface and preserves unknown runtime", () => {
  const data = contract.validate(fixture());
  const summary = contract.summarize(data);
  assert.deepEqual(summary.managedHostIDs, ["PSE-HOST-ATLAS", "PSE-HOST-FORGE", "PSE-HOST-NEXUS"]);
  assert.equal(summary.runtimeTruthStatus, "UNKNOWN_NO_ACCEPTANCE");
  assert.equal(summary.hostHealthAvailable, false);
  assert.equal(summary.graphUnresolved, 145);
  assert.equal(summary.repositoryCandidates, 9);
  assert.equal(summary.requirementsNotSatisfied, 30);
  assert.equal(summary.completeProfiles, 5);
  assert.equal(summary.notEvaluatedProfiles, 1);
});

test("rejects legacy managed host names", () => {
  const data = fixture();
  data.managedHosts[0] = { id: "PSE-HOST-ATLAS", name: "Mac" };
  assert.throws(() => contract.validate(data), /managed host identity drift/);
});

test("rejects command capability and ranking fields", () => {
  const commandData = fixture();
  commandData.capabilities.commandsAvailable = true;
  assert.throws(() => contract.validate(commandData), /command capability/);

  const scoreData = fixture();
  scoreData.requirements.byStatus.score = 100;
  assert.throws(() => contract.validate(scoreData), /forbidden Foundation Surface key/);
});

test("rejects unknown schema keys instead of silently ignoring them", () => {
  const topLevel = fixture();
  topLevel.unexpected = "drift";
  assert.throws(() => contract.validate(topLevel), /unknown Foundation Surface key/);

  const nested = fixture();
  nested.graph.extra = 1;
  assert.throws(() => contract.validate(nested), /unknown Foundation Surface key/);
});

test("rejects invalid provenance and authority", () => {
  const authority = fixture();
  authority.authority = "something else";
  assert.throws(() => contract.validate(authority), /authority/);

  const hash = fixture();
  hash.sources.compilerSha256 = "ABC";
  assert.throws(() => contract.validate(hash), /compilerSha256/);

  const snapshot = fixture();
  snapshot.sources.graphSnapshotId = "sha256:" + "A".repeat(64);
  assert.throws(() => contract.validate(snapshot), /graphSnapshotId/);
});

test("rejects negative counts and invalid profile states", () => {
  const negative = fixture();
  negative.graph.unresolved = -1;
  assert.throws(() => contract.validate(negative), /nonnegative integer/);

  const badProfile = fixture();
  badProfile.completeness.profiles[0].status = "HEALTHY";
  assert.throws(() => contract.validate(badProfile), /profile status/);
});

test("rejects missing required contract fields", () => {
  const data = fixture();
  delete data.attention;
  assert.throws(() => contract.validate(data), /missing Foundation Surface key/);
});

test("rejects inferred runtime health when acceptance is absent", () => {
  const bad = fixture();
  bad.capabilities.hostHealthAvailable = true;
  assert.throws(() => contract.validate(bad), /runtime truth inferred/);

  const live = fixture();
  live.runtime.truthStatus = "LIVE_COMPLETE";
  assert.throws(() => contract.validate(live), /runtime truth inferred/);
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

test("Foundation failure rendering does not infer health", () => {
  const app = fs.readFileSync(path.join(repoRoot, "docs/app.js"), "utf8");
  const start = app.indexOf("function setFoundationUnavailable");
  const end = app.indexOf("function renderFoundation", start);
  const block = app.slice(start, end);
  assert.match(block, /foundationRuntime"\)\.textContent = "UNKNOWN"/);
  assert.doesNotMatch(block, /HEALTHY|LIVE_COMPLETE/);
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

test("accepts the externally supplied canonical producer fixture when provided", () => {
  const fixturePath = process.env.PSE_FOUNDATION_SURFACE_FIXTURE;
  if (!fixturePath) return;
  const data = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const summary = contract.summarize(contract.validate(data));
  assert.equal(summary.surfaceId, data.surfaceId);
  assert.equal(summary.runtimeTruthStatus, data.runtime.truthStatus);
  assert.deepEqual(summary.managedHostIDs, ["PSE-HOST-ATLAS", "PSE-HOST-FORGE", "PSE-HOST-NEXUS"]);
  assert.equal(summary.runtimeEvidenceAvailable, data.capabilities.runtimeEvidenceAvailable);
  assert.equal(summary.hostHealthAvailable, data.capabilities.hostHealthAvailable);
  assert.equal(data.capabilities.commandsAvailable, false);
  assert.equal(data.mutationPerformed, false);
});
