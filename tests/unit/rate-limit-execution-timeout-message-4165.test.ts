/**
 * Queue/dispatch timeout separation regression coverage.
 *
 * requestQueue.maxWaitMs is retained as a persisted compatibility key, but it
 * now bounds only time spent waiting for a Bottleneck slot. Provider, target,
 * and combo deadlines own post-dispatch execution.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-rl-queue-timeout-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const resilienceSettings = await import("../../src/lib/resilience/settings.ts");
const rateLimitManager = await import("../../open-sse/services/rateLimitManager.ts");
const { getTrustedLocalRateLimitError } =
  await import("../../open-sse/services/rateLimitManager/errors.ts");

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function configure(maxWaitMs: number) {
  await rateLimitManager.applyRequestQueueSettings({
    ...resilienceSettings.DEFAULT_RESILIENCE_SETTINGS.requestQueue,
    autoEnableApiKeyProviders: false,
    concurrentRequests: 1,
    requestsPerMinute: 100000,
    minTimeBetweenRequestsMs: 0,
    maxWaitMs,
  });
}

test.afterEach(async () => {
  await rateLimitManager.__resetRateLimitManagerForTests();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("maxWaitMs does not expire work after dispatch", async () => {
  await configure(40);
  rateLimitManager.enableRateLimitProtection("conn-long-execution");

  const result = await rateLimitManager.withRateLimit(
    "openai",
    "conn-long-execution",
    "gpt-4o",
    async () => {
      await wait(120);
      return "completed";
    }
  );

  assert.equal(result, "completed");
});

test("a pre-aborted unprotected request never invokes provider work", async () => {
  const controller = new AbortController();
  controller.abort(new Error("parent cancelled"));
  let executed = false;
  await assert.rejects(
    rateLimitManager.withRateLimit(
      "openai",
      "conn-without-protection",
      "gpt-4o",
      async () => {
        executed = true;
        return "unexpected";
      },
      controller.signal
    ),
    /parent cancelled/
  );
  assert.equal(executed, false);
});

test("maxWaitMs rejects only queued work and never dispatches it later", async () => {
  await configure(40);
  rateLimitManager.enableRateLimitProtection("conn-queue-timeout");

  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = rateLimitManager.withRateLimit(
    "openai",
    "conn-queue-timeout",
    "gpt-4o",
    async () => {
      await firstGate;
      return "first";
    }
  );

  await wait(15);
  let secondExecuted = false;
  await assert.rejects(
    rateLimitManager.withRateLimit(
      "openai",
      "conn-queue-timeout",
      "gpt-4o",
      async () => {
        secondExecuted = true;
        return "second";
      }
    ),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "RATE_LIMIT_QUEUE_TIMEOUT");
      assert.match(error.message, /queue wait exceeded/i);
      assert.deepEqual(getTrustedLocalRateLimitError(error), {
        code: "RATE_LIMIT_QUEUE_TIMEOUT",
        status: 503,
      });
      return true;
    }
  );

  releaseFirst();
  assert.equal(await first, "first");
  await wait(40);
  assert.equal(secondExecuted, false, "expired queued work must never call the provider");
});

test("an aborted queued job never dispatches after capacity returns", async () => {
  await configure(5_000);
  rateLimitManager.enableRateLimitProtection("conn-abort-queue");

  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = rateLimitManager.withRateLimit(
    "openai",
    "conn-abort-queue",
    "gpt-4o",
    async () => {
      await firstGate;
      return "first";
    }
  );
  await wait(15);

  const controller = new AbortController();
  let secondExecuted = false;
  const second = rateLimitManager.withRateLimit(
    "openai",
    "conn-abort-queue",
    "gpt-4o",
    async () => {
      secondExecuted = true;
      return "second";
    },
    controller.signal
  );
  controller.abort();
  await assert.rejects(second, (error: Error) => error.name === "AbortError");

  releaseFirst();
  assert.equal(await first, "first");
  await wait(40);
  assert.equal(secondExecuted, false);
});
