import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

describe('activity-driven WebUI power refresh', () => {
  it('uses foreground lifecycle signals and visible-only 30 second polling', () => {
    expect(app).toContain("window.addEventListener('pageshow'");
    expect(app).toContain("document.addEventListener('visibilitychange'");
    expect(app).toContain("window.addEventListener('focus'");
    expect(app).toContain("window.addEventListener('online'");
    expect(app).toContain("document.visibilityState !== 'visible'");
    expect(app).toContain('30_000');
    expect(app).not.toContain('}, 10_000);');
  });

  it('coalesces status refreshes and cancels polling while hidden', () => {
    expect(app).toContain('let refreshPending;');
    expect(app).toMatch(/if \(refreshPendingGeneration === expectedGeneration && refreshPending\) return refreshPending/);
    expect(app).toContain('clearTimeout(statusPollTimer)');
    expect(app).toContain('stopStatusPolling();');
  });
});
