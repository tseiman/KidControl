import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const publicAsset = (name: string) => new URL(`../public/${name}`, import.meta.url);

describe('WebUI icons', () => {
  it('provides an opaque 180x180 Apple touch icon', () => {
    const png = readFileSync(publicAsset('apple-touch-icon.png'));
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(180);
    expect(png.readUInt32BE(20)).toBe(180);
    expect(png[25]).toBe(2); // PNG truecolour without alpha
  });

  it('provides conventional favicon sizes in one ICO file', () => {
    const ico = readFileSync(publicAsset('favicon.ico'));
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    expect(count).toBe(4);
    const sizes = Array.from({ length: count }, (_, index) => {
      const value = ico[6 + index * 16];
      return value === 0 ? 256 : value;
    });
    expect(sizes).toEqual([16, 32, 48, 64]);
  });
});
