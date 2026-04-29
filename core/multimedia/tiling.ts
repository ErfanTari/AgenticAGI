import sharp from 'sharp';

export const TILE_SIZE = 1072; // Qwen 3 VL 8B empirical sweet spot

export type Tile = {
  buffer: Buffer;
  x: number;
  y: number;
  width: number;
  height: number;
  index: number;
};

export async function tileImage(buffer: Buffer): Promise<Tile[]> {
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) throw new Error('Cannot determine image dimensions');

  if (meta.width <= TILE_SIZE && meta.height <= TILE_SIZE) {
    return [{ buffer, x: 0, y: 0, width: meta.width, height: meta.height, index: 0 }];
  }

  const tiles: Tile[] = [];
  let index = 0;
  for (let y = 0; y < meta.height; y += TILE_SIZE) {
    for (let x = 0; x < meta.width; x += TILE_SIZE) {
      const w = Math.min(TILE_SIZE, meta.width - x);
      const h = Math.min(TILE_SIZE, meta.height - y);
      const tile = await sharp(buffer)
        .extract({ left: x, top: y, width: w, height: h })
        .toBuffer();
      tiles.push({ buffer: tile, x, y, width: w, height: h, index: index++ });
    }
  }
  return tiles;
}
