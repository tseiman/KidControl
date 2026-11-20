import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { translate } from '../public/i18n.js';

const asset = (name: string) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');

describe('separated superuser controls', () => {
  it('places users, remaining time, daily reset, and network restore in distinct panels', () => {
    const html = asset('index.html');
    const css = asset('styles.css');
    const ids = ['admin-users', 'admin-remaining', 'admin-daily-reset', 'admin-network'];

    for (const id of ids) {
      expect(html).toContain(`id="${id}" class="panel admin-section"`);
    }
    expect(ids.map((id) => html.indexOf(`id="${id}"`))).toEqual(
      [...ids.map((id) => html.indexOf(`id="${id}"`))].sort((a, b) => a - b)
    );
    expect(html).toMatch(/id="admin-users"[\s\S]*id="target-picker"[\s\S]*id="usage-chart"[\s\S]*<\/section>/);
    expect(html).toMatch(/id="admin-remaining"[\s\S]*id="hours"[\s\S]*id="minutes"[\s\S]*id="adjust-submit"[\s\S]*<\/section>/);
    expect(html).toMatch(/id="admin-daily-reset"[\s\S]*id="daily-reset-form"[\s\S]*<\/section>/);
    expect(html).toMatch(/id="admin-network"[\s\S]*id="restore"[\s\S]*<\/section>/);
    expect(css).toContain('.admin-section');
  });

  it('localizes every new section heading in English and German', () => {
    const expected = {
      'admin.title': ['Administration', 'Administration'],
      'admin.usersTitle': ['Users', 'Benutzer'],
      'admin.remainingTitle': ['Set remaining time', 'Verbleibende Zeit setzen'],
      'admin.dailyResetTitle': ['Daily reset', 'Tägliche Rücksetzung'],
      'admin.networkTitle': ['Reset network status', 'Netzwerkstatus zurücksetzen']
    } as const;

    for (const [key, [english, german]] of Object.entries(expected)) {
      expect(translate('en', key)).toBe(english);
      expect(translate('de', key)).toBe(german);
    }
  });
});
