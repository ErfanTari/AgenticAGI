import { memoryReadSkill } from './memory_read.js';
import { memoryWriteSkill } from './memory_write.js';
import { registerSkill, getSkill, getAllSkills, getSkillDescriptions, } from './store.js';
// Built-in MCP skills self-register via store.
import './tools/calculator.js';
import './tools/file_reader.js';
import './tools/file_writer.js';
import './tools/web_fetch.js';
import './tools/web_search.js';
import './tools/shell_runner.js';
import './tools/task_planner.js';
import './tools/log_analyzer.js';
import './tools/code_editor.js';
export { registerSkill, getSkill, getAllSkills, getSkillDescriptions };
// --- Legacy skill loading (used by context builder) ---
const ALL_SKILLS = [memoryReadSkill, memoryWriteSkill];
export function getSkillsForIntent(intent) {
    return ALL_SKILLS.filter(skill => skill.intents.includes(intent));
}
