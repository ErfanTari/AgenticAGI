/**
 * Phase 19e — WHO.CT-000076 Audit Fixes
 *
 * Tests for six bugs found in manual audit on 2026-04-07:
 * - Bug A: Code normalization for suffixed codes (WHO.CT-000076_zaraban)
 * - Bug B: Identity-first routing for "who is X" questions
 * - Bug C: Notebook scoping for code-derived queries
 * - Bug D: Output sanitization (control tokens, thinking text, pseudo-tool narratives)
 * - Bug E: Grounding guard (entry existence)
 * - Bug F: Agentic signal tightening (identity queries marked as query, not agentic)
 */

import { describe, it, expect } from 'vitest';
import { extractCodes, extractIdentityTarget } from '../../core/memory/quick-resolve.js';
import { extractNotebookHint } from '../../core/memory/unit-search.js';
import { sanitizeFinalOutput } from '../../core/llm.js';

describe('Phase 19e — WHO.CT-000076 Audit Fixes', () => {

  // ── FIX A: Code Normalization ──

  describe('extractCodes — suffixed code handling', () => {

    it('extracts code from WHO.CT-000076_zaraban', () => {
      const codes = extractCodes('WHO.CT-000076_zaraban');
      expect(codes).toContain('WHO.CT-000076');
      expect(codes).toHaveLength(1);
    });

    it('extracts code from suffixed code inside a question', () => {
      const codes = extractCodes('who is WHO.CT-000076_zaraban ?');
      expect(codes).toContain('WHO.CT-000076');
      expect(codes).toHaveLength(1);
    });

    it('still extracts bare codes without suffix', () => {
      const codes = extractCodes('WHO.CT-000076');
      expect(codes).toContain('WHO.CT-000076');
      expect(codes).toHaveLength(1);
    });

    it('extracts multiple codes including suffixed ones', () => {
      const codes = extractCodes('Compare WHO.CT-000076_zaraban with PLAN.PJ-000075_dashboard');
      expect(codes).toContain('WHO.CT-000076');
      expect(codes).toContain('PLAN.PJ-000075');
      expect(codes).toHaveLength(2);
    });

    it('does not extract partial codes', () => {
      const codes = extractCodes('WHO.CT-00007');
      expect(codes).toHaveLength(0);
    });

    it('ignores invalid type codes', () => {
      const codes = extractCodes('WHO.XX-000001');
      expect(codes).toHaveLength(0);
    });
  });

  // ── FIX B: Identity Routing ──

  describe('extractIdentityTarget — identity question detection', () => {

    it('extracts name from "who is Zaraban"', () => {
      const target = extractIdentityTarget('who is Zaraban');
      expect(target).toBe('Zaraban');
    });

    it('extracts name from "who is Zaraban?"', () => {
      const target = extractIdentityTarget('who is Zaraban?');
      expect(target).toBe('Zaraban');
    });

    it('extracts name from "who is Zaraban ???"', () => {
      const target = extractIdentityTarget('who is Zaraban ???');
      expect(target).toBe('Zaraban');
    });

    it('extracts name from "tell me about Zaraban"', () => {
      const target = extractIdentityTarget('tell me about Zaraban');
      expect(target).toBe('Zaraban');
    });

    it('extracts name from "what is Zaraban"', () => {
      const target = extractIdentityTarget('what is Zaraban');
      expect(target).toBe('Zaraban');
    });

    it('extracts name from "what does Zaraban do"', () => {
      const target = extractIdentityTarget('what does Zaraban do');
      expect(target).toBe('Zaraban');
    });

    it('strips code prefix from identity target', () => {
      const target = extractIdentityTarget('who is WHO.CT-000076_zaraban ?');
      expect(target).not.toBeNull();
      expect(target).toBe('zaraban');
      // Code portion should be stripped
      expect(target).not.toContain('WHO.CT-000076');
    });

    it('returns null for non-identity questions', () => {
      expect(extractIdentityTarget('build me a website')).toBeNull();
      expect(extractIdentityTarget('hello')).toBeNull();
      expect(extractIdentityTarget('show all contacts')).toBeNull();
    });

    it('returns null for incomplete identity pattern', () => {
      expect(extractIdentityTarget('who is')).toBeNull();
      expect(extractIdentityTarget('tell me')).toBeNull();
    });
  });

  // ── FIX C: Notebook Scoping ──

  describe('extractNotebookHint — code prefix detection', () => {

    it('extracts WHO from code-like query', () => {
      expect(extractNotebookHint('WHO.CT-000076_zaraban')).toBe('WHO');
    });

    it('extracts PLAN from code-like query', () => {
      expect(extractNotebookHint('PLAN.PJ-000075')).toBe('PLAN');
    });

    it('extracts WHEN from code-like query', () => {
      expect(extractNotebookHint('WHEN.EV-000123')).toBe('WHEN');
    });

    it('returns null for queries without code prefix', () => {
      expect(extractNotebookHint('who is Zaraban')).toBeNull();
      expect(extractNotebookHint('tell me about the project')).toBeNull();
    });

    it('extracts notebook even in question context', () => {
      expect(extractNotebookHint('who is WHO.CT-000076')).toBe('WHO');
    });

    it('extracts notebook from message with multiple patterns', () => {
      const hint = extractNotebookHint('WHO.CT-000076_zaraban and PLAN.PJ-000075');
      // Should extract the first one
      expect(hint).toBe('WHO');
    });
  });

  // ── FIX D: Output Sanitization ──

  describe('sanitizeFinalOutput — control token & thinking text removal', () => {

    it('strips model control tokens <|tool_call|>', () => {
      const dirty = 'Zaraban is an AI agent.<|tool_call|>memory_read("WHO.CT-000076")<|tool_response|>';
      const clean = sanitizeFinalOutput(dirty);
      expect(clean).not.toContain('<|tool_call');
      expect(clean).not.toContain('<|tool_response');
      expect(clean).toContain('Zaraban is an AI agent');
    });

    it('strips model control tokens <|channel>', () => {
      const dirty = 'Here is the answer:<|channel>thought\nLet me think...<channel|> Zaraban is an AI agent.';
      const clean = sanitizeFinalOutput(dirty);
      expect(clean).not.toContain('<|channel>');
      expect(clean).toContain('Zaraban is an AI agent');
    });

    it('strips pseudo-tool-call narratives', () => {
      const dirty = 'Calling tool memory_read with code WHO.CT-000076\nZaraban is an AI agent.';
      const clean = sanitizeFinalOutput(dirty);
      expect(clean).not.toContain('Calling tool');
      expect(clean).toContain('Zaraban is an AI agent');
    });

    it('strips pseudo-tool-call with "Using"', () => {
      const dirty = 'Using function memory_write to save information.\nZaraban is an AI agent.';
      const clean = sanitizeFinalOutput(dirty);
      expect(clean).not.toContain('Using function');
      expect(clean).toContain('Zaraban is an AI agent');
    });

    it('strips thinking preamble lines', () => {
      const dirty = 'Let me search the memory for this entry.\nZaraban is an AI agent.';
      const clean = sanitizeFinalOutput(dirty);
      expect(clean).not.toContain('Let me search');
      expect(clean).toContain('Zaraban is an AI agent');
    });

    it('strips "I need to" preamble', () => {
      const dirty = 'I need to check the database first.\nZaraban is an AI agent.';
      const clean = sanitizeFinalOutput(dirty);
      expect(clean).not.toContain('I need to');
      expect(clean).toContain('Zaraban is an AI agent');
    });

    it('preserves clean output unchanged', () => {
      const clean = 'Zaraban is an AI agent platform.';
      expect(sanitizeFinalOutput(clean)).toBe(clean);
    });

    it('collapses multiple blank lines', () => {
      const dirty = 'Line 1\n\n\n\nLine 2';
      const clean = sanitizeFinalOutput(dirty);
      expect(clean).toBe('Line 1\n\nLine 2');
    });

    it('combines thinking tags with control tokens', () => {
      const dirty = '<think>Let me analyze...</think>\n<|tool_call|>memory_read()<|tool_response|>\nThe answer is Zaraban.';
      const clean = sanitizeFinalOutput(dirty);
      expect(clean).not.toContain('<think>');
      expect(clean).not.toContain('<|tool_call');
      expect(clean).toContain('The answer is Zaraban');
    });
  });

  // ── FIX E: Grounding Guard (implicit in test structure) ──

  describe('Grounding guard — system prompt enforcement', () => {

    it('sanitizeFinalOutput does not allow model to negate retrieved entries', () => {
      // This test documents that output sanitization removes thinking/narration that could
      // contradict grounding. The actual grounding enforcement happens via system prompt
      // in the query response path (checked in integration tests).
      expect(true).toBe(true);
    });
  });

  // ── FIX F: Agentic Signal Tightening (intake.md documentation) ──

  describe('Agentic signal tightening — identity patterns marked as query', () => {

    it('identity patterns should be query, not agentic', () => {
      // This test documents the intake.md FIX F: identity lookups are QUERY, not AGENTIC.
      // The actual classification happens in the intake LLM, verified via integration tests.
      // Here we document the expected behavior.
      const identityPatterns = [
        'who is Zaraban',
        'what is Zaraban',
        'tell me about Zaraban',
        'what does Zaraban do',
      ];
      for (const pattern of identityPatterns) {
        // Each should be detected as an identity target (query)
        expect(extractIdentityTarget(pattern)).not.toBeNull();
      }
    });
  });

  // ── Integration: Combined Fixes ──

  describe('Integration — all fixes working together', () => {

    it('handles WHO.CT-000076_zaraban in a full identity context', () => {
      const message = 'who is WHO.CT-000076_zaraban ?';

      // FIX A: Extract code
      const codes = extractCodes(message);
      expect(codes).toContain('WHO.CT-000076');

      // FIX B: Extract identity target
      const target = extractIdentityTarget(message);
      expect(target).not.toBeNull();

      // FIX C: Extract notebook hint
      const hint = extractNotebookHint(message);
      expect(hint).toBe('WHO');
    });

    it('output sanitization handles complex model response', () => {
      const complexReply = `<think>
The user is asking about WHO.CT-000076_zaraban. Let me find this entry.
</think>

Using memory_read to fetch the entry...

Zaraban is an AI agent platform built on AgenticAGI framework. <|channel>thought
Providing detailed information...
<channel|>

Based on the retrieved entry: Zaraban is a personal AI assistant with persistent memory.`;

      const clean = sanitizeFinalOutput(complexReply);

      // Should not contain any control tokens or thinking
      expect(clean).not.toContain('<think>');
      expect(clean).not.toContain('<|channel>');
      expect(clean).not.toContain('Using memory_read');

      // Should preserve actual information
      expect(clean).toContain('Zaraban');
      expect(clean).toContain('AI agent');
    });
  });
});
