import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-quattro-integration-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "quattro-routing-integration-secret";

const core = await import("../../src/lib/db/core.ts");
const capabilitiesRoute = await import("../../src/app/api/v1/capabilities/route.ts");
const candidatesRoute = await import("../../src/app/api/v1/routing/candidates/route.ts");
const routingEnvelope = await import("../../open-sse/services/autoCombo/routingEnvelope.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("standard and enhanced routing metadata paths remain additive", async () => {
  const standardBody = {
    model: "auto",
    messages: [{ role: "user", content: "hello" }],
  };
  const standard = routingEnvelope.extractRoutingPreferenceEnvelope(standardBody);
  assert.equal(standard.success, true);
  if (standard.success) {
    assert.equal(standard.body, standardBody);
    assert.equal(standard.envelope, null);
  }

  const enhanced = routingEnvelope.extractRoutingPreferenceEnvelope({
    ...standardBody,
    routing: {
      schema_version: 1,
      requirements: { capabilities: ["code_execution"], minimum_context: 120_000 },
      preferred_candidates: ["codex/luna", "codex/sol"],
      preference_mode: "balanced",
    },
  });
  assert.equal(enhanced.success, true);
  if (enhanced.success) {
    assert.equal("routing" in enhanced.body, false);
    assert.deepEqual(enhanced.envelope?.requiredCapabilities, ["code_execution"]);
  }

  const capabilities = await capabilitiesRoute.GET(
    new Request("http://localhost/api/v1/capabilities")
  );
  assert.equal(capabilities.status, 200);
  const capabilityBody = await capabilities.json();
  assert.equal(capabilityBody.schema_version, 1);

  const snapshot = await candidatesRoute.GET(
    new Request("http://localhost/api/v1/routing/candidates?channel=auto")
  );
  assert.equal(snapshot.status, 200);
  const snapshotBody = await snapshot.json();
  assert.equal(snapshotBody.schema_version, 1);
  assert.ok(Array.isArray(snapshotBody.candidates));
  assert.equal(JSON.stringify(snapshotBody).includes("connectionId"), false);
});
