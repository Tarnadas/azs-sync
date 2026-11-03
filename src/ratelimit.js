import { HttpError } from './util.js';

/**
 * Fixed-window per-IP limiter. This is intentionally simple: a public
 * registration endpoint without any limit is an invitation to fill D1 with
 * junk accounts. Turnstile can be layered on top when configured.
 */
export async function enforceRateLimit(env, request, bucket, limit, windowMs) {
  const forwarded = request.headers.get('x-forwarded-for') || '';
  const ip =
    request.headers.get('cf-connecting-ip') ||
    forwarded.split(',')[0].trim() ||
    'local';
  const key = `${bucket}:${ip}`;
  const now = Date.now();

  const row = await env.DB.prepare(
    'SELECT count, window_start FROM rate_limits WHERE key = ?',
  )
    .bind(key)
    .first();

  let count = 1;
  let started = now;
  if (row && now - Number(row.window_start) < windowMs) {
    count = Number(row.count) + 1;
    started = Number(row.window_start);
  }

  await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, window_start)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET count = excluded.count, window_start = excluded.window_start`,
  )
    .bind(key, count, started)
    .run();

  if (Math.random() < 0.02) {
    await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?')
      .bind(now - 24 * 60 * 60 * 1000)
      .run();
  }

  if (count > limit) {
    const retry = Math.max(1, Math.ceil((started + windowMs - now) / 1000));
    throw new HttpError(429, `too many attempts; try again in ${retry}s`, 'rate_limited');
  }
}
