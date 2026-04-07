import type { PermissionLevel } from './skills/types.js';

export const LEVEL_RANK: Record<PermissionLevel, number> = {
  'read-only': 0,
  'workspace-write': 1,
  'full-access': 2,
};

export function enforcePermission(
  skillName: string,
  requiredLevel: PermissionLevel,
  activeMode: PermissionLevel,
): { allowed: boolean; error?: string } {
  if (LEVEL_RANK[requiredLevel] <= LEVEL_RANK[activeMode]) {
    return { allowed: true };
  }
  return {
    allowed: false,
    error: `Permission denied: skill '${skillName}' requires '${requiredLevel}' but active mode is '${activeMode}'`,
  };
}

export function getActivePermissionMode(): PermissionLevel {
  const mode = process.env.PERMISSION_MODE ?? 'workspace-write';
  if (mode === 'read-only' || mode === 'workspace-write' || mode === 'full-access') {
    return mode;
  }
  console.warn(`[permission] Unknown PERMISSION_MODE '${mode}', defaulting to workspace-write`);
  return 'workspace-write';
}
