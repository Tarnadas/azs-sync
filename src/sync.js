export const SAVE_PREFIX = 'RSE1:';
export const MAX_SAVE_BYTES = 65536;
export const HISTORY_LIMIT = 50;

export function validateSave(save) {
  if (typeof save !== 'string') return 'save must be a string';
  if (save.length === 0) return 'save is empty';
  if (new TextEncoder().encode(save).length > MAX_SAVE_BYTES) return 'save is too large';
  if (!save.startsWith(SAVE_PREFIX)) return 'save is not a sealed RSE1: save';
  return null;
}

/**
 * Decide what a client should do with its local save, its last-synced save,
 * and the server's current save.
 *
 * The game's import replaces the whole account, so there is deliberately no
 * merge case. A conflict means both sides changed since the last sync.
 *
 * @param {{localSave: string|null, baseSave: string|null, remote: {version:number, save:string}|null}} input
 * @returns {'noop'|'push'|'pull'|'conflict'}
 */
export function decideSync({ localSave, baseSave, remote }) {
  const local = localSave || null;
  const base = baseSave || null;
  const hasRemote = Boolean(remote && remote.version > 0 && remote.save);

  if (!hasRemote) return local ? 'push' : 'noop';
  if (!local) return 'pull';
  if (local === remote.save) return 'noop';
  if (local === base) return 'pull';
  if (remote.save === base) return 'push';
  return 'conflict';
}

export function publicState(row) {
  if (!row) {
    return { version: 0, save: null, hash: null, updatedAt: null, deviceName: null };
  }
  return {
    version: row.version,
    save: row.save,
    hash: row.hash,
    updatedAt: row.updated_at,
    deviceName: row.device_name || null,
  };
}
