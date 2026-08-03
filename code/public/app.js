import { canStart, initials } from './ui-model.js';
import { applyTranslations, resolveLocale, translate } from './i18n.js';

const byId = (id) => document.getElementById(id);
const locale = resolveLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
const t = (key, values) => translate(locale, key, values);
let csrf = '';
let state = null;
let lastSync = Date.now();
let publicUsers = [];
let selectedLoginUserId = '';
let adminUsers = [];

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
    throw new Error(value.error);
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

function renderLoginUsers(users) {
  publicUsers = users;
  if (!users.some((user) => user.id === selectedLoginUserId)) selectedLoginUserId = '';
  byId('user').value = selectedLoginUserId;
  byId('login-submit').disabled = !selectedLoginUserId;
  byId('user-grid').replaceChildren(...users.map((user) => {
    const button = document.createElement('button');
    const selected = user.id === selectedLoginUserId;
    button.type = 'button';
    button.className = `user-tile${selected ? ' selected' : ''}`;
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

async function refresh() {
  state = await api('/api/status');
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
  byId('admin').hidden = state.me.role !== 'superuser';
  if (state.users) renderTargetPicker(state.users);
}

async function mutate(path, value = {}) {
  try {
    await api(path, { method: 'POST', body: JSON.stringify(value) });
    note(t('status.updated'));
    await refresh();
  } catch (error) {
    if (error.message === 'Apple TV is not on') {
      // Power can change after rendering; refresh silently so the disabled button reflects authoritative state.
      await refresh().catch(() => undefined);
      return;
    }
    note(localizedError(error.message), true);
  }
}

byId('login-form').onsubmit = async (event) => {
  event.preventDefault();
  if (!selectedLoginUserId) return;
  try {
    const result = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ userId: selectedLoginUserId, pin: byId('pin').value })
    });
    csrf = result.csrf;
    byId('pin').value = '';
    await refresh();
  } catch (error) { note(localizedError(error.message), true); }
};
byId('stop').onclick = () => mutate('/api/stop');
byId('restore').onclick = () => mutate('/api/admin/restore');
byId('logout').onclick = async () => {
  try {
    await api('/api/logout', { method: 'POST', body: '{}' });
    csrf = ''; state = null;
    byId('dashboard').hidden = true; byId('login').hidden = false;
    note(t('status.signedOut'));
  } catch (error) { note(localizedError(error.message), true); }
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
  try {
    const session = await api('/api/session');
    csrf = session.csrf;
    await refresh();
  } catch {
    byId('login').hidden = false;
  }
})();
