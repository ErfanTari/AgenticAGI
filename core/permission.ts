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
  // Also check session-approved levels
  if (_sessionApprovedLevels.has(requiredLevel)) {
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

// Session-scoped auto-approvals: populated by "Yes to All" responses.
// Any level in this set is allowed for the remainder of the process lifetime.
const _sessionApprovedLevels = new Set<PermissionLevel>();

export function sessionApproveLevel(level: PermissionLevel): void {
  _sessionApprovedLevels.add(level);
  // Approving a higher level implicitly covers lower ones
  if (LEVEL_RANK[level] >= LEVEL_RANK['full-access']) {
    _sessionApprovedLevels.add('workspace-write');
    _sessionApprovedLevels.add('read-only');
  } else if (LEVEL_RANK[level] >= LEVEL_RANK['workspace-write']) {
    _sessionApprovedLevels.add('read-only');
  }
}

export function isSessionApproved(level: PermissionLevel): boolean {
  return _sessionApprovedLevels.has(level);
}

export function clearSessionApprovals(): void {
  _sessionApprovedLevels.clear();
}
