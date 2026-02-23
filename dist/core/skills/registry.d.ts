import type { Intent } from '../types.js';
import type { Skill, MCPSkill } from './types.js';
export declare function registerSkill(skill: MCPSkill): void;
export declare function getSkill(name: string): MCPSkill | undefined;
export declare function getAllSkills(): MCPSkill[];
export declare function getSkillDescriptions(): string;
export declare function getSkillsForIntent(intent: Intent): Skill[];
