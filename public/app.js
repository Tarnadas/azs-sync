import qrcode from './vendor/qrcode.mjs';

const app = document.querySelector('#app');
const toastEl = document.querySelector('#toast');

const state = {
  config: null,
  me: null,
  pairingToken: null,
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

async function registerPasskey(name, turnstileToken) {
  if (!window.PublicKeyCredential) {
    throw new Error('This browser does not support passkeys.');
  }
  const options = await api('/api/auth/register/options', {
    method: 'POST',
    body: { name, turnstileToken },
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

let turnstileLoader = null;

function loadTurnstile() {
  if (!state.config?.turnstileSiteKey) return Promise.resolve(null);
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileLoader) return turnstileLoader;
  turnstileLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => resolve(window.turnstile);
    script.onerror = () => reject(new Error('Could not load the verification widget.'));
    document.head.append(script);
  });
  return turnstileLoader;
}

function turnstileWidget() {
  if (!state.config?.turnstileSiteKey) return null;
  const holder = {
    el: h('div', { class: 'turnstile' }),
    token: null,
    widget: null,
    reset() {
      this.token = null;
      if (window.turnstile && this.widget !== null) window.turnstile.reset(this.widget);
    },
  };
  loadTurnstile()
    .then((turnstile) => {
      if (!turnstile) return;
      holder.widget = turnstile.render(holder.el, {
        sitekey: state.config.turnstileSiteKey,
        theme: 'dark',
        callback: (token) => {
          holder.token = token;
        },
        'expired-callback': () => {
          holder.token = null;
        },
        'error-callback': () => {
          holder.token = null;
        },
      });
    })
    .catch(() => {
      holder.el.append(h('div', { class: 'muted small' }, 'Verification widget unavailable.'));
    });
  return holder;
}

function challengeOk(holder) {
  if (!state.config?.turnstileSiteKey) return true;
  if (!holder?.token) {
    toast('Complete the verification challenge first.', true);
    return false;
  }
  return true;
}

function recoveryForm() {
  const input = h('input', {
    class: 'input mono',
    type: 'password',
    autocomplete: 'one-time-code',
    placeholder: 'Recovery code',
  });
  const challenge = turnstileWidget();
  const button = h('button', { class: 'btn', type: 'submit' }, 'Use recovery code');
  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (event) => {
        event.preventDefault();
        if (!challengeOk(challenge)) return;
        button.disabled = true;
        try {
          await api('/api/auth/recovery', {
            method: 'POST',
            body: { code: input.value.trim(), turnstileToken: challenge?.token },
          });
          location.reload();
        } catch (error) {
          displayError(error);
          challenge?.reset();
        } finally {
          button.disabled = false;
        }
      },
    },
    input,
    challenge?.el,
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
    h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Optional recovery code'), h('p', { class: 'muted small' }, 'Use this to sign in on a device that does not have your passkey. It is shown once; creating a new code replaces the old one.'))),
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

function createAccountCard() {
  const name = h('input', {
    id: 'account-name',
    class: 'input',
    type: 'text',
    maxlength: '60',
    placeholder: 'Your name',
    autocomplete: 'nickname',
    value: '',
  });
  const challenge = turnstileWidget();
  const create = h('button', { class: 'btn btn-primary' }, 'Create account with a passkey');
  create.addEventListener('click', async () => {
    if (!challengeOk(challenge)) return;
    create.disabled = true;
    try {
      await registerPasskey(name.value.trim() || 'Player', challenge?.token);
      location.reload();
    } catch (error) {
      displayError(error);
      challenge?.reset();
    } finally {
      create.disabled = false;
    }
  });

  const card = h(
    'section',
    { class: 'card stack' },
    h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Create an account'), h('p', { class: 'muted small' }, 'Each person gets their own account, pairing QR, save history, and optional recovery code. Use a passkey (fingerprint, face, or device PIN).'))),
    h('div', { class: 'field' }, h('label', { for: 'account-name' }, 'Display name'), name),
    challenge?.el,
    create,
  );
  if (!window.PublicKeyCredential) {
    card.append(h('div', { class: 'notice error' }, h('p', {}, 'This browser does not support WebAuthn passkeys. Use a current Chromium, Safari, or Firefox browser.')));
  }
  return card;
}

function signInCard() {
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

  const recoveryHost = h('div', { class: 'stack', hidden: true });
  const showRecovery = h('button', { class: 'btn btn-ghost btn-sm' }, 'Use a recovery code');
  showRecovery.addEventListener('click', () => {
    if (!recoveryHost.firstChild) recoveryHost.append(recoveryForm());
    recoveryHost.hidden = false;
    showRecovery.hidden = true;
  });

  return h(
    'section',
    { class: 'card stack' },
    h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Sign in'), h('p', { class: 'muted small' }, 'Use a passkey registered to any account on this service. The browser will let you choose the account.'))),
    signIn,
    h('p', { class: 'muted small' }, 'Lost the passkey on this device? If you created an optional recovery code, you can use it below.'),
    showRecovery,
    recoveryHost,
    h('p', { class: 'muted small' }, 'The game itself has no login. This account only protects the sync service.'),
  );
}

function howItWorksCard() {
  return h(
    'section',
    { class: 'card plain stack' },
    h('h2', {}, 'How it works'),
    h(
      'ol',
      { class: 'steps' },
      h('li', {}, h('strong', {}, 'Create an account '), 'with a passkey.'),
      h('li', {}, h('strong', {}, 'Optional: '), 'click Recovery code on the dashboard if you want a fallback for a device without your passkey.'),
      h('li', {}, h('strong', {}, 'Open the dashboard '), 'after signing in. It already shows a phone setup QR.'),
      h('li', {}, h('strong', {}, 'Scan the QR '), 'with your phone. The setup page walks through Vivaldi, Tampermonkey, the userscript, and the game.'),
      h('li', {}, h('strong', {}, 'Play normally. '), 'The script compares the sealed save and pushes or pulls when it changes.'),
      h('li', {}, h('strong', {}, 'Brave Android? '), 'Skip the QR and use manual transfer on the dashboard.'),
    ),
    h('div', { class: 'notice' }, h('p', {}, 'Every account has its own account-level pairing QR, save, and history. Importing a save replaces the whole account; this tool never merges two saves.')),
  );
}

function renderAuth(error = null) {
  clear(app);
  app.append(
    h(
      'div',
      { class: 'hero' },
      h('h1', {}, 'Your save, on every device.'),
      h('p', {}, 'Azeroth Survivors keeps its account in the browser. This service syncs that sealed save through a private, passkey-protected account — desktop to phone and back. Anyone can create their own account.'),
    ),
  );

  app.append(
    h(
      'div',
      { class: 'stack-lg' },
      h('div', { class: 'grid' }, createAccountCard(), signInCard()),
      howItWorksCard(),
    ),
  );

  if (error) {
    app.append(h('div', { class: 'notice error' }, h('p', {}, error.message || String(error))));
  }
}

function uploadControl() {
  const file = h('input', { type: 'file', accept: '.sav,.txt', class: 'hidden' });
  const button = h('button', { class: 'btn' }, 'Upload .sav');

  async function send(text, force = false) {
    try {
      await api('/api/save', {
        method: 'POST',
        body: { save: text, baseVersion: state.save?.version ?? 0, force },
      });
      toast(force ? 'Save replaced' : 'Save uploaded');
      await loadDashboard();
    } catch (error) {
      if (error.status === 409 && !force) {
        const remote = error.data || {};
        const when = remote.updatedAt ? new Date(remote.updatedAt).toLocaleString() : 'a newer version';
        const replace = confirm(
          `The server has a newer save (v${remote.version ?? '?'}, ${remote.deviceName || 'unknown device'}, ${when}).\n\nReplace it with this file? The current save stays in history.`,
        );
        if (replace) {
          await send(text, true);
        } else {
          toast('Upload cancelled');
        }
        return;
      }
      if (error.status === 409 && force) {
        toast('The server changed again. Refresh and retry.', true);
        return;
      }
      throw error;
    }
  }

  button.addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const picked = file.files?.[0];
    file.value = '';
    if (!picked) return;
    if (picked.size > 65536) {
      toast('That file is too large for a sealed save.', true);
      return;
    }
    let text = '';
    try {
      text = await picked.text();
    } catch {
      toast('Could not read that file.', true);
      return;
    }
    if (!text.startsWith('RSE1:')) {
      toast('That is not a sealed Azeroth Survivors .sav.', true);
      return;
    }
    button.disabled = true;
    try {
      await send(text);
    } catch (error) {
      displayError(error);
    } finally {
      button.disabled = false;
    }
  });

  return h(
    'div',
    { class: 'row' },
    button,
    file,
    h('span', { class: 'muted small' }, 'Export from the game, then upload the .sav here.'),
  );
}

function saveCard() {
  const save = state.save;
  const manualNote = h(
    'p',
    { class: 'muted small' },
    'Manual mode: no userscript? Export from the game, upload here, then download the file on the other device and import it. Works in Brave for Android without extensions.',
  );

  if (!save || save.version === 0) {
    return h(
      'section',
      { class: 'card stack' },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Manual transfer'), h('p', { class: 'muted small' }, 'Upload/download a sealed .sav. No userscript or pairing link needed.'))),
      h('div', { class: 'empty' }, 'No save yet. Upload an exported .sav below, or pair a device and play a run.'),
      uploadControl(),
      manualNote,
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
      h('div', {}, h('h2', {}, 'Manual transfer'), h('p', { class: 'muted small' }, 'The current sealed account. Upload/download a .sav for Brave Android or any browser without the userscript.')),
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
    uploadControl(),
    manualNote,
  );
}

function qrDataUrl(link) {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(link);
    qr.make();
    return qr.createDataURL(4, 4);
  } catch {
    return null;
  }
}

function setupLinkForAccount() {
  if (!state.pairingToken) return null;
  return `${location.origin}/pair#t=${encodeURIComponent(state.pairingToken)}`;
}

function phoneSyncCard() {
  const setupLink = setupLinkForAccount();
  const qr = setupLink ? qrDataUrl(setupLink) : null;

  const copy = h('button', { class: 'btn' }, 'Copy phone setup link');
  copy.disabled = !setupLink;
  copy.addEventListener('click', () => copyText(setupLink, 'Phone setup link copied'));

  const open = h('a', {
    class: 'btn',
    href: setupLink || '#',
    target: '_blank',
    rel: 'noopener',
  }, 'Open setup page on this device');
  if (!setupLink) open.setAttribute('aria-disabled', 'true');
  open.addEventListener('click', (event) => {
    if (!setupLink) {
      event.preventDefault();
      toast('Pairing link is not available yet.', true);
    }
  });

  const reset = h('button', { class: 'btn btn-danger btn-sm' }, 'Reset QR');
  reset.disabled = !setupLink;
  reset.addEventListener('click', async () => {
    if (!confirm('Reset this pairing QR? Older scans and userscripts paired with it will stop syncing. The save stays on the server.')) return;
    reset.disabled = true;
    try {
      const result = await api('/api/pairing/reset', { method: 'POST' });
      state.pairingToken = result.token;
      toast('Pairing QR reset');
      renderDashboard();
    } catch (error) {
      displayError(error);
    } finally {
      reset.disabled = false;
    }
  });

  return h(
    'section',
    { class: 'card stack' },
    h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Sync to your phone'), h('p', { class: 'muted small' }, 'Scan this with your phone camera. It opens a setup page that walks through Vivaldi, Tampermonkey, the userscript, and the game link. No create-device step.'))),
    qr
      ? h('div', { class: 'qr-wrap' }, h('img', { class: 'qr', src: qr, alt: 'Phone setup QR code', width: '280', height: '280' }))
      : h('div', { class: 'notice error' }, h('p', {}, 'Could not draw the QR code. Use Copy phone setup link below.')),
    h('div', { class: 'row' }, copy, open, reset),
    h('div', { class: 'notice' }, h('p', {}, 'This QR is your account pairing key. Treat it like a password; anyone with it can sync this account. Reset it to invalidate old scans.')),
    h('p', { class: 'muted small' }, 'The phone needs no passkey or dashboard login. Scan the QR; the setup page includes automatic sync and a token-authorized Manual transfer fallback.'),
    h('p', { class: 'muted small' }, 'On a desktop, open the setup page to install Tampermonkey and the userscript. On Brave for Android, use Manual transfer; automatic sync needs Vivaldi or another Chromium browser with extensions.'),
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
          h('thead', {}, h('tr', {}, h('th', {}, 'Version'), h('th', {}, 'When'), h('th', {}, 'Previous device'), h('th', {}, 'Reason'), h('th', {}, 'Size'), h('th', {}, ''))),
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
    : h('div', { class: 'empty' }, 'No previous versions yet. The current save is shown above.');

  return h(
    'section',
    { class: 'card stack' },
    h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'History'), h('p', { class: 'muted small' }, 'Previous versions replaced by a sync. The current save is in the Manual transfer card above. Every download is a sealed save the game can import.'))),
    content,
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

  const recovery = h('button', { class: 'btn btn-sm' }, 'Recovery code');
  recovery.addEventListener('click', async () => {
    if (!confirm('Create a new recovery code? Any previous recovery code for this account will stop working.')) return;
    recovery.disabled = true;
    try {
      const result = await api('/api/account/recovery', { method: 'POST' });
      showRecoveryCode(result.recoveryCode);
    } catch (error) {
      displayError(error);
    } finally {
      recovery.disabled = false;
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
    h('div', { class: 'row' }, addPasskey, recovery, logout),
  );
}

async function loadDashboard() {
  const [pairing, history, save] = await Promise.all([
    api('/api/pairing'),
    api('/api/history'),
    api('/api/save'),
  ]);
  state.pairingToken = pairing.token;
  state.history = history.items || [];
  state.save = save;
  renderDashboard();
}

function renderDashboard() {
  clear(app);
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const stack = h(
    'div',
    { class: 'stack-lg' },
    dashboardHeader(),
  );
  if (isLocal) {
    stack.append(
      h(
        'div',
        { class: 'notice error' },
        h('p', {}, h('strong', {}, 'This dashboard is running on localhost. '), 'A phone cannot reach it. Deploy the Worker and use the deployed URL before pairing a phone or using manual transfer on another device.'),
        h('p', {}, 'A passkey created on localhost is bound to localhost; create the account again on the deployed URL.'),
      ),
    );
  }
  stack.append(phoneSyncCard(), saveCard(), historyCard());
  app.append(stack);
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
