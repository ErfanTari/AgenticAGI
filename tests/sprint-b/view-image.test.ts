import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import sharp from 'sharp';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

vi.mock('../../core/multimedia/vision-router.js', () => ({
  describeImage: vi.fn(async (_buf: Buffer, prompt: string) => ({
    description: `Mock description for: ${prompt.slice(0, 30)}`,
    tier: 'local' as const,
    confidence: 'high' as const,
  })),
}));

import { describeImage } from '../../core/multimedia/vision-router.js';

async function makeTestImage(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } } })
    .png().toBuffer();
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'view-img-test-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('view_image', () => {
  it('single-tile image calls describeImage once', async () => {
    const buf = await makeTestImage(500, 400);
    const imgPath = path.join(tmpDir, 'small.png');
    fs.writeFileSync(imgPath, buf);

    const { default: skill } = await import('../../core/skills/tools/view_image.js');
    const result = await skill.execute({ path: imgPath });
    expect(result.success).toBe(true);
    expect(describeImage).toHaveBeenCalledTimes(1);
  });

  it('multi-tile image calls describeImage per tile', async () => {
    // 2000×2000 → 2×2 grid = 4 tiles (each col/row ≤ 2144 so fits in 2 steps)
    const buf = await makeTestImage(2000, 2000);
    const imgPath = path.join(tmpDir, 'large.png');
    fs.writeFileSync(imgPath, buf);

    const { default: skill } = await import('../../core/skills/tools/view_image.js');
    const result = await skill.execute({ path: imgPath });
    expect(result.success).toBe(true);
    expect(describeImage).toHaveBeenCalledTimes(4); // 2×2 grid
    expect(result.output).toContain('Tile 1');
  });

  it('mixed-tier output noted when cloud was used', async () => {
    vi.mocked(describeImage)
      .mockResolvedValueOnce({ description: 'local desc', tier: 'local', confidence: 'high' })
      .mockResolvedValueOnce({ description: 'cloud desc', tier: 'cloud-fallback', confidence: 'low' })
      .mockResolvedValueOnce({ description: 'local desc 2', tier: 'local', confidence: 'high' })
      .mockResolvedValueOnce({ description: 'local desc 3', tier: 'local', confidence: 'high' });

    const buf = await makeTestImage(2000, 2000);
    const imgPath = path.join(tmpDir, 'mixed.png');
    fs.writeFileSync(imgPath, buf);

    const { default: skill } = await import('../../core/skills/tools/view_image.js');
    const result = await skill.execute({ path: imgPath });
    expect(result.success).toBe(true);
    expect(result.display).toContain('mixed');
  });
});
