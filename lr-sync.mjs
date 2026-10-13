#!/usr/bin/env node
// Lightroom → portfolio sync for an Astro site. Run it via cron on your web server.
// 1. refresh Adobe token  2. read album "Portfolio" (+ sub-albums = categories)  3. download 2048px renditions
// 4. write src/data/lightroom.json  5. if anything changed: astro build + publish to TARGET  6. ntfy push
//
// Node 18+, no npm dependencies (sharp is used for AI tagging only if it is installed).
// Place this file at <your-astro-project>/scripts/lr-sync.mjs. Config: <PRIVATE>/lightroom.json (see lightroom.example.json and README).
// Usage:  node scripts/lr-sync.mjs [--force] [--dry-run]
//         node scripts/lr-sync.mjs --auth-url        print the Adobe login URL (one-time connect)
//         node scripts/lr-sync.mjs --code <code>     exchange the code from the redirect for a refresh token
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (typeof fetch !== "function") { console.error("Node 18 or newer is required (global fetch)"); process.exit(1); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE = process.env.LS_PRIVATE || path.join(ROOT, "private"); // keep this OUTSIDE the webroot
const CFG_FILE = path.join(PRIVATE, "lightroom.json");
const STATE_FILE = path.join(PRIVATE, "lightroom-state.json");
const PHOTO_DIR = path.join(ROOT, "src/photos/lr");
const DATA_FILE = path.join(ROOT, "src/data/lightroom.json");
const FORCE = process.argv.includes("--force");
const DRY = process.argv.includes("--dry-run");
const LR = "https://lr.adobe.io";
const IMS = "https://ims-na1.adobelogin.com/ims";

const log = (...a) => console.log(new Date().toISOString(), ...a);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const writeJson = (f, v) => {
  fs.writeFileSync(f, JSON.stringify(v, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(f, 0o600); } catch {} // the mode above only applies to newly created files
};

const cfg = readJson(CFG_FILE);
if (!cfg?.client_id || !cfg?.client_secret) { log(`missing client_id / client_secret in ${CFG_FILE}`); process.exit(1); }
const SCOPES = cfg.scopes ?? "openid,AdobeID,lr_partner_apis,lr_partner_rendition_apis,offline_access";
const DEFAULT_ALT = cfg.default_alt ?? "Photo";

// ---- one-time connect: --auth-url, then --code <code> ----
if (process.argv.includes("--auth-url")) {
  if (!cfg.redirect_uri) { log('set "redirect_uri" (the Default Redirect URI from the Adobe console) first'); process.exit(1); }
  const u = new URL(`${IMS}/authorize/v2`);
  u.search = new URLSearchParams({ client_id: cfg.client_id, scope: SCOPES, response_type: "code", redirect_uri: cfg.redirect_uri, state: crypto.randomBytes(8).toString("hex") }).toString();
  console.log(`Open this URL, log in, then copy the "code" parameter from the address bar after the redirect:\n${u}`);
  process.exit(0);
}
const codeIdx = process.argv.indexOf("--code");
if (codeIdx !== -1) {
  const code = process.argv[codeIdx + 1];
  if (!code) { log("usage: --code <code>"); process.exit(1); }
  const r = await fetch(`${IMS}/token/v3`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(`${cfg.client_id}:${cfg.client_secret}`).toString("base64") },
    body: new URLSearchParams({ grant_type: "authorization_code", code }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.refresh_token) { log(`code exchange failed: ${r.status} ${j.error ?? ""} ${j.error_description ?? ""} (no refresh_token? check the offline_access scope)`); process.exit(1); }
  cfg.refresh_token = j.refresh_token;
  writeJson(CFG_FILE, cfg);
  log(`connected, refresh token saved to ${CFG_FILE}`);
  process.exit(0);
}
if (!cfg.refresh_token || cfg.refresh_token.startsWith("filled in")) {
  log("not connected yet (no refresh token): run with --auth-url, then --code <code>"); process.exit(0);
}
const state = readJson(STATE_FILE, { assets: {}, hash: "" });

function ntfy(title, body, prio = 3) { // optional push via ntfy (ntfy_url + ntfy_token in the config)
  if (!cfg.ntfy_url || !cfg.ntfy_token) return;
  return fetch(cfg.ntfy_url, { method: "POST", headers: { Authorization: `Bearer ${cfg.ntfy_token}`, Title: title, Tags: "frame_with_picture", Priority: String(prio) }, body }).catch(() => {});
}

async function token() {
  const r = await fetch(`${IMS}/token/v3`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: cfg.client_id, client_secret: cfg.client_secret, refresh_token: cfg.refresh_token }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`token refresh failed: ${r.status} ${j.error ?? ""} ${j.error_description ?? ""}`);
  if (j.refresh_token && j.refresh_token !== cfg.refresh_token) { cfg.refresh_token = j.refresh_token; writeJson(CFG_FILE, cfg); }
  return j.access_token;
}

let AT;
async function api(p, raw = false) {
  const url = p.startsWith("http") ? p : `${LR}${p.startsWith("/") ? "" : "/"}${p}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: { "X-API-Key": cfg.client_id, Authorization: `Bearer ${AT}` } });
    if (r.status === 503 || r.status === 429) { await new Promise((s) => setTimeout(s, 2000 * (attempt + 1))); continue; }
    if (!r.ok) throw Object.assign(new Error(`${r.status} ${url}`), { status: r.status });
    if (raw) return Buffer.from(await r.arrayBuffer());
    const t = await r.text();
    return JSON.parse(t.replace(/^while\s*\(1\)\s*\{\s*\}\s*/, ""));
  }
  throw new Error(`gave up: ${url}`);
}

const slug = (s) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "work";
const cleanName = (s) => s.replace(/^\s*\d+\s*[-_.)]\s*/, "").trim(); // "1 - Portraits" -> "Portraits" (prefix = sort order)
const num = (v) => {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v[1] ? v[0] / v[1] : v[0];
  if (typeof v === "string" && v.includes("/")) { const [a, b] = v.split("/").map(Number); return b ? a / b : a; }
  const n = Number(v); return Number.isFinite(n) ? n : undefined;
};

function extract(asset) {
  const p = asset.payload ?? {};
  const x = p.xmp ?? {};
  const tiff = x.tiff ?? {}, exif = x.exif ?? {}, aux = x.aux ?? {}, dc = x.dc ?? {}, ps = x.photoshop ?? {}, iptc = x.Iptc4xmpCore ?? {};
  const pick = (v) => (typeof v === "string" ? v : v?.["x-default"] ?? (Array.isArray(v) ? v[0] : undefined));
  const caption = pick(dc.description) ?? pick(dc.title) ?? p.importSource?.originalFileName ?? DEFAULT_ALT;
  const loc = [p.location?.city ?? ps.City ?? iptc.Location, p.location?.country ?? ps.Country].filter(Boolean);
  return {
    alt: String(caption).trim(),
    location: loc.length ? [...new Set(loc)].join(", ") : undefined,
    taken: exif.DateTimeOriginal ? String(exif.DateTimeOriginal).slice(0, 19) : undefined,
    exif: {
      model: tiff.Model, lens: aux.Lens ?? exif.LensModel,
      focal: num(exif.FocalLength), focal35: num(exif.FocalLengthIn35mmFilm),
      fnumber: num(exif.FNumber), exposure: num(exif.ExposureTime),
      iso: num(Array.isArray(exif.ISOSpeedRatings) ? exif.ISOSpeedRatings[0] : exif.ISOSpeedRatings ?? exif.PhotographicSensitivity),
    },
  };
}

// ---- AI auto-tagging (Claude) for photos without a category album / caption ----
// Category slugs + labels, override with "ai_categories" in the config. The last key is the fallback.
const CATS = cfg.ai_categories ?? { portraits: "Portraits", events: "Events", automotive: "Automotive", street: "Street & Travel" };
async function aiTag(file) {
  if (!cfg.anthropic_key) return null;
  let img;
  try { // shrink to 800px if sharp is installed, otherwise send the 2048px rendition as it is
    const { default: sharp } = await import("sharp");
    img = await sharp(file).resize(800, 800, { fit: "inside" }).jpeg({ quality: 70 }).toBuffer();
  } catch { img = fs.readFileSync(file); }
  const prompt = `You tag photos for the portfolio of ${cfg.ai_context || "a photographer"}.
Return ONLY JSON: {"categories": [1-2 of ${JSON.stringify(Object.keys(CATS))}, best fit first], "alt": "...", "location": "..." or null}
- categories: use a second category only if the photo clearly fits both. ${cfg.ai_categories ? "Categories: " + Object.entries(CATS).map(([k, v]) => `${k} = ${v}`).join("; ") + "." : 'Example: a portrait shot on a street at night -> ["portraits","street"]. portraits = a person/animal is the main subject; events = concerts, stages, esports, parties, crowds at an event; automotive = cars/vehicles are the subject; street = street, city, architecture, travel, details, landscapes.'}
- alt: one concise English alt text (max 110 characters), describe what is visible, mood/light if relevant. Never guess names or identities.
- location: only a city/country if it is clearly recognisable (e.g. Japanese signage -> "Japan", Shinjuku skyline -> "Tokyo"), else null.`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": cfg.anthropic_key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: cfg.ai_model || "claude-haiku-5-5",
      max_tokens: 1024,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: img.toString("base64") } },
        { type: "text", text: prompt },
      ] }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`AI tagging failed: ${r.status} ${j.error?.message ?? ""}`);
  const txt = (j.content ?? []).map((c) => c.text ?? "").join("");
  let out;
  try { out = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1)); }
  catch { throw new Error(`AI answer not parseable (${j.stop_reason}): ${txt.slice(0, 160)}`); }
  let cats = (Array.isArray(out.categories) ? out.categories : [out.category]).filter((c) => CATS[c]).slice(0, 2);
  if (!cats.length) cats = [Object.keys(CATS).at(-1)];
  return { categories: cats, alt: String(out.alt ?? "").slice(0, 140) || undefined, location: out.location || undefined };
}

async function albumAssets(cid, aid) {
  const out = [];
  let next = `/v2/catalogs/${cid}/albums/${aid}/assets?embed=asset&subtype=image&order_after=-&limit=500`;
  while (next) {
    const j = await api(next);
    out.push(...(j.resources ?? []));
    const n = j.links?.next?.href;
    next = n ? new URL(n, j.base ?? `${LR}/v2/catalogs/${cid}/albums/${aid}/`).toString() : null;
  }
  return out;
}

async function main() {
  AT = await token();
  const catalog = await api("/v2/catalog");
  const cid = catalog.id;
  const albums = [];
  let page = `/v2/catalogs/${cid}/albums?limit=500`; // Lightroom cloud: subtype collection / collection_set
  while (page) {
    const j = await api(page);
    albums.push(...(j.resources ?? []));
    const n = j.links?.next?.href;
    page = n ? new URL(n, j.base ?? `${LR}/v2/catalogs/${cid}/`).toString() : null;
  }
  // Three ways to organise the portfolio in Lightroom (first match wins):
  //  1) folder "Portfolio" containing albums        -> one category per album
  //  2) albums named "Portfolio - Portraits" etc.     -> category = text after the dash
  //  3) a single album "Portfolio"                     -> one category "Work"
  const name = (cfg.album ?? "Portfolio").toLowerCase();
  const nm = (a) => (a.payload?.name ?? "").trim();
  const byNum = (a, b) => nm(a).localeCompare(nm(b), "en", { numeric: true });
  const named = albums.filter((a) => nm(a).toLowerCase() === name);
  const folder = named.find((a) => a.subtype?.endsWith("_set"));
  let groups = [];
  let rootName = cfg.album ?? "Portfolio";
  if (folder) {
    groups = albums.filter((a) => a.payload?.parent?.id === folder.id && !a.subtype?.endsWith("_set")).sort(byNum)
      .map((a) => ({ album: a, label: cleanName(nm(a)) }));
    rootName = `${nm(folder)}/ (folder)`;
  }
  if (!groups.length) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("^" + esc + "\\s*[-–—:|]\\s*(.+)$", "i");
    groups = albums.filter((a) => re.test(nm(a))).sort(byNum).map((a) => ({ album: a, label: cleanName(nm(a).match(re)[1]) }));
    if (groups.length) rootName = `${cfg.album ?? "Portfolio"} - … (${groups.length} albums)`;
  }
  if (!groups.length) {
    const single = named.find((a) => !a.subtype?.endsWith("_set"));
    if (single) groups = [{ album: single, label: "Work" }];
  }
  if (!groups.length) throw new Error(`no Lightroom album/folder "${cfg.album ?? "Portfolio"}" found (${albums.length} albums in catalog)`);

  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  const categories = [];
  const photos = [];
  const seen = new Set();
  let downloaded = 0;
  let aiCalls = 0;
  for (const g of groups) {
    const label = g.label;
    const cat = slug(label);
    const items = await albumAssets(cid, g.album.id);
    if (!items.length) continue;
    for (const it of items) {
      const a = it.asset;
      if (!a?.id) continue;
      if (seen.has(a.id)) { // same photo in several category albums -> multi-tag
        const prev = photos.find((p) => p.file === `lr/${a.id}.jpg`);
        if (prev && !prev.categories.includes(cat)) prev.categories.push(cat);
        if (!categories.some((c) => c.slug === cat)) categories.push({ slug: cat, label });
        continue;
      }
      seen.add(a.id);
      const file = `lr/${a.id}.jpg`;
      const dest = path.join(ROOT, "src/photos", file);
      const ver = a.updated ?? a.payload?.userUpdated ?? "";
      if (FORCE || !fs.existsSync(dest) || state.assets[a.id] !== ver) {
        if (!DRY) {
          const buf = await api(`/v2/catalogs/${cid}/assets/${a.id}/renditions/2048`, true);
          fs.writeFileSync(dest, buf);
        }
        state.assets[a.id] = ver;
        downloaded++;
      }
      const meta = extract(a);
      const hasCaption = meta.alt && meta.alt !== DEFAULT_ALT && !/\.(jpe?g|arw|dng|heic|cr3|nef|raf)$/i.test(meta.alt);
      let cats = [cat];
      const needsCat = g.label === "Work";
      if ((needsCat || !hasCaption) && cfg.anthropic_key) {
        state.ai ??= {};
        let t = state.ai[a.id];
        if (!t || t.ver !== ver || !t.categories) {
          try { t = { ver, ...(await aiTag(dest)) }; state.ai[a.id] = t; aiCalls++; }
          catch (e) { log("WARN", e.message); t = null; }
        }
        if (t) {
          if (needsCat && (t.categories?.length || t.category)) cats = t.categories ?? [t.category];
          if (!hasCaption && t.alt) meta.alt = t.alt;
          if (!meta.location && t.location) meta.location = t.location;
        }
      }
      for (const c of cats) if (!categories.some((x) => x.slug === c)) categories.push({ slug: c, label: CATS[c] ?? label });
      photos.push({ file, categories: cats, ...meta });
    }
  }
  // drop renditions no longer in the album (derived cache files only)
  let removed = 0;
  for (const f of fs.readdirSync(PHOTO_DIR)) {
    const id = f.replace(/\.jpg$/, "");
    if (!seen.has(id)) { if (!DRY) fs.unlinkSync(path.join(PHOTO_DIR, f)); delete state.assets[id]; removed++; }
  }

  const data = { synced: new Date().toISOString().slice(0, 16).replace("T", " "), categories, photos };
  const hash = crypto.createHash("sha256").update(JSON.stringify({ categories, photos, assets: state.assets, code: fs.statSync(new URL(import.meta.url)).mtimeMs })).digest("hex");
  log(`${rootName}: ${categories.length} categories, ${photos.length} photos, ${downloaded} downloaded, ${removed} removed, ${aiCalls} AI-tagged`);
  if (DRY) { console.log(JSON.stringify(data, null, 2).slice(0, 3000)); return; }
  if (!FORCE && hash === state.hash) { log("no changes"); writeJson(STATE_FILE, state); return; }
  if (!photos.length) throw new Error("album is empty – refusing to publish an empty portfolio");

  writeJson(DATA_FILE, data);
  execSync(cfg.build ?? "npx astro build", { cwd: ROOT, stdio: "inherit" }); // must write the site to dist/
  const target = cfg.target; // WARNING: everything in this folder (except .well-known) gets replaced by the new build
  if (!target) throw new Error("set \"target\" (your webroot) in the config first");
  const keep = new Set([".well-known"]);
  for (const f of fs.readdirSync(target)) if (!keep.has(f)) fs.rmSync(path.join(target, f), { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "dist"), target, { recursive: true });
  if (cfg.staging ?? target.includes("staging")) fs.appendFileSync(path.join(target, ".htaccess"), '\nHeader always set X-Robots-Tag "noindex, nofollow"\n');
  state.hash = hash;
  writeJson(STATE_FILE, state);
  log(`published to ${target}`);
  if (!FORCE) await ntfy("Portfolio updated", `${photos.length} photos in ${categories.length} categories (+${downloaded} new/edited, -${removed} removed)`, 2); // manual --force runs stay quiet
}

main().then(() => {
  if (state.lastError) { delete state.lastError; writeJson(STATE_FILE, state); }
}).catch(async (e) => {
  log("ERROR", e.message);
  if (state.lastError !== e.message) { // notify once per distinct error, not every run
    await ntfy("Portfolio sync failed", e.message, 4);
    state.lastError = e.message;
    writeJson(STATE_FILE, state);
  }
  process.exit(1);
});
