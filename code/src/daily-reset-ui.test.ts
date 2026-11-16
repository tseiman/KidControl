import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const asset = (name: string) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');

describe('daily reset WebUI', () => {
  it('provides a localized superuser time control wired to the protected API', () => {
    const html = asset('index.html');
    const app = asset('app.js');
    expect(html).toContain('id="daily-reset-form"');
    expect(html).toContain('data-i18n="admin.dailyResetTime"');
    expect(html).toMatch(/id="daily-reset-time"[^>]*type="time"[^>]*required/);
    expect(html).toContain('data-i18n="admin.saveDailyReset"');
    expect(app).toMatch(/daily-reset-time['"]\)\.value\s*=\s*state\.dailyResetTime/);
    expect(app).toContain("mutate('/api/admin/daily-reset', { time: byId('daily-reset-time').value })");
  });
});
