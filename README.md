# AZS Sync

Passkey-protected cloud sync for the sealed browser save of **Azeroth Survivors** (`https://wow.aethus.pl/`).

The game has no login. It keeps the whole account in `localStorage['rogue.characters']` as a sealed `RSE1:` blob (~1.6 KB), and imports replace the whole account. This project copies that blob between browsers without decrypting or re-sealing it.

## What it does

- A **Cloudflare Worker + D1** service stores the current sealed save, its SHA-256 hash, a version number, the device that wrote it, and the last 50 versions.
- A **passkey dashboard** (WebAuthn) creates the sync account, manages device tokens, downloads saves, and browses history.
- A **Tampermonkey userscript** runs on `https://wow.aethus.pl/*`, reads/writes the game's own `localStorage`, and pushes or pulls automatically.
- **No merge.** The game cannot merge two accounts. If both devices changed since the last sync, the userscript asks which one to keep and archives the other in history.

```
[Vivaldi Android + Tampermonkey] ─┐
                                  ├─ HTTPS ─> [Cloudflare Worker + D1]
[Brave desktop + Tampermonkey] ───┘             ├─ passkey dashboard
                                                ├─ device tokens (hashed)
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

# 5. Set an operator recovery token. This is the bootstrap login on a browser
#    without a platform passkey provider (common on Linux) and an emergency
#    fallback. Recommended.
openssl rand -base64 48 | npx wrangler secret put RECOVERY_TOKEN

# 6. Deploy.
npm run deploy
```

Open the deployed `https://azs-sync.<your-subdomain>.workers.dev/` URL and create the account with a passkey. **Save the recovery code shown after registration** — it is shown once, and it is how you sign in on a device that does not have your passkey yet. From there you can add a passkey on each device.

If your desktop browser has no platform passkey provider (common on Linux), the first-run screen also offers the operator recovery token. Use it to create the account, then add a passkey on your phone. If your phone does not have the passkey yet: open the dashboard in the phone browser, sign in with **Use recovery code**, then click **Add passkey** to create a phone-local passkey. After that, normal passkey sign-in works on both devices.

> Passkeys are bound to the dashboard origin. If you later move the Worker to a custom domain, log in with the recovery code (or the old passkey), add a passkey for the new origin, and keep the old one until you are sure.

### Local development

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
# http://localhost:8787
```

The example `.dev.vars` includes `RECOVERY_TOKEN=dev-recovery-token`, so you can sign in locally without a platform authenticator. Do not deploy with that token.

```bash
npm test
```

## Connect a browser

1. Open the dashboard in the browser you will play in (or on your desktop) and sign in.
2. Install **Tampermonkey** in that browser.
3. On the dashboard, click **Install userscript** and confirm the install.
4. In the dashboard, create a device (for example “Desktop” or “Phone”).
5. Open the device's **pairing link** on the game page. It looks like:

   ```
   https://wow.aethus.pl/#azs-pair=<base64url JSON>
   ```

   The userscript reads the fragment, stores the server URL + device token in the game's localStorage, clears the fragment, and starts syncing. The token is shown only once.

6. Play. The small **AZS** pill in the corner shows the state:
   - `AZS synced` — up to date
   - `AZS newer` — the server has a newer save; open the pill and choose **Sync now**
   - `AZS conflict` — both sides changed; choose one
   - `AZS offline` — will retry

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
- Install the userscript from your dashboard, then use the pairing link.
- Keep Brave as your normal browser; use Vivaldi only for the game if you prefer. Alternatively, use the dashboard's **manual mode** in Brave (upload/download a `.sav` around each session) without installing anything.
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

Device endpoints use `Authorization: Bearer azs_…`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/config` | none | dashboard bootstrap |
| GET | `/api/me` | session | current user |
| POST | `/api/auth/register/options` | none/session | create account or add passkey |
| POST | `/api/auth/register/verify` | challenge | verify passkey |
| POST | `/api/auth/login/options` | none | passkey sign-in |
| POST | `/api/auth/login/verify` | challenge | verify sign-in |
| POST | `/api/auth/recovery` | recovery code | password fallback |
| POST | `/api/auth/logout` | session | sign out |
| GET/POST | `/api/devices` | session | list/create devices |
| DELETE | `/api/devices/:id` | session | revoke a device |
| GET | `/api/state` | session/device | current save |
| POST | `/api/sync` | device | push with `baseVersion` |
| POST | `/api/force` | device | user-confirmed overwrite |
| POST | `/api/archive` | device | keep a losing save in history |
| GET | `/api/history` | session/device | last 50 versions |
| GET | `/api/history/:id` | session/device | one version |
| GET | `/api/save` | session | current save for download |
| POST | `/api/save` | session | manual upload/replace from the dashboard |
| GET | `/api/health` | none | health check |

CORS is restricted to `https://wow.aethus.pl` so the userscript can call the API from the game page. The device token is the actual authorization; CORS is not a security boundary outside browsers.

## Security and privacy

- The save is never decrypted. The server only sees the sealed `RSE1:` text.
- Device tokens are random 32-byte values, stored only as SHA-256 hashes. The raw token exists in the browser's localStorage and in the one-time pairing link fragment. The fragment is not sent to the server.
- Passkeys are verified with `@simplewebauthn/server`; challenges are single-use, expire after five minutes, and travel in an HttpOnly cookie.
- Dashboard sessions are HMAC-signed, HttpOnly, SameSite=Lax cookies; `SESSION_SECRET` is required.
- Every account created through the dashboard gets a random **recovery code**, stored only as a SHA-256 hash. It is shown once and can sign in / add a passkey on another device. Store it like a password.
- `RECOVERY_TOKEN` is an operator fallback for a fresh instance or an emergency, and the bootstrap login on a browser without a platform passkey provider. It is a full account login. Use a long random value and store it like a password.
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
src/devices.js     device tokens
src/saves.js       optimistic save sync + history
src/sync.js        pure sync decision + validation
src/util.js        base64url, cookies, JSON helpers
public/            dashboard + Tampermonkey userscript
migrations/        D1 schema
test/              node:test unit tests
```

## License

MIT
