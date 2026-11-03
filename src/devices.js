import { HttpError, randomId, randomToken, sha256Hex } from './util.js';

const TOKEN_PREFIX = 'azs_';

export async function createDevice(env, user, name) {
  const cleanName = String(name || '').trim().slice(0, 60) || 'Device';
  const token = TOKEN_PREFIX + randomToken(32);
  const tokenHash = await sha256Hex(token);
  const id = randomId();
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO devices (id, user_id, name, token, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, user.id, cleanName, token, tokenHash, now, null)
    .run();
  return {
    device: { id, name: cleanName, token, createdAt: now, lastSeenAt: null },
    token,
  };
}

export async function authenticateDevice(request, env, { touch = true } = {}) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) throw new HttpError(401, 'missing device token');
  const token = match[1].trim();
  if (!token.startsWith(TOKEN_PREFIX) || token.length < 20) {
    throw new HttpError(401, 'invalid device token');
  }
  const tokenHash = await sha256Hex(token);
  const device = await env.DB.prepare(
    `SELECT d.id, d.user_id, d.name, d.created_at, d.last_seen_at, d.last_version,
            u.name AS user_name
       FROM devices d
       JOIN users u ON u.id = d.user_id
      WHERE d.token_hash = ? AND d.revoked_at IS NULL`,
  )
    .bind(tokenHash)
    .first();
  if (!device) throw new HttpError(401, 'unknown or revoked device token');
  if (touch) {
    await env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')
      .bind(Date.now(), device.id)
      .run();
  }
  return device;
}

export async function listDevices(env, userId) {
  const rows = await env.DB.prepare(
    `SELECT id, name, token, created_at, last_seen_at, last_version
       FROM devices
      WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY created_at DESC`,
  )
    .bind(userId)
    .all();
  return (rows.results || []).map(publicDevice);
}

export function publicDevice(row) {
  return {
    id: row.id,
    name: row.name,
    token: row.token || null,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    lastVersion: row.last_version,
  };
}

export async function rotateDeviceToken(env, userId, deviceId) {
  const token = TOKEN_PREFIX + randomToken(32);
  const tokenHash = await sha256Hex(token);
  const result = await env.DB.prepare(
    'UPDATE devices SET token = ?, token_hash = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
  )
    .bind(token, tokenHash, deviceId, userId)
    .run();
  if (!result.meta?.changes) throw new HttpError(404, 'device not found');
  return token;
}

export async function revokeDevice(env, userId, deviceId) {
  const result = await env.DB.prepare(
    'UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
  )
    .bind(Date.now(), deviceId, userId)
    .run();
  if (!result.meta?.changes) throw new HttpError(404, 'device not found');
}
