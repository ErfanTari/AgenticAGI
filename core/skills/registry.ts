import type { Intent } from '../types.js';
import type { Skill } from './types.js';
import { memoryReadSkill } from './memory_read.js';
import { memoryWriteSkill } from './memory_write.js';
import calculatorSkill from './tools/calculator.js';
import fileReaderSkill from './tools/file_reader.js';
import webSearchSkill from './tools/web_search.js';
import {
  registerSkill,
  getSkill as getSkillFromStore,
  getAllSkills as getAllSkillsFromStore,
} from './store.js';

// Register core Phase 6 skills at module load time.
registerSkill(calculatorSkill);
registerSkill(fileReaderSkill);
registerSkill(webSearchSkill);

// Extended tools continue self-registration for optional workflows.
import './tools/file_writer.js';
import './tools/web_fetch.js';
import './tools/shell_runner.js';
import './tools/task_planner.js';
import './tools/log_analyzer.js';
import './tools/code_editor.js';

const HIDDEN_DEFAULT_SKILL_NAMES = new Set([
  'file_writer',
  'web_fetch',
  'shell_runner',
  'task_planner',
  'log_analyzer',
  'code_editor',
]);

export { registerSkill };

export function getSkill(name: string) {
  return getSkillFromStore(name);
}

export function getAllSkills() {
  return getAllSkillsFromStore().filter(skill => !HIDDEN_DEFAULT_SKILL_NAMES.has(skill.name));
}

export function getSkillDescriptions(): string {
  return getAllSkills()
    .map(skill => `${skill.name}: ${skill.description}`)
    .join('\n');
}

// --- Legacy skill loading (used by context builder) ---

const ALL_SKILLS: Skill[] = [memoryReadSkill, memoryWriteSkill];

export function getSkillsForIntent(intent: Intent): Skill[] {
  return ALL_SKILLS.filter(skill => skill.intents.includes(intent));
}
