import { z } from 'zod';

const ConfigSchema = z.object({
  LLM_ENDPOINT: z.string().url('LLM_ENDPOINT must be a valid URL'),
  LLM_MODEL: z.string().min(1, 'LLM_MODEL must be non-empty'),
  EMBEDDING_MODEL: z.string().optional(),
  EMBEDDING_ENDPOINT: z.string().url().optional(),
  PERMISSION_MODE: z
    .enum(['read-only', 'workspace-write', 'full-access'])
    .default('workspace-write'),
  LLM_FALLBACK_PROVIDER: z.enum(['gemini', 'anthropic', 'none']).optional(),
  LLM_FALLBACK_MODEL: z.string().optional(),
  TRANSPARENT: z.string().optional(),
  DEBUG_PLANNER: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

let _config: Config | null = null;

export function validateConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    console.error('\n[config] Startup validation failed:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    console.error('');
    process.exit(1);
  }
  _config = result.data;
  return _config;
}

export function getConfig(): Config {
  if (!_config) return validateConfig();
  return _config;
}

// For test isolation only
export function _resetConfig(): void { _config = null; }
