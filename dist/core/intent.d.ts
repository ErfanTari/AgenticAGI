import type { Classification } from './types.js';
import { getSkillDescriptions } from './skills/registry.js';
export { getSkillDescriptions };
export declare function classifyIntent(message: string): Classification;
