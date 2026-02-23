import { memoryReadSkill } from './memory_read.js';
import { memoryWriteSkill } from './memory_write.js';
// Import MCP skill defaults
import calculatorSkill from './tools/calculator.js';
import fileReaderSkill from './tools/file_reader.js';
import webSearchSkill from './tools/web_search.js';
// --- MCP Skill Registry (Map-based) ---
const registry = new Map();
export function registerSkill(skill) {
    registry.set(skill.name, skill);
}
export function getSkill(name) {
    return registry.get(name);
}
export function getAllSkills() {
    return [...registry.values()];
}
export function getSkillDescriptions() {
    return getAllSkills()
        .map(s => `${s.name}: ${s.description}`)
        .join('\n');
}
// Register built-in skills once, after all imports resolved
registerSkill(calculatorSkill);
registerSkill(fileReaderSkill);
registerSkill(webSearchSkill);
// --- Legacy skill loading (used by context builder) ---
const ALL_SKILLS = [memoryReadSkill, memoryWriteSkill];
export function getSkillsForIntent(intent) {
    return ALL_SKILLS.filter(skill => skill.intents.includes(intent));
}
