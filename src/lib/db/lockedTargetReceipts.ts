import { getDbInstance } from "./core";

const NAMESPACE = "lockedTargetReceipts";
export const LOCKED_RECEIPT_MAX_RECORDS = 500;
export const LOCKED_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type StoredReceipt = {
  receivedAtMs: number;
  receipt: string;
};

function storageKey(planKey: string, capabilityHash: string): string {
  return `${planKey}:${capabilityHash}`;
}

function parseStoredReceipt(value: string): StoredReceipt | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredReceipt>;
    if (
      typeof parsed.receivedAtMs === "number" &&
      Number.isFinite(parsed.receivedAtMs) &&
      typeof parsed.receipt === "string"
    ) {
      return { receivedAtMs: parsed.receivedAtMs, receipt: parsed.receipt };
    }
  } catch {}
  return null;
}

/** Persist the latest receipt for one plan/capability pair and prune stale evidence. */
export function saveLockedTargetReceipt(args: {
  planKey: string;
  capabilityHash: string;
  receipt: string;
  receivedAtMs: number;
}): void {
  const db = getDbInstance();
  const writeAndCleanup = db.transaction(() => {
    db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
      NAMESPACE,
      storageKey(args.planKey, args.capabilityHash),
      JSON.stringify({ receivedAtMs: args.receivedAtMs, receipt: args.receipt })
    );

    const rows = db
      .prepare("SELECT key, value FROM key_value WHERE namespace = ?")
      .all(NAMESPACE) as Array<{ key: string; value: string }>;
    const cutoff = args.receivedAtMs - LOCKED_RECEIPT_RETENTION_MS;
    const retained: Array<{ key: string; receivedAtMs: number }> = [];
    const remove = db.prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?");

    for (const row of rows) {
      const stored = parseStoredReceipt(row.value);
      if (!stored || stored.receivedAtMs < cutoff) {
        remove.run(NAMESPACE, row.key);
      } else {
        retained.push({ key: row.key, receivedAtMs: stored.receivedAtMs });
      }
    }

    retained.sort((left, right) => right.receivedAtMs - left.receivedAtMs);
    for (const row of retained.slice(LOCKED_RECEIPT_MAX_RECORDS)) {
      remove.run(NAMESPACE, row.key);
    }
  });
  writeAndCleanup();
}

/** Read only when both the plan-derived key and capability hash match. */
export function loadLockedTargetReceipt(planKey: string, capabilityHash: string): string | null {
  const db = getDbInstance();
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(NAMESPACE, storageKey(planKey, capabilityHash)) as { value: string } | undefined;
  if (!row) return null;
  const stored = parseStoredReceipt(row.value);
  if (!stored || stored.receivedAtMs < Date.now() - LOCKED_RECEIPT_RETENTION_MS) {
    db.prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?").run(
      NAMESPACE,
      storageKey(planKey, capabilityHash)
    );
    return null;
  }
  return stored.receipt;
}
