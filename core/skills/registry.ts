import type { Intent } from '../types.js';
import type { Skill, MCPSkill } from './types.js';
import { memoryReadSkill } from './memory_read.js';
import { memoryWriteSkill } from './memory_write.js';

// --- MCP Skill Registry (Map-based) ---

const registry = new Map<string, MCPSkill>();

export function registerSkill(skill: MCPSkill): void {
  registry.set(skill.name, skill);
}

export function getSkill(name: string): MCPSkill | undefined {
  return registry.get(name);
}

export function getAllSkills(): MCPSkill[] {
  return [...registry.values()];
}

export function getSkillDescriptions(): string {
  return getAllSkills()
    .map(s => `${s.name}: ${s.description}`)
    .join('\n');
}

// --- Legacy skill loading (used by context builder) ---

const ALL_SKILLS: Skill[] = [memoryReadSkill, memoryWriteSkill];

export function getSkillsForIntent(intent: Intent): Skill[] {
  return ALL_SKILLS.filter(skill => skill.intents.includes(intent));
}
