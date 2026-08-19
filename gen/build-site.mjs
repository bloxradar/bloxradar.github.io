#!/usr/bin/env node
/*
 * Blox Radar site generator.
 *
 *   node gen/build-site.mjs             -> dist/        (web build: CDN icons,
 *                                          per-game pages, sitemap, robots)
 *   node gen/build-site.mjs --artifact  -> dist-artifact/index.html (claude.ai
 *                                          artifact flavor: data-URI icons, no
 *                                          per-game links)
 *   --skip-buzz  skips Google Trends (useful when rate-limited)
 *
 * Data sources: Roblox explore API (all sort rows), games API (details +
 * Korean localized names), thumbnails API, Google Trends (best effort).
 * Curated inputs: data/codes.json (active/expired codes), watchlist.txt,
 * data/slugs.json (stable per-universe URL slugs, extended automatically).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = process.argv.includes("--artifact");
const SKIP_BUZZ = process.argv.includes("--skip-buzz");
const OUT = path.join(ROOT, ARTIFACT ? "dist-artifact" : "dist");
const SITE_BASE = (process.env.SITE_BASE || "").replace(/\/$/, "");
const SITE_CFG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "data", "site.json"), "utf8")); }
  catch { return {}; }
})();
const FAVICON = `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📡</text></svg>">`;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, headers = {}) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": UA, ...headers } });
      if (r.status === 429) throw new Error("429");
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      if (attempt === 4) throw e;
      console.log(`  retry ${attempt} (${e.message}) for ${url.slice(0, 80)}`);
      await sleep(15000 * attempt);
    }
  }
}

const esc = s => String(s).replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
const norm = s => String(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").normalize("NFC")
  .toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").trim();
/* strip [tags] and non-ASCII decorations for titles/slugs */
const cleanName = s => String(s).replace(/\[[^\]]*\]/g, " ").replace(/[^\x20-\x7E]/g, " ")
  .replace(/\s+/g, " ").trim();
const slugify = s => cleanName(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const fmtN = n => n >= 1e9 ? (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B"
  : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M"
  : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K" : String(n);

/* code entry matching — same rule as the homepage client code */
function makeCodeEntryFinder(codes) {
  return name => {
    const n = norm(name);
    return codes.find(c => {
      const m = norm(c.match);
      return m.includes(" ") ? (" " + n + " ").includes(" " + m + " ") : n === m;
    });
  };
}

async function main() {
  console.log(`build: ${ARTIFACT ? "artifact" : "web"} flavor`);
  const codes = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "codes.json"), "utf8"));
  const codeEntry = makeCodeEntryFinder(codes);

  /* ---- 1. all sort rows (paginated) ---- */
  const sid = crypto.randomUUID();
  const base = `https://apis.roblox.com/explore-api/v1/get-sorts?sessionId=${sid}&device=computer&country=all`;
  let sorts = [], tok = null, pages = 0;
  do {
    const u = tok ? `${base}&sortsPageToken=${encodeURIComponent(tok)}` : base;
    const resp = await fetchJson(u);
    sorts = sorts.concat(resp.sorts || []);
    tok = resp.nextSortsPageToken;
    pages++;
    await sleep(300);
  } while (tok && pages < 12);
  console.log(`sort rows: ${sorts.length} (${pages} pages)`);

  const pick = id => ((sorts.find(s => s.sortId === id) || {}).games || []).filter(g => !g.isSponsored);
  const picks = {
    trending: pick("top-trending"),
    playing: pick("top-playing-now"),
    rising: pick("up-and-coming"),
    friends: pick("fun-with-friends"),
    revisited: pick("top-revisited")
  };

  /* ---- 2. watchlist ---- */
  const wlPath = path.join(ROOT, "watchlist.txt");
  let watch = [];
  if (fs.existsSync(wlPath)) {
    const ids = fs.readFileSync(wlPath, "utf8").split(/\r?\n/)
      .map(l => (l.match(/^\s*(\d+)/) || [])[1]).filter(Boolean);
    if (ids.length) {
      const chunk = ids.join(",");
      const votes = {};
      for (const v of (await fetchJson(`https://games.roblox.com/v1/games/votes?universeIds=${chunk}`)).data) votes[v.id] = v;
      for (const g of (await fetchJson(`https://games.roblox.com/v1/games?universeIds=${chunk}`)).data) {
        watch.push({
          universeId: g.id, rootPlaceId: g.rootPlaceId, name: g.name, playerCount: g.playing,
          totalUpVotes: votes[g.id]?.upVotes || 0, totalDownVotes: votes[g.id]?.downVotes || 0,
          isSponsored: false, genreL1: g.genre_l1
        });
      }
    }
  }
  picks.watch = watch;
  console.log(`watchlist: ${watch.length} games`);

  /* ---- 3. deep catalog: every other row, >=500 CCU, deduped ---- */
  const MAIN_SORTS = new Set(["filters_v5", "top-trending", "top-playing-now", "up-and-coming", "fun-with-friends", "top-revisited"]);
  const mainIds = new Set();
  for (const k of ["trending", "playing", "rising", "friends", "revisited", "watch"])
    for (const g of picks[k]) mainIds.add(String(g.universeId));
  const deepMap = new Map();
  for (const s of sorts) {
    if (MAIN_SORTS.has(s.sortId) || !s.games) continue;
    for (const g of s.games) {
      const id = String(g.universeId);
      if (g.isSponsored || g.playerCount < 500 || mainIds.has(id) || deepMap.has(id)) continue;
      deepMap.set(id, g);
    }
  }
  picks.deep = [...deepMap.values()];
  console.log(`deep catalog: ${picks.deep.length} extra games (>=500 CCU)`);

  /* ---- 4. unified pool ---- */
  const ALL = new Map();
  for (const k of ["trending", "playing", "rising", "friends", "revisited", "watch", "deep"])
    for (const g of picks[k]) if (!ALL.has(String(g.universeId))) ALL.set(String(g.universeId), g);
  const allIds = [...ALL.keys()];
  console.log(`unique games: ${allIds.length}`);

  /* ---- 5. details (creator, visits) + Korean names ---- */
  const details = {};
  for (let i = 0; i < allIds.length; i += 50) {
    const chunk = allIds.slice(i, i + 50).join(",");
    const en = {};
    for (const g of (await fetchJson(`https://games.roblox.com/v1/games?universeIds=${chunk}`)).data) {
      details[g.id] = { creator: g.creator?.name, visits: g.visits };
      en[g.id] = g.name;
    }
    for (const g of (await fetchJson(`https://games.roblox.com/v1/games?universeIds=${chunk}`, { "accept-language": "ko-KR,ko;q=0.9" })).data) {
      if (details[g.id] && g.name && g.name !== en[g.id]) details[g.id].kn = g.name;
    }
    await sleep(200);
  }

  /* ---- 6. icons: web = CDN urls; artifact = data URIs ---- */
  const iconUrl = {};
  const deepIds = new Set(picks.deep.map(g => String(g.universeId)));
  const fetchIcons = async (ids, size) => {
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50).join(",");
      for (const x of (await fetchJson(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${chunk}&size=${size}&format=WebP`)).data) {
        if (x.imageUrl) iconUrl[x.targetId] = x.imageUrl;
      }
      await sleep(150);
    }
  };
  await fetchIcons(allIds.filter(id => !deepIds.has(id)), "150x150");
  await fetchIcons(allIds.filter(id => deepIds.has(id)), "50x50");

  let icons = {};
  if (ARTIFACT) {
    const entries = Object.entries(iconUrl);
    let done = 0;
    const workers = Array.from({ length: 8 }, async () => {
      while (entries.length) {
        const [id, url] = entries.pop();
        try {
          const r = await fetch(url);
          const buf = Buffer.from(await r.arrayBuffer());
          icons[id] = "data:image/webp;base64," + buf.toString("base64");
        } catch { /* icon is cosmetic — skip on failure */ }
        if (++done % 100 === 0) console.log(`  icons: ${done}`);
      }
    });
    await Promise.all(workers);
  } else {
    icons = iconUrl;
  }
  console.log(`icons: ${Object.keys(icons).length}`);

  /* ---- 7. Google Trends search buzz (best effort) ---- */
  const buzz = {};
  if (!SKIP_BUZZ) {
    try {
      const home = await fetch("https://trends.google.com/", { headers: { "user-agent": UA } });
      const cookie = (home.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).join("; ");
      await sleep(1000);
      const targets = [];
      const seen = new Set();
      for (const g of [...picks.trending.slice(0, 15), ...picks.playing.slice(0, 10)]) {
        const id = String(g.universeId);
        if (seen.has(id)) continue;
        seen.add(id);
        const kw = norm(cleanName(g.name)).replace(/\s+/g, " ").trim();
        if (!kw) continue;
        targets.push({ id, kw: kw + " roblox" });
        if (targets.length >= 25) break;
      }
      for (let i = 0; i < targets.length; i += 5) {
        const batch = targets.slice(i, i + 5);
        try {
          const req = encodeURIComponent(JSON.stringify({
            comparisonItem: batch.map(t => ({ keyword: t.kw, geo: "", time: "now 7-d" })),
            category: 0, property: ""
          }));
          const r1 = await fetch(`https://trends.google.com/trends/api/explore?hl=en-US&tz=-540&req=${req}`,
            { headers: { "user-agent": UA, cookie } });
          const j1 = JSON.parse((await r1.text()).replace(/^\)\]\}'/, ""));
          const w = j1.widgets.find(x => x.id === "TIMESERIES");
          await sleep(1000);
          const r2 = await fetch(`https://trends.google.com/trends/api/widgetdata/multiline?hl=en-US&tz=-540&req=${encodeURIComponent(JSON.stringify(w.request))}&token=${w.token}`,
            { headers: { "user-agent": UA, cookie } });
          const pts = JSON.parse((await r2.text()).replace(/^\)\]\}',/, "")).default.timelineData;
          if (pts.length > 48) {
            batch.forEach((t, k) => {
              const vals = pts.map(p => Number(p.value[k]));
              const a7 = vals.reduce((a, b) => a + b, 0) / vals.length;
              const a24 = vals.slice(-24).reduce((a, b) => a + b, 0) / 24;
              if (a7 > 0.5) buzz[t.id] = { m: Math.round((a24 / a7) * 100) / 100 };
            });
          }
        } catch (e) { console.log(`  buzz batch failed: ${e.message}`); }
        await sleep(2000);
      }
    } catch (e) { console.log(`buzz skipped: ${e.message}`); }
  }
  console.log(`buzz measured: ${Object.keys(buzz).length} games`);

  /* ---- 8. stable slugs ---- */
  const slugsPath = path.join(ROOT, "data", "slugs.json");
  const slugs = fs.existsSync(slugsPath) ? JSON.parse(fs.readFileSync(slugsPath, "utf8")) : {};
  const used = new Set(Object.values(slugs));
  for (const [id, g] of ALL) {
    if (slugs[id]) continue;
    let s = slugify(g.name) || "game-" + id;
    if (used.has(s)) s = s + "-" + id.slice(-4);
    slugs[id] = s;
    used.add(s);
  }
  fs.writeFileSync(slugsPath, JSON.stringify(slugs, null, 2));

  /* ---- 9. assemble DATA + homepage ---- */
  const slim = gs => gs.map(g => ({
    u: g.universeId, place: g.rootPlaceId, name: g.name, playing: g.playerCount,
    up: g.totalUpVotes, down: g.totalDownVotes, genre: g.genreL1
  }));
  const DATA = {
    fetchedAt: new Date().toISOString(),
    sorts: {
      trending: slim(picks.trending), playing: slim(picks.playing), rising: slim(picks.rising),
      friends: slim(picks.friends), revisited: slim(picks.revisited),
      watch: slim(picks.watch), deep: slim(picks.deep)
    },
    details, icons, buzz,
    slugs: ARTIFACT ? {} : slugs
  };
  const tpl = fs.readFileSync(path.join(ROOT, "template.html"), "utf8");
  const inject = j => JSON.stringify(j).replace(/<\//g, "<\\/");
  const home = tpl.replace("/*__DATA__*/", inject(DATA)).replace("/*__CODES__*/", inject(codes));

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  /* artifact flavor stays a bare fragment (claude.ai wraps it); the web build
     gets a proper document skeleton so browsers leave quirks mode and search
     engines see real head metadata */
  fs.writeFileSync(path.join(OUT, "index.html"), ARTIFACT ? home : webWrapHome(home));

  if (ARTIFACT) {
    console.log(`done: ${path.join(OUT, "index.html")}`);
    return;
  }

  /* ---- 10. per-game pages ---- */
  const now = new Date();
  const monthYear = now.toLocaleString("en-US", { month: "long", year: "numeric" });
  const updated = now.toLocaleString("en-US", { dateStyle: "medium" });
  const byGenre = {};
  for (const g of ALL.values()) (byGenre[g.genreL1 || "Other"] ||= []).push(g);
  for (const k of Object.keys(byGenre)) byGenre[k].sort((a, b) => b.playerCount - a.playerCount);

  for (const [id, g] of ALL) {
    const d = details[id] || {};
    const ce = codeEntry(g.name);
    const dir = path.join(OUT, "games", slugs[id]);
    fs.mkdirSync(dir, { recursive: true });
    const related = (byGenre[g.genreL1 || "Other"] || [])
      .filter(x => String(x.universeId) !== id).slice(0, 6);
    fs.writeFileSync(path.join(dir, "index.html"),
      gamePage(g, d, ce, buzz[id], related, { slugs, iconUrl, monthYear, updated }));
  }
  console.log(`game pages: ${ALL.size}`);

  /* ---- 10b. all-games index (crawlable entry point per genre) ---- */
  fs.mkdirSync(path.join(OUT, "games"), { recursive: true });
  fs.writeFileSync(path.join(OUT, "games", "index.html"),
    indexPage(byGenre, { slugs, monthYear, updated, codeEntry, total: ALL.size }));

  /* ---- 11. sitemap + robots + .nojekyll ---- */
  const urls = ["/", "/games/", ...[...ALL.keys()].map(id => `/games/${slugs[id]}/`)];
  const lastmod = now.toISOString().slice(0, 10);
  fs.writeFileSync(path.join(OUT, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + urls.map(u => `  <url><loc>${SITE_BASE}${u}</loc><lastmod>${lastmod}</lastmod></url>`).join("\n")
    + `\n</urlset>\n`);
  fs.writeFileSync(path.join(OUT, "robots.txt"),
    `User-agent: *\nAllow: /\n${SITE_BASE ? `Sitemap: ${SITE_BASE}/sitemap.xml\n` : ""}`);
  fs.writeFileSync(path.join(OUT, ".nojekyll"), "");
  console.log(`done: ${OUT} (SITE_BASE=${SITE_BASE || "(unset)"})`);
}

/* ---------------- all-games index ---------------- */
function indexPage(byGenre, ctx) {
  const genres = Object.keys(byGenre).sort((a, b) =>
    byGenre[b].reduce((s, g) => s + g.playerCount, 0) - byGenre[a].reduce((s, g) => s + g.playerCount, 0));
  const desc = `Every Roblox game on the discovery charts — ${ctx.total} games by genre, with live player counts and working codes, refreshed daily.`;
  const sections = genres.map(gen => {
    const list = byGenre[gen];
    return `<section><h2>${esc(gen)} <span class="cnt">${list.length}</span></h2><ul class="idx">`
      + list.map(g => {
        const ce = ctx.codeEntry(g.name);
        const live = ce && ce.status === "live";
        return `<li><a href="${ctx.slugs[String(g.universeId)]}/">${esc(cleanName(g.name) || g.name)}</a>`
          + (live ? `<span class="cf">${ce.codes.length} codes</span>` : "")
          + `<span class="pc">${fmtN(g.playerCount)}</span></li>`;
      }).join("")
      + `</ul></section>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>All Roblox Games by Genre (${ctx.monthYear}) — Blox Radar</title>
<meta name="description" content="${esc(desc)}">
${SITE_BASE ? `<link rel="canonical" href="${SITE_BASE}/games/">` : ""}
<meta property="og:title" content="All Roblox Games by Genre — Blox Radar">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
${FAVICON}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&display=swap">
<style>
:root{--bg:#eef1f6;--surface:#fff;--ink:#1b2534;--ink-2:#55617a;--ink-3:#8b95ab;--line:#d7dde8;--accent:#d92d20;--accent-ink:#fff;--live:#12805c;--live-bg:#d9f0e5;--shadow:0 1px 2px rgba(16,24,40,.06),0 4px 14px rgba(16,24,40,.05);--display:"Bricolage Grotesque","Segoe UI",Pretendard,sans-serif}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#12161d;--surface:#1a2029;--ink:#e9edf4;--ink-2:#a6b0c3;--ink-3:#6d7789;--line:#2b3442;--accent:#f0483b;--live:#4fd6a2;--live-bg:#17352b;--shadow:0 1px 2px rgba(0,0,0,.4),0 4px 14px rgba(0,0,0,.3)}}
:root[data-theme="dark"]{--bg:#12161d;--surface:#1a2029;--ink:#e9edf4;--ink-2:#a6b0c3;--ink-3:#6d7789;--line:#2b3442;--accent:#f0483b;--live:#4fd6a2;--live-bg:#17352b;--shadow:0 1px 2px rgba(0,0,0,.4),0 4px 14px rgba(0,0,0,.3)}
*{box-sizing:border-box}
html{scrollbar-width:thin;scrollbar-color:var(--ink-3) transparent}
::selection{background:var(--accent);color:var(--accent-ink)}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"Segoe UI",Pretendard,"Apple SD Gothic Neo",sans-serif;line-height:1.5}
.wrap{max-width:880px;margin:0 auto;padding:20px 16px 60px}
.top{display:flex;align-items:center;gap:11px;margin-bottom:20px}
.top a{display:flex;align-items:center;gap:11px;color:inherit;text-decoration:none;font-family:var(--display);font-weight:800;font-size:18px;letter-spacing:-.02em}
.logo-block{width:36px;height:36px;border-radius:10px;background:var(--accent);color:var(--accent-ink);display:grid;place-items:center;box-shadow:var(--shadow)}
h1{font-family:var(--display);font-size:25px;font-weight:800;letter-spacing:-.02em;margin:0 0 4px;text-wrap:balance}
.lede{color:var(--ink-2);font-size:14px;margin:0 0 6px;max-width:66ch}
.upd{color:var(--ink-3);font-size:12.5px;margin:0 0 24px}
section{margin-bottom:30px}
h2{font-family:var(--display);font-size:17px;font-weight:800;letter-spacing:-.01em;margin:0 0 10px;display:flex;align-items:baseline;gap:8px}
h2 .cnt{font-family:inherit;font-size:12px;font-weight:600;color:var(--ink-3)}
ul.idx{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:6px}
ul.idx li{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:8px 12px;display:flex;align-items:center;gap:8px;transition:border-color .15s ease}
ul.idx li:hover{border-color:var(--ink-3)}
ul.idx a{color:inherit;text-decoration:none;font-weight:700;font-size:13.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
ul.idx a:hover{text-decoration:underline}
.cf{font-size:10px;font-weight:800;letter-spacing:.04em;color:var(--live);background:var(--live-bg);border-radius:5px;padding:1px 6px;flex-shrink:0}
.pc{margin-left:auto;color:var(--ink-3);font-size:12px;font-variant-numeric:tabular-nums;flex-shrink:0}
a:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
.foot{margin-top:36px;border-top:1px solid var(--line);padding-top:16px;font-size:12px;color:var(--ink-3);max-width:68ch}
</style>
</head>
<body>
<div class="wrap">
  <div class="top"><a href="../"><span class="logo-block" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9" opacity=".45"/><circle cx="12" cy="12" r="5" opacity=".7"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><path d="M12 12L18.5 5.5"/><circle cx="16.4" cy="9" r="1.4" fill="currentColor" stroke="none"/></svg></span>Blox Radar</a></div>
  <h1>All Roblox games by genre</h1>
  <p class="lede">Every game currently on Roblox's discovery charts, grouped by genre and sorted by players. Each one has a page with its working codes and live stats.</p>
  <p class="upd">${ctx.total} games · updated ${ctx.updated}</p>
  ${sections}
  <p class="foot">Unofficial fan site. Not affiliated with Roblox Corporation; game names belong to their respective creators.</p>
</div>
</body>
</html>`;
}

function webWrapHome(fragment) {
  /* hoist the fragment's <link> tags (fonts) into the real head */
  const links = fragment.match(/<link\b[^>]*>/g) || [];
  const body = fragment
    .replace(/<title>[\s\S]*?<\/title>\s*/, "")
    .replace(/<link\b[^>]*>\s*/g, "");
  const desc = "Live Roblox trending charts, working codes checked daily, and search across every discovery chart — 500+ games tracked.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blox Radar — Roblox Trending Charts & Working Codes</title>
${SITE_CFG.googleVerification ? `<meta name="google-site-verification" content="${esc(SITE_CFG.googleVerification)}">\n` : ""}<meta name="description" content="${esc(desc)}">
${SITE_BASE ? `<link rel="canonical" href="${SITE_BASE}/">\n<meta property="og:url" content="${SITE_BASE}/">\n` : ""}<meta property="og:title" content="Blox Radar — Roblox Trending Charts & Working Codes">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
${FAVICON}
${links.join("\n")}
</head>
<body>
${body}
</body>
</html>`;
}

/* ---------------- per-game page template ---------------- */
function gamePage(g, d, ce, bz, related, ctx) {
  const id = String(g.universeId);
  const name = cleanName(g.name) || g.name;
  const title = `${name} Codes & Live Stats (${ctx.monthYear})`;
  const total = g.totalUpVotes + g.totalDownVotes;
  const pct = total ? Math.round(g.totalUpVotes / total * 100) : null;
  const icon = ctx.iconUrl[id] || "";
  const canonical = SITE_BASE ? `${SITE_BASE}/games/${ctx.slugs[id]}/` : "";
  const live = ce && ce.status === "live";
  const desc = live
    ? `${ce.codes.length} working ${name} codes for ${ctx.monthYear}, checked daily — plus live player count (${fmtN(g.playerCount)} playing now), rating and trend data.`
    : `${name} on Roblox: live player count (${fmtN(g.playerCount)} playing now), rating, and code status — checked daily.`;

  const stat = (label, value) => `<div class="stat"><div class="v">${value}</div><div class="l">${label}</div></div>`;
  const IC_THUMB = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px"><path d="M2 20h3V9H2v11zM22 10c0-1.1-.9-2-2-2h-5.2l.9-4.3v-.3c0-.4-.2-.8-.4-1L14.2 1 8.6 6.6c-.4.3-.6.8-.6 1.4v10c0 1.1.9 2 2 2h7c.8 0 1.5-.5 1.8-1.2l2.1-5.5c.1-.2.1-.5.1-.7v-2.6z"/></svg>';
  let stats = stat("Playing now", fmtN(g.playerCount));
  if (d.visits) stats += stat("Total visits", fmtN(d.visits));
  if (pct !== null) stats += stat("Rating", IC_THUMB + " " + pct + "%");
  if (bz) {
    const p = Math.round((bz.m - 1) * 100);
    stats += stat("Search trend (24h)", p >= 15 ? "▲ +" + p + "%" : p <= -15 ? "▼ " + p + "%" : "≈ flat");
  }

  let codesHtml = "";
  if (live) {
    codesHtml = `<h2>Working ${esc(name)} codes</h2><div class="codelist">`
      + ce.codes.map(x => `<div class="codeline"><button class="codechip" data-code="${esc(x.c)}">${esc(x.c)}</button><span class="reward">${esc(x.r)}</span></div>`).join("")
      + `</div>`
      + (ce.how ? `<p class="how">${ce.how}</p>` : "")
      + (ce.expired?.length
        ? `<details class="exp"><summary>Expired codes (${ce.expired.length}) — no longer redeemable</summary><div class="explist">`
          + ce.expired.map(x => `<span class="codechip dead">${esc(x)}</span>`).join("") + `</div></details>`
        : "");
  } else if (ce) {
    codesHtml = `<h2>${esc(name)} codes</h2><p class="how">${esc(ce.note)}</p>`;
  } else {
    codesHtml = `<h2>${esc(name)} codes</h2><p class="how">No verified codes tracked for this game yet — new codes usually drop on the developer’s Discord or X. This page is refreshed daily, so check back.</p>`;
  }
  const src = ce?.src?.length
    ? `<p class="src">Sources: ${ce.src.map(s => `<a href="${s[1]}" target="_blank" rel="noopener">${esc(s[0])}</a>`).join(" · ")}</p>` : "";

  const relatedHtml = related.length
    ? `<h2>More ${esc(g.genreL1 || "popular")} games</h2><ul class="rel">`
      + related.map(r => `<li><a href="../${ctx.slugs[String(r.universeId)]}/">${esc(cleanName(r.name) || r.name)}</a> <span>${fmtN(r.playerCount)} playing</span></li>`).join("")
      + `</ul>` : "";

  const ld = [{
    "@context": "https://schema.org", "@type": "VideoGame",
    name, url: canonical || undefined,
    gamePlatform: "Roblox", genre: g.genreL1 || undefined,
    ...(total ? { aggregateRating: { "@type": "AggregateRating", ratingValue: pct, bestRating: 100, ratingCount: total } } : {})
  }];
  if (live) {
    ld.push({
      "@context": "https://schema.org", "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question", name: `What are the working ${name} codes right now?`,
          acceptedAnswer: { "@type": "Answer", text: ce.codes.map(x => `${x.c} (${x.r})`).join(", ") + `. Checked ${ctx.updated}.` }
        },
        ...(ce.expired?.length ? [{
          "@type": "Question", name: `Which ${name} codes have expired?`,
          acceptedAnswer: { "@type": "Answer", text: `These no longer work: ${ce.expired.join(", ")}.` }
        }] : [])
      ]
    });
  }
  if (SITE_BASE) {
    ld.push({
      "@context": "https://schema.org", "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Blox Radar", item: SITE_BASE + "/" },
        { "@type": "ListItem", position: 2, name, item: canonical }
      ]
    });
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Blox Radar</title>
<meta name="description" content="${esc(desc)}">
${canonical ? `<link rel="canonical" href="${canonical}">` : ""}
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
${icon ? `<meta property="og:image" content="${icon}">` : ""}
<meta property="og:type" content="website">
${FAVICON}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&display=swap">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>
:root{--bg:#eef1f6;--surface:#fff;--surface-2:#e4e9f1;--ink:#1b2534;--ink-2:#55617a;--ink-3:#8b95ab;--line:#d7dde8;--accent:#d92d20;--accent-ink:#fff;--live:#12805c;--live-bg:#d9f0e5;--code-bg:#1b2534;--code-ink:#aef2d0;--shadow:0 1px 2px rgba(16,24,40,.06),0 4px 14px rgba(16,24,40,.05);--display:"Bricolage Grotesque","Segoe UI","Pretendard Variable",Pretendard,sans-serif}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#12161d;--surface:#1a2029;--surface-2:#232b37;--ink:#e9edf4;--ink-2:#a6b0c3;--ink-3:#6d7789;--line:#2b3442;--accent:#f0483b;--live:#4fd6a2;--live-bg:#17352b;--code-bg:#0c1117;--code-ink:#8ff0c0;--shadow:0 1px 2px rgba(0,0,0,.4),0 4px 14px rgba(0,0,0,.3)}}
:root[data-theme="dark"]{--bg:#12161d;--surface:#1a2029;--surface-2:#232b37;--ink:#e9edf4;--ink-2:#a6b0c3;--ink-3:#6d7789;--line:#2b3442;--accent:#f0483b;--live:#4fd6a2;--live-bg:#17352b;--code-bg:#0c1117;--code-ink:#8ff0c0;--shadow:0 1px 2px rgba(0,0,0,.4),0 4px 14px rgba(0,0,0,.3)}
*{box-sizing:border-box}
html{scrollbar-width:thin;scrollbar-color:var(--ink-3) transparent}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:var(--line);border-radius:8px;border:2px solid var(--bg)}
::-webkit-scrollbar-thumb:hover{background:var(--ink-3)}
::selection{background:var(--accent);color:var(--accent-ink)}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"Segoe UI","Pretendard Variable",Pretendard,"Apple SD Gothic Neo",sans-serif;line-height:1.55}
.wrap{max-width:760px;margin:0 auto;padding:20px 16px 60px}
.top{display:flex;align-items:center;gap:10px;margin-bottom:22px}
.top a{display:flex;align-items:center;gap:11px;color:inherit;text-decoration:none;font-family:var(--display);font-weight:800;font-size:18px;letter-spacing:-.02em}
.logo-block{width:36px;height:36px;border-radius:10px;background:var(--accent);color:var(--accent-ink);display:grid;place-items:center;box-shadow:var(--shadow)}
.logo-block svg{display:block}
.hero{display:flex;gap:16px;align-items:center;background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);padding:18px}
.hero img{width:88px;height:88px;border-radius:14px;background:var(--surface-2);flex-shrink:0}
h1{margin:0;font-family:var(--display);font-size:24px;font-weight:800;letter-spacing:-.02em;text-wrap:balance}
.kn{margin:2px 0 0;color:var(--ink-2);font-size:14px}
.meta{margin:4px 0 0;color:var(--ink-3);font-size:13px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin:14px 0}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:10px 14px}
.stat .v{font-family:var(--display);font-weight:800;font-size:19px;font-variant-numeric:tabular-nums}
.stat .l{font-size:11.5px;color:var(--ink-3);margin-top:1px}
h2{font-family:var(--display)}
.actions{display:flex;gap:8px;margin:6px 0 8px}
.btn-play{background:var(--accent);color:var(--accent-ink);font-weight:700;font-size:14px;padding:9px 18px;border-radius:9px;text-decoration:none}
h2{font-size:18px;font-weight:900;letter-spacing:-.01em;margin:26px 0 10px}
.codelist{display:flex;flex-direction:column;gap:7px}
.codeline{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.codechip{appearance:none;border:none;cursor:pointer;font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:14px;font-weight:600;letter-spacing:.03em;background:var(--code-bg);color:var(--code-ink);padding:7px 13px;border-radius:8px}
.codechip:hover{filter:brightness(1.2)}
.codechip.dead{background:transparent;border:1px dashed var(--line);color:var(--ink-3);text-decoration:line-through;cursor:default;font-size:12.5px;padding:5px 11px}
.codechip.dead:hover{filter:none}
.reward{font-size:13.5px;color:var(--ink-2)}
.how{font-size:13.5px;color:var(--ink-3);max-width:64ch}
.how b{color:var(--ink-2)}
details.exp{margin-top:12px}
details.exp summary{cursor:pointer;font-size:12.5px;font-weight:600;color:var(--ink-3)}
details.exp .explist{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.src{font-size:12px;color:var(--ink-3)}.src a{color:var(--ink-2)}
ul.rel{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
ul.rel li{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:9px 14px;display:flex;justify-content:space-between;gap:10px}
ul.rel a{color:inherit;text-decoration:none;font-weight:700}ul.rel a:hover{text-decoration:underline}
ul.rel span{color:var(--ink-3);font-size:12.5px;font-variant-numeric:tabular-nums}
.foot{margin-top:36px;border-top:1px solid var(--line);padding-top:16px;font-size:12px;color:var(--ink-3);max-width:68ch}
#toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:var(--ink);color:var(--bg);font-size:13px;font-weight:700;padding:9px 18px;border-radius:999px;opacity:0;pointer-events:none;transition:opacity .18s}
#toast.show{opacity:1}
a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
</head>
<body>
<div class="wrap">
  <div class="top"><a href="../../"><span class="logo-block" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9" opacity=".45"/><circle cx="12" cy="12" r="5" opacity=".7"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><path d="M12 12L18.5 5.5"/><circle cx="16.4" cy="9" r="1.4" fill="currentColor" stroke="none"/></svg></span>Blox Radar</a></div>
  <div class="hero">
    ${icon ? `<img src="${icon}" alt="${esc(name)} icon">` : ""}
    <div>
      <h1>${esc(title)}</h1>
      ${d.kn ? `<p class="kn">${esc(d.kn)}</p>` : ""}
      <p class="meta">${esc(g.genreL1 || "Roblox game")}${d.creator ? " · by " + esc(d.creator) : ""} · Updated ${ctx.updated}</p>
    </div>
  </div>
  <div class="stats">${stats}</div>
  <div class="actions"><a class="btn-play" href="https://www.roblox.com/games/${g.rootPlaceId}" target="_blank" rel="noopener">Play on Roblox ↗</a></div>
  ${codesHtml}
  ${src}
  ${relatedHtml}
  <p class="foot">Unofficial fan site. Not affiliated with Roblox Corporation; game names and icons belong to their respective creators. Codes are gathered from outlets that verify them and can expire at any time.</p>
</div>
<div id="toast" role="status">Copied</div>
<script>
document.addEventListener("click",async e=>{const b=e.target.closest(".codechip");if(!b||!b.dataset.code)return;
let ok=false;try{await navigator.clipboard.writeText(b.dataset.code);ok=true}catch(_){const t=document.createElement("textarea");t.value=b.dataset.code;document.body.appendChild(t);t.select();try{ok=document.execCommand("copy")}catch(_){ }t.remove()}
const el=document.getElementById("toast");el.textContent=ok?"Copied "+b.dataset.code:"Copy failed";el.classList.add("show");clearTimeout(window.__t);window.__t=setTimeout(()=>el.classList.remove("show"),1500)});
</script>
</body>
</html>`;
}

main().catch(e => { console.error(e); process.exit(1); });
