# AZS Sync

Cloud sync for **Azeroth Survivors** browser saves (`https://wow.aethus.pl/`).

The game has no login. It keeps your whole account in the browser as a sealed `RSE1:` save, and importing a save replaces the whole account. AZS Sync copies that sealed file between browsers without decrypting or modifying it.

## Use the hosted instance

**https://azs-sync.shrm.workers.dev**

You can use this instance. There is no invite and no operator approval: create an account with a passkey and start syncing. Each account is isolated; your save, pairing QR, and history are only yours.

### Quick start

1. Open the hosted instance on your desktop.
2. Click **Create an account**, complete the Turnstile check, and create a passkey.
3. The dashboard immediately shows a **Sync another device** QR. There is no “create device” step.
4. Scan the QR with a phone or tablet, **or copy the setup link and open it on another desktop/laptop**. A computer without a camera uses the copied link.
5. Follow the setup page:
   - **Vivaldi on Android:** install Tampermonkey, install the userscript, tap **Open game & pair**. Automatic sync.
   - **Brave or another Android browser:** use **Manual transfer** on the setup page. No passkey and no dashboard login are needed on the device.
   - **Another desktop/laptop:** install Tampermonkey, install the userscript, and open the game from the setup page.
6. Play. The small **AZS** pill in the bottom-right of the game shows sync status.

The dashboard also has a copyable **Game pair link** if you want to paste the direct game URL instead of scanning. Any number of desktops, laptops, tablets, and phones can use the same setup link; there is no per-device list.

### What another device needs

The other device **does not need a passkey, recovery code, or dashboard login** for either path. The QR contains an account pairing key; the setup page uses it for automatic sync and for token-authorized `.sav` upload/download.

- **Automatic on desktop:** Brave/Chrome/Edge + Tampermonkey. The setup page detects a desktop and shows the Tampermonkey/userscript steps.
- **Automatic on Android:** Vivaldi 8.2+ + Tampermonkey. The game needs WebGPU (Android 12+ with a supported GPU).
- **Manual:** works in any browser, including Brave Android. Export a `.sav` from the game, upload it on the setup page, then download/import on another device. The setup page is the QR page; no login.

The passkey is only for the **desktop dashboard**, where you manage the QR and optional recovery code.

The passkey is only for the **desktop dashboard**, where you manage the QR and optional recovery code.

### Important

- **No merge.** Importing replaces the whole account. If two devices both changed, the userscript asks which save to keep and archives the other in history.
- **The QR is a key.** Anyone with the QR/setup link can sync or overwrite this account. Treat it like a password. **Reset QR** invalidates old scans and userscripts.
- **History shows previous versions**, not every sync event. The current save is shown in the Manual transfer card.
- **Recovery codes are optional.** Signup does not create one. If you want a fallback for a device without your passkey, open the dashboard and click **Recovery code**; it is shown once and replaces any older code.
- **The AZS userscript** is version 0.1.1; its panel can download the current local save and the pre-pull backup (`rogue.characters.backup.1`).
- **The game must support WebGPU.** If it does not boot in Vivaldi, try Lemur or Quetta. Brave for Android does not support extensions yet, so it uses manual transfer.

### Troubleshooting

**The QR opened Brave, not Vivaldi.**  
The setup page detects this and offers **Copy setup link**. Install Vivaldi, paste the link into Vivaldi, or make Vivaldi your default browser and scan again.

**The game does not boot on a phone or tablet.**  
Check WebGPU support. Try a current Vivaldi/Lemur/Quetta on Android 12+ with a supported GPU. The desktop/Windows build is a fallback.

**The pairing link says it was reset or is invalid.**  
Refresh the dashboard and scan/copy the current QR. **Reset QR** invalidates old links by design.

**The AZS pill says “newer” or “conflict.”**  
“Newer” means the server has a newer save; open the pill and choose **Sync now**. “Conflict” means both sides changed; choose the save to keep. The other is kept in history.

**History only shows an old device label.**  
History lists the version that was replaced, and the device label came from the old pairing flow. Look at the current save in the Manual transfer card; a new push becomes the current version, and the old version appears in history.

**I lost the save on one device.**  
Export from the game (Options → Saves → Export Save) before making changes. The userscript panel’s **Local .sav** and **Backup .sav** buttons download the browser’s current and pre-pull saves. The dashboard can also upload an exported `.sav`.

---

## For developers

### What this is

- A Cloudflare Worker and D1 database store each account’s sealed save, SHA-256 hash, version, and last 50 replaced versions.
- Passkey (WebAuthn) accounts; no passwords, no operator-wide login.
- One account-level pairing key/QR; no per-device list.
- A Tampermonkey userscript runs on `https://wow.aethus.pl/*` and pushes/pulls automatically.
- A token-authorized device setup page (`/pair#t=…`) provides automatic setup instructions and manual upload/download without a dashboard session.
- Optional recovery codes and optional Cloudflare Turnstile.
- Per-IP rate limits on account creation, recovery, and passkey login.

```text
[Vivaldi Android + Tampermonkey] ─┐
                                  ├─ HTTPS ─> [Cloudflare Worker + D1]
[Brave desktop + Tampermonkey] ───┘             ├─ passkey dashboard + account QR
                                                ├─ device setup / manual page
                                                └─ sealed save history
```

### Requirements

- Node.js 20+ and npm.
- A Cloudflare account (free tier is enough).
- A browser with WebAuthn for the dashboard.
- For automatic sync on Android: a Chromium-based browser with Chrome extension support. **Vivaldi 8.2+** is recommended; Lemur or Quetta also work. Brave for Android does not support stable extensions yet.
- The game needs WebGPU: Android 12+ with a current Chromium and supported GPU.

### Deploy your own

```bash
npm install

# 1. Create the D1 database.
npx wrangler login
npx wrangler d1 create azs-sync

# 2. Put the database id into wrangler.jsonc.

# 3. Apply all migrations.
npm run db:migrate:remote

# 4. Sign dashboard sessions.
openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET

# 5. Optional: Turnstile for account creation and recovery.
#    Create a widget for your Worker hostname in the Cloudflare dashboard.
# npx wrangler secret put TURNSTILE_SITE_KEY
# npx wrangler secret put TURNSTILE_SECRET_KEY

# 6. Deploy.
npm run deploy
```

Every visitor can create an account. If someone loses their passkey and never created a recovery code, that account cannot be recovered.

Passkeys are bound to the dashboard origin. If you move the Worker to a custom domain, sign in with the optional recovery code, add a passkey for the new origin, and keep the old one until you are sure.

### Turnstile and rate limits

Turnstile is optional. When both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set, account creation and recovery require the challenge. Without them, per-IP limits still apply:

- 15 account-creation attempts/hour
- 30 recovery attempts/hour
- 60 passkey-login attempts/hour

Adjust the limits in `src/index.js`.

### Local development

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
# http://localhost:8787
```

The local instance is **same-machine only**. Another device cannot reach `http://localhost:8787`, and a QR generated there embeds localhost. Deploy before syncing another device. A passkey made on localhost is bound to localhost.

For local Turnstile UI testing, use Cloudflare’s documented test keys in `.dev.vars`; they always pass and are not protection.

```bash
npm test
```

### The save flow

The userscript stores three values in the game’s localStorage:

| Key | Meaning |
| --- | --- |
| `azs.sync.config` | `{ api, token, name }` |
| `azs.sync.base` | The last save both sides agreed on |
| `azs.sync.cache` | The last known remote save, written before the game boots |

- Local unchanged + server changed → pull.
- Local changed + server unchanged → push.
- Both changed → conflict dialog: keep this device, use the server, or download both.
- A pull keeps the previous local save in `rogue.characters.backup.1`.
- The server uses `baseVersion` optimistic concurrency, so a stale tab cannot silently overwrite a newer save.

### API

The userscript authenticates with the account pairing token:

```http
Authorization: Bearer azs_…
X-AZS-Device: Desktop
```

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/config` | none | dashboard bootstrap / Turnstile key |
| GET | `/api/me` | session | current user |
| POST | `/api/auth/register/options` | none/session | create account or add passkey |
| POST | `/api/auth/register/verify` | challenge | verify passkey |
| POST | `/api/auth/login/options` | none | passkey sign-in |
| POST | `/api/auth/login/verify` | challenge | verify sign-in |
| POST | `/api/auth/recovery` | optional recovery code | sign-in fallback |
| POST | `/api/auth/logout` | session | sign out |
| POST | `/api/account/recovery` | session | create/replace optional recovery code |
| GET | `/api/pairing` | session | account pairing token |
| POST | `/api/pairing/reset` | session | rotate account pairing token |
| GET | `/api/state` | session/account | current save |
| POST | `/api/sync` | account | push with `baseVersion` |
| POST | `/api/force` | account | user-confirmed overwrite |
| POST | `/api/archive` | account | keep a losing save in history |
| GET | `/api/history` | session/account | previous versions |
| GET | `/api/history/:id` | session/account | one previous version |
| POST | `/api/save` | session | manual upload from dashboard |
| GET | `/api/save` | session | current save for dashboard |
| GET | `/api/health` | none | health check |

CORS is restricted to `https://wow.aethus.pl` for the userscript. The account pairing token is the authorization; CORS is not a security boundary outside browsers.

### Security

- Saves are never decrypted. The server stores the sealed `RSE1:` text.
- The account pairing key is random 32 bytes. It is stored in D1 in a recoverable form so the dashboard can show its QR again; authentication checks a SHA-256 hash. The raw key also exists in the browser’s localStorage and in the setup-link fragment, which is not sent to the setup server. Treat the QR and database access as save access.
- **Reset QR** replaces the account key; all previous scans/userscripts stop until re-paired. There is no per-device token list.
- Passkeys are verified with `@simplewebauthn/server`; challenges are single-use, expire after five minutes, and travel in an HttpOnly cookie.
- Dashboard sessions are HMAC-signed, HttpOnly, SameSite=Lax cookies; `SESSION_SECRET` is required.
- Optional recovery codes are stored only as SHA-256 hashes and shown once.
- There is no operator-wide login.
- Account creation and recovery are rate-limited; Turnstile is optional.
- Self-host if you do not trust the instance.

### Limitations

- **No merge.** The game’s import replaces the whole account.
- **One writer at a time.** Two devices without syncing create a conflict.
- **One game tab at a time.** Tabs share localStorage and can race; the server rejects the stale writer.
- The game writes saves when you leave a shop/end a run; only written saves sync.
- The device setup page and direct game link require the userscript to be installed for automatic sync; browsers always require user confirmation to install an extension.
- No account-deletion UI yet.

### Layout

```text
src/index.js       Worker routes, CORS, static assets
src/auth.js        passkeys, sessions, challenges, optional recovery
src/devices.js     legacy device-token auth + account-token auth
src/pairing.js     account-level pairing key
src/saves.js       optimistic save sync + history
src/ratelimit.js   per-IP auth rate limits
src/turnstile.js   optional Turnstile verification
src/sync.js        pure sync decision + validation
src/util.js        base64url, cookies, JSON helpers
public/            dashboard, device setup page, Tampermonkey userscript
public/pair.*      token-authorized device setup + manual transfer page
public/vendor/     qrcode-generator (MIT) for the pairing QR
migrations/        D1 schema
test/              node:test unit tests
```

### License

MIT

The QR renderer in `public/vendor/qrcode.mjs` is [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase, also MIT.
