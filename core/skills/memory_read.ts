import type { Skill } from './types.js';

export const memoryReadSkill: Skill = {
  name: 'memory_read',
  description: 'Fetch memory entries by code, query the index by notebook/type/status, or look up relationships between entries.',
  intents: ['code_fetch', 'memory_query', 'relationship_query'],
};
