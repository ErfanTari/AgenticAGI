import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { tileImage, TILE_SIZE } from '../../core/multimedia/tiling.js';

async function makeImage(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 128, g: 128, b: 128 } } })
    .png()
    .toBuffer();
}

describe('tileImage', () => {
  it('small image (500×400) returns single tile, no extraction', async () => {
    const buf = await makeImage(500, 400);
    const tiles = await tileImage(buf);
    expect(tiles).toHaveLength(1);
    expect(tiles[0].x).toBe(0);
    expect(tiles[0].y).toBe(0);
    expect(tiles[0].index).toBe(0);
  });

  it('exactly 1072×1072 returns single tile', async () => {
    const buf = await makeImage(1072, 1072);
    const tiles = await tileImage(buf);
    expect(tiles).toHaveLength(1);
    expect(tiles[0].width).toBe(1072);
    expect(tiles[0].height).toBe(1072);
  });

  it('2000×1500 produces 4 tiles with correct dimensions', async () => {
    const buf = await makeImage(2000, 1500);
    const tiles = await tileImage(buf);
    // cols: ceil(2000/1072) = 2, rows: ceil(1500/1072) = 2 → 4 tiles
    expect(tiles).toHaveLength(4);
    expect(tiles.map(t => t.index)).toEqual([0, 1, 2, 3]);
    // Right edge tile width: 2000 - 1072 = 928
    const rightEdge = tiles.find(t => t.x === TILE_SIZE);
    expect(rightEdge?.width).toBe(2000 - TILE_SIZE);
    // Bottom edge tile height: 1500 - 1072 = 428
    const bottomEdge = tiles.find(t => t.y === TILE_SIZE);
    expect(bottomEdge?.height).toBe(1500 - TILE_SIZE);
  });

  it('3000×3000 produces 9 tiles', async () => {
    const buf = await makeImage(3000, 3000);
    const tiles = await tileImage(buf);
    expect(tiles).toHaveLength(9); // 3×3 grid
  });
});
