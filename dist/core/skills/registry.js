import { LEVEL_RANK } from '../permission.js';
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
import generateAndSaveFileSkill from './tools/generate_and_save_file.js';
import patchFileSkill from './tools/patch_file.js';
import grepWorkspaceSkill from './tools/grep_workspace.js';
import listDirSkill from './tools/list_dir.js';
import globSkill from './tools/glob.js';
import confirmPlanSkill from './tools/confirm_plan.js';
import { requestUserInputSkill } from './tools/request_user_input.js';
import { requestPermissionSkill } from './tools/request_permission.js';
import skillSchemaSkill from './tools/skill_schema.js';
import taskTrackerSkill from './tools/task_tracker.js';
// --- MCP Skill Registry (Map-based) ---
const registry = new Map();
let _frozen = false;
export function registerSkill(skill) {
    if (_frozen) {
        console.warn(`[registry] Attempted to register '${skill.name}' after registry was frozen. Ignored.`);
        return;
    }
    registry.set(skill.name, skill);
}
function freezeRegistry() {
    _frozen = true;
}
export function _resetRegistry() {
    registry.clear();
    _frozen = false;
}
// Lift the freeze without clearing built-in skills — for tests that only need to add a test skill
export function _unfreezeRegistry() {
    _frozen = false;
}
export function getSkill(name) {
    return registry.get(name);
}
export function getAllSkills() {
    return [...registry.values()];
}
function placeholderValue(property) {
    if (property.enum && property.enum.length > 0) {
        return property.enum[0];
    }
    switch (property.type) {
        case 'number':
        case 'integer':
            return 1;
        case 'boolean':
            return true;
        case 'array':
            return [];
        case 'object':
            return {};
        case 'string':
        default:
            return '<string>';
    }
}
function buildSkillSchemaExample(skill) {
    const entries = Object.entries(skill.inputSchema.properties);
    const required = new Set(skill.inputSchema.required);
    const exampleEntries = entries.filter(([name]) => required.has(name));
    const source = exampleEntries.length > 0 ? exampleEntries : entries.slice(0, 2);
    const input = Object.fromEntries(source.map(([name, property]) => [name, placeholderValue(property)]));
    return JSON.stringify({ action: skill.name, input });
}
export function getSkillDescriptions() {
    return formatSkillList(getAllSkills());
}
/** One-liner list: "name — first sentence of description" per line. ~300 tokens for full registry. */
export function getSkillOneLinerList(mode, opts) {
    const memoryEnabled = opts?.memoryEnabled !== false;
    const lines = [];
    for (const skill of registry.values()) {
        if (!memoryEnabled && MEMORY_SKILL_NAMES.has(skill.name))
            continue;
        const firstSentence = skill.description.split(/\.\s+/)[0].replace(/\.$/, '');
        if (LEVEL_RANK[skill.permissionLevel] <= LEVEL_RANK[mode]) {
            lines.push(`${skill.name} — ${firstSentence}`);
        }
        else {
            // Show locked skills so model knows they exist and can request_permission
            lines.push(`${skill.name} — ${firstSentence} [requires ${skill.permissionLevel} — call request_permission to unlock]`);
        }
    }
    return lines.join('\n');
}
/** Compact format: name + description + required params only. No JSON examples. ~half the full format size. */
export function getSkillCompactDescriptions(mode, opts) {
    return getSkillsByPermission(mode, opts)
        .map(skill => {
        const req = skill.inputSchema.required.join(', ');
        const opt = Object.keys(skill.inputSchema.properties)
            .filter(k => !skill.inputSchema.required.includes(k))
            .join(', ');
        return [
            `${skill.name}: ${skill.description}`,
            req ? `  Required: ${req}` : null,
            opt ? `  Optional: ${opt}` : null,
        ].filter(Boolean).join('\n');
    })
        .join('\n\n');
}
const MEMORY_SKILL_NAMES = new Set(['memory_read', 'memory_write', 'relationship_write', 'memory_history']);
export function getSkillsByPermission(mode, opts) {
    const memoryEnabled = opts?.memoryEnabled !== false;
    const allowed = [];
    for (const skill of registry.values()) {
        if (LEVEL_RANK[skill.permissionLevel] <= LEVEL_RANK[mode]) {
            if (!memoryEnabled && MEMORY_SKILL_NAMES.has(skill.name))
                continue;
            allowed.push(skill);
        }
    }
    return allowed;
}
export function getSkillDescriptionsForPermission(mode, opts) {
    return formatSkillList(getSkillsByPermission(mode, opts));
}
function formatSkillList(skills) {
    return skills
        .map(skill => {
        const optionalFields = Object.keys(skill.inputSchema.properties)
            .filter(name => !skill.inputSchema.required.includes(name));
        const optionalLine = optionalFields.length > 0
            ? `\nOptional fields: ${optionalFields.join(', ')}`
            : '';
        return [
            `${skill.name}: ${skill.description}`,
            `Schema: ${buildSkillSchemaExample(skill)}`,
            optionalLine.trim(),
        ].filter(Boolean).join('\n');
    })
        .join('\n\n');
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
registerSkill(generateAndSaveFileSkill);
registerSkill(patchFileSkill);
registerSkill(grepWorkspaceSkill);
registerSkill(listDirSkill);
registerSkill(globSkill);
registerSkill(confirmPlanSkill);
registerSkill(requestUserInputSkill);
registerSkill(requestPermissionSkill);
registerSkill(skillSchemaSkill);
registerSkill(taskTrackerSkill);
// Freeze the registry after all built-in skills are registered
freezeRegistry();
// --- Legacy skill loading (used by context builder) ---
const ALL_SKILLS = [memoryReadSkill, memoryWriteSkill];
export function getSkillsForIntent(intent) {
    return ALL_SKILLS.filter(skill => skill.intents.includes(intent));
}
