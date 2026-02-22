import type { MCPSkill } from './types.js';

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
    .map(skill => `${skill.name}: ${skill.description}`)
    .join('\n');
}
