import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAgentCard, updateAgentCard } from '../../core/agent-card.js';
import { getAllSkills } from '../../core/skills/registry.js';

describe('Priority 6: A2A Agent Card', () => {
  it('P6A: agent-card.json exists at project root', () => {
    const cardPath = path.join(process.cwd(), 'agent-card.json');
    expect(fs.existsSync(cardPath)).toBe(true);
  });

  it('P6B: getAgentCard returns valid JSON with required fields', () => {
    const card = getAgentCard();
    expect(card.name).toBe('AgenticAGI');
    expect(typeof card.version).toBe('string');
    expect(typeof card.description).toBe('string');
    expect(typeof card.endpoint).toBe('string');
    expect(card.protocol).toBe('a2a/1.0');
    expect(card.capabilities).toBeDefined();
    expect(card.identity).toBeDefined();
  });

  it('P6C: capabilities.memory has required fields', () => {
    const card = getAgentCard();
    expect(Array.isArray(card.capabilities.memory.notebooks)).toBe(true);
    expect(card.capabilities.memory.notebooks).toContain('WHO');
    expect(card.capabilities.memory.notebooks).toContain('HOW');
    expect(card.capabilities.memory.versioned).toBe(true);
    expect(card.capabilities.memory.hybrid_search).toBe(true);
  });

  it('P6D: updateAgentCard syncs skills list from registry', () => {
    updateAgentCard();
    const card = getAgentCard();
    const registeredSkills = getAllSkills().map(s => s.name);
    expect(Array.isArray(card.capabilities.skills)).toBe(true);
    // All registered skills should be in card
    for (const skill of registeredSkills) {
      expect(card.capabilities.skills).toContain(skill);
    }
  });

  it('P6E: memory_history skill is in registry', () => {
    const skills = getAllSkills();
    const names = skills.map(s => s.name);
    expect(names).toContain('memory_history');
  });

  it('P6F: agent card planning section has correct values', () => {
    const card = getAgentCard();
    expect(card.capabilities.planning.max_steps).toBe(8);
    expect(card.capabilities.planning.retry).toBe(true);
    expect(card.capabilities.planning.verification).toBe(true);
    expect(card.capabilities.planning.episodic_memory).toBe(true);
  });

  it('P6G: identity.local_first is true', () => {
    const card = getAgentCard();
    expect(card.identity.local_first).toBe(true);
  });
});
