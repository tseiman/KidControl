const byId = (id) => document.getElementById(id);
let csrf = '';
let state = null;
let lastSync = Date.now();

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

function statusLine(device) {
  const line = document.createElement('p');
  line.className = 'device-status';
  line.textContent = `Power: ${device.power} · Network: ${device.acl}`;
  return line;
}

async function refresh() {
  state = await api('/api/status');
  lastSync = Date.now();
  byId('login').hidden = true;
  byId('dashboard').hidden = false;
  byId('remaining').textContent = state.unlimited ? 'Unlimited' : format(state.remainingSeconds);
  byId('devices').replaceChildren(...state.devices.map((device) => {
    const card = document.createElement('article');
    const active = device.id === state.activeDeviceId;
    card.className = `device${active ? ' active' : ''}`;
    const details = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = device.displayName;
    details.append(title, statusLine(device));
    const button = document.createElement('button');
    button.textContent = active ? 'Active' : 'Start';
    button.disabled = active || (state.me.role !== 'superuser' && device.power !== 'on');
    button.onclick = () => mutate('/api/claim', { deviceId: device.id });
    card.append(details, button);
    return card;
  }));
  byId('stop').hidden = !state.activeDeviceId;
  byId('admin').hidden = state.me.role !== 'superuser';
  if (state.users) {
    byId('target').replaceChildren(...state.users.map((user) => new Option(
      `${user.displayName} — ${format(user.remainingSeconds)}`, user.id
    )));
  }
}

async function mutate(path, value = {}) {
  try {
    await api(path, { method: 'POST', body: JSON.stringify(value) });
    note('State updated.');
    await refresh();
  } catch (error) { note(error.message, true); }
}

byId('login-form').onsubmit = async (event) => {
  event.preventDefault();
  try {
    const result = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ userId: byId('user').value, pin: byId('pin').value })
    });
    csrf = result.csrf;
    byId('pin').value = '';
    await refresh();
  } catch (error) { note(error.message, true); }
};
byId('stop').onclick = () => mutate('/api/stop');
byId('restore').onclick = () => mutate('/api/admin/restore');
byId('logout').onclick = async () => {
  try {
    await api('/api/logout', { method: 'POST', body: '{}' });
    csrf = ''; state = null;
    byId('dashboard').hidden = true; byId('login').hidden = false;
    note('Signed out.');
  } catch (error) { note(error.message, true); }
};
byId('adjust').onsubmit = (event) => {
  event.preventDefault();
  const seconds = (Number(byId('hours').value) * 60 + Number(byId('minutes').value)) * 60;
  void mutate('/api/admin/adjust', { userId: byId('target').value, remainingSeconds: seconds });
};
for (let value = 0; value <= 24; value++) byId('hours').append(new Option(String(value).padStart(2, '0'), String(value)));
for (let value = 0; value < 60; value++) byId('minutes').append(new Option(String(value).padStart(2, '0'), String(value)));

setInterval(() => {
  if (state && !state.unlimited && state.activeDeviceId) {
    byId('remaining').textContent = format(state.remainingSeconds - (Date.now() - lastSync) / 1000);
  }
}, 1000);
setInterval(() => {
  if (state) void refresh().catch((error) => note(error.message, true));
}, 10_000);

(async () => {
  const choices = await api('/api/public');
  byId('user').replaceChildren(...choices.users.map((user) => new Option(user.displayName, user.id)));
  try {
    const session = await api('/api/session');
    csrf = session.csrf;
    await refresh();
  } catch {
    byId('login').hidden = false;
  }
})();
