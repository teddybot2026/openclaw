import { describe, it, expect, beforeEach } from "vitest";
import {
  recoverOrphanedSubagentRuns,
  getOrphanDetectionThresholds,
  resetGatewayStartedAtForTest,
} from "./subagent-registry-orphan-recovery.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

describe("subagent-registry-orphan-recovery", () => {
  const thresholds = getOrphanDetectionThresholds();

  beforeEach(() => {
    // Reset gateway start time for each test to avoid interference
    resetGatewayStartedAtForTest(0); // Set to epoch start so runs created "now" are after gateway start
  });

  describe("recoverOrphanedSubagentRuns", () => {
    it("should not mark runs in grace period as orphaned", () => {
      const runs = new Map<string, SubagentRunRecord>();
      const now = Date.now();

      // Set gateway started before the run was created
      resetGatewayStartedAtForTest(now - 120_000); // 2 minutes before run

      runs.set("run-1", {
        runId: "run-1",
        childSessionKey: "agent:main:subagent:abc",
        requesterSessionKey: "agent:main",
        requesterDisplayKey: "main",
        task: "test task",
        cleanup: "delete",
        createdAt: now - 60_000, // 1 minute ago - within grace period
        startedAt: now - 60_000,
        // No endedAt - still running
      });

      const result = recoverOrphanedSubagentRuns(runs);
      expect(result.recovered).toBe(0);
      expect(runs.has("run-1")).toBe(true);
    });

    it("should mark runs older than max age as orphaned", () => {
      const runs = new Map<string, SubagentRunRecord>();
      const now = Date.now();

      runs.set("run-1", {
        runId: "run-1",
        childSessionKey: "agent:main:subagent:abc",
        requesterSessionKey: "agent:main",
        requesterDisplayKey: "main",
        task: "test task",
        cleanup: "delete",
        createdAt: now - thresholds.maxAgeMs - 1, // Older than max age
        startedAt: now - thresholds.maxAgeMs - 1,
        // No endedAt - stuck running
      });

      const result = recoverOrphanedSubagentRuns(runs);
      expect(result.recovered).toBe(1);
      expect(runs.has("run-1")).toBe(false);
    });

    it("should not mark runs that have ended as orphaned", () => {
      const runs = new Map<string, SubagentRunRecord>();
      const now = Date.now();

      runs.set("run-1", {
        runId: "run-1",
        childSessionKey: "agent:main:subagent:abc",
        requesterSessionKey: "agent:main",
        requesterDisplayKey: "main",
        task: "test task",
        cleanup: "delete",
        createdAt: now - thresholds.maxAgeMs - 1,
        startedAt: now - thresholds.maxAgeMs - 1,
        endedAt: now - 1000, // Already ended - should not be marked
        outcome: { status: "ok" },
      });

      const result = recoverOrphanedSubagentRuns(runs);
      expect(result.recovered).toBe(0);
      expect(runs.has("run-1")).toBe(true);
    });

    it("should handle empty runs map", () => {
      const runs = new Map<string, SubagentRunRecord>();
      const result = recoverOrphanedSubagentRuns(runs);
      expect(result.recovered).toBe(0);
    });

    it("should mark multiple orphaned runs", () => {
      const runs = new Map<string, SubagentRunRecord>();
      const now = Date.now();
      const oldTime = now - thresholds.maxAgeMs - 1;

      // Set gateway started before all runs
      resetGatewayStartedAtForTest(oldTime - 1000);

      runs.set("run-1", {
        runId: "run-1",
        childSessionKey: "agent:main:subagent:abc",
        requesterSessionKey: "agent:main",
        requesterDisplayKey: "main",
        task: "test task",
        cleanup: "delete",
        createdAt: oldTime,
        startedAt: oldTime,
      });

      runs.set("run-2", {
        runId: "run-2",
        childSessionKey: "agent:main:subagent:def",
        requesterSessionKey: "agent:main",
        requesterDisplayKey: "main",
        task: "test task 2",
        cleanup: "delete",
        createdAt: oldTime,
        startedAt: oldTime,
      });

      // Add a valid run in grace period (created after gateway start)
      runs.set("run-3", {
        runId: "run-3",
        childSessionKey: "agent:main:subagent:ghi",
        requesterSessionKey: "agent:main",
        requesterDisplayKey: "main",
        task: "test task 3",
        cleanup: "delete",
        createdAt: now - 60_000,
        startedAt: now - 60_000,
      });

      const result = recoverOrphanedSubagentRuns(runs);
      expect(result.recovered).toBe(2);
      expect(runs.size).toBe(1);
      expect(runs.has("run-3")).toBe(true);
    });
  });

  describe("getOrphanDetectionThresholds", () => {
    it("should return valid thresholds", () => {
      const thresholds = getOrphanDetectionThresholds();
      expect(thresholds.maxAgeMs).toBe(24 * 60 * 60 * 1000); // 24 hours
      expect(thresholds.gracePeriodMs).toBe(5 * 60 * 1000); // 5 minutes
      expect(thresholds.gatewayRestartGracePeriodMs).toBe(30 * 1000); // 30 seconds
    });
  });

  describe("gateway restart orphan detection", () => {
    it("should mark runs created before gateway start as orphaned after grace period", () => {
      const runs = new Map<string, SubagentRunRecord>();
      const now = Date.now();

      // Simulate gateway started 1 minute ago
      const gatewayStartedAt = now - 60_000;
      resetGatewayStartedAtForTest(gatewayStartedAt);

      // Run was created 5 minutes ago (before gateway started)
      const runCreatedAt = now - 5 * 60_000;

      runs.set("run-restart-orphan", {
        runId: "run-restart-orphan",
        childSessionKey: "agent:main:subagent:abc",
        requesterSessionKey: "agent:main",
        requesterDisplayKey: "main",
        task: "interrupted task",
        cleanup: "delete",
        createdAt: runCreatedAt,
        startedAt: runCreatedAt,
        // No endedAt - stuck because gateway restarted
      });

      const result = recoverOrphanedSubagentRuns(runs);
      expect(result.recovered).toBe(1);
      expect(result.reasons.get("run-restart-orphan")).toBe("gateway-restart-orphaned");
      expect(runs.has("run-restart-orphan")).toBe(false);
    });

    it("should not mark runs created before gateway start during grace period", () => {
      const runs = new Map<string, SubagentRunRecord>();
      const now = Date.now();

      // Gateway just started 10 seconds ago (within 30 second grace period)
      const gatewayStartedAt = now - 10_000;
      resetGatewayStartedAtForTest(gatewayStartedAt);

      // Run was created 5 minutes ago (before gateway started)
      const runCreatedAt = now - 5 * 60_000;

      runs.set("run-grace", {
        runId: "run-grace",
        childSessionKey: "agent:main:subagent:abc",
        requesterSessionKey: "agent:main",
        requesterDisplayKey: "main",
        task: "recent interrupted task",
        cleanup: "delete",
        createdAt: runCreatedAt,
        startedAt: runCreatedAt,
      });

      const result = recoverOrphanedSubagentRuns(runs);
      // Should NOT be orphaned because within gateway restart grace period (30 seconds)
      expect(result.recovered).toBe(0);
      expect(runs.has("run-grace")).toBe(true);
    });

    it("should not mark runs created after gateway start within grace period", () => {
      const runs = new Map<string, SubagentRunRecord>();
      const now = Date.now();

      // Gateway started 10 minutes ago
      const gatewayStartedAt = now - 10 * 60_000;
      resetGatewayStartedAtForTest(gatewayStartedAt);

      // Run was created 2 minutes ago (after gateway started, within 5 minute grace period)
      const runCreatedAt = now - 2 * 60_000;

      runs.set("run-new", {
        runId: "run-new",
        childSessionKey: "agent:main:subagent:abc",
        requesterSessionKey: "agent:main",
        requesterDisplayKey: "main",
        task: "new task",
        cleanup: "delete",
        createdAt: runCreatedAt,
        startedAt: runCreatedAt,
      });

      const result = recoverOrphanedSubagentRuns(runs);
      // Should not be orphaned because it's within normal grace period (5 minutes)
      expect(result.recovered).toBe(0);
      expect(runs.has("run-new")).toBe(true);
    });
  });
});
