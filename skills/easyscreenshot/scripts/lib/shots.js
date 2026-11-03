"use strict";

// A site's pages worth showing, captured clean on the devices asked for.
// What comes out, in one folder:
//
//   SCREENSHOTS.md        every page: why it was picked, its files and the
//                         headings on its first screen, for people and agents
//   manifest.json         the same, for scripts
//   sheet.png             all pages on one picture
//   01-home-desktop.png   the first screen at 2x, 3200x1800
//   01-home-mobile.png    the first screen on a phone, 1080x1920
//   01-home-full.png      the whole page, 1600 wide
//   02-pricing-…          the same for every page picked
//
// The home page comes first. Its links (and the sitemap, as a fallback) give
// the other candidates; each one is opened, and kept only when it is a page
// of its own: not a redirect to a sign-in page or to the home page, not a
// bot check, not the same page as one already kept.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { launch, openTab, closeTab, navigate } = require("./chrome");
const { metrics, scrollTo, walk, waitForContent, settle, waitForFonts, clearHover, resetPictureWait, captureScreen, capturePage } = require("./page");
const { clean } = require("./clean");
const { homeOf, pageKey, linkUrl, siteOf, fold, kindOf, rankLinks, visitOrder, readSiteIndex, localeOf } = require("./pick");
const { pngSize, tagPng } = require("./png");
const { renderSheet } = require("./sheet");
const { setTimeLimit, timeLeft, sleep } = require("./time");
const version = require("./version");

// The devices a size names. Desktop at 1600x900 shows a site's full menu
// (narrower windows hide it behind a button); 2x keeps small text sharp for
// image and video models. A phone is 9:16, the shape of a vertical video and
// of Google Play's screenshots; an iPhone is the App Store's 6.9" size.
const DEVICES = {
  desktop: { width: 1600, height: 900, scale: 2, mobile: false, touch: false, agent: "desktop" },
  mobile: { width: 360, height: 640, scale: 3, mobile: true, touch: true, agent: "android" },
  iphone: { width: 440, height: 956, scale: 3, mobile: true, touch: true, agent: "iphone" },
};
const SIZE_WORDS = { desktop: "first screen, desktop", mobile: "first screen, phone", iphone: "first screen, iPhone", full: "whole page, desktop", "mobile-full": "whole page, phone" };
// A whole page stops here: an endless feed would otherwise never end.
const MAX_HEIGHT = 15_000;

// "desktop,mobile,full" as the devices to open each page on and what to
// take on each: [{key, device, shots: [{size, full, scale}]}]. A whole page
// is taken on the first desktop size listed (or the desktop), a phone's whole
// page on the phone.
function parseSizes(text) {
  const names = String(text || "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (!names.length) throw new Error("--sizes needs at least one size");
  const groups = new Map();
  const wholes = [];
  let firstDesktop = "";
  for (const name of names) {
    const m = /^(desktop|mobile|iphone|full|mobile-full|(\d{3,4})x(\d{3,4}))(?:@(\d+(?:\.\d+)?)x?)?$/.exec(name);
    if (!m) throw new Error(`Unknown size: ${name}. Use desktop, mobile, iphone, full, mobile-full or WxH, each with an optional @scale`);
    const scale = m[4] === undefined ? null : Number(m[4]);
    if (scale !== null && !(scale >= 0.5 && scale <= 4)) throw new Error(`${name}: a scale goes from 0.5 to 4`);
    if (m[1] === "full" || m[1] === "mobile-full") {
      if (wholes.some((whole) => whole.size === m[1])) throw new Error(`${m[1]} is given twice in --sizes`);
      wholes.push({ size: m[1], scale: scale || (m[1] === "full" ? 1 : 2) });
      continue;
    }
    let device;
    let size;
    if (DEVICES[m[1]]) {
      size = m[1];
      device = { ...DEVICES[size], ...(scale ? { scale } : {}) };
    } else {
      const width = Number(m[2]);
      const height = Number(m[3]);
      if (width < 240 || width > 3840 || height < 240 || height > 3840) throw new Error(`${name}: width and height go from 240 to 3840`);
      const phone = width < 600;
      size = `${width}x${height}`;
      device = { width, height, scale: scale || 1, mobile: phone, touch: phone, agent: phone ? "android" : "desktop" };
    }
    if (groups.has(size)) throw new Error(`${size} is given twice in --sizes`);
    groups.set(size, { key: size, device, shots: [{ size, full: false }] });
    if (!device.mobile && !firstDesktop) firstDesktop = size;
  }
  for (const whole of wholes) {
    const key = whole.size === "mobile-full" ? "mobile" : firstDesktop || "desktop";
    if (!groups.has(key)) groups.set(key, { key, device: { ...DEVICES[key] }, shots: [] });
    groups.get(key).shots.push({ size: whole.size, full: true, scale: whole.scale });
  }
  return [...groups.values()];
}

// "acme.com", "www.acme.com/pricing" and "https://acme.com" all mean a web
// address; anything that is not http(s) is refused.
function normalizeUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("Give a website address, for example: easyscreenshot acme.com");
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error(`Not a web address: ${text}`);
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname) throw new Error(`Not a web address: ${text}`);
  url.hash = "";
  return url.href;
}

// Files a run writes, by name: a manifest someone edited cannot point the
// clean-up outside the folder.
const RUN_FILE = /^(\d{2}-[a-z0-9-]+\.png|sheet\.png|manifest\.json|SCREENSHOTS\.md)$/;

// The run's folder: created when missing, reused when an earlier
// easyscreenshot run made it (that run's files are replaced), refused when
// it holds anything else, so a run never mixes into or overwrites someone's
// own files.
function prepareDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).length === 0) return;
  let old = null;
  try {
    old = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch {
    // Not a run of ours.
  }
  if (!old || old.version !== 1 || !/^easyscreenshot /.test(String(old.tool || ""))) {
    throw new Error(`${dir} is not empty and holds no earlier easyscreenshot run. Pick another folder with --out.`);
  }
  for (const file of fs.readdirSync(dir)) if (RUN_FILE.test(file)) fs.rmSync(path.join(dir, file), { force: true });
}

// A failed run leaves nothing half made: its own files go, and so does the
// folder when this run created it.
function cleanUp(dir, existed) {
  for (const file of fs.readdirSync(dir)) if (RUN_FILE.test(file)) fs.rmSync(path.join(dir, file), { force: true });
  if (!existed) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // Not empty: what is left there is not this run's.
    }
  }
}

// A page's name in file names: home, pricing, product-teams.
function slugOf(url, home) {
  if (pageKey(url) === pageKey(home)) return "home";
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const inner = localeOf(new URL(url).pathname) ? parts.slice(1) : parts;
  const slug = fold(
    inner
      .map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          return part;
        }
      })
      .join("-"),
  )
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "page";
}

// The site's name: og:site_name, else the title up to its first separator
// ("Acme | Payments for teams" is Acme), else the host name.
function siteName(info, url) {
  if (info.siteName) return info.siteName;
  const first = String(info.title || "").split(/\s+[|·•:–—-]\s+/)[0].trim();
  if (first && first.length <= 40) return first;
  const label = new URL(url).hostname.replace(/^www\./, "").split(".")[0];
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// A bot check served instead of the page (a CAPTCHA, "Just a moment…"). A
// form's reCAPTCHA or Turnstile script on a real page is common, so a script
// counts only on a short page with almost no links.
const CHALLENGE_TITLE = /human verification|just a moment|attention required|access denied|verify you are human|are you a robot|security check|checking your browser|pardon our interruption|ddos-guard|one more step|request blocked|captcha/i;
const CHALLENGE_SRC = /challenges\.cloudflare\.com|hcaptcha\.com|google\.com\/recaptcha|recaptcha\.net|captcha-delivery\.com|px-cdn\.net|perimeterx|awswaf/i;
const SIGN_IN = /(^|[./])(log-?in|sign-?in|sign-?up|auth|oauth|sso|accounts?|giris|oturum|register|session)([./?#_-]|$)/i;

// A heading that carries its words twice (once for the eye, once for screen
// readers) is read once.
const ONCE = `((text) => {
  const words = text.split(" ");
  const half = words.length / 2;
  return words.length % 2 === 0 && words.slice(0, half).join(" ") === words.slice(half).join(" ") ? words.slice(0, half).join(" ") : text;
})`;

const READ_INFO = `(() => {
  const once = ${ONCE};
  const meta = (selector) => ((document.querySelector(selector) || {}).content || "").trim();
  const h1 = document.querySelector("h1");
  const text = (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").trim();
  return {
    title: document.title.trim(),
    description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
    siteName: meta('meta[property="og:site_name"]'),
    heading: h1 ? once(h1.innerText.replace(/\\s+/g, " ").trim()).slice(0, 200) : "",
    canonical: (document.querySelector('link[rel="canonical"]') || {}).href || "",
    lang: document.documentElement.lang || "",
    text: text.slice(0, 20000),
    scripts: [...document.querySelectorAll("script[src], iframe[src]")].map((el) => el.src).join(" ").slice(0, 20000),
    height: document.documentElement.scrollHeight,
    links: document.links.length,
    alternates: [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map((link) => ({ lang: link.hreflang, href: link.href })),
  };
})()`;

async function readInfo(cdp) {
  const { result } = await cdp.send("Runtime.evaluate", { expression: READ_INFO, returnByValue: true }, 10_000).catch(() => ({ result: {} }));
  const info = (result && result.value) || { title: "", description: "", siteName: "", heading: "", canonical: "", lang: "", text: "", scripts: "", height: 0, links: 0, alternates: [] };
  const challenge =
    (CHALLENGE_TITLE.test(info.title) && (info.height < 1500 || info.links < 15)) || (CHALLENGE_SRC.test(info.scripts) && info.height < 1200 && info.links < 10);
  return { ...info, challenge, textHash: info.text ? crypto.createHash("sha1").update(info.text).digest("hex") : "" };
}

// Every link on the page with its words and where it sits: the header and
// menus, a big button on the first screen, the body, the footer. Links in a
// closed dropdown count: they are in the menu.
const READ_LINKS = `(() => {
  const out = [];
  const textOf = (a) => (a.innerText || a.textContent || a.getAttribute("aria-label") || a.title || (a.querySelector("img[alt]") || {}).alt || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  for (const a of document.querySelectorAll("a[href]")) {
    if (!/^https?:/i.test(a.href)) continue;
    let where = "body";
    if (a.closest('header, [role="banner"], nav, [role="navigation"]')) where = "header";
    else if (a.closest('footer, [role="contentinfo"]')) where = "footer";
    if (where === "body") {
      const r = a.getBoundingClientRect();
      const top = r.top + scrollY;
      if (r.width > 0 && r.height >= 28 && top < innerHeight) {
        const s = getComputedStyle(a);
        const filled = s.backgroundColor && s.backgroundColor !== "transparent" && !/^rgba\\(.*,\\s*0\\)$/.test(s.backgroundColor);
        if (filled || parseFloat(s.borderTopWidth) > 0 || /btn|button|cta/i.test(a.className)) where = "hero";
      }
    }
    out.push({ href: a.href, text: textOf(a), where });
  }
  return out;
})()`;

async function readLinks(cdp) {
  const { result } = await cdp.send("Runtime.evaluate", { expression: READ_LINKS, returnByValue: true }, 15_000).catch(() => ({ result: {} }));
  return (result && result.value) || [];
}

// The headings on the first screen, with their boxes in the image's own
// pixels (x, y, width, height), so a crop or a zoom does not have to guess.
const READ_HEADINGS = `((scale) => {
  const once = ${ONCE};
  const out = [];
  for (const el of document.querySelectorAll("h1, h2, h3, [role='heading']")) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || parseFloat(s.opacity) === 0) continue;
    const text = once(el.innerText.replace(/\\s+/g, " ").trim());
    if (!text || text.length > 200) continue;
    const level = /^H[1-6]$/.test(el.tagName) ? Number(el.tagName[1]) : Number(el.getAttribute("aria-level")) || 2;
    const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top), x1 = Math.min(innerWidth, r.right), y1 = Math.min(innerHeight, r.bottom);
    out.push({ text: text.slice(0, 120), level, box: [x0, y0, x1 - x0, y1 - y0].map((v) => Math.round(v * scale)) });
    if (out.length >= 20) break;
  }
  return out;
})`;

// Where each section of a whole page starts and ends, in the image's own
// pixels: a section is the block its heading opens (an h2, or h1 to h3 on a
// page with fewer than two h2s), down to where the next one starts.
const READ_SECTIONS = `((scale, limit) => {
  const once = ${ONCE};
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden"; };
  let heads = [...document.querySelectorAll("h2")].filter(shown);
  if (heads.length < 2) heads = [...document.querySelectorAll("h1, h2, h3")].filter(shown);
  const seen = new Set();
  const tops = [];
  for (const el of heads) {
    const text = once(el.innerText.replace(/\\s+/g, " ").trim());
    if (!text || text.length > 160) continue;
    let block = el.closest("section, article, [class*='section' i]");
    if (block && block.getBoundingClientRect().width < 0.6 * innerWidth) block = null;
    if (block && seen.has(block)) continue;
    if (block) seen.add(block);
    const top = Math.max(0, (block || el).getBoundingClientRect().top + scrollY - (block ? 0 : 24));
    if (top >= limit) continue;
    tops.push({ heading: text.slice(0, 120), top });
  }
  tops.sort((a, b) => a.top - b.top);
  return tops.slice(0, 40).map((s, i, all) => ({
    heading: s.heading,
    top: Math.round(s.top * scale),
    height: Math.round(((i + 1 < all.length ? all[i + 1].top : limit) - s.top) * scale),
  })).filter((s) => s.height > 0);
})`;

async function evaluate(cdp, expression, fallback) {
  const { result } = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, 15_000).catch(() => ({ result: {} }));
  return result && result.value !== undefined ? result.value : fallback;
}

// Why a page found by easyscreenshot is not kept, or "". What the address
// and the first look tell is checked at once; whether the page loaded and
// whether it repeats a page already kept, once it has settled.
function rejectAtOnce({ asked, nav, info }, { site, homeKey }) {
  if (nav.status >= 400) return `the page answered ${nav.status}`;
  if (info.challenge) return "a bot check instead of the page";
  if (siteOf(nav.url) !== site) return `redirected to ${new URL(nav.url).hostname}`;
  const landed = pageKey(nav.url);
  if (landed !== pageKey(asked)) {
    const where = new URL(nav.url);
    if (SIGN_IN.test(`${where.hostname}${where.pathname}`)) return "redirected to a sign-in page";
    if (landed === homeKey) return "redirected to the home page";
  }
  return "";
}

function rejectReason({ asked, nav, info, loaded }, check) {
  const first = rejectAtOnce({ asked, nav, info }, check);
  if (first) return first;
  if (!loaded) return "still loading after 20 s";
  const landed = pageKey(nav.url);
  let canonical = "";
  try {
    canonical = info.canonical ? pageKey(info.canonical) : "";
  } catch {
    // A canonical link that is not an address says nothing.
  }
  const same = check.kept.find((page) => page.keys.has(landed) || (canonical && page.keys.has(canonical)) || (info.textHash && page.textHash === info.textHash));
  return same ? `the same page as ${same.slug}` : "";
}

// Opens one page on one device in one theme and takes the captures the
// device holds. check: decide first whether the page is kept (see
// rejectReason); links: read the page's links too.
async function visit(chrome, page, group, theme, ctx, { check = null, links = false } = {}) {
  const tab = await openTab(chrome, group.device, { lang: ctx.lang, theme, reducedMotion: ctx.reducedMotion });
  try {
    resetPictureWait(tab);
    const nav = await navigate(tab, page.url);
    // A bot check, an error or a redirect to a sign-in page is known at once:
    // no need to wait for it to settle.
    const glance = await readInfo(tab);
    if (check) {
      const reason = rejectAtOnce({ asked: page.url, nav, info: glance }, check);
      if (reason) return { rejected: reason, nav, info: glance };
    } else if (glance.challenge || nav.status >= 400) {
      return { nav, info: glance, loaded: false, links: [], shots: [], cleaned: { hidden: 0, unlocked: false, badSelectors: [] } };
    }
    const loaded = await waitForContent(tab, 20_000);
    await settle(tab, 6_000);
    const info = await readInfo(tab);
    if (check) {
      const reason = rejectReason({ asked: page.url, nav, info, loaded }, check);
      if (reason) return { rejected: reason, nav, info };
    }
    const full = group.shots.some((shot) => shot.full);
    // Lazy parts render, footers load, and boxes that come up on scrolling
    // come up before the clean-up. A first screen alone needs no walk.
    if (full || links) await walk(tab, MAX_HEIGHT);
    else await scrollTo(tab, 0);
    const found = links ? await readLinks(tab) : null;
    const m0 = await metrics(tab);
    const cleaned = ctx.clean
      ? await clean(tab, { hide: ctx.hide, viewport: { width: m0.width, height: m0.viewportHeight } })
      : { hidden: 0, unlocked: false, badSelectors: [] };
    await waitForFonts(tab);
    await scrollTo(tab, 0);
    await sleep(400);
    const shots = [];
    for (const shot of group.shots) {
      if (timeLeft() < 20_000) break;
      const m = await metrics(tab);
      // A phone page wider than the screen (no viewport tag, or content that
      // overflows) is shown zoomed out, as a phone shows it: the first screen
      // is the screen itself, and a whole page is fitted to its width.
      const fit = Math.min(1, group.device.width / m.visualWidth);
      if (!shot.full) {
        await clearHover(tab, m.width, m.viewportHeight);
        const data = await captureScreen(tab);
        const png = Buffer.from(data.data || "", "base64");
        if (!pngSize(png)) continue;
        const scale = group.device.scale * fit;
        const headings = await evaluate(tab, `${READ_HEADINGS}(${scale})`, []);
        shots.push({ size: shot.size, full: false, png, scale: group.device.scale, cssWidth: m.width, cssHeight: m.viewportHeight, headings });
      } else {
        const whole = await capturePage(tab, { scale: (shot.scale / group.device.scale) * fit, maxHeight: MAX_HEIGHT });
        if (!whole || !pngSize(whole.png)) continue;
        const sections = await evaluate(tab, `${READ_SECTIONS}(${shot.scale * fit}, ${whole.height})`, []);
        shots.push({ size: shot.size, full: true, png: whole.png, scale: shot.scale, cssWidth: m.width, cssHeight: whole.height, truncated: whole.truncated, sections });
      }
    }
    return { nav, info, loaded, links: found, shots, cleaned };
  } finally {
    await closeTab(chrome, tab);
  }
}

// A file of the run. A full disk or quota comes back from Node as "UNKNOWN:
// unknown error, write" (EDQUOT), which says nothing; this says what.
function save(dir, file, data) {
  try {
    fs.writeFileSync(path.join(dir, file), data);
  } catch (err) {
    const full = err.code === "ENOSPC" || err.code === "EDQUOT" || err.errno === -122;
    throw new Error(`Could not save ${file} in ${dir}: ${full ? "the disk, or your disk quota, is full" : err.message}`);
  }
}

// Writes a visit's captures as files of the page and records them.
function saveShots(page, result, theme, dir, written) {
  for (const shot of result.shots) {
    const file = `${String(page.n).padStart(2, "0")}-${page.slug}-${shot.size}${theme === "dark" ? "-dark" : ""}.png`;
    const png = tagPng(shot.png, {
      Title: page.title || "",
      Source: result.nav.url,
      "Creation Time": new Date().toISOString(),
      Software: `easyscreenshot ${version}`,
    });
    save(dir, file, png);
    written.push(file);
    const { width, height } = pngSize(png);
    const entry = { file, size: shot.size, full: Boolean(shot.full), theme, width, height, scale: shot.scale, cssWidth: shot.cssWidth, cssHeight: shot.cssHeight };
    if (shot.full) Object.assign(entry, { truncated: Boolean(shot.truncated), sections: shot.sections });
    else entry.headings = shot.headings;
    page.shots.push(entry);
  }
  page.hidden = Math.max(page.hidden || 0, result.cleaned.hidden);
  if (result.cleaned.unlocked && !page.notes.includes("scroll unlocked")) page.notes.push("scroll unlocked");
}

function describeSizes(groups) {
  const out = [];
  for (const group of groups) {
    for (const shot of group.shots) {
      const scale = shot.full ? shot.scale : group.device.scale;
      out.push({ size: shot.size, width: group.device.width, height: shot.full ? null : group.device.height, scale, device: group.device.agent, full: shot.full });
    }
  }
  return out;
}

function writeMarkdown(manifest, dir) {
  const date = manifest.takenAt.slice(0, 10);
  const lines = [`# Screenshots of ${manifest.site}`, "", `Taken from ${manifest.url} on ${date} by easyscreenshot ${version}.`, ""];
  lines.push(
    "Use the files as they are: they are the real pages, with cookie banners, chat bubbles and other floating boxes hidden. Do not redraw the interface, and do not present them as another product's. Boxes are in each image's own pixels: x, y, width, height.",
    "",
  );
  for (const page of manifest.pages) {
    const label = `${String(page.n).padStart(2, "0")} ${page.slug}`;
    lines.push(`## ${label}`, "", `- Address: ${page.url}`, `- Why: ${page.why}`);
    if (page.title) lines.push(`- Title: ${page.title}`);
    if (page.heading) lines.push(`- Main heading: ${page.heading}`);
    if (page.notes.length) lines.push(`- Notes: ${page.notes.join("; ")}`);
    lines.push("", "| File | Size | What |", "| --- | --- | --- |");
    for (const shot of page.shots) {
      const what = `${SIZE_WORDS[shot.size] || `first screen, ${shot.size}`}${shot.theme === "dark" ? ", dark" : ""}${shot.truncated ? ", cut at its first 15,000 px" : ""}`;
      lines.push(`| ${shot.file} | ${shot.width}x${shot.height} | ${what} |`);
    }
    const first = page.shots.find((shot) => !shot.full && shot.headings && shot.headings.length);
    if (first) {
      lines.push("", `Headings on the first screen of ${first.file}:`, "");
      for (const heading of first.headings.slice(0, 8)) lines.push(`- H${heading.level} "${heading.text}" at ${heading.box.join(", ")}`);
    }
    const whole = page.shots.find((shot) => shot.full && shot.sections && shot.sections.length);
    if (whole) {
      lines.push("", `Sections of ${whole.file} (top and height):`, "");
      for (const section of whole.sections.slice(0, 12)) lines.push(`- "${section.heading}" at ${section.top}, ${section.height} high`);
    }
    lines.push("");
  }
  if (manifest.sheet) lines.push("## All pages on one picture", "", `- ${manifest.sheet.file} (${manifest.sheet.width}x${manifest.sheet.height})`, "");
  if (manifest.skipped.length) {
    lines.push("## Left out", "");
    for (const skip of manifest.skipped) lines.push(`- ${skip.url}: ${skip.reason}`);
    lines.push("");
  }
  if (manifest.candidates.length) {
    lines.push("## Other pages it could take", "", "Run again with `--page <path>` to add one.", "");
    for (const candidate of manifest.candidates.slice(0, 10)) lines.push(`- ${candidate.url} (${candidate.kind}, ${candidate.why})`);
    lines.push("");
  }
  if (manifest.notes.length) lines.push("## Notes", "", ...manifest.notes.map((note) => `- ${note}`), "");
  save(dir, "SCREENSHOTS.md", lines.join("\n"));
}

async function takeShots(rawUrl, options = {}) {
  const {
    dir,
    pages: wanted = 5,
    extra = [],
    sizes = "desktop,mobile,full",
    theme = "light",
    lang = "",
    hide = [],
    reducedMotion = false,
    clean: tidy = true,
    timeLimit = 300_000,
    log = () => {},
  } = options;
  setTimeLimit(timeLimit);
  const groups = parseSizes(sizes);
  const themes = theme === "both" ? ["light", "dark"] : [theme === "dark" ? "dark" : "light"];
  const asked = normalizeUrl(rawUrl);
  let home = homeOf(asked);
  // An address deeper than its home page is a page of its own to take.
  const given = pageKey(asked) !== pageKey(home) ? asked : "";
  const asks = extra.map((raw) => {
    const url = linkUrl(raw, home);
    if (!url || siteOf(url.href) !== siteOf(home)) throw new Error(`--page ${raw} is not a page of ${siteOf(home)}`);
    return url.href;
  });
  const target = dir || `easyscreenshot-${siteOf(asked)}`;
  const existed = fs.existsSync(target);
  prepareDir(target);
  const ctx = { lang, hide, reducedMotion, clean: tidy };
  const notes = [];
  // Pages opened and left out come first in the manifest's list, then the
  // links left out without opening.
  const rejected = [];
  const skipped = [];
  const kept = [];
  const written = [];
  let leftover = [];
  let name = "";
  const chrome = await launch({ lang });
  // The other devices and themes of a page kept are taken in windows of
  // their own while the next pages are being found.
  const pool = makePool(2);
  try {
    const [first] = groups;
    const firstTheme = themes[0];
    const others = (page) => {
      for (const themeName of themes) {
        for (const group of groups) {
          if (group === first && themeName === firstTheme) continue;
          pool.add(async () => {
            const label = `${group.key}${themeName === "dark" ? " (dark)" : ""}`;
            if (timeLeft() < 30_000) {
              page.notes.push(`${label} not taken: time ran out`);
              return;
            }
            log(`${String(page.n).padStart(2, "0")} ${page.slug}  ${label}`);
            try {
              const got = await visit(chrome, { ...page }, group, themeName, ctx);
              if (got.info.challenge || got.nav.status >= 400) page.notes.push(`${label} not taken: ${got.info.challenge ? "the site answered with a bot check" : `the page answered ${got.nav.status}`}`);
              saveShots(page, got, themeName, target, written);
            } catch (err) {
              page.notes.push(`${label} could not be taken: ${err.message}`);
            }
          });
        }
      }
    };
    const keep = (page, result) => {
      page.n = kept.length + 1;
      const taken = new Set(kept.map((other) => other.slug));
      let slug = page.slug || slugOf(result.nav.url, home);
      for (let k = 2; taken.has(slug); k++) slug = `${page.slug || slugOf(result.nav.url, home)}-${k}`;
      page.slug = slug;
      Object.assign(page, {
        url: result.nav.url,
        title: result.info.title,
        heading: result.info.heading,
        description: result.info.description,
        lang: result.info.lang,
        textHash: result.info.textHash,
        keys: new Set([pageKey(page.asked), pageKey(result.nav.url), ...(result.info.canonical ? [pageKey(result.info.canonical)] : [])]),
      });
      if (!result.loaded) page.notes.push("still showed a loading screen after 20 s");
      if (pageKey(result.nav.url) !== pageKey(page.asked)) page.notes.push(`opened ${page.asked} and landed on ${result.nav.url}`);
      kept.push(page);
      saveShots(page, result, firstTheme, target, written);
      log(`${String(page.n).padStart(2, "0")} ${page.slug}  ${new URL(result.nav.url).pathname}`);
      others(page);
    };
    const newPage = (url, kind, why) => ({ asked: url, url, kind, why, slug: "", shots: [], notes: [], hidden: 0 });

    // The home page, or only the address given when one page is asked for.
    const startUrl = wanted === 1 ? asked : home;
    log(`Opening ${startUrl}`);
    const indexing = wanted > 1 ? readSiteIndex(new URL(home).origin).catch(() => ({ robots: null, urls: [] })) : Promise.resolve({ robots: null, urls: [] });
    let start = newPage(startUrl, wanted === 1 && given ? "given" : "home", wanted === 1 && given ? "the address given" : "the home page");
    let begun = Date.now();
    let result = await visit(chrome, start, first, firstTheme, ctx, { links: wanted > 1 });
    // The site's own page in the language asked for, when it names one.
    if (lang && wanted > 1) {
      const alternate = (result.info.alternates || []).find((alt) => fold(alt.lang) === fold(lang) || fold(alt.lang).split("-")[0] === fold(lang).split("-")[0]);
      if (alternate && pageKey(alternate.href) !== pageKey(result.nav.url) && siteOf(alternate.href) === siteOf(home)) {
        log(`Opening its ${alternate.lang} version, ${alternate.href}`);
        home = homeOf(alternate.href);
        start = newPage(alternate.href, "home", `the home page in ${alternate.lang}`);
        begun = Date.now();
        result = await visit(chrome, start, first, firstTheme, ctx, { links: true });
      } else if (!alternate) {
        notes.push(`The home page names no ${lang} version of itself, so it was opened with ${lang} as the browser's language.`);
      }
    }
    if (result.nav.status >= 400) throw new Error(`${result.nav.url} answered ${result.nav.status}, so no screenshots were taken.`);
    if (result.info.challenge) {
      throw new Error(`${result.nav.url} answered with a bot check ("${result.info.title || "a challenge page"}") instead of its page, so no screenshots were taken. Open the site in a normal browser to check it.`);
    }
    const lastVisit = Date.now() - begun;
    name = siteName(result.info, result.nav.url);
    keep(start, result);
    if (start.kind === "home") start.keys.add(pageKey(home));

    if (wanted > 1) {
      const site = siteOf(home);
      const homeKey = pageKey(kept[0].url);
      // The page given, when it is not the home page, and the pages asked for
      // with --page: taken whatever they are, unless they fail to open.
      const named = [...(given && pageKey(given) !== homeKey ? [[given, "the address given"]] : []), ...asks.map((url) => [url, "asked for with --page"])];
      for (const [url, why] of named) {
        if (timeLeft() < 45_000) break;
        if (kept.some((page) => page.keys.has(pageKey(url)))) continue;
        const kind = (kindOf(new URL(url), "") || { kind: "other" }).kind;
        const page = newPage(url, kind, why);
        log(`Opening ${url}`);
        const got = await visit(chrome, page, first, firstTheme, ctx);
        const failed = got.nav.status >= 400 ? `the page answered ${got.nav.status}` : got.info.challenge ? "a bot check instead of the page" : "";
        if (failed) {
          rejected.push({ url, reason: failed });
          notes.push(`${url} was asked for but not taken: ${failed}.`);
        } else keep(page, got);
      }
      // Then the pages found on the home page and in the sitemap.
      const index = await indexing;
      const ranked = rankLinks(result.links || [], index.urls || [], {
        home: kept[0].url,
        robots: index.robots,
        alternates: (result.info.alternates || []).map((alt) => alt.href),
        exclude: kept.map((page) => page.url),
      });
      skipped.push(...ranked.skipped);
      const queue = visitOrder(ranked.candidates);
      let visits = 0;
      // A page is opened only when there is time to take it: as long as the
      // pages taken so far took on average, and a margin.
      const took = [lastVisit];
      while (queue.length && kept.length < wanted && visits < wanted * 3) {
        const expected = took.reduce((sum, ms) => sum + ms, 0) / took.length;
        if (timeLeft() < Math.max(60_000, expected * 1.3 + 20_000)) {
          notes.push(`Time ran out after ${kept.length === 1 ? "1 page" : `${kept.length} pages`}; give more with --timeout.`);
          break;
        }
        const candidate = queue.shift();
        if (kept.some((page) => page.keys.has(pageKey(candidate.url)))) continue;
        visits++;
        const page = newPage(candidate.url, candidate.kind, candidate.why);
        log(`Opening ${candidate.url}`);
        let got;
        const started = Date.now();
        try {
          got = await visit(chrome, page, first, firstTheme, ctx, { check: { site, homeKey, kept } });
          if (!got.rejected) took.push(Date.now() - started);
        } catch (err) {
          // A call that failed because the run's time is up is no reason
          // to leave the page out.
          if (timeLeft() < 30_000) {
            notes.push(`Time ran out after ${kept.length === 1 ? "1 page" : `${kept.length} pages`}; give more with --timeout.`);
            break;
          }
          rejected.push({ url: candidate.url, reason: /timed out/.test(err.message) ? `too slow to answer (${err.message})` : `could not be opened: ${err.message}` });
          continue;
        }
        if (got.rejected) rejected.push({ url: candidate.url, reason: got.rejected });
        else keep(page, got);
      }
      leftover = queue.slice(0, 20).map(({ url, kind, score, why }) => ({ url, kind, score, why }));
    }

    await pool.drain();
    // Each page's files in the order the sizes were asked for, light first.
    const order = describeSizes(groups).map((size) => size.size);
    for (const page of kept) page.shots.sort((a, b) => themes.indexOf(a.theme) - themes.indexOf(b.theme) || order.indexOf(a.size) - order.indexOf(b.size));
    if (!kept.some((page) => page.shots.length)) throw new Error("No page could be captured.");
    if (kept.some((page) => page.notes.some((note) => /time ran out/.test(note)))) notes.push("Time ran out before every size was taken; give more with --timeout.");
    if (themes.includes("dark")) notes.push("Dark captures use the page's own dark theme, through prefers-color-scheme. A site without one looks the same in both.");
  } catch (err) {
    await pool.drain();
    await chrome.close();
    cleanUp(target, existed);
    throw err;
  }
  const manifest = {
    version: 1,
    tool: `easyscreenshot ${version}`,
    url: asked,
    site: name,
    takenAt: new Date().toISOString(),
    sizes: describeSizes(groups),
    themes,
    lang: lang || (kept[0] && kept[0].lang) || "",
    pages: kept.map((page) => ({
      n: page.n,
      slug: page.slug,
      url: page.url,
      kind: page.kind,
      why: page.why,
      title: page.title,
      heading: page.heading,
      description: page.description,
      lang: page.lang,
      hidden: page.hidden,
      notes: page.notes,
      shots: page.shots,
    })),
    sheet: null,
    candidates: leftover,
    skipped: dedupeSkipped([...rejected, ...skipped]),
    notes,
  };
  try {
    log("Drawing the sheet");
    // The sheet takes a few seconds and is drawn even when the pages used up
    // the run's time.
    if (timeLeft() < 90_000) setTimeLimit(90_000);
    manifest.sheet = await renderSheet(chrome, manifest, target).catch(() => null);
  } finally {
    await chrome.close();
  }
  save(target, "manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  writeMarkdown(manifest, target);
  return { dir: target, manifest };
}

// Runs jobs, at most limit at a time; drain() waits for all of them.
function makePool(limit) {
  const waiting = [];
  const idle = [];
  let running = 0;
  const next = () => {
    while (running < limit && waiting.length) {
      const job = waiting.shift();
      running++;
      Promise.resolve()
        .then(job)
        .catch(() => {})
        .finally(() => {
          running--;
          next();
        });
    }
    if (!running && !waiting.length) idle.splice(0).forEach((resolve) => resolve());
  };
  return {
    add(job) {
      waiting.push(job);
      next();
    },
    drain() {
      return new Promise((resolve) => {
        idle.push(resolve);
        next();
      });
    },
  };
}

function dedupeSkipped(list) {
  const seen = new Set();
  const out = [];
  for (const skip of list) {
    let key;
    try {
      key = pageKey(skip.url);
    } catch {
      key = skip.url;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(skip);
  }
  return out.slice(0, 40);
}

module.exports = { takeShots, parseSizes, normalizeUrl, prepareDir, slugOf, siteName, rejectAtOnce, rejectReason, DEVICES, MAX_HEIGHT };
