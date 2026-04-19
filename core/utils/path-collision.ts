import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ResolveOptions {
  overwrite?: boolean;
  maxAttempts?: number; // default 999
}

export interface ResolveResult {
  finalPath: string;
  renamed: boolean;
  originalPath: string;
}

export function resolveCollision(
  targetPath: string,
  opts: ResolveOptions = {},
): ResolveResult {
  const { overwrite = false, maxAttempts = 999 } = opts;

  if (overwrite) {
    return { finalPath: targetPath, renamed: false, originalPath: targetPath };
  }

  if (!fs.existsSync(targetPath)) {
    return { finalPath: targetPath, renamed: false, originalPath: targetPath };
  }

  const parsed = path.parse(targetPath);
  const stem = parsed.name;
  const ext = parsed.ext;
  const dir = parsed.dir;

  for (let i = 2; i <= maxAttempts; i++) {
    const candidate = path.join(dir, `${stem}-${i}${ext}`);
    if (!fs.existsSync(candidate)) {
      return { finalPath: candidate, renamed: true, originalPath: targetPath };
    }
  }

  throw new Error(`Could not resolve collision for ${targetPath} after ${maxAttempts} attempts`);
}
