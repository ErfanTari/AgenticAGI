import type { Skill } from './types.js';

export const memoryWriteSkill: Skill = {
  name: 'memory_write',
  description: 'Create new memory entries or update existing ones. Supports all notebook types: contacts, projects, knowledge, events, todos, procedures, and more.',
  intents: ['memory_write'],
};
