import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const asset = (name: string) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');

function declarations(source: string, selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's'));
  if (!match?.[1]) return new Map();
  return new Map(match[1].split(';').map((item) => item.trim()).filter(Boolean).map((item) => {
    const separator = item.indexOf(':');
    return [item.slice(0, separator).trim(), item.slice(separator + 1).trim()];
  }));
}

describe('superuser seven-day usage chart', () => {
  it('places one accessible chart below the network restore action', () => {
    const html = asset('index.html');
    const elements = [
      'id="restore"',
      'id="usage-chart"',
      'id="usage-chart-title"',
      'id="usage-axis-max"',
      'id="usage-bars"'
    ];

    expect(elements.every((element) => html.includes(element))).toBe(true);
    expect(elements.map((element) => html.indexOf(element))).toEqual(
      [...elements.map((element) => html.indexOf(element))].sort((a, b) => a - b)
    );
    expect(html).toContain('aria-labelledby="usage-chart-title"');
  });

  it('re-renders safe localized bars whenever the selected user changes', () => {
    const app = asset('app.js');

    expect(app).toContain("import { usageChartModel } from './usage-chart.js';");
    expect(app).toContain('function renderUsageChart(user)');
    expect(app).toMatch(/function selectTarget[\s\S]*renderUsageChart\(user\)/);
    expect(app).toContain("bar.setAttribute('aria-label'");
    expect(app).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  });

  it('uses a responsive seven-column bar grid with a bounded plot height', () => {
    const css = asset('styles.css');
    const bars = declarations(css, '.usage-bars');
    const track = declarations(css, '.usage-bar-track');

    expect(bars.get('display')).toBe('grid');
    expect(bars.get('grid-template-columns')).toBe('repeat(7, minmax(0, 1fr))');
    expect(track.get('height')).toMatch(/^clamp\(/);
    expect(track.get('overflow')).toBe('hidden');
  });
});
