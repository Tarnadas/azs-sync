import { randomToken, sha256Hex } from './util.js';

const TOKEN_PREFIX = 'azs_';

export async function ensurePairingToken(env, userId) {
  const row = await env.DB.prepare('SELECT pairing_token FROM users WHERE id = ?')
    .bind(userId)
    .first();
  if (row?.pairing_token) return row.pairing_token;

  const token = TOKEN_PREFIX + randomToken(32);
  const hash = await sha256Hex(token);
  await env.DB.prepare(
    'UPDATE users SET pairing_token = ?, pairing_token_hash = ? WHERE id = ? AND pairing_token IS NULL',
  )
    .bind(token, hash, userId)
    .run();

  const after = await env.DB.prepare('SELECT pairing_token FROM users WHERE id = ?')
    .bind(userId)
    .first();
  return after?.pairing_token || token;
}

export async function resetPairingToken(env, userId) {
  const token = TOKEN_PREFIX + randomToken(32);
  const hash = await sha256Hex(token);
  const result = await env.DB.prepare(
    'UPDATE users SET pairing_token = ?, pairing_token_hash = ? WHERE id = ?',
  )
    .bind(token, hash, userId)
    .run();
  if (!result.meta?.changes) throw new Error('account not found');
  return token;
}
