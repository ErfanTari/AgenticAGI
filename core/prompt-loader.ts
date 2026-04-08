/**
 * PromptLoader — Phase 18
 *
 * Loads .md template files from the prompts/ directory, substitutes
 * {{variable}} placeholders, and caches raw file contents.
 *
 * Design rules:
 *  - Cache stores raw file content (keyed by template name).
 *  - Substitution is NOT cached — vars differ per call.
 *  - Missing vars are left as-is (no throw on unresolved placeholders).
 *  - load() throws if the .md file does not exist.
 *  - Sync reads only (templates are small, read at call time).
 */

import fs from 'node:fs';
import path from 'node:path';

export type TemplateVars = Record<string, string>;
export interface PromptLoaderOptions {
  reloadOnChange?: boolean;
}

interface CachedPrompt {
  raw: string;
  mtimeMs: number;
}

export interface PromptLoader {
  /**
   * Load a named template, substitute {{key}} placeholders, return final string.
   * Template name maps to prompts/<name>.md
   * Caches the raw file on first read. Substitution is not cached (vars change per call).
   * Throws if the file does not exist.
   */
  load(name: string, vars?: TemplateVars): string;

  /** Force-reload a template from disk (for hot-reload and testing). */
  invalidate(name: string): void;

  /** Clear all cached templates. */
  invalidateAll(): void;

  /** Returns true if template file exists at prompts/<name>.md */
  exists(name: string): boolean;
}

function substitute(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : `{{${key}}}`;
  });
}

export function createPromptLoader(promptsDir?: string, options?: PromptLoaderOptions): PromptLoader {
  const dir = promptsDir ?? path.join(process.cwd(), 'prompts');
  const cache = new Map<string, CachedPrompt>();

  function filePath(name: string): string {
    return path.join(dir, `${name}.md`);
  }

  function loadRaw(name: string): string {
    const fp = filePath(name);
    if (!fs.existsSync(fp)) {
      throw new Error(`[prompt-loader] Template not found: ${fp}`);
    }

    const stat = fs.statSync(fp);
    const cached = cache.get(name);
    if (cached !== undefined) {
      if (!options?.reloadOnChange) return cached.raw;
      if (stat.mtimeMs <= cached.mtimeMs) return cached.raw;
    }

    const raw = fs.readFileSync(fp, 'utf8');
    if (cached && options?.reloadOnChange) {
      console.log(
        `[zaraban][prompt-loader] Reloaded ${name} prompt (mtime: ${new Date(stat.mtimeMs).toISOString()})`
      );
    }
    cache.set(name, { raw, mtimeMs: stat.mtimeMs });
    return raw;
  }

  return {
    load(name: string, vars?: TemplateVars): string {
      const raw = loadRaw(name);
      return vars && Object.keys(vars).length > 0 ? substitute(raw, vars) : raw;
    },

    invalidate(name: string): void {
      cache.delete(name);
    },

    invalidateAll(): void {
      cache.clear();
    },

    exists(name: string): boolean {
      return fs.existsSync(filePath(name));
    },
  };
}

/** Default singleton pointed at <cwd>/prompts/ */
export const promptLoader: PromptLoader = createPromptLoader(undefined, { reloadOnChange: true });

export function loadPlannerPrompt(vars?: TemplateVars): string {
  return promptLoader.load('planner', vars);
}
