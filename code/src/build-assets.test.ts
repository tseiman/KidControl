import { describe, expect, it } from 'vitest';
import { injectVersion } from '../scripts/build-helpers.mjs';

describe('WebUI build metadata', () => {
  it('injects the exact build version into every WebUI placeholder', () => {
    const html = '<span data-version="__KIDCONTROL_VERSION__">Version __KIDCONTROL_VERSION__</span>';
    expect(injectVersion(html, 'abc1234-dirty')).toBe('<span data-version="abc1234-dirty">Version abc1234-dirty</span>');
  });

  it('fails the build when the WebUI version placeholder is missing', () => {
    expect(() => injectVersion('<html></html>', 'abc1234')).toThrow('version placeholder');
  });
});
