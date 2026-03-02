/**
 * Orphaned subagent run recovery.
 *
 * When the OpenClaw Gateway restarts, active sub-agent runs can become orphaned
 * because:
 * 1. The in-memory agent run tracking is lost
 * 2. The subagent registry is persisted and tries to resume waiting
 * 3. But `agent.wait` has no knowledge of the runs that were in-flight
 *
 * This module provides recovery logic to detect and clean up orphaned runs
 * on gateway startup.
 */

import { loadConfig } from "../config/config.js";
import { resolveAgentIdFromSessionKey, resolveStorePath } from "../config/sessions.js";
import { loadSessionStore } from "../config/sessions/store.js";
import { SUBAGENT_ENDED_REASON_ORPHANED } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/**
 * Maximum time a run can be "in progress" (no endedAt) after gateway restart
 * before we consider it orphaned. Runs without an end timestamp that were
 * created more than this duration ago are presumed to have been interrupted
 * by a gateway restart.
 */
const ORPHAN_RUN_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Grace period after a run is created before we consider it orphaned.
 * This gives legitimate long-running tasks time to complete.
 */
const ORPHAN_RUN_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Grace period for detecting orphaned runs on gateway restart.
 * Runs that were created before the gateway started (meaning they were
 * from a previous gateway instance) are orphaned after this grace period.
 */
const GATEWAY_RESTART_GRACE_PERIOD_MS = 30 * 1000; // 30 seconds

/**
 * Timestamp when this gateway instance started. Used to detect runs
 * that were interrupted by a gateway restart.
 */
let gatewayStartedAtMs = Date.now();

/**
 * Update the gateway start timestamp. Should be called once during gateway startup.
 */
export function markGatewayStarted(): void {
  gatewayStartedAtMs = Date.now();
}

/**
 * Get the gateway start timestamp (for testing).
 */
export function getGatewayStartedAtMs(): number {
  return gatewayStartedAtMs;
}

/**
 * Reset the gateway start timestamp for tests.
 * @param timestamp - Optional timestamp to set (defaults to current time)
 */
export function resetGatewayStartedAtForTest(timestamp?: number): void {
  gatewayStartedAtMs = timestamp ?? Date.now();
}

export type OrphanRecoveryResult = {
  recovered: number;
  reasons: Map<string, string>;
  /**
   * Run IDs that were recovered - can be used to emit subagent_ended hooks
   */
  recoveredRunIds: string[];
  /**
   * Recovered entries with full details - can be used to emit subagent_ended hooks
   * These entries have been marked as ended with orphaned reason
   */
  recoveredEntries: SubagentRunRecord[];
};

type OrphanDetectionReason =
  | "stale-unended-run"
  | "missing-session-entry"
  | "missing-session-id"
  | "gateway-restart-orphaned";

function detectOrphanedRun(params: {
  entry: SubagentRunRecord;
  now: number;
  storeCache: Map<string, ReturnType<typeof loadSessionStore>>;
  gatewayStartedAt: number;
}): OrphanDetectionReason | null {
  const { entry, now, storeCache, gatewayStartedAt } = params;

  // If the run has already ended, it's not orphaned (just pending cleanup)
  if (typeof entry.endedAt === "number") {
    return null;
  }

  const runCreatedAt = entry.createdAt ?? 0;
  const runAge = now - runCreatedAt;

  // Check if the run has been around too long without completing
  if (runAge > ORPHAN_RUN_MAX_AGE_MS) {
    return "stale-unended-run";
  }

  // KEY FIX: Detect runs that were created BEFORE this gateway instance started.
  // These runs were interrupted by a gateway restart and will never complete
  // because the in-memory agent run tracking was lost.
  const timeSinceGatewayStart = now - gatewayStartedAt;
  const runCreatedBeforeGatewayStart = runCreatedAt > 0 && runCreatedAt < gatewayStartedAt;

  if (runCreatedBeforeGatewayStart) {
    // If it's within gateway restart grace period, don't orphan yet
    if (timeSinceGatewayStart <= GATEWAY_RESTART_GRACE_PERIOD_MS) {
      return null; // Still in gateway restart grace period - might still resume
    }
    // Past gateway restart grace period - mark as orphaned
    return "gateway-restart-orphaned";
  }

  // Run was created AFTER gateway started - use normal grace period
  if (runAge < ORPHAN_RUN_GRACE_PERIOD_MS) {
    return null; // Within normal grace period - give it time to complete
  }

  // Check if the session entry exists and has a valid sessionId
  const childSessionKey = entry.childSessionKey?.trim();
  if (!childSessionKey) {
    return "missing-session-entry";
  }

  try {
    const cfg = loadConfig();
    const agentId = resolveAgentIdFromSessionKey(childSessionKey);
    const storePath = resolveStorePath(cfg.session?.store, { agentId });

    let store = storeCache.get(storePath);
    if (!store) {
      store = loadSessionStore(storePath);
      storeCache.set(storePath, store);
    }

    // Case-insensitive session key lookup
    const normalizedKey = childSessionKey.toLowerCase();
    let sessionEntry = store[childSessionKey];
    if (!sessionEntry) {
      for (const [key, value] of Object.entries(store)) {
        if (key.toLowerCase() === normalizedKey) {
          sessionEntry = value;
          break;
        }
      }
    }

    if (!sessionEntry) {
      return "missing-session-entry";
    }

    if (typeof sessionEntry.sessionId !== "string" || !sessionEntry.sessionId.trim()) {
      return "missing-session-id";
    }

    return null;
  } catch {
    // On config/load errors, be conservative and don't mark as orphaned
    return null;
  }
}

function markRunAsOrphaned(
  entry: SubagentRunRecord,
  reason: OrphanDetectionReason,
): SubagentRunRecord {
  const now = Date.now();
  entry.endedAt = now;
  entry.outcome = {
    status: "error",
    error: `orphaned: ${reason} (gateway restart recovery)`,
  };
  entry.endedReason = SUBAGENT_ENDED_REASON_ORPHANED;
  entry.cleanupHandled = true;
  entry.cleanupCompletedAt = now;
  return entry;
}

/**
 * Scan for and recover orphaned subagent runs.
 * This should be called once during gateway startup after the subagent
 * registry has been restored from disk.
 *
 * @param runs - The in-memory subagent runs map (will be mutated)
 * @returns Summary of recovered runs including run IDs for hook emission
 */
export function recoverOrphanedSubagentRuns(
  runs: Map<string, SubagentRunRecord>,
): OrphanRecoveryResult {
  const now = Date.now();
  const gatewayStartedAt = getGatewayStartedAtMs();
  const storeCache = new Map<string, ReturnType<typeof loadSessionStore>>();
  const reasons = new Map<string, string>();
  const recoveredRunIds: string[] = [];
  const recoveredEntries: SubagentRunRecord[] = [];
  let recovered = 0;

  for (const [runId, entry] of runs.entries()) {
    if (!entry) {
      continue;
    }

    const orphanReason = detectOrphanedRun({ entry, now, storeCache, gatewayStartedAt });
    if (!orphanReason) {
      continue;
    }

    markRunAsOrphaned(entry, orphanReason);
    reasons.set(runId, orphanReason);
    recoveredRunIds.push(runId);
    recoveredEntries.push(entry);
    recovered++;

    // Remove the run from the active registry
    runs.delete(runId);
  }

  return { recovered, reasons, recoveredRunIds, recoveredEntries };
}

/**
 * Check if a run appears to be orphaned (for use in resume logic).
 * This is a lighter check used during the resume phase to detect
 * runs that became orphaned after the initial recovery scan.
 */
export function checkRunAppearsOrphaned(params: {
  entry: SubagentRunRecord;
  now: number;
}): boolean {
  const { entry, now } = params;

  // Already ended runs are not orphaned
  if (typeof entry.endedAt === "number") {
    return false;
  }

  const runCreatedAt = entry.createdAt ?? 0;
  const runAge = now - runCreatedAt;

  // Check age-based orphaning
  if (runAge > ORPHAN_RUN_MAX_AGE_MS) {
    return true;
  }

  // Check for gateway restart orphaning
  const gatewayStartedAt = getGatewayStartedAtMs();
  const timeSinceGatewayStart = now - gatewayStartedAt;
  const runCreatedBeforeGatewayStart = runCreatedAt > 0 && runCreatedAt < gatewayStartedAt;

  if (runCreatedBeforeGatewayStart) {
    // If within gateway restart grace period, not orphaned yet
    if (timeSinceGatewayStart <= GATEWAY_RESTART_GRACE_PERIOD_MS) {
      return false;
    }
    // Past gateway restart grace period - orphaned
    return true;
  }

  // Runs created after gateway start - use normal grace period
  if (runAge < ORPHAN_RUN_GRACE_PERIOD_MS) {
    return false;
  }

  return false;
}

/**
 * Get the configured orphan detection thresholds (for testing/debugging).
 */
export function getOrphanDetectionThresholds() {
  return {
    maxAgeMs: ORPHAN_RUN_MAX_AGE_MS,
    gracePeriodMs: ORPHAN_RUN_GRACE_PERIOD_MS,
    gatewayRestartGracePeriodMs: GATEWAY_RESTART_GRACE_PERIOD_MS,
  };
}
