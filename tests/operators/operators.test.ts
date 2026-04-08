/**
 * Tests for operator commands: /cost, /doctor, /context
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getCostReport, formatCostReport } from '../../core/operators/cost.js';
import { runHealthCheck, formatHealthCheck } from '../../core/operators/doctor.js';
import { captureContextSnapshot, formatContextSnapshot } from '../../core/operators/context.js';
import { PATHS } from '../../config/agent.config.js';
import { initDatabase } from '../../core/memory/mod.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(__dirname, `tmp-operators-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'index'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'workspace'), { recursive: true });

  // Override PATHS for this test
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'index', 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  (PATHS as Record<string, string>).workspace = path.join(tmpDir, 'workspace');
  (PATHS as Record<string, string>).index = path.join(tmpDir, 'index');

  // Initialize database for tests
  initDatabase();
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('Operator commands', () => {

  describe('/cost operator', () => {

    it('T1: getCostReport returns valid structure', () => {
      const report = getCostReport();
      expect(report).toHaveProperty('sessionTokensUsed');
      expect(report).toHaveProperty('estimatedCost');
      expect(report).toHaveProperty('modelUsed');
      expect(report).toHaveProperty('turnCount');
      expect(report).toHaveProperty('averageTokensPerTurn');
    });

    it('T2: getCostReport has non-negative values', () => {
      const report = getCostReport();
      expect(report.sessionTokensUsed).toBeGreaterThanOrEqual(0);
      expect(report.estimatedCost).toBeGreaterThanOrEqual(0);
      expect(report.turnCount).toBeGreaterThanOrEqual(0);
      expect(report.averageTokensPerTurn).toBeGreaterThanOrEqual(0);
    });

    it('T3: formatCostReport produces readable output', () => {
      const report = getCostReport();
      const formatted = formatCostReport(report);
      expect(formatted).toContain('Cost Report');
      expect(formatted).toContain('Model:');
      expect(formatted).toContain('tokens');
      expect(formatted).toMatch(/\$\d+\.\d{4}/); // Dollar amount with 4 decimals
    });

  });

  describe('/doctor operator', () => {

    it('T4: runHealthCheck returns valid structure', () => {
      const health = runHealthCheck();
      expect(health).toHaveProperty('databaseOK');
      expect(health).toHaveProperty('memoryDirOK');
      expect(health).toHaveProperty('workspaceDirOK');
      expect(health).toHaveProperty('indexDirOK');
      expect(health).toHaveProperty('entryCount');
      expect(health).toHaveProperty('relationshipCount');
      expect(health).toHaveProperty('recentErrors');
    });

    it('T5: runHealthCheck verifies database connectivity', () => {
      const health = runHealthCheck();
      expect(typeof health.databaseOK).toBe('boolean');
      // After init, database should be OK
      expect(health.databaseOK).toBe(true);
    });

    it('T6: runHealthCheck verifies directory existence', () => {
      const health = runHealthCheck();
      expect(health.memoryDirOK).toBe(true);
      expect(health.workspaceDirOK).toBe(true);
      expect(health.indexDirOK).toBe(true);
    });

    it('T7: formatHealthCheck produces readable output', () => {
      const health = runHealthCheck();
      const formatted = formatHealthCheck(health);
      expect(formatted).toContain('System Health Check');
      expect(formatted).toContain('Database:');
      expect(formatted).toContain('entries');
      expect(formatted.includes('✓') || formatted.includes('✗')).toBe(true);
    });

    it('T8: formatHealthCheck lists recent errors when present', () => {
      const health = runHealthCheck();
      const formatted = formatHealthCheck(health);
      if (health.recentErrors.length > 0) {
        expect(formatted).toContain('Issues found');
      } else {
        expect(formatted).toContain('All systems operational');
      }
    });

  });

  describe('/context operator', () => {

    it('T9: captureContextSnapshot returns valid structure', () => {
      const snapshot = captureContextSnapshot();
      expect(snapshot).toHaveProperty('activeSessions');
      expect(snapshot).toHaveProperty('totalEntries');
      expect(snapshot).toHaveProperty('entriesByNotebook');
      expect(snapshot).toHaveProperty('recentEntries');
    });

    it('T10: captureContextSnapshot has non-negative counts', () => {
      const snapshot = captureContextSnapshot();
      expect(snapshot.activeSessions).toBeGreaterThanOrEqual(0);
      expect(snapshot.totalEntries).toBeGreaterThanOrEqual(0);
    });

    it('T11: captureContextSnapshot groups entries by notebook', () => {
      const snapshot = captureContextSnapshot();
      expect(typeof snapshot.entriesByNotebook).toBe('object');
      // Entries by notebook should be non-negative
      for (const count of Object.values(snapshot.entriesByNotebook)) {
        expect(count).toBeGreaterThanOrEqual(0);
      }
    });

    it('T12: recentEntries array is valid', () => {
      const snapshot = captureContextSnapshot();
      expect(Array.isArray(snapshot.recentEntries)).toBe(true);
      for (const entry of snapshot.recentEntries) {
        expect(entry).toHaveProperty('code');
        expect(entry).toHaveProperty('name');
        expect(entry).toHaveProperty('updated');
        expect(entry).toHaveProperty('status');
      }
    });

    it('T13: formatContextSnapshot produces readable output', () => {
      const snapshot = captureContextSnapshot();
      const formatted = formatContextSnapshot(snapshot);
      expect(formatted).toContain('Memory Context Snapshot');
      expect(formatted).toContain('entries');
      expect(formatted).toContain('Entries by notebook');
    });

    it('T14: formatContextSnapshot includes notebook section', () => {
      const snapshot = captureContextSnapshot();
      const formatted = formatContextSnapshot(snapshot);
      // Should contain the "Entries by notebook" header even if no entries
      expect(formatted).toContain('Entries by notebook');
    });

  });

});
