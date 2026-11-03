import {
  authenticationOptions,
  authenticationVerify,
  clearSessionCookie,
  getCredentials,
  hasUsers,
  recoveryLogin,
  registrationOptions,
  registrationVerify,
  requireSession,
  sessionUser,
} from './auth.js';
import { authenticateDevice, createDevice, listDevices, revokeDevice } from './devices.js';
import { archiveSave, getHistoryItem, getState, listHistory, pushSave } from './saves.js';
import {
  HttpError,
  assertSameOrigin,
  isNonEmptyString,
  json,
  readJson,
  text,
} from './util.js';

const GAME_ORIGIN = 'https://wow.aethus.pl';
const API_CORS_HEADERS = {
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type',
  'access-control-max-age': '86400',
};

function withCors(request, response) {
  const origin = request.headers.get('origin');
  if (origin === GAME_ORIGIN) {
    response.headers.set('access-control-allow-origin', origin);
    response.headers.set('vary', 'Origin');
    for (const [name, value] of Object.entries(API_CORS_HEADERS)) response.headers.set(name, value);
  }
  return response;
}

function jsonWithCookies(data, status, cookies) {
  const response = json(data, status);
  for (const value of cookies || []) response.headers.append('set-cookie', value);
  return response;
}

async function requireAnyUser(request, env) {
  const authorization = request.headers.get('authorization');
  if (authorization && /^Bearer\s+/i.test(authorization)) {
    const device = await authenticateDevice(request, env);
    return {
      user: { id: device.user_id, name: device.user_name },
      device,
    };
  }
  const user = await sessionUser(request, env);
  if (!user) throw new HttpError(401, 'sign in required');
  return { user, device: null };
}

async function handleAuth(request, env, url) {
  if (url.pathname === '/api/config' && request.method === 'GET') {
    const usersExist = await hasUsers(env);
    return json({
      hasUsers: usersExist,
      recovery: usersExist || Boolean(env.RECOVERY_TOKEN),
      origin: new URL(env.ORIGIN || request.url).origin,
    });
  }

  if (url.pathname === '/api/me' && request.method === 'GET') {
    const user = await sessionUser(request, env);
    return json({
      authenticated: Boolean(user),
      user: user ? { id: user.id, name: user.name } : null,
    });
  }

  if (url.pathname.startsWith('/api/auth/') && (!env.SESSION_SECRET || env.SESSION_SECRET.length < 16)) {
    throw new HttpError(500, 'SESSION_SECRET is not configured');
  }

  if (url.pathname === '/api/auth/register/options' && request.method === 'POST') {
    assertSameOrigin(request);
    const body = await readJson(request);
    const session = await sessionUser(request, env);
    const { data, cookies } = await registrationOptions(request, env, {
      name: body.name,
      session,
    });
    return jsonWithCookies(data, 200, cookies);
  }

  if (url.pathname === '/api/auth/register/verify' && request.method === 'POST') {
    assertSameOrigin(request);
    const body = await readJson(request);
    const { data, cookies } = await registrationVerify(request, env, body);
    return jsonWithCookies(data, 200, cookies);
  }

  if (url.pathname === '/api/auth/login/options' && request.method === 'POST') {
    assertSameOrigin(request);
    const { data, cookies } = await authenticationOptions(request, env);
    return jsonWithCookies(data, 200, cookies);
  }

  if (url.pathname === '/api/auth/login/verify' && request.method === 'POST') {
    assertSameOrigin(request);
    const body = await readJson(request);
    const { data, cookies } = await authenticationVerify(request, env, body);
    return jsonWithCookies(data, 200, cookies);
  }

  if (url.pathname === '/api/auth/recovery' && request.method === 'POST') {
    assertSameOrigin(request);
    const body = await readJson(request);
    const { data, cookies } = await recoveryLogin(request, env, body);
    return jsonWithCookies(data, 200, cookies);
  }

  if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
    assertSameOrigin(request);
    return jsonWithCookies({ ok: true }, 200, [clearSessionCookie(request)]);
  }

  return null;
}

async function handleAccount(request, env, url) {
  if (url.pathname === '/api/credentials' && request.method === 'GET') {
    const user = await requireSession(request, env);
    return json({ items: await getCredentials(env, user.id) });
  }

  if (url.pathname === '/api/devices' && request.method === 'GET') {
    const user = await requireSession(request, env);
    return json({ items: await listDevices(env, user.id) });
  }

  if (url.pathname === '/api/devices' && request.method === 'POST') {
    assertSameOrigin(request);
    const user = await requireSession(request, env);
    const body = await readJson(request);
    if (!isNonEmptyString(body.name, 60)) throw new HttpError(400, 'device name is required');
    const created = await createDevice(env, user, body.name);
    return json(created, 201);
  }

  const revoke = /^\/api\/devices\/([a-f0-9-]+)$/i.exec(url.pathname);
  if (revoke && request.method === 'DELETE') {
    assertSameOrigin(request);
    const user = await requireSession(request, env);
    await revokeDevice(env, user.id, revoke[1]);
    return json({ ok: true });
  }

  if (url.pathname === '/api/save' && request.method === 'GET') {
    const user = await requireSession(request, env);
    return json(await getState(env, user.id));
  }

  if (url.pathname === '/api/save' && request.method === 'POST') {
    assertSameOrigin(request);
    const user = await requireSession(request, env);
    const body = await readJson(request);
    const current = await getState(env, user.id);
    const result = await pushSave(env, {
      user,
      device: { id: null, name: 'Dashboard upload' },
      save: body.save,
      baseVersion: body.force ? current.version : (body.baseVersion ?? 0),
      reason: body.force ? 'force' : 'push',
    });
    return json(result, result.status === 'conflict' ? 409 : 200);
  }

  if (url.pathname === '/api/state' && request.method === 'GET') {
    const { user } = await requireAnyUser(request, env);
    return json(await getState(env, user.id));
  }

  if (url.pathname === '/api/history' && request.method === 'GET') {
    const { user } = await requireAnyUser(request, env);
    return json({ items: await listHistory(env, user.id) });
  }

  const history = /^\/api\/history\/(\d+)$/.exec(url.pathname);
  if (history && request.method === 'GET') {
    const { user } = await requireAnyUser(request, env);
    return json(await getHistoryItem(env, user.id, Number(history[1])));
  }

  return null;
}

async function handleSync(request, env, url) {
  if (url.pathname === '/api/sync' && request.method === 'POST') {
    const device = await authenticateDevice(request, env);
    const body = await readJson(request);
    const result = await pushSave(env, {
      user: { id: device.user_id, name: device.user_name },
      device,
      save: body.save,
      baseVersion: body.baseVersion ?? 0,
      reason: 'push',
    });
    return json(result, result.status === 'conflict' ? 409 : 200);
  }

  if (url.pathname === '/api/force' && request.method === 'POST') {
    const device = await authenticateDevice(request, env);
    const body = await readJson(request);
    const result = await pushSave(env, {
      user: { id: device.user_id, name: device.user_name },
      device,
      save: body.save,
      baseVersion: body.baseVersion ?? 0,
      reason: 'force',
    });
    return json(result, result.status === 'conflict' ? 409 : 200);
  }

  if (url.pathname === '/api/archive' && request.method === 'POST') {
    const device = await authenticateDevice(request, env);
    const body = await readJson(request);
    const result = await archiveSave(env, {
      user: { id: device.user_id, name: device.user_name },
      device,
      save: body.save,
    });
    return json(result);
  }

  if (url.pathname === '/api/device' && request.method === 'GET') {
    const device = await authenticateDevice(request, env, { touch: false });
    return json({
      device: {
        id: device.id,
        name: device.name,
        lastVersion: device.last_version,
      },
      user: { id: device.user_id, name: device.user_name },
    });
  }

  return null;
}

async function handleApi(request, env, url) {
  const auth = await handleAuth(request, env, url);
  if (auth) return auth;

  const account = await handleAccount(request, env, url);
  if (account) return account;

  const sync = await handleSync(request, env, url);
  if (sync) return sync;

  if (url.pathname === '/api/health') {
    return json({ ok: true, now: Date.now() });
  }

  throw new HttpError(404, 'not found');
}

async function serveAsset(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return text('method not allowed', 405, { allow: 'GET, HEAD' });
  }
  if (url.pathname === '/favicon.ico') {
    return new Response(null, { status: 204 });
  }

  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  const assetResponse = await env.ASSETS.fetch(new Request(new URL(path, url.origin), request));
  if (!assetResponse.ok) {
    return text('not found', 404);
  }

  const headers = new Headers(assetResponse.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');

  if (path === '/index.html') {
    headers.set('cache-control', 'no-cache');
    headers.set('x-frame-options', 'DENY');
    headers.set(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
  }

  if (path === '/azs-sync.user.js') {
    headers.set('content-type', 'text/javascript; charset=utf-8');
    headers.set('cache-control', 'no-cache');
  }

  return new Response(assetResponse.body, { status: assetResponse.status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return withCors(request, new Response(null, { status: 204 }));
    }

    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        return withCors(request, await handleApi(request, env, url));
      }
      return await serveAsset(request, env, url);
    } catch (error) {
      if (error instanceof HttpError) {
        return withCors(request, json({ error: error.message, code: error.code }, error.status));
      }
      console.error('unhandled error', error);
      return withCors(request, json({ error: 'internal error' }, 500));
    }
  },
};
