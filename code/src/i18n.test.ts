import { describe, expect, it } from 'vitest';
import { applyTranslations, resolveLocale, translate } from '../public/i18n.js';

describe('client-side WebUI localization', () => {
  it('selects the first supported browser language and defaults to English', () => {
    expect(resolveLocale(['fr-FR', 'de-DE', 'en-US'])).toBe('de');
    expect(resolveLocale(['en-GB', 'de-DE'])).toBe('en');
    expect(resolveLocale(['de-AT'])).toBe('de');
    expect(resolveLocale(['fr-FR'])).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
  });

  it('translates static, dynamic, and parameterized text in both languages', () => {
    expect(translate('en', 'login.title')).toBe('Sign in');
    expect(translate('de', 'login.title')).toBe('Anmelden');
    expect(translate('en', 'device.status', {
      power: translate('en', 'power.on'),
      network: translate('en', 'network.blocked')
    })).toBe('Power: On · Network: Blocked');
    expect(translate('de', 'device.status', {
      power: translate('de', 'power.on'),
      network: translate('de', 'network.blocked')
    })).toBe('Strom: Ein · Netzwerk: Gesperrt');
    expect(translate('de', 'picker.remaining', { time: '01:02:03' })).toBe('01:02:03 verbleibend');
    expect(translate('en', 'admin.restore')).toBe('Restore network state');
    expect(translate('de', 'admin.restore')).toBe('Netzwerkzustand wiederherstellen');
    expect(translate('en', 'network.degraded')).toBe('Degraded');
    expect(translate('de', 'network.degraded')).toBe('Eingeschränkt');
  });

  it('falls back to the English translation when a German entry is unavailable', () => {
    expect(translate('de', 'test.englishOnly')).toBe('English fallback');
  });

  it('translates every stable API error that can reach the browser', () => {
    const errors = {
      'Request failed': 'Anfrage fehlgeschlagen',
      'request failed': 'Anfrage fehlgeschlagen',
      'invalid host': 'Ungültiger Hostname',
      'invalid origin': 'Ungültiger Ursprung',
      'request body too large': 'Anfrage ist zu groß',
      'invalid JSON body': 'Ungültige Anfragedaten',
      'invalid forwarded client address': 'Ungültige Client-Adresse',
      'not found': 'Nicht gefunden',
      'authentication required': 'Anmeldung erforderlich',
      'invalid CSRF token': 'Ungültiges Sicherheitstoken',
      'internal server error': 'Interner Serverfehler',
      'invalid credentials': 'Ungültige Anmeldedaten',
      'unknown user': 'Unbekannter Benutzer',
      'unknown device': 'Unbekanntes Gerät',
      'Apple TV is not on': 'Apple TV ist nicht eingeschaltet',
      'budget exhausted': 'Zeitbudget aufgebraucht',
      'device reserved by superuser': 'Gerät ist durch einen Superuser reserviert',
      'superuser required': 'Superuser-Berechtigung erforderlich',
      'target must be a regular user': 'Das Ziel muss ein regulärer Benutzer sein',
      'remaining time must be 00:00 through 24:59': 'Die verbleibende Zeit muss zwischen 00:00 und 24:59 liegen'
    };

    for (const [message, expected] of Object.entries(errors)) {
      expect(translate('de', `error.${message}`), message).toBe(expected);
    }
  });

  it('applies text, accessible labels, and the document language client-side', () => {
    const textElement = { dataset: { i18n: 'login.title' }, textContent: '', setAttribute() {} };
    const labelAttributes: Record<string, string> = {};
    const labelElement = {
      dataset: { i18nAriaLabel: 'login.chooseProfile' },
      textContent: '',
      setAttribute(name: string, value: string) { labelAttributes[name] = value; }
    };
    const htmlAttributes: Record<string, string> = {};
    const root = {
      documentElement: { setAttribute(name: string, value: string) { htmlAttributes[name] = value; } },
      querySelectorAll(selector: string) {
        if (selector === '[data-i18n]') return [textElement];
        if (selector === '[data-i18n-aria-label]') return [labelElement];
        return [];
      }
    };

    applyTranslations(root, 'de');

    expect(textElement.textContent).toBe('Anmelden');
    expect(labelAttributes['aria-label']).toBe('Profil auswählen');
    expect(htmlAttributes.lang).toBe('de');
  });
});
