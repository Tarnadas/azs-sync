// ==UserScript==
// @name         Azeroth Survivors Sync
// @namespace    https://github.com/azs-sync
// @version      0.1.0
// @description  Two-way sync for the sealed Azeroth Survivors browser save.
// @match        https://wow.aethus.pl/*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.1.0';
  const SAVE_KEY = 'rogue.characters';
  const BACKUP_KEY = 'rogue.characters.backup.1';
  const CONFIG_KEY = 'azs.sync.config';
  const BASE_KEY = 'azs.sync.base';
  const CACHE_KEY = 'azs.sync.cache';
  const LAST_KEY = 'azs.sync.last';

  const POLL_MS = 2500;
  const PUSH_DEBOUNCE_MS = 1800;
  const REMOTE_RETRY_MS = 45000;

  let config = readJson(CONFIG_KEY);
  let syncing = false;
  let queued = null;
  let pushTimer = 0;
  let lastLocal = null;
  let pendingRemote = null;
  let conflictOpen = false;
  let setupOpen = false;
  let retryTimer = 0;

  let host = null;
  let shadow = null;
  let pill = null;
  let pillLabel = null;
  let pillDot = null;
  let panel = null;
  let panelStatus = null;
  let panelDevice = null;
  let panelServer = null;
  let panelLast = null;
  let modal = null;
  let pendingCard = null;

  let statusText = 'Not configured';
  let statusTone = 'idle';

  // ---------------------------------------------------------------- storage

  function readJson(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* quota or private mode */
    }
  }

  function getSave() {
    try {
      const value = localStorage.getItem(SAVE_KEY);
      return value && value.length ? value : null;
    } catch {
      return null;
    }
  }

  function getBase() {
    return readJson(BASE_KEY);
  }

  function getCache() {
    return readJson(CACHE_KEY);
  }

  function writeSave(save) {
    const current = getSave();
    if (current && current !== save) {
      try {
        localStorage.setItem(BACKUP_KEY, current);
      } catch {
        /* ignore */
      }
    }
    localStorage.setItem(SAVE_KEY, save);
  }

  function setBase(state) {
    if (!state?.save) return;
    writeJson(BASE_KEY, { version: state.version, save: state.save });
    writeJson(CACHE_KEY, { version: state.version, save: state.save });
  }

  function markSynced() {
    try {
      localStorage.setItem(LAST_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
  }

  function lastSyncText() {
    try {
      const value = Number(localStorage.getItem(LAST_KEY) || 0);
      if (!value) return 'never';
      return new Date(value).toLocaleString();
    } catch {
      return 'never';
    }
  }

  // ---------------------------------------------------------------- pairing

  function b64urlToBytes(value) {
    const normal = String(value).replace(/-/g, '+').replace(/_/g, '/');
    const padded = normal + '='.repeat((4 - (normal.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function validApi(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    } catch {
      return false;
    }
  }

  function readPairingHash() {
    const match = /^#azs-pair=(.+)$/.exec(location.hash || '');
    if (!match) return null;
    try {
      const data = JSON.parse(new TextDecoder().decode(b64urlToBytes(match[1])));
      if (!data || typeof data.a !== 'string' || typeof data.t !== 'string') return null;
      if (!validApi(data.a) || !String(data.t).startsWith('azs_')) return null;
      return {
        api: data.a.replace(/\/+$/, ''),
        token: String(data.t),
        name: String(data.n || 'Device').slice(0, 60) || 'Device',
      };
    } catch {
      return null;
    }
  }

  function consumePairingHash() {
    const paired = readPairingHash();
    if (!paired) return false;
    if (config && (config.api !== paired.api || config.token !== paired.token)) {
      try {
        localStorage.removeItem(BASE_KEY);
        localStorage.removeItem(CACHE_KEY);
      } catch {
        /* ignore */
      }
    }
    config = paired;
    writeJson(CONFIG_KEY, config);
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch {
      /* ignore */
    }
    return true;
  }

  // ---------------------------------------------------------------- api

  async function api(path, options = {}) {
    if (!config) throw new Error('not configured');
    const hasBody = options.body !== undefined;
    const headers = {};
    if (hasBody) headers['content-type'] = 'application/json';
    if (config.token) headers.authorization = `Bearer ${config.token}`;
    if (config.name) headers['x-azs-device'] = config.name;
    const response = await fetch(config.api.replace(/\/+$/, '') + path, {
      method: options.method || 'GET',
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
      credentials: 'omit',
      mode: 'cors',
    });
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (!response.ok) {
      const error = new Error(data.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  // ---------------------------------------------------------------- UI

  const shadowStyles = `
    :host {
      all: initial;
      position: fixed;
      bottom: 8px;
      right: 8px;
      z-index: 2147483647;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #f4e9d2;
      pointer-events: none;
    }
    [hidden] { display: none !important; }
    * { box-sizing: border-box; }
    button, input { font: inherit; }
    .pill {
      pointer-events: auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 28px;
      padding: 0 9px;
      border: 1px solid rgba(240, 201, 106, .38);
      border-radius: 999px;
      background: rgba(12, 10, 7, .82);
      color: #f4e9d2;
      font-size: 10px;
      font-weight: 750;
      letter-spacing: .04em;
      cursor: pointer;
      box-shadow: 0 6px 22px rgba(0, 0, 0, .35);
      opacity: .82;
      backdrop-filter: blur(5px);
    }
    .pill:hover { opacity: 1; border-color: rgba(240, 201, 106, .7); }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #f0c96a;
      box-shadow: 0 0 0 2px rgba(240, 201, 106, .12);
      flex: none;
    }
    .dot.ok { background: #7fce8a; box-shadow: 0 0 0 2px rgba(127, 206, 138, .12); }
    .dot.warn { background: #f0c96a; }
    .dot.error { background: #ff8b7d; box-shadow: 0 0 0 2px rgba(255, 139, 125, .12); }
    .panel {
      pointer-events: auto;
      position: absolute;
      bottom: 36px;
      right: 0;
      width: min(330px, calc(100vw - 20px));
      padding: 14px;
      border: 1px solid #3b3224;
      border-radius: 13px;
      background: #17140f;
      box-shadow: 0 24px 60px rgba(0, 0, 0, .55);
      font-size: 12px;
      line-height: 1.45;
    }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
    .panel-title { font-size: 13px; font-weight: 750; letter-spacing: .01em; }
    .panel-title span { color: #f0c96a; }
    .icon {
      pointer-events: auto;
      border: 0;
      background: transparent;
      color: #a99b83;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      padding: 0 2px;
    }
    .icon:hover { color: #f4e9d2; }
    .status-line { display: flex; align-items: center; gap: 7px; margin-bottom: 10px; color: #d8cbb2; min-height: 18px; }
    .meta { display: grid; grid-template-columns: 70px 1fr; gap: 4px 10px; margin: 0 0 12px; }
    .meta dt { color: #8f826d; }
    .meta dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #e7dbc4; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
    .actions button {
      pointer-events: auto;
      padding: 7px 9px;
      border: 1px solid #3b3224;
      border-radius: 8px;
      background: #211d16;
      color: #f4e9d2;
      font-size: 11px;
      font-weight: 650;
      cursor: pointer;
    }
    .actions button:hover { border-color: rgba(240, 201, 106, .5); background: #292318; }
    .actions button.primary { background: linear-gradient(180deg, #f3d27e, #d9a83e); border-color: rgba(240, 201, 106, .6); color: #221a0a; }
    .actions button.danger { color: #ff8b7d; border-color: rgba(255, 139, 125, .28); }
    .actions button:disabled { opacity: .45; cursor: not-allowed; }
    .foot { margin-top: 10px; color: #776b58; font-size: 10px; }
    .modal {
      pointer-events: auto;
      position: fixed;
      inset: 0;
      display: grid;
      place-items: center;
      padding: 16px;
      background: rgba(0, 0, 0, .68);
      backdrop-filter: blur(4px);
    }
    .card {
      width: min(430px, 100%);
      max-height: 86vh;
      overflow: auto;
      padding: 18px;
      border: 1px solid #3b3224;
      border-radius: 15px;
      background: #17140f;
      box-shadow: 0 30px 80px rgba(0, 0, 0, .6);
      font-size: 12px;
      line-height: 1.5;
    }
    .card h2 { margin: 0 0 4px; font-size: 17px; line-height: 1.25; }
    .card p { margin: 0; color: #a99b83; }
    .field { display: grid; gap: 5px; margin-top: 11px; }
    .field label { color: #a99b83; font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
    .field input {
      width: 100%;
      padding: 8px 10px;
      border: 1px solid #3b3224;
      border-radius: 8px;
      background: #0f0d0a;
      color: #f4e9d2;
      font-size: 12px;
      outline: none;
    }
    .field input:focus { border-color: rgba(240, 201, 106, .65); }
    .error { color: #ff8b7d; min-height: 16px; margin-top: 8px; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
    .row button {
      pointer-events: auto;
      flex: 1;
      min-width: 110px;
      padding: 9px 10px;
      border: 1px solid #3b3224;
      border-radius: 8px;
      background: #211d16;
      color: #f4e9d2;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
    }
    .row button:hover { border-color: rgba(240, 201, 106, .5); }
    .row button.primary { background: linear-gradient(180deg, #f3d27e, #d9a83e); border-color: rgba(240, 201, 106, .6); color: #221a0a; }
    .row button.danger { color: #ff8b7d; border-color: rgba(255, 139, 125, .28); }
    .row button:disabled { opacity: .45; cursor: not-allowed; }
    .note { margin-top: 12px; padding: 9px 10px; border: 1px solid rgba(240, 201, 106, .2); background: rgba(240, 201, 106, .055); border-radius: 8px; color: #cdbfa5; }
    .note.bad { border-color: rgba(255, 139, 125, .3); background: rgba(255, 139, 125, .06); color: #ffd6d1; }
    a { color: #f0c96a; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .95em; }
  `;

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'value') node.value = value;
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

  function mountUi() {
    if (host) return;
    if (!document.body) {
      setTimeout(mountUi, 50);
      return;
    }

    host = document.createElement('div');
    host.id = 'azs-sync-ui';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${shadowStyles}</style>
      <button class="pill" id="pill" type="button" title="AZS Sync">
        <span class="dot" id="dot"></span><span id="pill-label">AZS</span>
      </button>
      <div class="panel" id="panel" hidden>
        <div class="panel-head">
          <div class="panel-title">AZS <span>Sync</span></div>
          <button class="icon" id="close-panel" type="button" aria-label="Close">×</button>
        </div>
        <div class="status-line"><span class="dot" id="panel-dot"></span><span id="panel-status">Not configured</span></div>
        <dl class="meta">
          <dt>Device</dt><dd id="meta-device">—</dd>
          <dt>Server</dt><dd id="meta-server">—</dd>
          <dt>Last sync</dt><dd id="meta-last">never</dd>
        </dl>
        <div class="actions">
          <button class="primary" id="sync-now" type="button">Sync now</button>
          <button id="open-dashboard" type="button">Dashboard</button>
          <button id="settings" type="button">Settings</button>
          <button class="danger" id="unpair" type="button">Unpair</button>
        </div>
        <div class="foot">v${VERSION} · sealed save only</div>
      </div>
      <div id="modal" hidden></div>
    `;
    document.body.append(host);

    pill = shadow.querySelector('#pill');
    pillLabel = shadow.querySelector('#pill-label');
    pillDot = shadow.querySelector('#dot');
    panel = shadow.querySelector('#panel');
    panelStatus = shadow.querySelector('#panel-status');
    panelDevice = shadow.querySelector('#meta-device');
    panelServer = shadow.querySelector('#meta-server');
    panelLast = shadow.querySelector('#meta-last');
    modal = shadow.querySelector('#modal');

    pill.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) refreshPanel();
    });
    shadow.querySelector('#close-panel').addEventListener('click', () => {
      panel.hidden = true;
    });
    shadow.querySelector('#sync-now').addEventListener('click', () => {
      panel.hidden = true;
      sync({ manual: true }).catch(() => {});
    });
    shadow.querySelector('#open-dashboard').addEventListener('click', () => {
      if (!config) return;
      window.open(config.api, '_blank', 'noopener');
    });
    shadow.querySelector('#settings').addEventListener('click', () => {
      panel.hidden = true;
      showSetup();
    });
    shadow.querySelector('#unpair').addEventListener('click', () => {
      if (!confirm('Unpair this device? The game save is not deleted, but sync stops until you pair again.')) return;
      try {
        localStorage.removeItem(CONFIG_KEY);
        localStorage.removeItem(BASE_KEY);
        localStorage.removeItem(CACHE_KEY);
      } catch {
        /* ignore */
      }
      location.reload();
    });

    setStatus(statusText, statusTone);
    if (pendingCard) {
      const card = pendingCard;
      pendingCard = null;
      openModal(card);
    }
    if (!config) {
      setStatus('Not configured', 'idle');
      setTimeout(() => {
        if (!config && !setupOpen) showSetup();
      }, 900);
    }
  }

  function refreshPanel() {
    if (!panel) return;
    panelStatus.textContent = statusText;
    panelDevice.textContent = config?.name || '—';
    panelServer.textContent = config?.api || '—';
    panelLast.textContent = lastSyncText();
    const panelDot = shadow.querySelector('#panel-dot');
    panelDot.className = `dot ${statusTone === 'ok' ? 'ok' : statusTone === 'warn' ? 'warn' : statusTone === 'error' || statusTone === 'conflict' ? 'error' : ''}`;
  }

  function setStatus(text, tone = 'idle') {
    statusText = text;
    statusTone = tone;
    const dotClass = `dot ${tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : tone === 'error' || tone === 'conflict' ? 'error' : ''}`;
    if (pillDot) pillDot.className = dotClass;
    if (pillLabel) {
      const short =
        tone === 'ok' ? 'AZS synced'
          : tone === 'warn' ? 'AZS newer'
            : tone === 'conflict' ? 'AZS conflict'
              : tone === 'error' ? 'AZS offline'
                : 'AZS';
      pillLabel.textContent = short;
    }
    if (pill) pill.title = text;
    if (panelStatus) panelStatus.textContent = text;
    const panelDot = shadow?.querySelector('#panel-dot');
    if (panelDot) panelDot.className = dotClass;
    if (panelLast) panelLast.textContent = lastSyncText();
  }

  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    modal.textContent = '';
    conflictOpen = false;
    setupOpen = false;
  }

  function openModal(card) {
    if (!modal) {
      pendingCard = card;
      return;
    }
    modal.textContent = '';
    const backdrop = el('div', { class: 'modal' });
    backdrop.append(card);
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop && !conflictOpen) closeModal();
    });
    modal.append(backdrop);
    modal.hidden = false;
  }

  function downloadSave(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
  }

  // ---------------------------------------------------------------- setup

  function showSetup() {
    if (!modal || setupOpen) return;
    setupOpen = true;
    conflictOpen = false;

    const linkInput = el('input', {
      type: 'text',
      placeholder: 'https://wow.aethus.pl/#azs-pair=…',
      autocomplete: 'off',
    });
    const apiInput = el('input', {
      type: 'url',
      placeholder: 'https://azs-sync.you.workers.dev',
      value: config?.api || '',
      autocomplete: 'off',
    });
    const tokenInput = el('input', {
      type: 'password',
      placeholder: config ? 'Leave blank to keep the current token' : 'azs_…',
      autocomplete: 'off',
    });
    const nameInput = el('input', {
      type: 'text',
      maxlength: '60',
      value: config?.name || (/Android|iPhone|iPad/i.test(navigator.userAgent) ? 'Phone' : 'Desktop'),
      autocomplete: 'off',
    });
    const error = el('div', { class: 'error' });

    const save = el('button', { class: 'primary', type: 'button' }, 'Save & start syncing');
    const cancel = el('button', { type: 'button' }, config ? 'Cancel' : 'Close');
    cancel.addEventListener('click', () => closeModal());

    save.addEventListener('click', () => {
      error.textContent = '';
      let next = null;
      const paste = linkInput.value.trim();
      if (paste) {
        const match = /#azs-pair=(.+)$/.exec(paste);
        try {
          if (!match) throw new Error('no azs-pair fragment in that link');
          const data = JSON.parse(new TextDecoder().decode(b64urlToBytes(match[1])));
          if (!validApi(data.a) || !String(data.t).startsWith('azs_')) throw new Error('that pairing link is invalid');
          next = {
            api: data.a.replace(/\/+$/, ''),
            token: String(data.t),
            name: String(data.n || nameInput.value || 'Device').slice(0, 60) || 'Device',
          };
        } catch (e) {
          error.textContent = e.message || 'could not read that pairing link';
          return;
        }
      } else {
        const apiValue = apiInput.value.trim().replace(/\/+$/, '');
        const tokenValue = tokenInput.value.trim() || config?.token || '';
        if (!validApi(apiValue)) {
          error.textContent = 'Enter an https:// server URL.';
          return;
        }
        if (!tokenValue.startsWith('azs_')) {
          error.textContent = 'Enter the device token from the dashboard.';
          return;
        }
        next = {
          api: apiValue,
          token: tokenValue,
          name: (nameInput.value.trim() || 'Device').slice(0, 60) || 'Device',
        };
      }
      if (config && (config.api !== next.api || config.token !== next.token)) {
        try {
          localStorage.removeItem(BASE_KEY);
          localStorage.removeItem(CACHE_KEY);
        } catch {
          /* ignore */
        }
      }
      config = next;
      writeJson(CONFIG_KEY, config);
      closeModal();
      setStatus('Saved — syncing…', 'idle');
      location.reload();
    });

    const card = el(
      'div',
      { class: 'card' },
      el('h2', {}, 'AZS Sync setup'),
      el('p', {}, 'Pair this browser with your sync service. The token is stored only in this site’s localStorage.'),
      el(
        'div',
        { class: 'field' },
        el('label', {}, 'Pairing link (easiest)'),
        linkInput,
      ),
      el('div', { class: 'note' }, 'On the dashboard, create a device and copy its pairing link. You can also fill in the server URL and token below.'),
      el('div', { class: 'field' }, el('label', {}, 'Server URL'), apiInput),
      el('div', { class: 'field' }, el('label', {}, 'Device token'), tokenInput),
      el('div', { class: 'field' }, el('label', {}, 'Device name'), nameInput),
      error,
      el('div', { class: 'row' }, save, cancel),
    );
    openModal(card);
  }

  // ---------------------------------------------------------------- sync

  function applyCachedRemote() {
    const local = getSave();
    const base = getBase();
    const cache = getCache();
    if (!cache?.save || cache.save === local) return false;
    if (base && Number(cache.version) < Number(base.version)) return false;
    if (local === null || (base && base.save === local)) {
      writeSave(cache.save);
      writeJson(BASE_KEY, { version: cache.version, save: cache.save });
      lastLocal = cache.save;
      return true;
    }
    return false;
  }

  function applyRemote(state) {
    if (!state?.save) return;
    setBase(state);
    markSynced();
    // Keep the save that was actually synced, not whatever localStorage holds
    // now: the game may have written a newer save while the request was in
    // flight, and the poll below must still see that change and push it.
    lastLocal = state.save;
    setStatus(`Synced ${new Date().toLocaleTimeString()}`, 'ok');
    if (panel && !panel.hidden) refreshPanel();
  }

  async function push(local, baseVersion, reason = 'push') {
    const path = reason === 'force' ? '/api/force' : '/api/sync';
    try {
      const result = await api(path, {
        method: 'POST',
        body: { baseVersion, save: local },
      });
      applyRemote(result);
      return result;
    } catch (error) {
      if (error.status === 409 && error.data?.status === 'conflict') {
        showConflict(error.data);
        return null;
      }
      throw error;
    }
  }

  async function pull(remote, { archiveLocal = false } = {}) {
    const local = getSave();
    if (archiveLocal && local && local !== remote.save) {
      try {
        await api('/api/archive', { method: 'POST', body: { save: local } });
      } catch {
        /* archiving is best-effort */
      }
    }
    writeSave(remote.save);
    writeJson(BASE_KEY, { version: remote.version, save: remote.save });
    writeJson(CACHE_KEY, { version: remote.version, save: remote.save });
    lastLocal = remote.save;
    markSynced();
    setStatus(`Pulled v${remote.version} — reloading`, 'ok');
    setTimeout(() => location.reload(), 350);
  }

  async function sync({ boot = false, manual = false, auto = false } = {}) {
    if (!config) return;
    if (syncing) {
      queued = { boot, manual, auto };
      return;
    }
    syncing = true;
    try {
      const local = getSave();
      const remote = await api('/api/state');
      const base = getBase();

      if (!remote || remote.version === 0) {
        if (local) {
          await push(local, 0, 'initial');
        } else {
          setStatus('No save yet — play a run', 'idle');
        }
        return;
      }

      if (local === remote.save) {
        applyRemote(remote);
        return;
      }

      if (local === (base?.save ?? null)) {
        if (boot || manual || local === null) {
          await pull(remote);
          return;
        }
        pendingRemote = remote;
        setStatus('Server has a newer save — open AZS', 'warn');
        return;
      }

      if (remote.save === (base?.save ?? null)) {
        if (local === null) {
          await pull(remote);
          return;
        }
        await push(local, remote.version, 'push');
        return;
      }

      showConflict(remote);
    } catch (error) {
      if (error.status === 401) {
        setStatus('Device token rejected — open Settings', 'error');
      } else {
        setStatus(`Offline (${error.message || 'network'}) — retrying`, 'error');
        scheduleRetry();
      }
    } finally {
      syncing = false;
      if (queued) {
        const next = queued;
        queued = null;
        setTimeout(() => sync(next), 250);
      }
    }
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = 0;
      if (config) sync({ auto: true });
    }, REMOTE_RETRY_MS);
  }

  function showConflict(remote) {
    if (conflictOpen && pendingRemote?.version === remote.version) return;
    if (conflictOpen) closeModal();
    conflictOpen = true;
    setupOpen = false;
    pendingRemote = remote;
    setStatus('Conflict — choose a save', 'conflict');
    const local = getSave();
    if (!local) {
      conflictOpen = false;
      pull(remote, { archiveLocal: false }).catch(() => {});
      return;
    }

    const useLocal = el('button', { class: 'danger', type: 'button' }, 'Use this device');
    const useServer = el('button', { class: 'primary', type: 'button' }, 'Use server');
    const downloadBoth = el('button', { type: 'button' }, 'Download both');
    const later = el('button', { type: 'button' }, 'Decide later');
    const error = el('div', { class: 'error' });

    useLocal.addEventListener('click', async () => {
      useLocal.disabled = true;
      try {
        const current = getSave();
        if (!current) {
          await pull(remote, { archiveLocal: false });
          return;
        }
        const result = await push(current, remote.version, 'force');
        if (result) closeModal();
        else useLocal.disabled = false;
      } catch (e) {
        error.textContent = e.message || 'could not upload this save';
        useLocal.disabled = false;
      }
    });
    useServer.addEventListener('click', async () => {
      useServer.disabled = true;
      try {
        await pull(remote, { archiveLocal: true });
      } catch (e) {
        error.textContent = e.message || 'could not download the server save';
        useServer.disabled = false;
      }
    });
    downloadBoth.addEventListener('click', () => {
      const now = new Date().toISOString().replace(/[:.]/g, '-');
      const current = getSave();
      if (current) downloadSave(`AzerothSurvivors-this-device-${now}.sav`, current);
      setTimeout(() => downloadSave(`AzerothSurvivors-server-v${remote.version}-${now}.sav`, remote.save), current ? 500 : 0);
    });
    later.addEventListener('click', () => closeModal());

    const card = el(
      'div',
      { class: 'card' },
      el('h2', {}, 'Both saves changed'),
      el('p', {}, 'Both this device and the server have progress since the last sync. Azeroth Survivors has no merge: importing one replaces the whole account. Choose one, or download both and decide later.'),
      el(
        'div',
        { class: 'note' },
        `This device: ${local.length} chars. Server: v${remote.version}, ${remote.deviceName || 'unknown device'}, ${remote.updatedAt ? new Date(remote.updatedAt).toLocaleString() : 'unknown time'}.`,
      ),
      error,
      el('div', { class: 'row' }, useServer, useLocal),
      el('div', { class: 'row' }, downloadBoth, later),
    );
    openModal(card);
  }

  // ---------------------------------------------------------------- boot

  function start() {
    consumePairingHash();
    window.addEventListener('hashchange', () => {
      if (consumePairingHash()) location.reload();
    });
    config = readJson(CONFIG_KEY);

    if (config) {
      applyCachedRemote();
      lastLocal = getSave();
      setStatus('Starting…', 'idle');
      sync({ boot: true }).catch(() => {});
      setInterval(() => {
        const current = getSave();
        if (current !== lastLocal) {
          lastLocal = current;
          clearTimeout(pushTimer);
          pushTimer = setTimeout(() => {
            if (config) sync({ auto: true }).catch(() => {});
          }, PUSH_DEBOUNCE_MS);
        }
      }, POLL_MS);
      setInterval(() => {
        if (config && !syncing) sync({ auto: true }).catch(() => {});
      }, REMOTE_RETRY_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && config) sync({ auto: true }).catch(() => {});
      });
    } else {
      setStatus('Not configured', 'idle');
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mountUi, { once: true });
    } else {
      mountUi();
    }
  }

  start();
})();
