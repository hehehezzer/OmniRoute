import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import { resetDbInstance } from "../../../src/lib/db/core.ts";

import {
  classifyLockedFailure,
  consumeTestLockedPressure,
  connectionMatchesLockedAccount,
  extractLockedRoutingRequest,
  normalizeLockedFailure,
  normalizeLockedException,
  getLockedTargetReceipt,
  getLockedRoutingCapabilities,
  recordLockedTargetReceipt,
  resolveOmniRouteRoutingMode,
  resolveConnectionAccountIdentity,
  withLockedTargetEvidence,
} from "../../../open-sse/services/lockedTarget.ts";

const routing = {
  preference_mode: "passthrough",
  routingLocked: true,
  planId: "task_123e4567-e89b-42d3-a456-426614174000.plan-0",
  target: {
    provider: "codex",
    account: "account-1",
    model: "gpt-5.6-luna",
    route: "account-1/gpt-5.6-luna",
  },
};

test("locked passthrough keeps the local pressure fuse before provider dispatch", () => {
  const source = fs.readFileSync("src/sse/handlers/chat.ts", "utf8");
  const locked = source.indexOf("if (lockedRoutingRequest) {");
  const pressure = source.indexOf("checkResourcePressureBeforeProviderWork()", locked);
  const dispatch = source.indexOf("handleSingleModelChat(", locked);
  assert.ok(locked >= 0 && pressure > locked && dispatch > pressure);
  assert.match(
    source.slice(pressure, dispatch),
    /normalizeLockedFailure\(pressureGuard\.response, null\)/
  );
  assert.match(
    source.slice(pressure, dispatch),
    /persistLockedReceipt\(response, null\)/
  );
});

test("test-only locked pressure probe holds dispatch zero for one exact plan", async () => {
  const previous = process.env.OMNIROUTE_TEST_LOCKED_PRESSURE_PLAN_ID;
  process.env.OMNIROUTE_TEST_LOCKED_PRESSURE_PLAN_ID = routing.planId;
  try {
    const result = extractLockedRoutingRequest({
      model: routing.target.route,
      routing,
    });
    assert.ok("locked" in result && result.locked);
    const first = consumeTestLockedPressure(result.locked);
    assert.ok(first);
    const payload = await first.json();
    assert.equal(payload.error.type, "GATEWAY_RESOURCE_PRESSURE");
    assert.equal(payload.error.route, routing.target.route);
    assert.equal(first.headers.get("retry-after"), null);
    assert.ok(consumeTestLockedPressure(result.locked));
    assert.equal(
      consumeTestLockedPressure({ ...result.locked, samePlanDispatchAttempt: 1 }),
      null
    );
    assert.equal(
      consumeTestLockedPressure({ ...result.locked, planId: `${routing.planId}-other` }),
      null
    );
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_TEST_LOCKED_PRESSURE_PLAN_ID;
    else process.env.OMNIROUTE_TEST_LOCKED_PRESSURE_PLAN_ID = previous;
  }
});

test("extracts complete locked request and strips gateway metadata", () => {
  const result = extractLockedRoutingRequest({
    model: routing.target.route,
    routing: { ...routing, session_id: "session-1", turn_id: "turn-1" },
  });
  assert.ok("locked" in result);
  assert.equal(result.locked?.target.account, "account-1");
  assert.equal(result.locked?.sessionId, "session-1");
  assert.equal(result.locked?.turnId, "turn-1");
  assert.equal(result.locked?.samePlanDispatchAttempt, 0);
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

test("rejects conflicting header and body locks instead of selecting one", () => {
  const conflicting = {
    ...routing,
    target: { ...routing.target, account: "account-2", route: "account-2/gpt-5.6-luna" },
  };
  const result = extractLockedRoutingRequest(
    { model: routing.target.route, routing: conflicting },
    new Headers({ "X-Quattro-Routing": JSON.stringify(routing) })
  );
  assert.ok("response" in result);
  assert.equal(result.response.status, 503);
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

test("gateway defaults to passthrough and keeps legacy behind an explicit mode", () => {
  assert.equal(resolveOmniRouteRoutingMode(undefined), "passthrough");
  assert.equal(resolveOmniRouteRoutingMode("LEGACY"), "legacy");
  assert.equal(resolveOmniRouteRoutingMode("balanced"), null);
});

test("legacy gateway mode rejects a locked request instead of silently rerouting", () => {
  const previous = process.env.OMNIROUTE_ROUTING_MODE;
  process.env.OMNIROUTE_ROUTING_MODE = "legacy";
  try {
    const result = extractLockedRoutingRequest({ model: routing.target.route, routing });
    assert.ok("response" in result);
    if ("response" in result) assert.equal(result.response.status, 503);
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_ROUTING_MODE;
    else process.env.OMNIROUTE_ROUTING_MODE = previous;
  }
});

test("legacy preference cannot enter the locked passthrough path", () => {
  const result = extractLockedRoutingRequest({
    model: routing.target.route,
    routing: { ...routing, preference_mode: "legacy" },
  });
  assert.ok("response" in result);
  if ("response" in result) assert.equal(result.response.status, 503);
});

test("reports the runtime locked-routing contract", () => {
  const previous = process.env.OMNIROUTE_ROUTING_MODE;
  process.env.OMNIROUTE_ROUTING_MODE = "passthrough";
  try {
    assert.deepEqual(getLockedRoutingCapabilities(), {
      routing_mode: "passthrough",
      locked_target_supported: true,
      receipt_supported: true,
      target_rerouting: false,
    });
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_ROUTING_MODE;
    else process.env.OMNIROUTE_ROUTING_MODE = previous;
  }
});

test("account identity is independently derived from connection", () => {
  const connection = { id: "conn-1", name: "account-1", provider: "codex" };
  assert.equal(resolveConnectionAccountIdentity(connection), "account-1");
  assert.equal(connectionMatchesLockedAccount(connection, "account-1"), true);
  assert.equal(connectionMatchesLockedAccount(connection, "account-2"), false);
});

test("connection account evidence cannot be inferred from the requested route", () => {
  const connection = { id: "conn-2", name: "account-2", provider: "codex" };
  assert.equal(resolveConnectionAccountIdentity(connection), "account-2");
  assert.equal(connectionMatchesLockedAccount(connection, "account-1"), false);
});

test("account matching accepts provider-native identity when the display name differs", () => {
  const connection = {
    id: "conn-native",
    name: "Personal Codex",
    providerSpecificData: { accountId: "account-1" },
  };
  assert.equal(connectionMatchesLockedAccount(connection, "account-1"), true);
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
  assert.equal(classifyLockedFailure(403, "forbidden"), "AUTHENTICATION_FAILED");
  assert.equal(classifyLockedFailure(400, "capability unsupported"), "CAPABILITY_UNSUPPORTED");
  assert.equal(classifyLockedFailure(400, "context length exceeded"), "CONTEXT_LIMIT");
  assert.equal(classifyLockedFailure(422, "invalid request shape"), "CLIENT_ERROR");
  assert.equal(classifyLockedFailure(502, "socket hang up"), "TRANSPORT_FAILURE");
  assert.equal(
    classifyLockedFailure(503, '{"error":{"code":"resource_pressure"}}'),
    "GATEWAY_RESOURCE_PRESSURE"
  );
});

test("normalizes gateway pressure without blaming the locked target", async () => {
  const response = await normalizeLockedFailure(
    new Response('{"error":{"code":"resource_pressure"}}', {
      status: 503,
      headers: { "Retry-After": "5" },
    })
  );
  const payload = await response.json();
  assert.equal(payload.error.type, "GATEWAY_RESOURCE_PRESSURE");
  assert.equal(payload.error.retryable, true);
  assert.equal(payload.error.retry_after_ms, 5000);
});

test("normalizes thrown locked dispatch failures with evidence", async () => {
  const actual = { ...routing.target, account: "account-1", connectionId: "conn-1" };
  const response = normalizeLockedException(
    Object.assign(new Error("socket hang up"), { status: 502 }),
    actual
  );
  const payload = await response.json();
  assert.equal(payload.error.type, "TRANSPORT_FAILURE");
  assert.equal(payload.error.retryable, true);
  assert.equal(response.headers.get("X-OmniRoute-Selected-Connection-Id"), "conn-1");
});

test("records a sanitized plan-scoped receipt for delegated execution", async () => {
  const planId = "task_123e4567-e89b-42d3-a456-426614174001.plan-0";
  const request = {
    planId,
    receiptToken: planId,
    sessionId: "session-1",
    turnId: "turn-2",
    target: routing.target,
  };
  const actual = { ...routing.target, connectionId: "conn-receipt" };
  await recordLockedTargetReceipt(
    request,
    Response.json({
      usage: {
        input_tokens: 120,
        input_tokens_details: { cached_tokens: 80 },
        output_tokens: 20,
      },
    }),
    actual
  );
  assert.equal(getLockedTargetReceipt(planId, "wrong-token"), null);
  const receivedAt = getLockedTargetReceipt(planId, planId)?.received_at;
  assert.deepEqual(getLockedTargetReceipt(planId, planId), {
    plan_id: planId,
    session_id: "session-1",
    turn_id: "turn-2",
    success: true,
    selected_target: routing.target,
    routing_mode: "passthrough",
    targetHonored: true,
    actual_provider: "codex",
    actual_account: "account-1",
    actual_model: "gpt-5.6-luna",
    actual_route: "account-1/gpt-5.6-luna",
    connection_id: "conn-receipt",
    failure: null,
    usage: {
      input_tokens: 120,
      cached_input_tokens: 80,
      uncached_input_tokens: 40,
      output_tokens: 20,
      cache_metric_provenance: "provider_response",
    },
    received_at: receivedAt,
  });

  resetDbInstance();
  assert.equal(getLockedTargetReceipt(planId, planId)?.received_at, receivedAt);
});
