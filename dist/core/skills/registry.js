import { memoryReadSkill } from './memory_read.js';
import { memoryWriteSkill } from './memory_write.js';
// Import MCP skill defaults
import calculatorSkill from './tools/calculator.js';
import fileReaderSkill from './tools/file_reader.js';
import webSearchSkill from './tools/web_search.js';
import { fileWriter } from './tools/file_writer.js';
import { runBash } from './tools/run_bash.js';
import memoryReadMCPSkill from './tools/memory_read.js';
import { memoryWriteMCPSkill } from './tools/memory_write.js';
import contentWriterSkill from './tools/content_writer.js';
import webFetchSkill from './tools/web_fetch.js';
import urlExtractSkill from './tools/url_extract.js';
import { relationshipWriteSkill } from './tools/relationship_write.js';
import { implementAndTestSkill } from './tools/implement_and_test.js';
import memoryHistorySkill from './tools/memory_history.js';
import verifyStateSkill from './tools/verify_state.js';
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
registerSkill(fileWriter);
registerSkill(runBash);
registerSkill(memoryReadMCPSkill);
registerSkill(memoryWriteMCPSkill);
registerSkill(contentWriterSkill);
registerSkill(webFetchSkill);
registerSkill(urlExtractSkill);
registerSkill(relationshipWriteSkill);
registerSkill(implementAndTestSkill);
registerSkill(memoryHistorySkill);
registerSkill(verifyStateSkill);
// --- Legacy skill loading (used by context builder) ---
const ALL_SKILLS = [memoryReadSkill, memoryWriteSkill];
export function getSkillsForIntent(intent) {
    return ALL_SKILLS.filter(skill => skill.intents.includes(intent));
}
