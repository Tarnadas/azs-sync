const app = document.querySelector('#app');
const toastEl = document.querySelector('#toast');

const state = {
  config: null,
  me: null,
  devices: [],
  history: [],
  save: null,
};

let toastTimer = 0;

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'value') node.value = value;
    else if (key === 'checked') node.checked = Boolean(value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function fmtDate(ms) {
  if (!ms) return 'never';
  return new Date(Number(ms)).toLocaleString();
}

function fmtBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function shortHash(hash) {
  if (!hash) return '—';
  return `${hash.slice(0, 8)}…`;
}

function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = `toast${isError ? ' error' : ''}`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 4200);
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    const error = new Error(data.error || response.statusText || 'request failed');
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function b64urlEncodeBytes(bytes) {
  let binary = '';
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlEncodeText(value) {
  return b64urlEncodeBytes(new TextEncoder().encode(value));
}

function b64urlToBuf(value) {
  const normal = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normal + '='.repeat((4 - (normal.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function displayError(error) {
  if (error?.name === 'NotAllowedError') {
    toast('Passkey prompt was cancelled.', true);
    return;
  }
  toast(error?.message || 'Something went wrong.', true);
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  const anchor = h('a', { href: url, download: name, class: 'hidden' });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function copyText(value, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(value);
    toast(label);
  } catch {
    const area = h('textarea', { class: 'offscreen', value });
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    toast(label);
  }
}

function prepareCreationOptions(options) {
  const publicKey = { ...options };
  publicKey.challenge = b64urlToBuf(publicKey.challenge);
  publicKey.user = { ...publicKey.user, id: b64urlToBuf(publicKey.user.id) };
  if (Array.isArray(publicKey.excludeCredentials)) {
    publicKey.excludeCredentials = publicKey.excludeCredentials.map((credential) => ({
      ...credential,
      id: b64urlToBuf(credential.id),
    }));
  }
  return publicKey;
}

function prepareRequestOptions(options) {
  const publicKey = { ...options };
  publicKey.challenge = b64urlToBuf(publicKey.challenge);
  if (Array.isArray(publicKey.allowCredentials)) {
    publicKey.allowCredentials = publicKey.allowCredentials.map((credential) => ({
      ...credential,
      id: b64urlToBuf(credential.id),
    }));
  }
  return publicKey;
}

function registrationResponse(credential) {
  const response = {
    clientDataJSON: b64urlEncodeBytes(credential.response.clientDataJSON),
    attestationObject: b64urlEncodeBytes(credential.response.attestationObject),
  };
  if (typeof credential.response.getTransports === 'function') {
    response.transports = credential.response.getTransports();
  }
  return {
    id: credential.id,
    rawId: b64urlEncodeBytes(credential.rawId),
    type: credential.type,
    response,
    clientExtensionResults: credential.getClientExtensionResults
      ? credential.getClientExtensionResults()
      : {},
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
  };
}

function authenticationResponse(credential) {
  return {
    id: credential.id,
    rawId: b64urlEncodeBytes(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: b64urlEncodeBytes(credential.response.clientDataJSON),
      authenticatorData: b64urlEncodeBytes(credential.response.authenticatorData),
      signature: b64urlEncodeBytes(credential.response.signature),
      userHandle: credential.response.userHandle
        ? b64urlEncodeBytes(credential.response.userHandle)
        : undefined,
    },
    clientExtensionResults: credential.getClientExtensionResults
      ? credential.getClientExtensionResults()
      : {},
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
  };
}

async function registerPasskey(name) {
  if (!window.PublicKeyCredential) {
    throw new Error('This browser does not support passkeys.');
  }
  const options = await api('/api/auth/register/options', {
    method: 'POST',
    body: { name },
  });
  const publicKey = prepareCreationOptions(options.publicKey);
  const credential = await navigator.credentials.create({ publicKey });
  if (!credential) throw new Error('No passkey was created.');
  return api('/api/auth/register/verify', {
    method: 'POST',
    body: { response: registrationResponse(credential) },
  });
}

async function loginPasskey() {
  if (!window.PublicKeyCredential) {
    throw new Error('This browser does not support passkeys.');
  }
  const options = await api('/api/auth/login/options', { method: 'POST' });
  const publicKey = prepareRequestOptions(options.publicKey);
  const credential = await navigator.credentials.get({ publicKey });
  if (!credential) throw new Error('No passkey was returned.');
  await api('/api/auth/login/verify', {
    method: 'POST',
    body: { response: authenticationResponse(credential) },
  });
}

function recoveryForm() {
  if (!state.config?.recovery) return null;
  const input = h('input', {
    class: 'input mono',
    type: 'password',
    autocomplete: 'one-time-code',
    placeholder: 'Recovery code',
  });
  const button = h('button', { class: 'btn', type: 'submit' }, 'Use recovery code');
  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (event) => {
        event.preventDefault();
        button.disabled = true;
        try {
          await api('/api/auth/recovery', {
            method: 'POST',
            body: { code: input.value.trim() },
          });
          location.reload();
        } catch (error) {
          displayError(error);
        } finally {
          button.disabled = false;
        }
      },
    },
    input,
    button,
  );
  return form;
}

function showRecoveryCode(code) {
  const codeInput = h('input', { class: 'input mono', readonly: true, value: code, spellcheck: 'false' });
  const copy = h('button', { class: 'btn' }, 'Copy code');
  copy.addEventListener('click', () => copyText(code, 'Recovery code copied'));

  const downloadButton = h('button', { class: 'btn' }, 'Download .txt');
  downloadButton.addEventListener('click', () => {
    download(
      'AZS-recovery-code.txt',
      `AZS Sync recovery code\n\n${code}\n\nUse this to sign in if your passkey is unavailable.\nKeep it somewhere safe. Anyone with this code can access your sync account.\n`,
    );
    toast('Recovery code downloaded');
  });

  const continueButton = h('button', { class: 'btn btn-primary' }, 'I saved it — continue');
  const backdrop = h('div', { class: 'modal-backdrop' });
  const modal = h(
    'div',
    { class: 'modal stack' },
    h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Save your recovery code'), h('p', { class: 'muted small' }, 'This is the only way to sign in on a device that does not have your passkey. It is shown once.'))),
    h('div', { class: 'token-box' }, h('div', { class: 'field' }, h('label', {}, 'Recovery code'), h('div', { class: 'token-value' }, codeInput, copy))),
    h('div', { class: 'row' }, downloadButton),
    h('div', { class: 'notice' }, h('p', {}, 'Store it like a password. It can recover the sync account, but it cannot recover a game save that was never uploaded.')),
    h('div', { class: 'row' }, continueButton),
  );
  continueButton.addEventListener('click', () => {
    backdrop.remove();
    location.reload();
  });
  backdrop.append(modal);
  document.body.append(backdrop);
}

function authCard() {
  if (state.config?.hasUsers) {
    const signIn = h('button', { class: 'btn btn-primary' }, 'Sign in with a passkey');
    signIn.addEventListener('click', async () => {
      signIn.disabled = true;
      try {
        await loginPasskey();
        location.reload();
      } catch (error) {
        displayError(error);
      } finally {
        signIn.disabled = false;
      }
    });
    return h(
      'section',
      { class: 'card stack' },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Sign in'), h('p', { class: 'muted small' }, 'Use the passkey you created for this sync account.'))),
      signIn,
      h('p', { class: 'muted small' }, 'Lost the passkey on this device? Use the recovery code you saved when creating the account, then add a new passkey from the dashboard.'),
      recoveryForm(),
      h('p', { class: 'muted small' }, 'The game itself has no login. This account only protects the sync service.'),
    );
  }

  const name = h('input', {
    id: 'account-name',
    class: 'input',
    type: 'text',
    maxlength: '60',
    placeholder: 'Your name',
    autocomplete: 'nickname',
    value: '',
  });
  const create = h('button', { class: 'btn btn-primary' }, 'Create account with a passkey');
  create.addEventListener('click', async () => {
    create.disabled = true;
    try {
      const result = await registerPasskey(name.value.trim() || 'Player');
      if (result?.recoveryCode) showRecoveryCode(result.recoveryCode);
      else location.reload();
    } catch (error) {
      displayError(error);
    } finally {
      create.disabled = false;
    }
  });

  const card = h(
    'section',
    { class: 'card stack' },
    h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Create your sync account'), h('p', { class: 'muted small' }, 'Use a passkey (fingerprint, face, or device PIN). There is no password to remember.'))),
    h('div', { class: 'field' }, h('label', { for: 'account-name' }, 'Display name'), name),
    create,
  );
  if (!window.PublicKeyCredential) {
    card.append(h('div', { class: 'notice error' }, h('p', {}, 'This browser does not support WebAuthn passkeys. Use a current Chromium, Safari, or Firefox browser.')));
  }
  const recovery = recoveryForm();
  if (recovery) {
    card.append(h('hr', { class: 'divider' }));
    card.append(h('p', { class: 'muted small' }, 'No passkey provider on this device? Use the recovery token configured by the server operator.'));
    card.append(recovery);
  }
  return card;
}

function renderAuth(error = null) {
  clear(app);
  app.append(
    h(
      'div',
      { class: 'hero' },
      h('h1', {}, 'Your save, on every device.'),
      h('p', {}, 'Azeroth Survivors keeps its account in the browser. This service syncs that sealed save through a private, passkey-protected account — desktop to phone and back.'),
    ),
  );

  const grid = h('div', { class: 'grid' });
  grid.append(authCard());
  grid.append(
    h(
      'section',
      { class: 'card plain stack' },
      h('h2', {}, 'How it works'),
      h(
        'ol',
        { class: 'steps' },
        h('li', {}, h('strong', {}, 'Create an account '), 'with a passkey.'),
        h('li', {}, h('strong', {}, 'Create a device '), 'and open its pairing link on the game page.'),
        h('li', {}, h('strong', {}, 'Install the userscript '), 'in the browser you play in.'),
        h('li', {}, h('strong', {}, 'Play normally. '), 'The script compares the sealed save and pushes or pulls when it changes.'),
      ),
      h('div', { class: 'notice' }, h('p', {}, 'Importing a save replaces the whole account. This tool never merges two saves; when both devices have new progress it asks which one to keep and stores the other in history.')),
    ),
  );

  if (error) {
    app.append(h('div', { class: 'notice error' }, h('p', {}, error.message || String(error))));
  }
  app.append(grid);
}

function saveCard() {
  const save = state.save;
  if (!save || save.version === 0) {
    return h(
      'section',
      { class: 'card stack' },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Save'), h('p', { class: 'muted small' }, 'The current sealed account on this sync service.'))),
      h('div', { class: 'empty' }, 'No save yet. Pair a device and play a run; the userscript will upload the first save.'),
    );
  }

  const downloadButton = h('button', { class: 'btn' }, 'Download current .sav');
  downloadButton.addEventListener('click', () => {
    download(`AzerothSurvivors-sync-v${save.version}.sav`, save.save);
    toast('Save downloaded');
  });

  return h(
    'section',
    { class: 'card stack' },
    h(
      'div',
      { class: 'card-head' },
      h('div', {}, h('h2', {}, 'Save'), h('p', { class: 'muted small' }, 'The current sealed account on this sync service.')),
      h('span', { class: 'badge gold' }, `v${save.version}`),
    ),
    h(
      'div',
      { class: 'row' },
      h('span', { class: 'muted small' }, `Updated ${fmtDate(save.updatedAt)}`),
      h('span', { class: 'muted small' }, `by ${save.deviceName || 'unknown device'}`),
      h('span', { class: 'muted small' }, `${fmtBytes(save.save?.length || 0)} sealed`),
      h('span', { class: 'muted small mono' }, `sha256 ${shortHash(save.hash)}`),
    ),
    h('div', { class: 'row' }, downloadButton),
  );
}

function deviceItem(device) {
  const revoke = h('button', { class: 'btn btn-danger btn-sm' }, 'Revoke');
  revoke.addEventListener('click', async () => {
    if (!confirm(`Revoke "${device.name}"? Its userscript will stop syncing.`)) return;
    revoke.disabled = true;
    try {
      await api(`/api/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' });
      toast('Device revoked');
      await loadDashboard();
    } catch (error) {
      displayError(error);
      revoke.disabled = false;
    }
  });
  return h(
    'div',
    { class: 'item' },
    h(
      'div',
      { class: 'item-main' },
      h('span', { class: 'item-title' }, device.name),
      h('span', { class: 'item-sub' }, `Created ${fmtDate(device.createdAt)} · last seen ${fmtDate(device.lastSeenAt)}${device.lastVersion ? ` · v${device.lastVersion}` : ''}`),
    ),
    h('div', { class: 'item-actions' }, revoke),
  );
}

function showDeviceModal(created) {
  const payload = {
    a: location.origin,
    t: created.token,
    n: created.device.name,
  };
  const pairingLink = `https://wow.aethus.pl/#azs-pair=${b64urlEncodeText(JSON.stringify(payload))}`;

  const tokenInput = h('input', { class: 'input mono', readonly: true, value: created.token, spellcheck: 'false' });
  const linkInput = h('input', { class: 'input mono', readonly: true, value: pairingLink, spellcheck: 'false' });

  const copyToken = h('button', { class: 'btn btn-sm' }, 'Copy token');
  copyToken.addEventListener('click', () => copyText(created.token, 'Device token copied'));
  const copyLink = h('button', { class: 'btn btn-sm' }, 'Copy pairing link');
  copyLink.addEventListener('click', () => copyText(pairingLink, 'Pairing link copied'));

  const install = h('a', { class: 'btn btn-sm', href: '/azs-sync.user.js', target: '_blank', rel: 'noopener' }, 'Install userscript');
  const open = h('a', { class: 'btn btn-primary btn-sm', href: pairingLink, target: '_blank', rel: 'noopener' }, 'Open game & pair');
  const done = h('button', { class: 'btn' }, 'Done');

  const backdrop = h('div', { class: 'modal-backdrop' });
  const modal = h(
    'div',
    { class: 'modal stack' },
    h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Device created'), h('p', { class: 'muted small' }, 'The token is shown once. Copy it or open the pairing link now.'))),
    h(
      'div',
      { class: 'token-box' },
      h('div', { class: 'field' }, h('label', {}, 'Device token'), h('div', { class: 'token-value' }, tokenInput, copyToken)),
      h('div', { class: 'field' }, h('label', {}, 'Pairing link (opens the game and configures the userscript)'), h('div', { class: 'token-value' }, linkInput, copyLink)),
      h('div', { class: 'row' }, install, open),
    ),
    h('div', { class: 'notice' }, h('p', {}, 'Install Tampermonkey first. On Android, use Vivaldi 8.2+ (or another Chromium browser with extension support); Brave for Android does not support extensions yet.')),
    h('div', { class: 'row' }, done),
  );
  done.addEventListener('click', () => {
    backdrop.remove();
    loadDashboard().catch(displayError);
  });
  backdrop.append(modal);
  document.body.append(backdrop);
}

function installCard() {
  return h(
    'section',
    { class: 'card stack' },
    h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Install the userscript'), h('p', { class: 'muted small' }, 'Desktop: Brave, Chrome, or Edge with Tampermonkey. Android: Vivaldi 8.2+ with Tampermonkey.'))),
    h(
      'ol',
      { class: 'steps' },
      h('li', {}, 'Install ', h('strong', {}, 'Tampermonkey'), ' in the browser you play in.'),
      h('li', {}, 'Click ', h('a', { href: '/azs-sync.user.js', target: '_blank', rel: 'noopener' }, 'azs-sync.user.js'), ' and confirm the install.'),
      h('li', {}, 'Create a device above, then open its ', h('strong', {}, 'pairing link'), ' on the game page.'),
      h('li', {}, 'The script syncs on load and after each save. The small AZS pill in the corner shows its state.'),
    ),
    h('div', { class: 'notice' }, h('p', {}, 'On Android, Vivaldi can install Chrome Web Store extensions. Enable “Desktop site” if the store asks. The game needs WebGPU: Android 12+ with a current Chromium build.')),
  );
}

function historyCard() {
  const rows = state.history || [];
  const content = rows.length
    ? h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Version'), h('th', {}, 'When'), h('th', {}, 'Device'), h('th', {}, 'Reason'), h('th', {}, 'Size'), h('th', {}, ''))),
          h(
            'tbody',
            {},
            ...rows.map((item) => {
              const button = h('button', { class: 'btn btn-sm' }, 'Download');
              button.addEventListener('click', async () => {
                button.disabled = true;
                try {
                  const full = await api(`/api/history/${item.id}`);
                  download(`AzerothSurvivors-v${item.version}-${item.id}.sav`, full.save);
                  toast('Version downloaded');
                } catch (error) {
                  displayError(error);
                } finally {
                  button.disabled = false;
                }
              });
              return h(
                'tr',
                {},
                h('td', { class: 'mono' }, `v${item.version}`),
                h('td', { class: 'muted' }, fmtDate(item.createdAt)),
                h('td', {}, item.deviceName || 'unknown'),
                h('td', { class: 'muted' }, item.reason),
                h('td', { class: 'muted' }, fmtBytes(item.size)),
                h('td', {}, button),
              );
            }),
          ),
        ),
      )
    : h('div', { class: 'empty' }, 'No history yet. Each push or overwrite keeps the previous version here.');

  return h(
    'section',
    { class: 'card stack' },
    h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'History'), h('p', { class: 'muted small' }, 'The last 50 versions. Every download is a sealed save the game can import.'))),
    content,
  );
}

function createDeviceCard() {
  const name = h('input', {
    class: 'input',
    type: 'text',
    maxlength: '60',
    placeholder: 'Device name',
    value: /Android|iPhone|iPad/i.test(navigator.userAgent) ? 'Phone' : 'Desktop',
  });
  const create = h('button', { class: 'btn btn-primary' }, 'Create device');
  create.addEventListener('click', async () => {
    create.disabled = true;
    try {
      const created = await api('/api/devices', {
        method: 'POST',
        body: { name: name.value.trim() || 'Device' },
      });
      showDeviceModal(created);
    } catch (error) {
      displayError(error);
    } finally {
      create.disabled = false;
    }
  });

  return h(
    'section',
    { class: 'card stack' },
    h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Devices'), h('p', { class: 'muted small' }, 'Each browser install gets its own token. Revoke one without touching the others.'))),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, name), create),
    state.devices.length ? h('div', { class: 'list' }, ...state.devices.map(deviceItem)) : h('div', { class: 'empty' }, 'No devices yet. Create one above.'),
  );
}

function dashboardHeader() {
  const addPasskey = h('button', { class: 'btn btn-sm' }, 'Add passkey');
  addPasskey.addEventListener('click', async () => {
    addPasskey.disabled = true;
    try {
      const result = await registerPasskey(state.me.user.name);
      if (result?.recoveryCode) showRecoveryCode(result.recoveryCode);
      else toast('Passkey added');
    } catch (error) {
      displayError(error);
    } finally {
      addPasskey.disabled = false;
    }
  });

  const logout = h('button', { class: 'btn btn-sm' }, 'Log out');
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    try {
      await api('/api/auth/logout', { method: 'POST' });
      location.reload();
    } catch (error) {
      displayError(error);
      logout.disabled = false;
    }
  });

  return h(
    'div',
    { class: 'row-between' },
    h(
      'div',
      {},
      h('h1', {}, 'Sync dashboard'),
      h('p', { class: 'muted small' }, `Signed in as ${state.me.user.name}. The save is sealed end to end; this service only stores the blob.`),
    ),
    h('div', { class: 'row' }, addPasskey, logout),
  );
}

async function loadDashboard() {
  const [devices, history, save] = await Promise.all([
    api('/api/devices'),
    api('/api/history'),
    api('/api/save'),
  ]);
  state.devices = devices.items || [];
  state.history = history.items || [];
  state.save = save;
  renderDashboard();
}

function renderDashboard() {
  clear(app);
  app.append(
    h(
      'div',
      { class: 'stack-lg' },
      dashboardHeader(),
      saveCard(),
      h('div', { class: 'grid' }, createDeviceCard(), installCard()),
      historyCard(),
    ),
  );
}

async function init() {
  try {
    const [config, me] = await Promise.all([api('/api/config'), api('/api/me')]);
    state.config = config;
    state.me = me;
    if (me.authenticated) {
      await loadDashboard();
    } else {
      renderAuth();
    }
  } catch (error) {
    clear(app);
    app.append(
      h(
        'section',
        { class: 'card stack' },
        h('h1', {}, 'Cannot reach the sync service'),
        h('p', { class: 'muted' }, error.message || String(error)),
      ),
    );
  }
}

init();
