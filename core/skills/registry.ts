import type { Intent } from '../types.js';
import type { Skill } from './types.js';
import { memoryReadSkill } from './memory_read.js';
import { memoryWriteSkill } from './memory_write.js';

const ALL_SKILLS: Skill[] = [memoryReadSkill, memoryWriteSkill];

export function getSkillsForIntent(intent: Intent): Skill[] {
  return ALL_SKILLS.filter(skill => skill.intents.includes(intent));
}
