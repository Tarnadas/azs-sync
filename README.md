# AZS Sync

Passkey-protected cloud sync for the sealed browser save of **Azeroth Survivors** (`https://wow.aethus.pl/`).

The game has no login. It keeps the whole account in `localStorage['rogue.characters']` as a sealed `RSE1:` blob (~1.6 KB), and imports replace the whole account. This project copies that blob between browsers without decrypting or re-sealing it.

## What it does

- A **multi-user Cloudflare Worker + D1** service stores each account's current sealed save, its SHA-256 hash, version, and last 50 versions.
- A **passkey dashboard** (WebAuthn) lets anyone create an account; every account has its own account-level pairing QR, save, and history. Recovery codes are optional.
- Per-IP rate limits protect account creation/recovery; Cloudflare Turnstile can be layered on top.
- A **Tampermonkey userscript** runs on `https://wow.aethus.pl/*`, reads/writes the game's own `localStorage`, and pushes or pulls automatically.
- **No merge.** The game cannot merge two accounts. If both devices changed since the last sync, the userscript asks which one to keep and archives the other in history.

```
[Vivaldi Android + Tampermonkey] ─┐
                                  ├─ HTTPS ─> [Cloudflare Worker + D1]
[Brave desktop + Tampermonkey] ───┘             ├─ passkey dashboard
                                                ├─ account pairing QR
                                                └─ sealed save history
```

## Requirements

- Node.js 20+ and npm.
- A Cloudflare account (free tier is enough).
- A browser with WebAuthn for the dashboard (any current browser).
- For automatic phone sync: a Chromium-based Android browser with **Chrome extension support**. **Vivaldi 8.2+** is the recommended one (Chromium 152/156, extensions from the Chrome Web Store). Lemur or Quetta also work. Brave for Android does not support stable extensions yet.
- The game itself needs **WebGPU**: Android 12+ with a current Chromium build and a supported GPU.

On desktop, Brave/Chrome/Edge with Tampermonkey works today.

## Deploy

```bash
npm install

# 1. Create the D1 database and copy its id into wrangler.jsonc.
npx wrangler login
npx wrangler d1 create azs-sync

# 2. Edit wrangler.jsonc and replace REPLACE_WITH_YOUR_D1_DATABASE_ID.

# 3. Create the tables.
npm run db:migrate:remote

# 4. Sign the dashboard session cookie.
openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET

# 5. Optional: Cloudflare Turnstile for account creation and recovery.
#    Create a widget for your Worker domain in the Cloudflare dashboard first.
# npx wrangler secret put TURNSTILE_SITE_KEY
# npx wrangler secret put TURNSTILE_SECRET_KEY

# 6. Deploy.
npm run deploy
```

The deployed site is **multi-user**: every visitor can create their own account with a passkey. Each account has its own dashboard, account-level pairing QR, save, and history. There is no create-device step; the QR exists as soon as you sign in.

**Recovery codes are optional.** By default an account is passkey-only; creating it shows no recovery code. If you want a fallback for a device where your passkey does not sync, open the dashboard and click **Recovery code**. It shows a code once and replaces any earlier code for that account.

There is no operator-wide login. If someone loses their passkey and never created a recovery code, that account cannot be recovered.

Turnstile is optional. If you set both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`, registration and recovery require the challenge. If you leave them unset, the built-in per-IP rate limits still apply.

To activate Turnstile:

1. Cloudflare dashboard → **Turnstile** → **Add widget**.
2. Add your Worker hostname, e.g. `azs-sync.<your-subdomain>.workers.dev`.
3. Copy the site key and secret key.
4. Set them on the Worker:

   ```bash
   npx wrangler secret put TURNSTILE_SITE_KEY
   npx wrangler secret put TURNSTILE_SECRET_KEY
   ```

Reload the dashboard. The widget appears on account creation and recovery. No redeploy is needed; the Worker reads the secrets from `/api/config`.

The built-in limits (fixed window per IP) are: **15 account-creation attempts/hour**, **30 recovery attempts/hour**, and **60 passkey-login attempts/hour**. Adjust them in `src/index.js` if your community is behind a shared NAT.

> Passkeys are bound to the dashboard origin. If you later move the Worker to a custom domain, sign in with the account recovery code (if you created one), add a passkey for the new origin, and keep the old one until you are sure.

### Local development

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
# http://localhost:8787
```

There is no local operator login. Create an account with a passkey, or set Cloudflare's documented Turnstile test keys in `.dev.vars` if you want to exercise the widget locally. The rate limits apply locally too; delete the `rate_limits` table rows to reset them.

**Localhost is same-machine only.** A phone cannot reach `http://localhost:8787`, and a QR/setup link generated there embeds localhost. Deploy the Worker before pairing a phone or using manual transfer on another device. A passkey made on localhost is also bound to localhost.

```bash
npm test
```

## Connect a browser

1. Open the dashboard on your desktop and sign in.
2. The **Sync to your phone** card is already there. There is no create-device step.
3. Scan the QR with your phone camera. It opens a **setup page** (`/pair#t=…`) carrying your account pairing key.
4. The setup page detects the browser and shows the relevant steps:
   - **Vivaldi Android:** install Tampermonkey, install the userscript, then open the game.
   - **Brave/other Android:** install Vivaldi, copy the setup link, and open it in Vivaldi. Or use Manual transfer on the dashboard.
   - **Desktop:** install Tampermonkey, install the userscript, then open the game.
5. On Vivaldi, install **Tampermonkey** from the Chrome Web Store (enable “Desktop site” if the store asks), open **Install azs-sync.user.js**, confirm, then tap **Open game & pair**.
6. Play. The small **AZS** pill in the bottom-right corner shows the state:
   - `AZS synced` — up to date
   - `AZS newer` — the server has a newer save; open the pill and choose **Sync now**
   - `AZS conflict` — both sides changed; choose one
   - `AZS offline` — will retry

The QR is **account-level**. There is no per-device token list to manage; any number of devices can pair with the same setup link. **Reset QR** rotates the account key and invalidates older scans. Android and browsers still require a user confirmation to install an app or extension, so the setup page puts all the required links on one screen rather than pretending it can install them silently.

### Manual mode (no userscript, any browser)

The dashboard also works as a manual transfer tool, including in **Brave for Android** (which has no stable extension support yet):

1. In the game: **Options → Saves → Export Save**. The `.sav` lands in Downloads.
2. Open the dashboard, sign in with the recovery code/passkey, and click **Upload .sav** in the Save card.
3. On the other device, download the current save from the dashboard.
4. In the game: **Options → Saves → Import Save**, pick the downloaded `.sav`, confirm.

This is more taps than the userscript, but it uses no browser extensions and keeps the same version history. The dashboard handles conflicts: if the server has newer progress, it asks before replacing it.

### Android notes

- Install **Vivaldi** from the Play Store.
- Open the Chrome Web Store in Vivaldi, enable **Desktop site** if needed, and install **Tampermonkey**.
- Scan the dashboard QR. The setup page walks through Vivaldi, Tampermonkey, the userscript, and the game link.
- Keep Brave as your normal browser; use Vivaldi only for the game if you prefer. Alternatively, use the dashboard's **manual mode** in Brave (upload/download a `.sav` around each session) without installing anything.
- A QR scan may open your default browser. If that is Brave, the setup page offers **Copy setup link**; paste it into Vivaldi. Setting Vivaldi as the default browser makes the QR open there directly.
- When Brave Android ships extension support, the same userscript can be installed there. As of November 2026 it is behind `brave://flags/#brave-android-extensions` and the phone UI is not finished.
- If the game does not boot in Vivaldi, check `navigator.gpu` / open a WebGPU demo. If WebGPU is unavailable, try Lemur or Quetta; if the device cannot do WebGPU, no browser will run this game.

## How the sync logic works

The client stores three values in the game's localStorage:

| Key | Meaning |
| --- | --- |
| `azs.sync.config` | `{ api, token, name }` |
| `azs.sync.base` | The last save both sides agreed on |
| `azs.sync.cache` | The last known remote save, used to pull before the game boots |

On load:

- If the local save is unchanged since `base` and `cache` is newer, the cached remote is written synchronously before the game boots.
- Then the userscript fetches `/api/state`; if the server is still newer, it writes the save and reloads.
- If the local save changed, it pushes when the server is unchanged.
- If both changed, it shows the conflict dialog: use this device, use the server, or download both.
- Pulling stores the previous local save in `rogue.characters.backup.1`.

The server uses optimistic concurrency: a push includes the `baseVersion` the client last saw. If the server is no longer there, the update is rejected with `409` and the current state, so a stale tab cannot silently overwrite a newer save.

## API

Authenticated sync endpoints use `Authorization: Bearer azs_…` with the account pairing token; the userscript also sends `X-AZS-Device` so history can label the device.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/config` | none | dashboard bootstrap |
| GET | `/api/me` | session | current user |
| POST | `/api/auth/register/options` | none/session | create account or add passkey |
| POST | `/api/auth/register/verify` | challenge | verify passkey |
| POST | `/api/auth/login/options` | none | passkey sign-in |
| POST | `/api/auth/login/verify` | challenge | verify sign-in |
| POST | `/api/auth/recovery` | optional recovery code | sign-in fallback |
| POST | `/api/account/recovery` | session | create/replace the account recovery code |
| POST | `/api/auth/logout` | session | sign out |
| GET | `/api/pairing` | session | get the account pairing token |
| POST | `/api/pairing/reset` | session | rotate the account pairing token |
| GET | `/api/state` | session/device | current save |
| POST | `/api/sync` | device | push with `baseVersion` |
| POST | `/api/force` | device | user-confirmed overwrite |
| POST | `/api/archive` | device | keep a losing save in history |
| GET | `/api/history` | session/device | last 50 versions |
| GET | `/api/history/:id` | session/device | one version |
| GET | `/api/save` | session | current save for download |
| POST | `/api/save` | session | manual upload/replace from the dashboard |
| GET | `/api/health` | none | health check |

CORS is restricted to `https://wow.aethus.pl` so the userscript can call the API from the game page. The account pairing token is the actual authorization; CORS is not a security boundary outside browsers.

## Security and privacy

- The save is never decrypted. The server only sees the sealed `RSE1:` text.
- The account pairing key is a random 32-byte value stored in D1 in a recoverable form so the dashboard can show its QR again; authentication checks a SHA-256 hash. The raw key also exists in the browser's localStorage and in the setup-link fragment (the fragment is not sent to the setup server). Treat the QR and database access as equivalent to save access.
- **Reset QR** replaces the account key; every previously scanned/userscript pairing stops syncing until re-paired. There is no per-device token list.
- Passkeys are verified with `@simplewebauthn/server`; challenges are single-use, expire after five minutes, and travel in an HttpOnly cookie.
- Dashboard sessions are HMAC-signed, HttpOnly, SameSite=Lax cookies; `SESSION_SECRET` is required.
- Recovery codes are **optional**. When created from the dashboard, a random code is stored only as a SHA-256 hash; it is shown once and can sign in / add a passkey on another device. A new code replaces the old one. Store it like a password.
- There is no operator-wide login. Each account's recovery code only opens that account.
- Account creation and recovery are protected by per-IP fixed-window rate limits. Optional Cloudflare Turnstile adds a bot challenge; it requires `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`.
- The dashboard sets a strict CSP and refuses framing. The service stores the sealed save; if you do not trust the server, self-host it.
- Do not publish a public instance that stores other people's saves without their consent.

## Limitations

- **Whole-account replacement.** No merge. The game's import replaces the account.
- **One writer at a time.** Playing on two devices without syncing between them creates a conflict, not a merge.
- **One game tab at a time.** Two open tabs share the same localStorage and can race each other; the server will reject the stale writer, but the conflict is easier to avoid with one tab.
- **Local-only progress during a run.** The game writes the save when you leave a shop/end a run; the userscript can only sync what the game has written.
- **Game updates may change the key.** The keys are at the top of the userscript (`rogue.characters`, `rogue.characters.backup.1`). Update the userscript if the game changes them.
- **Not affiliated with Aethus or Blizzard.** Use your own saves; this tool copies the sealed blob verbatim and does not bypass the game's tamper check.

## Layout

```
src/index.js       Worker routes, CORS, static assets
src/auth.js        passkeys, sessions, challenges
src/devices.js     legacy device-token auth + account-token auth
src/pairing.js     account-level pairing key
src/saves.js       optimistic save sync + history
src/ratelimit.js   per-IP auth rate limits
src/turnstile.js   optional Cloudflare Turnstile verification
src/sync.js        pure sync decision + validation
src/util.js        base64url, cookies, JSON helpers
public/            dashboard, phone setup page, Tampermonkey userscript
public/vendor/     qrcode-generator (MIT) for the pairing QR
migrations/        D1 schema (0001 initial, 0002 tokens, 0003 rate limits, 0004 pairing key)
test/              node:test unit tests
```

## License

MIT

The QR renderer in `public/vendor/qrcode.mjs` is [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase, also MIT.
