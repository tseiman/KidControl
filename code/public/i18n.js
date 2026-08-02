const messages = {
  en: {
    'app.eyebrow': 'HOME ACCESS',
    'nav.documentation': 'Documentation',
    'version.label': 'Version {version}',
    'login.title': 'Sign in',
    'login.intro': 'Choose your profile and enter your four-digit PIN.',
    'login.profile': 'Profile',
    'login.chooseProfile': 'Choose a profile',
    'login.pin': 'PIN',
    'login.submit': 'Sign in',
    'dashboard.remaining': 'TIME REMAINING',
    'dashboard.unlimited': 'Unlimited',
    'dashboard.logout': 'Log out',
    'dashboard.stop': 'Stop my session',
    'device.start': 'Start',
    'device.active': 'Active',
    'device.status': 'Power: {power} · Network: {network}',
    'power.on': 'On',
    'power.off': 'Off',
    'power.unknown': 'Unknown',
    'network.allowed': 'Allowed',
    'network.blocked': 'Blocked',
    'network.degraded': 'Degraded',
    'network.pending': 'Pending',
    'network.unknown': 'Unknown',
    'admin.title': 'Superuser controls',
    'admin.user': 'User',
    'admin.hours': 'Hours',
    'admin.minutes': 'Minutes',
    'admin.setRemaining': 'Set remaining time',
    'admin.restore': 'Restore KidControl state',
    'picker.remaining': '{time} remaining',
    'picker.noUsers': 'No regular users',
    'status.updated': 'State updated.',
    'status.signedOut': 'Signed out.',
    'error.Request failed': 'Request failed',
    'error.request failed': 'Request failed',
    'error.invalid host': 'Invalid host',
    'error.invalid origin': 'Invalid origin',
    'error.request body too large': 'Request body is too large',
    'error.invalid JSON body': 'Invalid request data',
    'error.invalid forwarded client address': 'Invalid client address',
    'error.not found': 'Not found',
    'error.invalid CSRF token': 'Invalid security token',
    'error.internal server error': 'Internal server error',
    'error.invalid credentials': 'Invalid credentials',
    'error.authentication required': 'Authentication required',
    'error.budget exhausted': 'Time budget exhausted',
    'error.device reserved by superuser': 'Device reserved by a superuser',
    'error.superuser required': 'Superuser access required',
    'error.target must be a regular user': 'Target must be a regular user',
    'error.remaining time must be 00:00 through 24:59': 'Remaining time must be between 00:00 and 24:59',
    'error.unknown user': 'Unknown user',
    'error.unknown device': 'Unknown device',
    'error.Apple TV is not on': 'Apple TV is not on',
    'test.englishOnly': 'English fallback'
  },
  de: {
    'app.eyebrow': 'HEIMZUGANG',
    'nav.documentation': 'Dokumentation',
    'version.label': 'Version {version}',
    'login.title': 'Anmelden',
    'login.intro': 'Wähle dein Profil und gib deine vierstellige PIN ein.',
    'login.profile': 'Profil',
    'login.chooseProfile': 'Profil auswählen',
    'login.pin': 'PIN',
    'login.submit': 'Anmelden',
    'dashboard.remaining': 'VERBLEIBENDE ZEIT',
    'dashboard.unlimited': 'Unbegrenzt',
    'dashboard.logout': 'Abmelden',
    'dashboard.stop': 'Meine Sitzung beenden',
    'device.start': 'Starten',
    'device.active': 'Aktiv',
    'device.status': 'Strom: {power} · Netzwerk: {network}',
    'power.on': 'Ein',
    'power.off': 'Aus',
    'power.unknown': 'Unbekannt',
    'network.allowed': 'Freigegeben',
    'network.blocked': 'Gesperrt',
    'network.degraded': 'Eingeschränkt',
    'network.pending': 'Ausstehend',
    'network.unknown': 'Unbekannt',
    'admin.title': 'Superuser-Steuerung',
    'admin.user': 'Benutzer',
    'admin.hours': 'Stunden',
    'admin.minutes': 'Minuten',
    'admin.setRemaining': 'Verbleibende Zeit setzen',
    'admin.restore': 'KidControl-Zustand wiederherstellen',
    'picker.remaining': '{time} verbleibend',
    'picker.noUsers': 'Keine regulären Benutzer',
    'status.updated': 'Status aktualisiert.',
    'status.signedOut': 'Abgemeldet.',
    'error.Request failed': 'Anfrage fehlgeschlagen',
    'error.request failed': 'Anfrage fehlgeschlagen',
    'error.invalid host': 'Ungültiger Hostname',
    'error.invalid origin': 'Ungültiger Ursprung',
    'error.request body too large': 'Anfrage ist zu groß',
    'error.invalid JSON body': 'Ungültige Anfragedaten',
    'error.invalid forwarded client address': 'Ungültige Client-Adresse',
    'error.not found': 'Nicht gefunden',
    'error.invalid CSRF token': 'Ungültiges Sicherheitstoken',
    'error.internal server error': 'Interner Serverfehler',
    'error.invalid credentials': 'Ungültige Anmeldedaten',
    'error.authentication required': 'Anmeldung erforderlich',
    'error.budget exhausted': 'Zeitbudget aufgebraucht',
    'error.device reserved by superuser': 'Gerät ist durch einen Superuser reserviert',
    'error.superuser required': 'Superuser-Berechtigung erforderlich',
    'error.target must be a regular user': 'Das Ziel muss ein regulärer Benutzer sein',
    'error.remaining time must be 00:00 through 24:59': 'Die verbleibende Zeit muss zwischen 00:00 und 24:59 liegen',
    'error.unknown user': 'Unbekannter Benutzer',
    'error.unknown device': 'Unbekanntes Gerät',
    'error.Apple TV is not on': 'Apple TV ist nicht eingeschaltet'
  }
};

export function resolveLocale(languages) {
  for (const language of languages ?? []) {
    const base = String(language).toLowerCase().split('-')[0];
    if (base === 'de' || base === 'en') return base;
  }
  return 'en';
}

export function translate(locale, key, values = {}) {
  const template = messages[locale]?.[key] ?? messages.en[key] ?? key;
  return template.replace(/\{([a-zA-Z]+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
  ));
}

export function applyTranslations(root, locale) {
  root.documentElement?.setAttribute('lang', locale);
  for (const element of root.querySelectorAll('[data-i18n]')) {
    element.textContent = translate(locale, element.dataset.i18n);
  }
  for (const element of root.querySelectorAll('[data-i18n-aria-label]')) {
    element.setAttribute('aria-label', translate(locale, element.dataset.i18nAriaLabel));
  }
}
