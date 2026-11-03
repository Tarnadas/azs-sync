import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

import {
  HttpError,
  b64urlDecode,
  b64urlEncode,
  cookie,
  isSecure,
  parseCookies,
  randomId,
  randomToken,
  sha256Hex,
  timingSafeEqual,
} from './util.js';

const SESSION_COOKIE = 'azs_session';
const CHALLENGE_COOKIE = 'azs_wa';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function hasUsers(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  return Number(row?.n || 0) > 0;
}

function rpConfig(request, env) {
  const origin = new URL(env.ORIGIN || new URL(request.url).origin).origin;
  return {
    origin,
    rpID: env.RP_ID || new URL(origin).hostname,
    rpName: env.RP_NAME || 'Azeroth Survivors Sync',
  };
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return b64urlEncode(signature);
}

export async function createSessionCookie(userId, request, env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 16) {
    throw new HttpError(500, 'SESSION_SECRET is not configured');
  }
  const payload = b64urlEncode(JSON.stringify({ uid: userId, exp: Date.now() + SESSION_TTL_MS }));
  const signature = await hmac(env.SESSION_SECRET, payload);
  return cookie(SESSION_COOKIE, `${payload}.${signature}`, {
    maxAge: SESSION_TTL_MS / 1000,
    secure: isSecure(request),
    sameSite: 'Lax',
  });
}

export function clearSessionCookie(request) {
  return cookie(SESSION_COOKIE, '', {
    maxAge: 0,
    secure: isSecure(request),
    sameSite: 'Lax',
  });
}

function clearChallengeCookie(request) {
  return cookie(CHALLENGE_COOKIE, '', {
    maxAge: 0,
    secure: isSecure(request),
    sameSite: 'Lax',
    path: '/api/auth',
  });
}

export async function sessionUser(request, env) {
  if (!env.SESSION_SECRET) return null;
  const raw = parseCookies(request)[SESSION_COOKIE];
  if (!raw) return null;
  const at = raw.lastIndexOf('.');
  if (at < 1) return null;
  const payload = raw.slice(0, at);
  const signature = raw.slice(at + 1);
  const expected = await hmac(env.SESSION_SECRET, payload);
  if (!timingSafeEqual(signature, expected)) return null;
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
  } catch {
    return null;
  }
  if (!data?.uid || !data?.exp || data.exp < Date.now()) return null;
  return env.DB.prepare('SELECT id, name, created_at FROM users WHERE id = ?').bind(data.uid).first();
}

export async function requireSession(request, env) {
  const user = await sessionUser(request, env);
  if (!user) throw new HttpError(401, 'sign in required');
  return user;
}

async function setChallenge(request, env, { type, challenge, userId = null, data = null }) {
  await env.DB.prepare('DELETE FROM challenges WHERE expires_at < ?').bind(Date.now()).run();
  const id = randomToken(24);
  await env.DB.prepare(
    'INSERT INTO challenges (id, challenge, type, user_id, data, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, challenge, type, userId, data ? JSON.stringify(data) : null, Date.now() + CHALLENGE_TTL_MS)
    .run();
  return cookie(CHALLENGE_COOKIE, id, {
    maxAge: CHALLENGE_TTL_MS / 1000,
    secure: isSecure(request),
    sameSite: 'Lax',
    path: '/api/auth',
  });
}

async function takeChallenge(request, env, type) {
  const id = parseCookies(request)[CHALLENGE_COOKIE];
  if (!id) throw new HttpError(400, 'missing WebAuthn challenge');
  const row = await env.DB.prepare('SELECT * FROM challenges WHERE id = ?').bind(id).first();
  await env.DB.prepare('DELETE FROM challenges WHERE id = ?').bind(id).run();
  if (!row || row.type !== type) throw new HttpError(400, 'WebAuthn challenge not found');
  if (row.expires_at < Date.now()) throw new HttpError(400, 'WebAuthn challenge expired');
  return row;
}

function toWebAuthnCredential(row) {
  let transports = [];
  try {
    transports = JSON.parse(row.transports || '[]');
  } catch {
    transports = [];
  }
  return {
    id: row.id,
    publicKey: b64urlDecode(row.public_key),
    counter: Number(row.counter || 0),
    transports,
  };
}

function normalizeName(name, fallback = 'Player') {
  const value = String(name || '').trim().slice(0, 60);
  return value || fallback;
}

export async function registrationOptions(request, env, { name, session }) {
  const { origin, rpID, rpName } = rpConfig(request, env);
  const usersExist = await hasUsers(env);

  let userId;
  let userName;
  let userDisplayName;
  let excludeCredentials = [];
  let pendingName = null;

  if (session) {
    userId = session.id;
    userName = session.name;
    userDisplayName = session.name;
    const rows = await env.DB.prepare(
      'SELECT id, transports FROM credentials WHERE user_id = ?',
    )
      .bind(session.id)
      .all();
    excludeCredentials = (rows.results || []).map((row) => {
      let transports = [];
      try {
        transports = JSON.parse(row.transports || '[]');
      } catch {
        transports = [];
      }
      return { id: row.id, transports };
    });
  } else {
    if (usersExist) throw new HttpError(403, 'an account already exists; sign in instead');
    pendingName = normalizeName(name);
    userId = randomId();
    userName = pendingName;
    userDisplayName = pendingName;
  }

  const challenge = randomToken(32);
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: new TextEncoder().encode(userId),
    userName,
    userDisplayName,
    challenge,
    attestationType: 'none',
    excludeCredentials,
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'preferred',
    },
  });

  const challengeCookie = await setChallenge(request, env, {
    type: 'register',
    challenge: options.challenge,
    userId,
    data: session ? null : { name: pendingName },
  });

  return {
    data: { publicKey: options, origin, rpID },
    cookies: [challengeCookie],
  };
}

export async function registrationVerify(request, env, body) {
  const row = await takeChallenge(request, env, 'register');
  const response = body?.response || body;
  if (!response || typeof response !== 'object') throw new HttpError(400, 'missing registration response');

  const { origin, rpID } = rpConfig(request, env);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: row.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (error) {
    throw new HttpError(400, `passkey registration failed: ${error.message}`);
  }
  if (!verification.verified || !verification.registrationInfo) {
    throw new HttpError(400, 'passkey registration was not verified');
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const now = Date.now();
  let user = null;
  let pendingName = null;
  let recoveryCode = null;
  let recoveryHash = null;
  let isNewAccount = false;

  if (row.data) {
    try {
      pendingName = JSON.parse(row.data)?.name || null;
    } catch {
      pendingName = null;
    }
  }

  // A registration started by a signed-in user adds a passkey to that
  // account. A registration started from the first-run form creates the
  // account, but only if nobody else created one in the meantime.
  if (row.user_id && row.data) {
    if (await hasUsers(env)) throw new HttpError(409, 'an account already exists; sign in instead');
    isNewAccount = true;
    recoveryCode = randomToken(32);
    recoveryHash = await sha256Hex(recoveryCode);
    user = { id: row.user_id, name: normalizeName(pendingName), created_at: now };
  } else {
    user = await env.DB.prepare('SELECT id, name, created_at FROM users WHERE id = ?').bind(row.user_id).first();
    if (!user) throw new HttpError(400, 'account for this passkey no longer exists');
  }

  const insertCredential = env.DB.prepare(
    `INSERT INTO credentials
       (id, user_id, public_key, counter, transports, device_type, backed_up, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    credential.id,
    user.id,
    b64urlEncode(credential.publicKey),
    Number(credential.counter || 0),
    JSON.stringify(credential.transports || []),
    credentialDeviceType || null,
    credentialBackedUp ? 1 : 0,
    now,
    now,
  );

  try {
    if (isNewAccount) {
      const insertUser = env.DB.prepare(
        'INSERT INTO users (id, name, created_at, recovery_hash) VALUES (?, ?, ?, ?)',
      ).bind(user.id, user.name, user.created_at, recoveryHash);
      await env.DB.batch([insertUser, insertCredential]);
    } else {
      await insertCredential.run();
    }
  } catch {
    throw new HttpError(409, 'this passkey or account is already registered');
  }

  const sessionCookie = await createSessionCookie(user.id, request, env);
  return {
    data: {
      user: { id: user.id, name: user.name },
      ...(recoveryCode ? { recoveryCode } : {}),
    },
    cookies: [sessionCookie, clearChallengeCookie(request)],
  };
}

export async function authenticationOptions(request, env) {
  if (!(await hasUsers(env))) throw new HttpError(400, 'no account exists yet');
  const { origin, rpID } = rpConfig(request, env);
  const challenge = randomToken(32);
  const options = await generateAuthenticationOptions({
    rpID,
    challenge,
    allowCredentials: [],
    userVerification: 'preferred',
  });
  const challengeCookie = await setChallenge(request, env, {
    type: 'login',
    challenge: options.challenge,
  });
  return {
    data: { publicKey: options, origin, rpID },
    cookies: [challengeCookie],
  };
}

export async function authenticationVerify(request, env, body) {
  const row = await takeChallenge(request, env, 'login');
  const response = body?.response || body;
  if (!response || typeof response !== 'object') throw new HttpError(400, 'missing authentication response');

  const credentialRow = await env.DB.prepare('SELECT * FROM credentials WHERE id = ?')
    .bind(String(response.id || ''))
    .first();
  if (!credentialRow) throw new HttpError(401, 'passkey is not registered');

  const { origin, rpID } = rpConfig(request, env);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: row.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: toWebAuthnCredential(credentialRow),
      requireUserVerification: false,
    });
  } catch (error) {
    throw new HttpError(401, `passkey sign-in failed: ${error.message}`);
  }
  if (!verification.verified) throw new HttpError(401, 'passkey sign-in was not verified');

  await env.DB.prepare('UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?')
    .bind(Number(verification.authenticationInfo.newCounter || 0), Date.now(), credentialRow.id)
    .run();

  const user = await env.DB.prepare('SELECT id, name, created_at FROM users WHERE id = ?')
    .bind(credentialRow.user_id)
    .first();
  if (!user) throw new HttpError(401, 'account no longer exists');

  const sessionCookie = await createSessionCookie(user.id, request, env);
  return {
    data: { user: { id: user.id, name: user.name } },
    cookies: [sessionCookie, clearChallengeCookie(request)],
  };
}

export async function recoveryLogin(request, env, body) {
  const provided = String(body?.code || body?.token || '').trim();
  if (!provided) throw new HttpError(400, 'recovery code is required');

  // Every account created through the dashboard gets a one-time recovery
  // code, stored only as a hash. The operator's RECOVERY_TOKEN is an
  // additional fallback for a fresh instance or an emergency.
  let user = await env.DB.prepare(
    'SELECT id, name, created_at FROM users WHERE recovery_hash = ?',
  )
    .bind(await sha256Hex(provided))
    .first();

  if (!user && env.RECOVERY_TOKEN && timingSafeEqual(provided, env.RECOVERY_TOKEN)) {
    user = await env.DB.prepare('SELECT id, name, created_at FROM users ORDER BY created_at LIMIT 1').first();
    if (!user) {
      const now = Date.now();
      user = { id: randomId(), name: 'Player', created_at: now };
      await env.DB.prepare('INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)')
        .bind(user.id, user.name, user.created_at)
        .run();
    }
  }

  if (!user) throw new HttpError(401, 'invalid recovery code');
  const sessionCookie = await createSessionCookie(user.id, request, env);
  return {
    data: { user: { id: user.id, name: user.name } },
    cookies: [sessionCookie],
  };
}

export async function getCredentials(env, userId) {
  const rows = await env.DB.prepare(
    'SELECT id, transports, created_at, last_used_at, device_type, backed_up FROM credentials WHERE user_id = ? ORDER BY created_at',
  )
    .bind(userId)
    .all();
  return rows.results || [];
}
