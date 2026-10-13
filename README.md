# lightroom-portfolio-sync

Keeps a photography portfolio in sync with an album in **Adobe Lightroom (cloud)**. Add a photo to the album and it shows up on your static site on the next run. Remove it and it's gone. Built for [Astro](https://astro.build), works with any static site generator that can read a JSON file.

One file, Node 18+, no npm dependencies.

What one run does:

1. Refreshes the Adobe access token with the stored refresh token (and saves the new refresh token)
2. Reads your album (default `Portfolio`, sub-albums become categories) in your Lightroom order
3. Downloads the 2048 px rendition of every new or edited photo, reads camera / lens / settings from the XMP metadata
4. Optional: asks Claude for 1-2 categories and an alt text per new photo, cached per asset version
5. Writes `src/data/lightroom.json`, and only if something changed: runs your build and copies `dist/` to your webroot
6. Optional: push notification via [ntfy](https://ntfy.sh)

## Requirements

- An Adobe account with a Creative Cloud plan that includes **Lightroom (cloud)**, and your photos synced to the cloud. Lightroom Classic catalogs are only visible if you sync a collection to the cloud.
- Node.js 18 or newer (uses the built-in `fetch`)
- A Linux server (or any machine) that can run cron or a systemd timer and write to your webroot
- Optional: an [Anthropic API key](https://console.anthropic.com/) for automatic categories and alt texts
- Optional: [`sharp`](https://www.npmjs.com/package/sharp) in your project. If it's installed, images are shrunk to 800 px before they go to Claude, otherwise the 2048 px rendition is sent as is. Astro projects usually have it already.

## 1. Adobe Developer Console

1. Go to <https://developer.adobe.com/console>, create a new project, **Add API** → **Lightroom Services**.
2. Credential type: **OAuth Web App**.
3. **Default redirect URI**: an HTTPS URL on your domain, e.g. `https://example.com/lr-connect/`. The page doesn't have to exist, you only need the `code` from the address bar after the redirect.
4. **Redirect URI pattern**: this is a regex, dots need a double backslash: `https://example\\.com/lr-connect/.*`. The default redirect URI must match it (mind the trailing slash). A wrong pattern ends with "API configuration failed".
5. Copy **Client ID** (also used as the API key) and **Client Secret**.

Scopes the script requests (override with `"scopes"` in the config):

```
openid,AdobeID,lr_partner_apis,lr_partner_rendition_apis,offline_access
```

`offline_access` is what makes Adobe return a refresh token. Without it the script can't run unattended.

**About access:** Adobe documents the Lightroom APIs as intended for *entitled partner applications* ([lightroom-partner-apis](https://github.com/AdobeDocs/lightroom-partner-apis), [Authenticate customers](https://developer.adobe.com/lightroom/lightroom-api-docs/getting-started/authenticate-customers/)). Adding Lightroom Services to a personal project and reading your own catalog worked for the author, but Adobe can restrict that at any time. If the console doesn't offer Lightroom Services, or calls return `403`, or the authorize step fails with `invalid_scope`, your API key isn't entitled: contact Adobe through the Developer Console / partner program and describe your use case. There is no workaround in this script.

## 2. Install

Download `lr-sync.mjs` and `lightroom.example.json` from this repo. Put the script into `scripts/` of your Astro project and `lightroom.example.json` directly into the project folder (`your-site/`), the commands below copy it from there:

```
your-site/
├── scripts/lr-sync.mjs        ← this file
├── private/lightroom.json     ← config + tokens (never commit, never inside the webroot)
├── src/data/lightroom.json    ← written by the script
├── src/photos/lr/*.jpg        ← renditions, written by the script
└── dist/                      ← your build output
```

The script resolves everything relative to the folder **above** `scripts/`. The `private/` folder can live elsewhere: set `LS_PRIVATE=/some/path`.

```bash
mkdir -p private && cp lightroom.example.json private/lightroom.json
chmod 700 private && chmod 600 private/lightroom.json
echo "private/" >> .gitignore
```

The config holds your client secret and the refresh token. Keep it readable only by the user that runs the sync. The script writes the config and state files with mode `600` itself.

## 3. Config

| Field | Required | Meaning |
|---|---|---|
| `client_id` | yes | Client ID from the Adobe console, also sent as `X-API-Key` |
| `client_secret` | yes | Client secret |
| `redirect_uri` | for connect | Your default redirect URI, used by `--auth-url` |
| `refresh_token` | yes | Written by `--code`, then updated automatically on every run |
| `album` | no | Album / folder name, default `Portfolio` |
| `target` | yes | Your webroot. **All its contents except `.well-known` are deleted and replaced by `dist/` on every publish.** Use a dedicated directory. If it doesn't exist, the script tries to create it and stops with an error if it can't. |
| `build` | no | Build command, default `npx astro build`. Must write to `dist/`. If Node comes from nvm, cron won't find `npx`: use the full path, e.g. `/home/deploy/.nvm/versions/node/v22.x.x/bin/npx astro build`, or set `PATH` in the crontab. |
| `staging` | no | `true` appends an `X-Robots-Tag: noindex` header to `.htaccess` in the target (Apache). Also on automatically if the target path contains `staging`. |
| `default_alt` | no | Alt text for photos without a Lightroom caption or title (unless AI tagging provides one), default `Photo`. The file name is never used. |
| `anthropic_key` | no | Enables AI tagging. Empty = off |
| `ai_model` | no | Default `claude-haiku-5-5` |
| `ai_context` | no | Who the portfolio belongs to, used in the prompt (e.g. `a photographer based in Hamburg`) |
| `ai_categories` | no | Your own categories as `{ "slug": "Label" }`. The last one is the fallback. |
| `ntfy_url`, `ntfy_token` | no | ntfy topic URL and access token for push notifications |
| `scopes` | no | Override the requested OAuth scopes |

## 4. Connect once (get the refresh token)

```bash
node scripts/lr-sync.mjs --auth-url
```

This prints a URL like:

```
https://ims-na1.adobelogin.com/ims/authorize/v2?client_id=…&scope=openid,AdobeID,lr_partner_apis,lr_partner_rendition_apis,offline_access&response_type=code&redirect_uri=https://example.com/lr-connect/&state=…
```

Open it, log in with the Adobe account that owns the photos, allow access. You land on `https://example.com/lr-connect/?code=…&state=…` (a 404 is fine). Copy the `code` value and run within a few minutes:

```bash
node scripts/lr-sync.mjs --code 'PASTE_CODE_HERE'
```

The script exchanges it at `POST https://ims-na1.adobelogin.com/ims/token/v3` (`grant_type=authorization_code`, client ID and secret as HTTP Basic auth) and stores the refresh token in `private/lightroom.json`.

## 5. First run

```bash
node scripts/lr-sync.mjs --dry-run   # reads Lightroom, prints the data, writes nothing
node scripts/lr-sync.mjs             # downloads, writes JSON, builds, publishes
```

Flags: `--force` (re-download and rebuild even without changes), `--dry-run` (no downloads, no Claude calls, no build).

## Organising the album

First match wins:

1. A **folder** named `Portfolio` with albums inside → one category per album
2. Albums named `Portfolio - Portraits`, `Portfolio - Street` … → category = text after the dash
3. A single **album** `Portfolio` → everything in category `Work` (and AI tagging picks real categories, if enabled)

A number prefix sorts categories and is stripped from the label: `1 - Portraits` → `Portraits`. Photos appear in the order you set in the album (Lightroom: sort by *Custom Order*). Each album asset carries its position as a lexicographic sort string in `payload.order`, the script keeps the order the API returns. A photo in several category albums gets several categories.

## Tokens and the 14-day limit

- Access tokens are short-lived. Every run gets a fresh one with `grant_type=refresh_token` at `/ims/token/v3`.
- If the response contains a new `refresh_token`, the script saves it immediately. Always keep the latest one.
- Adobe refresh tokens **expire after 14 days by default** ([Adobe IMS docs](https://developer.adobe.com/developer-console/docs/guides/authentication/UserAuthentication/ims)). Adobe's Lightroom docs say renewing refresh tokens needs *additional setup on the API key* that you request from Adobe. Without that, expect to repeat step 4 roughly every two weeks. When the refresh fails, the run logs `token refresh failed` and sends one ntfy push, so set up ntfy or watch the log.
- Adobe asks partners to store tokens encrypted at rest. At minimum: `chmod 600`, outside the webroot, out of git, backups encrypted.

## What the script calls

All Lightroom requests go to `https://lr.adobe.io` with two headers:

```
X-API-Key: <client_id>
Authorization: Bearer <access_token>
```

| Request | Purpose |
|---|---|
| `GET /v2/catalog` | your catalog, its `id` is the `catalog_id` |
| `GET /v2/catalogs/{catalog_id}/albums?limit=500` | all albums (`subtype` `collection`) and folders (`collection_set`), paginated via `links.next` |
| `GET /v2/catalogs/{catalog_id}/albums/{album_id}/assets?embed=asset&subtype=image&order_after=-&limit=500` | photos of one album in album order, with XMP metadata embedded |
| `GET /v2/catalogs/{catalog_id}/assets/{asset_id}/renditions/2048` | JPEG, 2048 px on the long edge, with your edits applied |

Pitfalls:

- **Every JSON response starts with `while(1){}`** ([Adobe: Calling a Lightroom API](https://developer.adobe.com/lightroom/lightroom-api-docs/guides/calling-api/)). Strip it before `JSON.parse`:
  ```js
  JSON.parse(text.replace(/^while\s*\(1\)\s*\{\s*\}\s*/, ""))
  ```
- The docs talk about albums of subtype `project`. Albums you create in Lightroom are `collection`, folders are `collection_set`. Filtering for `project` gives zero albums.
- Renditions contain **no EXIF**. Camera and lens come from `asset.payload.xmp` (`tiff.Model`, `aux.Lens`, `exif.*`). Values like `FNumber` come as fractions, e.g. `[28,10]` = f/2.8.
- `429` / `503` are retried with backoff.

## AI tagging (optional)

Only runs if `anthropic_key` is set, never with `--dry-run`, and only for photos that are in the generic `Work` category or have no caption (Lightroom caption / title). For each such photo, once per Lightroom edit version, the script sends the image plus a prompt to the Claude Messages API (`claude-haiku-5-5` by default, thinking disabled so the token budget goes to the answer) and expects JSON back:

```json
{ "categories": ["portraits", "street"], "alt": "Woman in a red coat crossing a wet street at night", "location": "Tokyo" }
```

Results are cached in `private/lightroom-state.json`. Captions you write in Lightroom always win over AI alt texts.

## Output and Astro integration

`src/data/lightroom.json`:

```json
{
  "synced": "2026-01-01 12:00",
  "categories": [{ "slug": "portraits", "label": "Portraits" }],
  "photos": [{
    "file": "lr/<asset_id>.jpg",
    "categories": ["portraits"],
    "alt": "…",
    "location": "Berlin, Germany",
    "taken": "2025-06-01T18:30:00",
    "exif": { "model": "…", "lens": "…", "focal": 35, "focal35": 35, "fnumber": 2.8, "exposure": 0.004, "iso": 400 }
  }]
}
```

Images land in `src/photos/lr/`, so Astro's image pipeline can optimise them. A minimal gallery page:

```astro
---
import { Image } from "astro:assets";
import data from "../data/lightroom.json";
const images = import.meta.glob<{ default: ImageMetadata }>("../photos/lr/*.jpg", { eager: true });
---
{data.photos.map((p) => (
  <Image src={images[`../photos/${p.file}`].default} alt={p.alt} widths={[640, 1280, 2048]} />
))}
```

Other generators (Eleventy, Hugo, Next static export …): read the same JSON, set `"build"` to your build command and make it output to `dist/` (or symlink). Commit a starter `src/data/lightroom.json` with `{"synced":"","categories":[],"photos":[]}` so the site builds before the first sync.

## Run it on a schedule

The user that runs the sync needs write access to the project and the target directory. Don't run it as root. Create the target folder once and give it to that user (here `deploy`):

```bash
sudo mkdir -p /var/www/example.com/htdocs && sudo chown deploy: /var/www/example.com/htdocs
```

**cron** (`crontab -e` as that user). Cron has a short `PATH`, use absolute paths:

```bash
*/30 * * * * cd /home/deploy/your-site && /usr/bin/node scripts/lr-sync.mjs >> private/lr-sync.log 2>&1
```

`command -v node` shows where Node lives. With nvm it's something like `/home/deploy/.nvm/versions/node/v22.x.x/bin/node`. Use that path in the cron line and also in `build` (`/home/deploy/.nvm/versions/node/v22.x.x/bin/npx astro build`), or put `PATH=/home/deploy/.nvm/versions/node/v22.x.x/bin:/usr/bin:/bin` as the first line of the crontab.

**systemd timer** (`/etc/systemd/system/lr-sync.service`):

```ini
[Unit]
Description=Lightroom portfolio sync

[Service]
Type=oneshot
User=deploy
WorkingDirectory=/home/deploy/your-site
ExecStart=/usr/bin/node scripts/lr-sync.mjs
```

`/etc/systemd/system/lr-sync.timer`:

```ini
[Unit]
Description=Run Lightroom portfolio sync every 30 minutes

[Timer]
OnCalendar=*:0/30
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now lr-sync.timer
journalctl -u lr-sync.service -n 50   # check the last run
```

If you build on one machine and host somewhere else, set `target` to a local folder and add an `rsync -a --delete target/ user@host:/var/www/example.com/htdocs/` step after the script (e.g. a second `ExecStart=` line).

## Guide (German)

Background and the pitfalls in detail: **[Lightroom API Portfolio: Deine Foto-Website pflegt sich selbst](https://mapplebox.de/lightroom-api-portfolio-astro-automatisch/)**

## License

MIT
