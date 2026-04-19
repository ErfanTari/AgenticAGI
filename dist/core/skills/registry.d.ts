import type { Intent } from '../types.js';
import type { Skill, MCPSkill, PermissionLevel } from './types.js';
export declare function registerSkill(skill: MCPSkill): void;
export declare function _resetRegistry(): void;
export declare function _unfreezeRegistry(): void;
export declare function getSkill(name: string): MCPSkill | undefined;
export declare function getAllSkills(): MCPSkill[];
export declare function getSkillDescriptions(): string;
/** One-liner list: "name — first sentence of description" per line. ~300 tokens for full registry. */
export declare function getSkillOneLinerList(mode: PermissionLevel, opts?: {
    memoryEnabled?: boolean;
}): string;
/** Compact format: name + description + required params only. No JSON examples. ~half the full format size. */
export declare function getSkillCompactDescriptions(mode: PermissionLevel, opts?: {
    memoryEnabled?: boolean;
}): string;
export declare function getSkillsByPermission(mode: PermissionLevel, opts?: {
    memoryEnabled?: boolean;
}): MCPSkill[];
export declare function getSkillDescriptionsForPermission(mode: PermissionLevel, opts?: {
    memoryEnabled?: boolean;
}): string;
export declare function getSkillsForIntent(intent: Intent): Skill[];
