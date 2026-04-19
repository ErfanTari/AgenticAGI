import { describe, expect, it } from 'vitest';
import { buildQueryCompatibilityClassification, buildSkillCompatibilityClassification } from '../../core/agent.js';

describe('Phase 13: rich artifact compatibility routing', () => {
  it('does not collapse rich single-file HTML generation into file_writer compatibility', () => {
    const classification = buildSkillCompatibilityClassification(
      'Create a complete single-file bakery website and save it as outputs/demo/index.html with inline CSS and JavaScript.',
    );

    expect(classification).toBeNull();
  });

  it('does not collapse rich coding project generation into file_writer compatibility', () => {
    const classification = buildSkillCompatibilityClassification(
      'Create a Node.js Express server with a GET /ok endpoint, package.json, and a test file in outputs/demo-api/.',
    );

    expect(classification).toBeNull();
  });

  it('keeps explicit file content writes on the file_writer compatibility path', () => {
    const classification = buildSkillCompatibilityClassification(
      'Create a file called hello.txt with content hello world',
    );

    expect(classification).toMatchObject({
      intent: 'skill',
      skill: 'file_writer',
      skillInput: { path: 'hello.txt', content: 'hello world' },
    });
  });

  it('does not treat benchmark-style generation prompts as memory queries just because they mention task/output', () => {
    const classification = buildQueryCompatibilityClassification(
      'Benchmark task: create a complete single-file bakery website and save it under outputs/demo-site/.',
    );

    expect(classification).toBeNull();
  });
});
