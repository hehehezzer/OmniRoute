import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyLockedFailure,
  connectionMatchesLockedAccount,
  extractLockedRoutingRequest,
  normalizeLockedFailure,
  getLockedTargetReceipt,
  recordLockedTargetReceipt,
  resolveConnectionAccountIdentity,
  withLockedTargetEvidence,
} from "../../../open-sse/services/lockedTarget.ts";

const routing = {
  preference_mode: "passthrough",
  routingLocked: true,
  planId: "plan-1",
  target: {
    provider: "codex",
    account: "account-1",
    model: "gpt-5.6-luna",
    route: "account-1/gpt-5.6-luna",
  },
};

test("extracts complete locked request and strips gateway metadata", () => {
  const result = extractLockedRoutingRequest({ model: routing.target.route, routing });
  assert.ok("locked" in result);
  assert.equal(result.locked?.target.account, "account-1");
  assert.equal(result.body.routing, undefined);
});

test("extracts locked request from delegated X-Quattro-Routing transport", () => {
  const encoded = Buffer.from(JSON.stringify(routing)).toString("base64url");
  const result = extractLockedRoutingRequest(
    { model: routing.target.route },
    new Headers({ "X-Quattro-Routing": encoded })
  );
  assert.ok("locked" in result);
  assert.equal(result.locked?.target.route, routing.target.route);
});

test("rejects malformed delegated routing headers instead of bypassing the lock", () => {
  const result = extractLockedRoutingRequest(
    { model: routing.target.route },
    new Headers({ "X-Quattro-Routing": "not-json-or-base64" })
  );
  assert.ok("response" in result);
});

test("rejects half-locked routing contracts", () => {
  const result = extractLockedRoutingRequest({
    model: "x",
    routing: { preference_mode: "passthrough" },
  });
  assert.ok("response" in result);
  assert.equal(result.response.status, 503);
});

test("account identity is independently derived from connection", () => {
  const connection = { id: "conn-1", name: "account-1", provider: "codex" };
  assert.equal(resolveConnectionAccountIdentity(connection), "account-1");
  assert.equal(connectionMatchesLockedAccount(connection, "account-1"), true);
  assert.equal(connectionMatchesLockedAccount(connection, "account-2"), false);
});

test("normalizes quota failure and retry-after without changing target", async () => {
  const actual = { ...routing.target, connectionId: "conn-1" };
  const normalized = await normalizeLockedFailure(
    new Response("quota exceeded", { status: 429, headers: { "retry-after": "7" } }),
    actual
  );
  const payload = await normalized.json();
  assert.equal(payload.error.type, "QUOTA_EXHAUSTED");
  assert.equal(payload.error.retry_after_ms, 7000);
  assert.equal(normalized.headers.get("X-OmniRoute-Selected-Connection-Id"), "conn-1");
});

test("actual evidence comes only from resolved execution target", () => {
  const response = withLockedTargetEvidence(new Response("ok"), {
    provider: "codex",
    account: "db-account",
    model: "gpt-5.6-luna",
    route: "db-route",
    connectionId: "conn-9",
  });
  assert.equal(response.headers.get("X-OmniRoute-Account"), "db-account");
  assert.equal(response.headers.get("X-OmniRoute-Route"), "db-route");
});

test("failure taxonomy covers transport, auth, capability and context", () => {
  assert.equal(classifyLockedFailure(401, "bad token"), "AUTHENTICATION_FAILED");
  assert.equal(classifyLockedFailure(400, "capability unsupported"), "CAPABILITY_UNSUPPORTED");
  assert.equal(classifyLockedFailure(400, "context length exceeded"), "CONTEXT_LIMIT");
  assert.equal(classifyLockedFailure(502, "socket hang up"), "TRANSPORT_FAILURE");
});

test("records a sanitized plan-scoped receipt for delegated execution", async () => {
  const request = { planId: "plan-receipt", target: routing.target };
  const actual = { ...routing.target, connectionId: "conn-receipt" };
  await recordLockedTargetReceipt(request, new Response("ok"), actual);
  assert.deepEqual(getLockedTargetReceipt("plan-receipt"), {
    plan_id: "plan-receipt",
    success: true,
    actual_provider: "codex",
    actual_account: "account-1",
    actual_model: "gpt-5.6-luna",
    actual_route: "account-1/gpt-5.6-luna",
    connection_id: "conn-receipt",
    failure: null,
    received_at: getLockedTargetReceipt("plan-receipt")?.received_at,
  });
});
