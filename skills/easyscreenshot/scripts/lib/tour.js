"use strict";

// The tour a demo takes when no steps are given. Its pages are the ones the
// screenshots would take: the home page, then the pages its menu puts
// forward (features, pricing and the like), each opened first to make sure
// it is a page of its own and not a sign-in redirect, a bot check or a page
// already taken. Pricing goes last, as a visitor's tour would end there.
//
// On each page: a moment on the first screen, a scroll down to a section or
// two, and on to the next page through the link in the site's own menu (a
// cut when the menu has none).

const { openTab, closeTab, navigate } = require("./chrome");
const { waitForContent, settle, walk } = require("./page");
const { readInfo, readLinks, rejectAtOnce, rejectReason, slugOf, siteName } = require("./shots");
const { fold, homeOf, pageKey, siteOf, rankLinks, visitOrder, readSiteIndex, kindOf, linkUrl } = require("./pick");
const { TOP_COVER } = require("./record");
const { timeLeft } = require("./time");

const PROBE = { width: 1600, height: 900, scale: 1, mobile: false, touch: false, agent: "desktop" };

// Opens a candidate in a window of its own and says whether it is a page
// worth showing: {nav, info}, or {rejected: reason}.
async function probe(chrome, url, check, ctx) {
  const tab = await openTab(chrome, PROBE, ctx);
  try {
    const nav = await navigate(tab, url);
    const glance = await readInfo(tab);
    const early = rejectAtOnce({ asked: url, nav, info: glance }, check);
    if (early) return { rejected: early };
    const loaded = await waitForContent(tab, 15_000);
    await settle(tab, 4_000);
    const info = await readInfo(tab);
    const reason = rejectReason({ asked: url, nav, info, loaded }, check);
    return reason ? { rejected: reason } : { nav, info };
  } finally {
    await closeTab(chrome, tab);
  }
}

// The pages of the tour, the home page first: [{url, kind, why, title}],
// with the ones left out and why.
async function pickPages(chrome, asked, { pages: wanted = 4, extra = [], lang = "", theme = "light", reducedMotion = false, log = () => {} } = {}) {
  const ctx = { lang, theme, reducedMotion };
  let home = homeOf(asked);
  const given = pageKey(asked) !== pageKey(home) ? asked : "";
  const asks = extra.map((raw) => {
    const url = linkUrl(raw, home);
    if (!url || siteOf(url.href) !== siteOf(home)) throw new Error(`--page ${raw} is not a page of ${siteOf(home)}`);
    return url.href;
  });
  log(`Opening ${home}`);
  const indexing = wanted > 1 ? readSiteIndex(new URL(home).origin).catch(() => ({ robots: null, urls: [] })) : Promise.resolve({ robots: null, urls: [] });
  const tab = await openTab(chrome, PROBE, ctx);
  let nav;
  let info;
  let links = [];
  try {
    nav = await navigate(tab, home);
    if (nav.status >= 400) throw new Error(`${nav.url} answered ${nav.status}, so no demo was recorded.`);
    await waitForContent(tab, 20_000);
    await settle(tab, 6_000);
    info = await readInfo(tab);
    if (info.challenge) throw new Error(`${nav.url} answered with a bot check ("${info.title || "a challenge page"}") instead of its page, so no demo was recorded. Open the site in a normal browser to check it.`);
    // The site's own home page in the language asked for, when it names one.
    const alternate = lang && (info.alternates || []).find((alt) => fold(alt.lang) === fold(lang) || fold(alt.lang).split("-")[0] === fold(lang).split("-")[0]);
    if (alternate && pageKey(alternate.href) !== pageKey(nav.url) && siteOf(alternate.href) === siteOf(home)) {
      log(`Opening its ${alternate.lang} version, ${alternate.href}`);
      home = homeOf(alternate.href);
      nav = await navigate(tab, alternate.href);
      await waitForContent(tab, 20_000);
      await settle(tab, 6_000);
      info = await readInfo(tab);
    }
    if (wanted > 1) {
      await walk(tab, 12_000);
      links = await readLinks(tab);
    }
  } finally {
    await closeTab(chrome, tab);
  }
  const homeKey = pageKey(nav.url);
  const kept = [{ url: nav.url, kind: "home", why: "the home page", title: info.title, slug: "home", textHash: info.textHash, keys: new Set([pageKey(home), homeKey]) }];
  const skipped = [];
  const keep = (url, kind, why, got) => {
    kept.push({
      url: got.nav.url,
      kind,
      why,
      title: got.info.title,
      slug: slugOf(got.nav.url, home),
      textHash: got.info.textHash,
      keys: new Set([pageKey(url), pageKey(got.nav.url), ...(got.info.canonical ? [pageKey(got.info.canonical)] : [])]),
    });
    log(`  ${new URL(got.nav.url).pathname} (${why})`);
  };
  const check = { site: siteOf(home), homeKey, kept };
  // The page given and the ones asked for come whatever they are, unless
  // they fail to open.
  for (const [url, why] of [...(given ? [[given, "the address given"]] : []), ...asks.map((url) => [url, "asked for with --page"])]) {
    if (kept.length >= Math.max(wanted, 1 + asks.length + (given ? 1 : 0)) || kept.some((page) => page.keys.has(pageKey(url)))) continue;
    const got = await probe(chrome, url, { site: check.site, homeKey: "", kept: [] }, ctx);
    if (got.rejected) skipped.push({ url, reason: got.rejected });
    else keep(url, (kindOf(new URL(url), "") || { kind: "other" }).kind, why, got);
  }
  if (wanted > kept.length) {
    const index = await indexing;
    const ranked = rankLinks(links, index.urls || [], {
      home: nav.url,
      robots: index.robots,
      alternates: (info.alternates || []).map((alt) => alt.href),
      exclude: kept.map((page) => page.url),
    });
    const queue = visitOrder(ranked.candidates);
    let visits = 0;
    while (queue.length && kept.length < wanted && visits < wanted * 3 && timeLeft() > 240_000) {
      const candidate = queue.shift();
      if (kept.some((page) => page.keys.has(pageKey(candidate.url)))) continue;
      visits++;
      let got;
      try {
        got = await probe(chrome, candidate.url, check, ctx);
      } catch (err) {
        skipped.push({ url: candidate.url, reason: `could not be opened: ${err.message}` });
        continue;
      }
      if (got.rejected) skipped.push({ url: candidate.url, reason: got.rejected });
      else keep(candidate.url, candidate.kind, candidate.why, got);
    }
  }
  // A visitor's order: what the product is first, what it costs last.
  const [first, ...rest] = kept;
  const ordered = [first, ...rest.filter((page) => page.kind !== "pricing"), ...rest.filter((page) => page.kind === "pricing")];
  return { pages: ordered.map(({ url, kind, why, title, slug }) => ({ url, kind, why, title, slug })), skipped, site: siteName(info, nav.url) };
}

// Where a page is worth stopping on the way down: the tops of its first
// sections (blocks opened by an h2), in CSS px from the page's top.
const SECTIONS = `(() => {
  const doc = document.scrollingElement || document.documentElement;
  const max = Math.max(0, doc.scrollHeight - innerHeight);
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  let heads = [...document.querySelectorAll("h2")].filter(shown);
  if (heads.length < 2) heads = [...document.querySelectorAll("h2, h3")].filter(shown);
  const tops = [];
  for (const el of heads) {
    const text = el.innerText.replace(/\\s+/g, " ").trim();
    if (!text || text.length > 120) continue;
    let block = el.closest("section, article, [class*='section' i]");
    if (block && block.getBoundingClientRect().width < 0.6 * innerWidth) block = null;
    const top = (block || el).getBoundingClientRect().top + scrollY - (block ? 0 : 40);
    tops.push({ top: Math.max(0, Math.round(top)), heading: text.slice(0, 80) });
  }
  tops.sort((a, b) => a.top - b.top);
  return { max, tops };
})()`;

// Up to two stops between half a screen and three and a half screens down,
// at least two thirds of a screen apart; plain screens when the page has
// no sections to stop at.
function chooseStops({ max, tops }, height, cover = 0) {
  if (max < height * 0.3) return [];
  const limit = Math.min(max, height * 3.5);
  const stops = [];
  for (const section of tops) {
    const y = Math.min(max, Math.max(0, section.top - cover - 8));
    if (y < height * 0.5 || y > limit) continue;
    if (stops.length && y - stops[stops.length - 1].y < height * 0.65) continue;
    stops.push({ y, heading: section.heading });
    if (stops.length === 2) break;
  }
  if (!stops.length) {
    for (const k of [0.9, 1.8]) if (height * k <= limit + height * 0.2) stops.push({ y: Math.min(max, Math.round(height * k)), heading: "" });
  }
  return stops.filter((stop, i, all) => i === 0 || stop.y - all[i - 1].y > height * 0.3);
}

// The link to url on the screen as it is, or null.
async function linkOnScreen(recorder, url) {
  const found = await recorder.locate({ href: url }, { timeout: 0, scroll: false });
  if (!found || found.covered) return null;
  const inside = found.top >= 0 && found.top + found.height <= recorder.viewport.height && found.left >= 0 && found.left + found.width <= recorder.viewport.width;
  return inside ? found : null;
}

// Whether a link to url shows on the page's first screen: a menu that
// scrolled away with the page is there again at the top.
async function linkAtTop(recorder, url) {
  const found = await recorder.locate({ href: url }, { timeout: 0, scroll: false });
  if (!found) return false;
  const { y } = await recorder.scrollState();
  return found.top + y >= 0 && found.top + y + found.height <= recorder.viewport.height;
}

// A heading or a link's words in a step's label: whole words, 40
// characters at most.
function quote(text) {
  const words = String(text).replace(/\s+/g, " ").trim();
  if (words.length <= 40) return `"${words}"`;
  const cut = words.slice(0, 40);
  return `"${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : 40).replace(/[\s,;:.-]+$/, "")}…"`;
}

// The tour as steps, made one page at a time: what a page shows is only
// known once it is open.
async function* tourSteps(recorder, pages) {
  const host = new URL(pages[0].url).hostname.replace(/^www\./, "");
  for (let i = 0; i < pages.length; i++) {
    if (i === 0) yield { action: "visit", url: pages[0].url, label: `Open ${host}` };
    yield { action: "wait", seconds: i === 0 ? 1.6 : 1.1 };
    const cover = (await recorder.eval(TOP_COVER)) || 0;
    const stops = chooseStops((await recorder.eval(SECTIONS)) || { max: 0, tops: [] }, recorder.viewport.height, cover);
    for (const stop of stops) {
      yield { action: "scroll", to: stop.y, label: stop.heading ? `Scroll to ${quote(stop.heading)}` : "Scroll down" };
      yield { action: "wait", seconds: 1 };
    }
    const next = pages[i + 1];
    if (!next || timeLeft() < 150_000) {
      yield { action: "wait", seconds: stops.length ? 0.6 : 1.2 };
      return;
    }
    let link = await linkOnScreen(recorder, next.url);
    if (!link && stops.length && (await linkAtTop(recorder, next.url))) {
      yield { action: "scroll", to: "top", label: "Back to the top" };
      link = await linkOnScreen(recorder, next.url);
    }
    const path = new URL(next.url).pathname;
    if (link) yield { action: "click", target: { href: next.url }, label: link.text ? `Click ${quote(link.text)}` : `Open ${path}`, text: link.text, expect: next.url };
    else yield { action: "visit", url: next.url, label: `Open ${path}` };
  }
}

module.exports = { pickPages, tourSteps, chooseStops, SECTIONS };
