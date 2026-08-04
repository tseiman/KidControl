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
    expect(html).toContain('id="usage-detail" class="usage-detail" aria-live="polite" aria-atomic="true"');
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
    expect(app).toContain('const focusedUsageDay = barsElement.contains(document.activeElement)');
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

describe('regular-user seven-day usage chart', () => {
  it('places a separate own-usage section below every device control and before the hidden admin section', () => {
    const html = asset('index.html');
    const elements = [
      'id="devices"',
      'id="stop"',
      'id="own-usage-chart"',
      'id="own-usage-chart-title"',
      'id="own-usage-detail"',
      'id="own-usage-axis-max"',
      'id="own-usage-bars"',
      'id="admin"'
    ];

    expect(elements.every((element) => html.includes(element))).toBe(true);
    expect(elements.map((element) => html.indexOf(element))).toEqual(
      [...elements.map((element) => html.indexOf(element))].sort((a, b) => a - b)
    );
    expect(html).toContain('id="own-usage-chart" class="panel usage-chart own-usage-chart" aria-labelledby="own-usage-chart-title" hidden');
    expect(html).toContain('id="own-usage-detail" class="usage-detail" aria-live="polite" aria-atomic="true"');
  });

  it('renders only a regular user own history while preserving the existing admin chart path', () => {
    const app = asset('app.js');

    expect(app).toContain('function renderChart(user, elements, selectionScope)');
    expect(app).toContain('function renderUsageChart(user)');
    expect(app).toContain('function renderOwnUsageChart(user)');
    expect(app).toContain("state.me.role === 'user'");
    expect(app).toContain('usageLast7Days: state.usageLast7Days');
    expect(app).toContain('renderOwnUsageChart(ownUsageUser)');
    expect(app).toMatch(/function selectTarget[\s\S]*renderUsageChart\(user\)/);
  });

  it('fails closed on logout, authentication loss, and obsolete status responses', () => {
    const app = asset('app.js');

    expect(app).toContain('let sessionGeneration = 0');
    expect(app).toContain('error.status = response.status');
    expect(app).toContain('function clearAuthenticatedUi()');
    expect(app).toContain('selectedUsageDays.clear()');
    expect(app).toContain('adminUsers = []');
    expect(app).toContain('renderUsageChart(undefined)');
    expect(app).toContain('renderOwnUsageChart(undefined)');
    expect(app).toContain("byId('target-options').replaceChildren()");
    expect(app).toContain('async function refresh(expectedGeneration = sessionGeneration)');
    expect(app).toContain('if (expectedGeneration !== sessionGeneration) return');
    expect(app).toContain('if (error.status === 401)');
    expect(app).toContain('sessionGeneration += 1');
    expect(app).toContain('let loginPending = false');
    expect(app).toContain('function setLoginPending(pending)');
    expect(app).toContain('if (!selectedLoginUserId || loginPending) return');
    expect(app).toContain('setLoginPending(true)');
    expect(app).toContain('loginPending = false');
    expect(app).toMatch(/byId\('logout'\)\.onclick[\s\S]*const logoutRequest = api[\s\S]*clearAuthenticatedUi\(\)[\s\S]*await logoutRequest[\s\S]*sessionGeneration \+= 1/);
  });
});
