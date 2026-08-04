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
      'id="usage-detail"',
      'id="usage-axis-max"',
      'id="usage-bars"'
    ];

    expect(elements.every((element) => html.includes(element))).toBe(true);
    expect(elements.map((element) => html.indexOf(element))).toEqual(
      [...elements.map((element) => html.indexOf(element))].sort((a, b) => a - b)
    );
    expect(html).toContain('aria-labelledby="usage-chart-title"');
    expect(html).toContain('id="usage-detail" aria-live="polite" aria-atomic="true"');
  });

  it('re-renders safe localized bars whenever the selected user changes', () => {
    const app = asset('app.js');

    expect(app).toContain('usageChartModel');
    expect(app).toContain('function renderUsageChart(user)');
    expect(app).toMatch(/function selectTarget[\s\S]*renderUsageChart\(user\)/);
    expect(app).toContain("bar.setAttribute('aria-label'");
    expect(app).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  });

  it('supports persistent touch selection, mouse preview, and keyboard navigation', () => {
    const app = asset('app.js');

    expect(app).toContain("import { selectedUsageEntry, usageChartModel } from './usage-chart.js';");
    expect(app).toContain("document.createElement('button')");
    expect(app).toContain("bar.setAttribute('aria-pressed'");
    expect(app).toContain("bar.addEventListener('click'");
    expect(app).toContain("bar.addEventListener('pointerenter'");
    expect(app).toContain("bar.addEventListener('pointerleave'");
    expect(app).toContain("bar.addEventListener('keydown'");
    expect(app).toContain("event.key === 'ArrowLeft'");
    expect(app).toContain("event.key === 'ArrowRight'");
    expect(app).toContain("const focusedUsageDay = byId('usage-bars').contains(document.activeElement)");
    expect(app).toContain('if (focusedUsageDay)');
    expect(app).toContain('.focus({ preventScroll: true })');
  });

  it('uses a responsive seven-column bar grid with a bounded plot height', () => {
    const css = asset('styles.css');
    const bars = declarations(css, '.usage-bars');
    const track = declarations(css, '.usage-bar-track');
    const selected = declarations(css, '.usage-bar.is-selected .usage-bar-track');

    expect(bars.get('display')).toBe('grid');
    expect(bars.get('grid-template-columns')).toBe('repeat(7, minmax(0, 1fr))');
    expect(track.get('height')).toMatch(/^clamp\(/);
    expect(track.get('overflow')).toBe('hidden');
    expect(selected.get('border-color')).toBe('var(--accent)');
  });
});
