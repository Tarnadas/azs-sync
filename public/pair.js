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
const deviceName = isMobile ? 'Phone' : 'Desktop';

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
        el('div', { class: 'pair-title' }, el('h1', {}, 'This setup link is incomplete'), el('p', {}, 'Open the QR or copy the phone setup link from your sync dashboard.')),
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
    card.append(el('div', { class: 'pair-status' }, el('span', { class: 'badge gold' }, 'This browser'), el('span', { class: 'muted small' }, 'Use manual transfer on the dashboard.')));
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
        el('p', {}, 'No extensions? Use Manual transfer on the dashboard instead: export a .sav from the game, upload it, then import it on the other device.'),
        el('div', { class: 'row' }, linkButton('Open manual dashboard', dashboard, false, true)),
      ),
    );
  } else if (isIOS) {
    card.append(
      el('div', { class: 'notice' }, el('p', {}, 'iOS browsers cannot install this userscript. Use manual transfer on the dashboard.')),
      el('div', { class: 'row' }, linkButton('Open manual dashboard', dashboard, true, true)),
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

  card.append(
    el(
      'div',
      { class: 'notice pair-note' },
      el('p', {}, 'This setup link is your account pairing key. Anyone who has it can sync this account. Treat it like a password.'),
      el('div', { class: 'row' }, copySetup, copyGame),
    ),
    el('p', { class: 'pair-foot' }, 'You can reset the QR from the dashboard if this link leaks. The save itself stays on the server.'),
  );

  root.append(card);
}

render();
