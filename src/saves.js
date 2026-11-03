import { HttpError, sha256Hex } from './util.js';
import { HISTORY_LIMIT, publicState, validateSave } from './sync.js';

export async function getSaveRow(env, userId) {
  return env.DB.prepare('SELECT * FROM saves WHERE user_id = ?').bind(userId).first();
}

export async function getState(env, userId) {
  return publicState(await getSaveRow(env, userId));
}

async function touchDevice(env, deviceId, version) {
  await env.DB.prepare('UPDATE devices SET last_seen_at = ?, last_version = ? WHERE id = ?')
    .bind(Date.now(), version, deviceId)
    .run();
}

async function insertHistory(env, { userId, version, save, hash, deviceName, reason }) {
  await env.DB.prepare(
    `INSERT INTO save_history (user_id, version, save, hash, created_at, device_name, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(userId, version, save, hash, Date.now(), deviceName || null, reason)
    .run();
  await env.DB.prepare(
    `DELETE FROM save_history
      WHERE user_id = ?
        AND id NOT IN (
          SELECT id FROM save_history WHERE user_id = ? ORDER BY id DESC LIMIT ${HISTORY_LIMIT}
        )`,
  )
    .bind(userId, userId)
    .run();
}

function conflict(state) {
  return { status: 'conflict', ...state };
}

function unchanged(state) {
  return { status: 'unchanged', ...state };
}

function pushed(state) {
  return { status: 'pushed', ...state };
}

/**
 * Push a save with optimistic concurrency. `baseVersion` is the version the
 * client last saw; the update only lands if the server is still there.
 */
export async function pushSave(env, { user, device, save, baseVersion, reason = 'push' }) {
  const invalid = validateSave(save);
  if (invalid) throw new HttpError(400, invalid);

  const hash = await sha256Hex(save);
  const now = Date.now();
  const current = await getSaveRow(env, user.id);

  if (!current) {
    const insert = await env.DB.prepare(
      `INSERT INTO saves (user_id, version, save, hash, updated_at, device_id, device_name)
       VALUES (?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO NOTHING`,
    )
      .bind(user.id, save, hash, now, device.id, device.name)
      .run();

    if (!insert.meta?.changes) {
      const raced = await getSaveRow(env, user.id);
      const state = publicState(raced);
      return raced?.save === save ? unchanged(state) : conflict(state);
    }

    await insertHistory(env, {
      userId: user.id,
      version: 1,
      save,
      hash,
      deviceName: device.name,
      reason: reason === 'force' ? 'force' : 'initial',
    });
    await touchDevice(env, device.id, 1);
    return pushed(publicState({ version: 1, save, hash, updated_at: now, device_name: device.name }));
  }

  if (save === current.save) {
    await touchDevice(env, device.id, current.version);
    return unchanged(publicState(current));
  }

  if (Number(baseVersion) !== Number(current.version)) {
    return conflict(publicState(current));
  }

  const nextVersion = Number(current.version) + 1;
  const update = await env.DB.prepare(
    `UPDATE saves
        SET version = ?, save = ?, hash = ?, updated_at = ?, device_id = ?, device_name = ?
      WHERE user_id = ? AND version = ?`,
  )
    .bind(nextVersion, save, hash, now, device.id, device.name, user.id, current.version)
    .run();

  if (!update.meta?.changes) {
    return conflict(publicState(await getSaveRow(env, user.id)));
  }

  await insertHistory(env, {
    userId: user.id,
    version: current.version,
    save: current.save,
    hash: current.hash,
    deviceName: current.device_name,
    reason: reason === 'force' ? 'force-overwritten' : 'push',
  });
  await touchDevice(env, device.id, nextVersion);
  return pushed(publicState({ version: nextVersion, save, hash, updated_at: now, device_name: device.name }));
}

export async function archiveSave(env, { user, device, save }) {
  const invalid = validateSave(save);
  if (invalid) throw new HttpError(400, invalid);
  const hash = await sha256Hex(save);
  const current = await getSaveRow(env, user.id);
  await insertHistory(env, {
    userId: user.id,
    version: current ? current.version : 0,
    save,
    hash,
    deviceName: device.name,
    reason: 'archive',
  });
  return { status: 'archived', version: current ? current.version : 0, hash };
}

export async function listHistory(env, userId) {
  const rows = await env.DB.prepare(
    `SELECT id, version, hash, created_at, device_name, reason, length(save) AS size
       FROM save_history
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT ${HISTORY_LIMIT}`,
  )
    .bind(userId)
    .all();
  return (rows.results || []).map((row) => ({
    id: row.id,
    version: row.version,
    hash: row.hash,
    createdAt: row.created_at,
    deviceName: row.device_name,
    reason: row.reason,
    size: row.size,
  }));
}

export async function getHistoryItem(env, userId, id) {
  const row = await env.DB.prepare(
    'SELECT id, version, save, hash, created_at, device_name, reason FROM save_history WHERE id = ? AND user_id = ?',
  )
    .bind(id, userId)
    .first();
  if (!row) throw new HttpError(404, 'save version not found');
  return {
    id: row.id,
    version: row.version,
    save: row.save,
    hash: row.hash,
    createdAt: row.created_at,
    deviceName: row.device_name,
    reason: row.reason,
  };
}
