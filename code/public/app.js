import { canStart, initials } from './ui-model.js';
import { applyTranslations, resolveLocale, translate } from './i18n.js';
import { selectedUsageEntry, usageChartModel } from './usage-chart.js';

const byId = (id) => document.getElementById(id);
const locale = resolveLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
const t = (key, values) => translate(locale, key, values);
let csrf = '';
let state = null;
let lastSync = Date.now();
let sessionGeneration = 0;
let loginPending = false;
let publicUsers = [];
let selectedLoginUserId = '';
let adminUsers = [];
const selectedUsageDays = new Map();
const adminUsageElements = { chart: 'usage-chart', detail: 'usage-detail', axisMax: 'usage-axis-max', bars: 'usage-bars' };
const ownUsageElements = { chart: 'own-usage-chart', detail: 'own-usage-detail', axisMax: 'own-usage-axis-max', bars: 'own-usage-bars' };

applyTranslations(document, locale);
byId('version-tag').textContent = t('version.label', { version: byId('version-tag').dataset.version });

function localizedError(value) {
  const key = `error.${value}`;
  const translated = t(key);
  return translated === key ? value : translated;
}

function format(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  return [Math.floor(safe / 3600), Math.floor((safe % 3600) / 60), safe % 60]
    .map((value) => String(value).padStart(2, '0')).join(':');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...options.headers
    }
  });
  if (!response.ok) {
    const value = await response.json().catch(() => ({ error: 'Request failed' }));
    const error = new Error(value.error);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

function note(value, error = false) {
  byId('message').textContent = value;
  byId('message').style.color = error ? 'var(--danger)' : 'var(--accent)';
}

function avatar(user, className = '') {
  const wrapper = document.createElement('span');
  wrapper.className = `avatar ${className}`.trim();
  const fallback = document.createElement('span');
  fallback.className = 'avatar-initials';
  fallback.textContent = initials(user.displayName);
  wrapper.append(fallback);
  if (user.iconUrl) {
    const image = document.createElement('img');
    image.src = user.iconUrl;
    image.alt = '';
    image.decoding = 'async';
    image.addEventListener('error', () => image.remove(), { once: true });
    wrapper.prepend(image);
  }
  return wrapper;
}

function setLoginPending(pending) {
  loginPending = pending;
  byId('pin').disabled = pending;
  byId('login-submit').disabled = pending || !selectedLoginUserId;
  for (const button of byId('user-grid').querySelectorAll('button')) button.disabled = pending;
}

function renderLoginUsers(users) {
  publicUsers = users;
  if (!users.some((user) => user.id === selectedLoginUserId)) selectedLoginUserId = '';
  byId('user').value = selectedLoginUserId;
  byId('login-submit').disabled = loginPending || !selectedLoginUserId;
  byId('user-grid').replaceChildren(...users.map((user) => {
    const button = document.createElement('button');
    const selected = user.id === selectedLoginUserId;
    button.type = 'button';
    button.className = `user-tile${selected ? ' selected' : ''}`;
    button.disabled = loginPending;
    button.setAttribute('aria-pressed', String(selected));
    button.append(avatar(user, 'avatar-login'));
    const name = document.createElement('span');
    name.className = 'user-tile-name';
    name.textContent = user.displayName;
    button.append(name);
    button.addEventListener('click', () => {
      selectedLoginUserId = user.id;
      renderLoginUsers(publicUsers);
      byId('pin').focus();
    });
    return button;
  }));
}

function statusLine(device) {
  const line = document.createElement('p');
  line.className = 'device-status';
  line.textContent = t('device.status', {
    power: t(`power.${device.power}`),
    network: t(`network.${device.acl}`)
  });
  return line;
}

function pickerUserRow(user) {
  const row = document.createElement('span');
  row.className = 'picker-user-row';
  row.append(avatar(user, 'avatar-picker'));
  const copy = document.createElement('span');
  copy.className = 'picker-user-copy';
  const name = document.createElement('strong');
  name.textContent = user.displayName;
  const remaining = document.createElement('span');
  remaining.textContent = t('picker.remaining', { time: format(user.remainingSeconds) });
  copy.append(name, remaining);
  row.append(copy);
  return row;
}

function renderChart(user, elements, selectionScope) {
  const chart = byId(elements.chart);
  const barsElement = byId(elements.bars);
  const focusedUsageDay = barsElement.contains(document.activeElement)
    ? document.activeElement.dataset.day
    : undefined;
  chart.hidden = !user;
  if (!user) {
    barsElement.replaceChildren();
    byId(elements.detail).textContent = '--';
    byId(elements.axisMax).textContent = '1 h';
    return;
  }
  const selectionKey = `${selectionScope}:${user.id}`;
  const model = usageChartModel(user.usageLast7Days, locale);
  const selected = selectedUsageEntry(model.bars, selectedUsageDays.get(selectionKey));
  if (selected) selectedUsageDays.set(selectionKey, selected.day);
  byId(elements.axisMax).textContent = `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(model.scaleSeconds / 3600)} h`;
  const showUsageDay = (day, persist = false) => {
    const entry = model.bars.find((candidate) => candidate.day === day) ?? selected;
    if (!entry) return;
    if (persist) selectedUsageDays.set(selectionKey, entry.day);
    byId(elements.detail).textContent = `${entry.label} · ${format(entry.seconds)}`;
    for (const candidate of barsElement.querySelectorAll('.usage-bar')) {
      const active = candidate.dataset.day === entry.day;
      candidate.classList.toggle('is-selected', active);
      candidate.setAttribute('aria-pressed', String(active));
    }
  };
  const bars = model.bars.map((entry, index) => {
    const bar = document.createElement('button');
    bar.type = 'button';
    bar.className = 'usage-bar';
    bar.dataset.day = entry.day;
    bar.setAttribute('aria-pressed', 'false');
    const accessibleLabel = t('usage.barLabel', { day: entry.label, time: format(entry.seconds) });
    bar.setAttribute('aria-label', accessibleLabel);
    bar.title = accessibleLabel;
    bar.addEventListener('click', () => showUsageDay(entry.day, true));
    bar.addEventListener('pointerenter', () => showUsageDay(entry.day));
    bar.addEventListener('pointerleave', () => showUsageDay(selectedUsageDays.get(selectionKey)));
    bar.addEventListener('focus', () => showUsageDay(entry.day));
    bar.addEventListener('blur', () => showUsageDay(selectedUsageDays.get(selectionKey)));
    bar.addEventListener('keydown', (event) => {
      let nextIndex;
      if (event.key === 'ArrowLeft') nextIndex = index - 1;
      if (event.key === 'ArrowRight') nextIndex = index + 1;
      if (nextIndex === undefined) return;
      event.preventDefault();
      const next = model.bars[Math.max(0, Math.min(model.bars.length - 1, nextIndex))];
      if (!next) return;
      showUsageDay(next.day, true);
      barsElement.querySelector(`[data-day="${next.day}"]`)?.focus();
    });
    const track = document.createElement('span');
    track.className = 'usage-bar-track';
    track.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('span');
    fill.className = 'usage-bar-fill';
    fill.style.height = `${entry.ratio * 100}%`;
    track.append(fill);
    const label = document.createElement('span');
    label.className = 'usage-day';
    label.textContent = entry.label;
    bar.append(track, label);
    return bar;
  });
  barsElement.replaceChildren(...bars);
  if (selected) showUsageDay(selected.day);
  if (focusedUsageDay) {
    const focusDay = model.bars.some((entry) => entry.day === focusedUsageDay)
      ? focusedUsageDay
      : selected?.day;
    barsElement.querySelector(`[data-day="${focusDay}"]`)?.focus({ preventScroll: true });
  }
}

function renderUsageChart(user) {
  renderChart(user, adminUsageElements, 'admin');
}

function renderOwnUsageChart(user) {
  renderChart(user, ownUsageElements, 'own');
}

function clearAuthenticatedUi() {
  csrf = '';
  state = null;
  lastSync = Date.now();
  adminUsers = [];
  selectedUsageDays.clear();
  setLoginPending(false);
  byId('summary-avatar').replaceChildren();
  byId('summary-user-name').textContent = '—';
  byId('remaining').textContent = '--:--:--';
  byId('devices').replaceChildren();
  byId('stop').hidden = true;
  byId('admin').hidden = true;
  byId('target').value = '';
  byId('target-options').replaceChildren();
  byId('target-options').hidden = true;
  byId('target-trigger').replaceChildren();
  byId('target-trigger').setAttribute('aria-expanded', 'false');
  byId('target-trigger').disabled = true;
  byId('adjust-submit').disabled = true;
  renderUsageChart(undefined);
  renderOwnUsageChart(undefined);
  byId('dashboard').hidden = true;
  byId('login').hidden = false;
}

function failClosed(error) {
  if (error.status !== 401) return false;
  sessionGeneration += 1;
  clearAuthenticatedUi();
  note(localizedError(error.message), true);
  return true;
}

function closeTargetPicker(focusTrigger = false) {
  byId('target-options').hidden = true;
  byId('target-trigger').setAttribute('aria-expanded', 'false');
  if (focusTrigger) byId('target-trigger').focus();
}

function selectTarget(userId, focusTrigger = false, closePicker = true) {
  const user = adminUsers.find((candidate) => candidate.id === userId) ?? adminUsers[0];
  byId('target').value = user?.id ?? '';
  byId('target-trigger').replaceChildren(user ? pickerUserRow(user) : document.createTextNode(t('picker.noUsers')));
  byId('target-trigger').disabled = !user;
  byId('adjust-submit').disabled = !user;
  renderUsageChart(user);
  for (const option of byId('target-options').querySelectorAll('[role="option"]')) {
    option.setAttribute('aria-selected', String(option.dataset.userId === user?.id));
  }
  if (closePicker) closeTargetPicker(focusTrigger);
}

function renderTargetPicker(users) {
  const prior = byId('target').value;
  const options = byId('target-options');
  const wasOpen = !options.hidden;
  const focusedUserId = options.contains(document.activeElement)
    ? document.activeElement.dataset.userId
    : undefined;
  adminUsers = users;
  options.replaceChildren(...users.map((user) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'user-picker-option';
    option.setAttribute('role', 'option');
    option.dataset.userId = user.id;
    option.append(pickerUserRow(user));
    option.addEventListener('click', () => selectTarget(user.id, true));
    return option;
  }));
  selectTarget(users.some((user) => user.id === prior) ? prior : users[0]?.id, false, false);
  if (!users.length) {
    closeTargetPicker();
  } else if (wasOpen) {
    openTargetPicker();
    [...options.querySelectorAll('[role="option"]')]
      .find((option) => option.dataset.userId === focusedUserId)?.focus();
  }
}

function openTargetPicker() {
  if (byId('target-trigger').disabled) return;
  byId('target-options').hidden = false;
  byId('target-trigger').setAttribute('aria-expanded', 'true');
}

async function refresh(expectedGeneration = sessionGeneration) {
  let nextState;
  try {
    nextState = await api('/api/status');
  } catch (error) {
    if (expectedGeneration !== sessionGeneration) return;
    if (error.status === 401) {
      failClosed(error);
      return;
    }
    throw error;
  }
  if (expectedGeneration !== sessionGeneration) return;
  state = nextState;
  lastSync = Date.now();
  byId('login').hidden = true;
  byId('dashboard').hidden = false;
  byId('summary-avatar').replaceChildren(avatar(state.me, 'avatar-summary'));
  byId('summary-user-name').textContent = state.me.displayName;
  byId('remaining').textContent = state.unlimited ? t('dashboard.unlimited') : format(state.remainingSeconds);
  byId('devices').replaceChildren(...state.devices.map((device) => {
    const card = document.createElement('article');
    const active = device.id === state.activeDeviceId;
    card.className = `device${active ? ' active' : ''}`;
    const details = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = device.displayName;
    details.append(title, statusLine(device));
    const button = document.createElement('button');
    button.textContent = active ? t('device.active') : t('device.start');
    button.disabled = !canStart(state.me.role, device.power, active);
    button.onclick = () => mutate('/api/claim', { deviceId: device.id });
    card.append(details, button);
    return card;
  }));
  byId('stop').hidden = !state.activeDeviceId;
  const ownUsageUser = state.me.role === 'user'
    ? { ...state.me, usageLast7Days: state.usageLast7Days }
    : undefined;
  renderOwnUsageChart(ownUsageUser);
  byId('admin').hidden = state.me.role !== 'superuser';
  if (state.users) renderTargetPicker(state.users);
}

async function mutate(path, value = {}) {
  const expectedGeneration = sessionGeneration;
  try {
    await api(path, { method: 'POST', body: JSON.stringify(value) });
    if (expectedGeneration !== sessionGeneration) return;
    note(t('status.updated'));
    await refresh(expectedGeneration);
  } catch (error) {
    if (expectedGeneration !== sessionGeneration) return;
    if (failClosed(error)) return;
    if (error.message === 'Apple TV is not on') {
      // Power can change after rendering; refresh silently so the disabled button reflects authoritative state.
      await refresh(expectedGeneration).catch(() => undefined);
      return;
    }
    note(localizedError(error.message), true);
  }
}

byId('login-form').onsubmit = async (event) => {
  event.preventDefault();
  if (!selectedLoginUserId || loginPending) return;
  setLoginPending(true);
  const expectedGeneration = ++sessionGeneration;
  try {
    const result = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ userId: selectedLoginUserId, pin: byId('pin').value })
    });
    if (expectedGeneration !== sessionGeneration) return;
    csrf = result.csrf;
    byId('pin').value = '';
    await refresh(expectedGeneration);
  } catch (error) {
    if (expectedGeneration === sessionGeneration) note(localizedError(error.message), true);
  } finally {
    if (expectedGeneration === sessionGeneration) setLoginPending(false);
  }
};
byId('stop').onclick = () => mutate('/api/stop');
byId('restore').onclick = () => mutate('/api/admin/restore');
byId('logout').onclick = async () => {
  const expectedGeneration = ++sessionGeneration;
  const logoutRequest = api('/api/logout', { method: 'POST', body: '{}' });
  clearAuthenticatedUi();
  setLoginPending(true);
  try {
    await logoutRequest;
    if (expectedGeneration !== sessionGeneration) return;
    sessionGeneration += 1;
    setLoginPending(false);
    note(t('status.signedOut'));
  } catch (error) {
    if (expectedGeneration !== sessionGeneration) return;
    if (!failClosed(error)) {
      setLoginPending(false);
      note(localizedError(error.message), true);
    }
  }
};
byId('adjust').onsubmit = (event) => {
  event.preventDefault();
  if (!byId('target').value) return;
  const seconds = (Number(byId('hours').value) * 60 + Number(byId('minutes').value)) * 60;
  void mutate('/api/admin/adjust', { userId: byId('target').value, remainingSeconds: seconds });
};
byId('target-trigger').addEventListener('click', () => {
  if (byId('target-options').hidden) openTargetPicker(); else closeTargetPicker();
});
byId('target-trigger').addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowDown') return;
  event.preventDefault();
  openTargetPicker();
  byId('target-options').querySelector('[role="option"]')?.focus();
});
byId('target-options').addEventListener('keydown', (event) => {
  const options = [...byId('target-options').querySelectorAll('[role="option"]')];
  const current = options.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault(); closeTargetPicker(true); return;
  }
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  const offset = event.key === 'ArrowDown' ? 1 : -1;
  options[(current + offset + options.length) % options.length]?.focus();
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('#target-picker')) closeTargetPicker();
});
for (let value = 0; value <= 24; value++) byId('hours').append(new Option(String(value).padStart(2, '0'), String(value)));
for (let value = 0; value < 60; value++) byId('minutes').append(new Option(String(value).padStart(2, '0'), String(value)));

setInterval(() => {
  if (state && !state.unlimited && state.activeDeviceId) {
    byId('remaining').textContent = format(state.remainingSeconds - (Date.now() - lastSync) / 1000);
  }
}, 1000);
setInterval(() => {
  if (state) void refresh().catch((error) => note(localizedError(error.message), true));
}, 10_000);

(async () => {
  const choices = await api('/api/public');
  renderLoginUsers(choices.users);
  const expectedGeneration = sessionGeneration;
  try {
    const session = await api('/api/session');
    if (expectedGeneration !== sessionGeneration) return;
    csrf = session.csrf;
    await refresh(expectedGeneration);
  } catch {
    if (expectedGeneration === sessionGeneration) clearAuthenticatedUi();
  }
})();
