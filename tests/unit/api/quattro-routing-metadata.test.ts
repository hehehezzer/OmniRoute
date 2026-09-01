import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-quattro-api-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "quattro-routing-metadata-test-secret";

const core = await import("../../../src/lib/db/core.ts");
const apiKeys = await import("../../../src/lib/db/apiKeys.ts");
const capabilitiesRoute = await import("../../../src/app/api/v1/capabilities/route.ts");
const candidatesRoute = await import("../../../src/app/api/v1/routing/candidates/route.ts");
const candidateHandler = await import("../../../open-sse/handlers/autoComboCandidates.ts");

function collectKeys(value: unknown, output = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    value.forEach((entry) => collectKeys(entry, output));
    return output;
  }
  for (const [key, nested] of Object.entries(value)) {
    output.add(key.toLowerCase());
    collectKeys(nested, output);
  }
  return output;
}

test.beforeEach(() => core.resetDbInstance());
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("capability negotiation advertises the additive contract", async () => {
  const response = await capabilitiesRoute.GET(new Request("http://localhost/api/v1/capabilities"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.schema_version, 1);
  assert.equal(body.capabilities.candidate_snapshot, true);
  assert.equal(body.capabilities.routing_requirements, true);
  assert.equal(body.capabilities.preferred_candidates, true);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("candidate snapshot has a versioned sanitized schema", async () => {
  const response = await candidatesRoute.GET(
    new Request("http://localhost/api/v1/routing/candidates?channel=auto")
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.schema_version, 1);
  assert.equal(typeof body.generated_at, "string");
  assert.equal(body.metadata_version, "quattro-routing-metadata-1");
  assert.ok(Array.isArray(body.candidates));

  const keys = collectKeys(body);
  for (const forbidden of [
    "connectionid",
    "api_key",
    "access_token",
    "refresh_token",
    "cookie",
    "credentials",
  ]) {
    assert.equal(keys.has(forbidden), false, `snapshot disclosed ${forbidden}`);
  }
});

test("public candidate identifiers reject account-like or unsafe values", () => {
  assert.equal(candidateHandler.isPublicCandidateIdentifier("codex", "gpt-5.6-sol"), true);
  assert.equal(candidateHandler.isPublicCandidateIdentifier("user@example.com", "model"), false);
  assert.equal(candidateHandler.isPublicCandidateIdentifier("provider", "account label"), false);
});

test("candidate snapshot rejects invalid channel input with a sanitized error", async () => {
  const response = await candidatesRoute.GET(
    new Request("http://localhost/api/v1/routing/candidates?channel=../../private")
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.message, "Invalid auto channel");
});

test("restricted API keys cannot enumerate an auto route they may not use", async () => {
  const created = await apiKeys.createApiKey("restricted-snapshot", "test-machine", []);
  await apiKeys.updateApiKeyPermissions(created.id, {
    modelAccessMode: "restricted",
    allowedModels: ["openai/gpt-4o-mini"],
  });
  const response = await candidatesRoute.GET(
    new Request("http://localhost/api/v1/routing/candidates?channel=auto", {
      headers: { Authorization: `Bearer ${created.key}` },
    })
  );
  assert.equal(response.status, 403);
});

test("endpoint-restricted API keys cannot read enhanced metadata", async () => {
  const created = await apiKeys.createApiKey("chat-only-snapshot", "test-machine", []);
  await apiKeys.updateApiKeyPermissions(created.id, { allowedEndpoints: ["chat"] });
  const response = await capabilitiesRoute.GET(
    new Request("http://localhost/api/v1/capabilities", {
      headers: { Authorization: `Bearer ${created.key}` },
    })
  );
  assert.equal(response.status, 403);
});
