import { memoryReadSkill } from './memory_read.js';
import { memoryWriteSkill } from './memory_write.js';
const ALL_SKILLS = [memoryReadSkill, memoryWriteSkill];
export function getSkillsForIntent(intent) {
    return ALL_SKILLS.filter(skill => skill.intents.includes(intent));
}
