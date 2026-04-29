import { describe, it, expect, vi, beforeEach } from 'vitest';

function mockVisionResponse(content: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

describe('vision-router', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('high-confidence local result returned without escalation', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(mockVisionResponse('A detailed pixel art tile showing grass and flowers.'));
    vi.stubGlobal('fetch', mockFetch);

    const { describeImage } = await import('../../core/multimedia/vision-router.js');
    const result = await describeImage(Buffer.from('fake'), 'describe this', 'image/png');
    expect(result.tier).toBe('local');
    expect(result.confidence).toBe('high');
    expect(result.description).toContain('grass');
  });

  it('low-confidence local result escalates to cloud-fallback tier', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(mockVisionResponse("I'm not sure what this image shows, it's unclear."))
      .mockResolvedValueOnce(mockVisionResponse('Cloud: A detailed Stardew Valley tile.'));
    vi.stubGlobal('fetch', mockFetch);
    // Inject a fake fallback endpoint so cloud path is reached
    process.env.LLM_FALLBACK_PROVIDER = 'gemini';
    process.env.LLM_FALLBACK_MODEL = 'gemini-2.5-flash';

    const { describeImage } = await import('../../core/multimedia/vision-router.js');
    const result = await describeImage(Buffer.from('fake'), 'describe', 'image/png');
    expect(result.tier).toBe('cloud-fallback');
    expect(result.confidence).toBe('low');

    delete process.env.LLM_FALLBACK_PROVIDER;
    delete process.env.LLM_FALLBACK_MODEL;
  });

  it('local API failure falls through to cloud-fallback tier', async () => {
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockResolvedValueOnce(mockVisionResponse('Cloud fallback description.'));
    vi.stubGlobal('fetch', mockFetch);
    process.env.LLM_FALLBACK_PROVIDER = 'gemini';
    process.env.LLM_FALLBACK_MODEL = 'gemini-2.5-flash';

    const { describeImage } = await import('../../core/multimedia/vision-router.js');
    const result = await describeImage(Buffer.from('fake'), 'describe', 'image/png');
    expect(result.tier).toBe('cloud-fallback');

    delete process.env.LLM_FALLBACK_PROVIDER;
    delete process.env.LLM_FALLBACK_MODEL;
  });
});
