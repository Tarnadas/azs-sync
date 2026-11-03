import { HttpError } from './util.js';

/**
 * Optional Cloudflare Turnstile check. When TURNSTILE_SECRET_KEY is not set,
 * the service relies on the per-IP rate limiter alone.
 */
export async function verifyTurnstile(request, env, token) {
  if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY) return;
  if (!token || typeof token !== 'string') {
    throw new HttpError(400, 'verification challenge is required');
  }

  const form = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token,
  });
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) form.set('remoteip', ip);

  let data;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    data = await response.json();
  } catch {
    throw new HttpError(502, 'verification service unavailable');
  }

  if (!data?.success) {
    throw new HttpError(400, 'verification challenge failed');
  }
}
