import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const asset = (name: string) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');

function declarations(source: string, selector: string): Map<string, string> {
  const match = source.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 's'));
  if (!match?.[1]) return new Map();
  return new Map(match[1].split(';').map((item) => item.trim()).filter(Boolean).map((item) => {
    const separator = item.indexOf(':');
    return [item.slice(0, separator).trim(), item.slice(separator + 1).trim()];
  }));
}

function mediaBlock(source: string, maxWidth: number): string {
  const start = source.indexOf(`@media (max-width: ${maxWidth}px)`);
  if (start < 0) return '';
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(open + 1, index);
  }
  return '';
}

describe('authenticated WebUI summary', () => {
  it('shows the current user avatar and name before the localized remaining time', () => {
    const html = asset('index.html');
    const app = asset('app.js');
    const elements = [
      'class="summary-profile"',
      'id="summary-avatar" aria-hidden="true"',
      'id="summary-user-name"',
      'class="summary-time"',
      'data-i18n="dashboard.remaining"',
      'id="remaining"',
      'id="logout"'
    ];

    expect(elements.map((element) => html.indexOf(element))).toEqual([...elements.map((element) => html.indexOf(element))].sort((a, b) => a - b));
    expect(elements.every((element) => html.includes(element))).toBe(true);
    expect(app).toMatch(/summary-avatar['"]\)\.replaceChildren\(avatar\(state\.me, ['"]avatar-summary['"]\)\)/);
    expect(app).toMatch(/summary-user-name['"]\)\.textContent\s*=\s*state\.me\.displayName/);
  });

  it('keeps profile, remaining time, and logout responsive without hiding controls', () => {
    const css = asset('styles.css');
    const desktopSummary = declarations(css, '.summary');
    const mobile = mediaBlock(css, 560);
    const mobileSummary = declarations(mobile, '.summary');
    const mobileLogout = declarations(mobile, '#logout');

    expect(desktopSummary.get('display')).toBe('grid');
    expect(desktopSummary.get('grid-template-columns')).toBe('auto minmax(0, 1fr) auto');
    expect(mobileSummary.get('grid-template-columns')).toBe('auto minmax(0, 1fr)');
    expect(mobileLogout.get('grid-column')).toBe('1 / -1');
    expect(mobileLogout.get('width')).toBe('100%');
  });
});
