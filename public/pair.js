const root = document.querySelector('#pair');

const token = new URLSearchParams(location.hash.slice(1)).get('t') || '';
const setupLink = location.href;
const dashboard = location.origin + '/';
const gameUrl = 'https://wow.aethus.pl/';
const vivaldiStore = 'https://play.google.com/store/apps/details?id=com.vivaldi.browser';
const tampermonkeyStore = 'https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo';

const ua = navigator.userAgent;
const isAndroid = /Android/i.test(ua);
const isIOS = /iPhone|iPad|iPod/i.test(ua);
const isMobile = isAndroid || isIOS;
const isVivaldi = /Vivaldi/i.test(ua);
const isDesktop = !isMobile;
const deviceName = isAndroid ? 'Android' : isIOS ? 'iOS' : 'Desktop';

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
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

function b64url(text) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function copy(value, message) {
  try {
    await navigator.clipboard.writeText(value);
    alert(message);
  } catch {
    const area = el('textarea', { class: 'offscreen' });
    area.value = value;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    alert(message);
  }
}

function step(number, title, body, actions) {
  return el(
    'div',
    { class: 'step' },
    el('div', { class: 'step-num' }, String(number)),
    el('div', {}, el('h3', {}, title), el('p', {}, body), actions ? el('div', { class: 'row' }, actions) : null),
  );
}

async function apiState() {
  const response = await fetch('/api/state', {
    headers: {
      authorization: `Bearer ${token}`,
      'x-azs-device': deviceName,
    },
    cache: 'no-store',
  });
  if (!response.ok) {
    const error = new Error(response.status === 401 ? 'Pairing link was reset or is invalid.' : `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

let currentSave = null;
let manualError = null;
let manualHost = null;

function drawManual() {
  if (!manualHost) return;
  manualHost.textContent = '';
  const box = el(
    'div',
    { class: 'manual-box' },
    el('h3', {}, 'Manual transfer'),
    el('p', { class: 'muted small' }, 'No passkey and no login on this device. The QR link itself authorizes the transfer.'),
  );

  if (manualError) {
    box.append(el('div', { class: 'notice error' }, el('p', {}, manualError.message || String(manualError))));
    const retry = el('button', { class: 'btn btn-sm', type: 'button' }, 'Retry');
    retry.addEventListener('click', refreshManual);
    box.append(retry);
    manualHost.append(box);
    return;
  }

  if (!currentSave) {
    box.append(el('p', { class: 'muted small' }, 'Loading the current save…'));
    manualHost.append(box);
    return;
  }

  if (currentSave.version > 0) {
    box.append(el('p', { class: 'manual-status' }, `Current server save: v${currentSave.version}, ${currentSave.deviceName || 'unknown device'}, ${currentSave.updatedAt ? new Date(currentSave.updatedAt).toLocaleString() : 'unknown time'}.`));
    const downloadButton = el('button', { class: 'btn', type: 'button' }, 'Download current .sav');
    downloadButton.addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([currentSave.save], { type: 'application/octet-stream' }));
      const anchor = el('a', { href: url, download: `AzerothSurvivors-sync-v${currentSave.version}.sav` });
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    });
    box.append(downloadButton);
  } else {
    box.append(el('p', { class: 'manual-status' }, 'No save on the server yet. Export one from the game and upload it below.'));
  }

  const file = el('input', { type: 'file', accept: '.sav,.txt', class: 'hidden' });
  const upload = el('button', { class: 'btn', type: 'button' }, 'Upload exported .sav');
  upload.addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const picked = file.files?.[0];
    file.value = '';
    if (!picked) return;
    if (picked.size > 65536) {
      alert('That file is too large for a sealed save.');
      return;
    }
    const text = await picked.text();
    if (!text.startsWith('RSE1:')) {
      alert('That is not a sealed Azeroth Survivors .sav.');
      return;
    }
    upload.disabled = true;
    try {
      const baseVersion = currentSave?.version ?? 0;
      let response = await fetch('/api/sync', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-azs-device': deviceName,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ baseVersion, save: text }),
      });
      let data = await response.json();
      if (response.status === 409) {
        const replace = confirm(`The server has a newer save (v${data.version}, ${data.deviceName || 'unknown device'}). Replace it with this file? The current save stays in history.`);
        if (!replace) return;
        response = await fetch('/api/force', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'x-azs-device': deviceName,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ baseVersion: data.version, save: text }),
        });
        data = await response.json();
      }
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      alert(`Uploaded v${data.version}.`);
      await refreshManual();
    } catch (error) {
      alert(error.message || 'Upload failed.');
    } finally {
      upload.disabled = false;
    }
  });

  box.append(
    el('div', { class: 'row' }, upload, file),
    el('p', { class: 'muted small' }, 'To push this device: export from the game, then upload. To pull: download here, then game → Options → Saves → Import Save.'),
  );
  manualHost.append(box);
}

async function refreshManual() {
  try {
    currentSave = await apiState();
    manualError = null;
  } catch (error) {
    currentSave = null;
    manualError = error;
  }
  drawManual();
}

function linkButton(label, href, primary = false, external = false) {
  return el('a', {
    class: `btn${primary ? ' btn-primary' : ''}`,
    href,
    ...(external ? { target: '_blank', rel: 'noopener' } : {}),
  }, label);
}

function copyButton(label, value, message) {
  const button = el('button', { class: 'btn', type: 'button' }, label);
  button.addEventListener('click', () => copy(value, message));
  return button;
}

function render() {
  root.textContent = '';
  if (!token || !token.startsWith('azs_')) {
    root.append(
      el(
        'section',
        { class: 'card pair-card stack' },
        el('div', { class: 'pair-title' }, el('h1', {}, 'This setup link is incomplete'), el('p', {}, 'Open the QR or copy the device setup link from your sync dashboard.')),
        linkButton('Open dashboard', dashboard, true),
      ),
    );
    return;
  }

  const payload = { a: location.origin, t: token, n: deviceName };
  const gameLink = `${gameUrl}#azs-pair=${b64url(JSON.stringify(payload))}`;
  const copySetup = copyButton('Copy setup link', setupLink, 'Setup link copied. Open it in Vivaldi.');
  const copyGame = copyButton('Copy game pair link', gameLink, 'Game pair link copied.');

  const card = el(
    'section',
    { class: 'card pair-card stack' },
    el(
      'div',
      { class: 'pair-title' },
      el('h1', {}, 'Set up Azeroth Survivors sync'),
      el('p', {}, 'This page carries your account pairing key. It is in the URL fragment, so it is not sent to the setup server. Treat the link like a password.'),
    ),
  );

  if (isVivaldi) {
    card.append(el('div', { class: 'pair-status' }, el('span', { class: 'badge green' }, 'Vivaldi detected'), el('span', { class: 'muted small' }, 'This browser can run the userscript.')));
  } else if (isDesktop) {
    card.append(el('div', { class: 'pair-status' }, el('span', { class: 'badge green' }, 'Desktop browser'), el('span', { class: 'muted small' }, 'Tampermonkey runs here.')));
  } else if (isAndroid) {
    card.append(el('div', { class: 'pair-status' }, el('span', { class: 'badge gold' }, 'Brave / Chrome on Android'), el('span', { class: 'muted small' }, 'Automatic sync needs Vivaldi, which supports Chrome extensions.')));
  } else {
    card.append(el('div', { class: 'pair-status' }, el('span', { class: 'badge gold' }, 'This browser'), el('span', { class: 'muted small' }, 'Use manual transfer below.')));
  }

  if (isAndroid && !isVivaldi) {
    card.append(
      step(
        1,
        'Install Vivaldi',
        'Vivaldi 8.2+ can install Tampermonkey from the Chrome Web Store. Brave for Android does not support extensions yet.',
        linkButton('Open Vivaldi in the Play Store', vivaldiStore, true, true),
      ),
      step(
        2,
        'Open this setup page in Vivaldi',
        'After Vivaldi is installed, copy this setup link and paste it into Vivaldi’s address bar. If you make Vivaldi your default browser, the QR will open there directly.',
        copyButton('Copy setup link', setupLink, 'Setup link copied. Open it in Vivaldi.'),
      ),
      el(
        'div',
        { class: 'notice pair-note' },
        el('p', {}, 'No extensions? Use Manual transfer below. It needs no passkey or login; this QR link is the key.'),
      ),
    );
  } else if (isIOS) {
    card.append(
      el('div', { class: 'notice' }, el('p', {}, 'iOS browsers cannot install this userscript. Use Manual transfer below; no login is needed.')),
    );
  } else {
    card.append(
      step(
        1,
        'Install Tampermonkey',
        'Install Tampermonkey in this browser. On Vivaldi Android, enable “Desktop site” on the Chrome Web Store if it asks.',
        linkButton('Open Tampermonkey in the Chrome Web Store', tampermonkeyStore, true, true),
      ),
      step(
        2,
        'Install the userscript',
        'Open the userscript in the browser where Tampermonkey is installed, then confirm the install.',
        linkButton('Install azs-sync.user.js', '/azs-sync.user.js', false, false),
      ),
      step(
        3,
        'Open the game and pair',
        'The userscript reads the pairing key from the game link and starts syncing. The AZS pill will be bottom-right in the game.',
        linkButton('Open game & pair', gameLink, true, false),
      ),
    );
  }

  manualHost = el('div');
  card.append(manualHost);
  refreshManual();

  card.append(
    el(
      'div',
      { class: 'notice pair-note' },
      el('p', {}, 'This setup link is your account pairing key. Anyone who has it can sync this account. Treat it like a password.'),
      el('div', { class: 'row' }, copySetup, copyGame),
    ),
    el('p', { class: 'pair-foot' }, 'Neither path needs a passkey on this device. Reset the QR from the dashboard if this link leaks; the save stays on the server.'),
  );

  root.append(card);
}

render();
