"use strict";

// The recording. The site opens in a headless window of its own, drawn at
// 1.5 pixels per CSS pixel (or more, for a deeper zoom) so a zoomed-in view
// stays sharp, and is used the way a person would use it: the pointer moves
// to what it clicks, text goes in a key at a time, the page scrolls. Chrome
// streams the window's screen meanwhile (Page.startScreencast), and every
// frame it sends is kept with the moment of the video it belongs to.
//
// Nothing is drawn into the page. The pointer, the zoom and the window
// around the page are added afterwards (compose.js) from what is written
// down here: where the pointer went and when, each click, key and scroll.
// So they move smoothly whatever rate the page itself was drawn at.
//
// Video time is not the clock's:
// - Loading a page is cut out. The recording pauses while a page opens and
//   is cleaned up, and the next part comes in with a short crossfade.
// - A scroll is drawn a frame at a time: the page is moved to exactly where
//   each frame of the video needs it and the frame showing it is kept, so
//   the scroll is even however slowly the machine draws.
// - A page that draws slowly is recorded in slow motion, its animations and
//   videos slowed to match, and played back at speed.

const fs = require("fs");
const path = require("path");
const { openTab, closeTab, navigate } = require("./chrome");
const { metrics, walk, waitForContent, settle, waitForFonts, resetPictureWait, waitForPictures } = require("./page");
const { clean } = require("./clean");
const { readInfo } = require("./shots");
const { ease, clamp, moveDuration, scrollDuration, curve, pointAt } = require("./motion");
const { lightnessOf } = require("./compose");
const { sleep } = require("./time");

// How long things take, in seconds of the video.
const FADE = 0.4; // crossfade into a page that was loaded off camera
const NAV_HOLD = 0.3; // the old page stays up after the click that leaves it
const DWELL = 0.12; // the pointer rests on its target before it presses
const AFTER = { click: 0.6, key: 0.5, type: 0.4, hover: 0.8 };
const LIVE_WAIT = 1.2; // waiting on camera for something to appear, at most
// A page is walked this many screens down before it is recorded, so lazy
// pictures and scroll-revealed parts are there when the demo gets to them.
const WALK_SCREENS = 6;

// ─── in the page ───────────────────────────────────────────────────────────
// Finds what a step points at: a CSS selector, the words on it, or a link to
// an address. Interactive elements win over plain text, then the first in
// the page's order. Returns its box on the screen, or null.
const LOCATE = `((spec) => {
  const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    return el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true;
  };
  const keyOf = (href) => {
    try { const u = new URL(href, location.href); return u.hostname.replace(/^www\\./, "").toLowerCase() + (u.pathname.replace(/\\/+$/, "").toLowerCase() || "/"); } catch (e) { return ""; }
  };
  let found = [];
  if (spec.css) {
    try { found = [...document.querySelectorAll(spec.css)].filter(shown); } catch (e) { return { error: "is not a CSS selector the browser can read" }; }
  } else if (spec.href) {
    const want = keyOf(spec.href);
    const links = [...document.querySelectorAll("a[href]")].filter((a) => keyOf(a.href) === want && shown(a));
    const top = (a) => (a.closest("header, nav, [role=banner], [role=navigation]") ? 0 : 1);
    found = links.sort((a, b) => top(a) - top(b));
  } else {
    const want = norm(spec.text);
    const label = (el) => norm(el.innerText || el.value || el.getAttribute("aria-label") || el.title || "");
    // The words alone first, then words that hold them; something to click
    // before plain text, and of plain text the innermost element.
    const active = [...document.querySelectorAll("a, button, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=switch], input[type=submit], input[type=button], summary, label, select, [onclick]")].filter(shown);
    const text = () => [...document.querySelectorAll("h1, h2, h3, h4, h5, h6, p, span, div, li, td, th, dt, dd, strong, em, b, small")].filter((el) => norm(el.innerText).includes(want) && shown(el));
    const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
    found = active.filter((el) => label(el) === want);
    if (!found.length) found = text().filter((el) => norm(el.innerText) === want).sort((a, b) => area(a) - area(b));
    if (!found.length) found = active.filter((el) => want && label(el).includes(want));
    if (!found.length && want) found = text().sort((a, b) => area(a) - area(b));
  }
  const el = found[0];
  if (!el) return null;
  window.__easyscreenshotTarget = el;
  const r = el.getBoundingClientRect();
  // The point to press: the middle, or another spot of the box when
  // something lies over the middle.
  let x = r.left + r.width / 2, y = r.top + r.height / 2, covered = true;
  for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7]]) {
    const px = r.left + r.width * fx, py = r.top + r.height * fy;
    const hit = document.elementFromPoint(px, py);
    if (hit && (hit === el || el.contains(hit) || hit.contains(el))) { x = px; y = py; covered = false; break; }
  }
  const link = el.closest("a");
  return { x, y, left: r.left, top: r.top, width: r.width, height: r.height, covered, text: label0(el), newTab: !!(link && /^_blank$/i.test(link.target)) };
  function label0(e) { return String(e.innerText || e.value || e.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 60); }
})`;

// The page's scroll: where it is, how far it goes, and whether the page
// itself scrolls or a box inside it does (an app's main pane).
const SCROLLER = `(() => {
  const doc = document.scrollingElement || document.documentElement;
  const max = Math.max(0, doc.scrollHeight - innerHeight);
  if (max > 4) { window.__easyscreenshotScroller = null; return { inner: false, y: scrollY, max }; }
  let best = null, area = 0;
  for (const el of document.querySelectorAll("body *")) {
    if (el.scrollHeight <= el.clientHeight + 4) continue;
    const s = getComputedStyle(el);
    if (!/(auto|scroll|overlay)/.test(s.overflowY)) continue;
    const r = el.getBoundingClientRect();
    const a = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    if (a > area) { area = a; best = el; }
  }
  window.__easyscreenshotScroller = best;
  if (!best || area < innerWidth * innerHeight * 0.25) return { inner: false, y: scrollY, max: 0 };
  return { inner: true, y: best.scrollTop, max: best.scrollHeight - best.clientHeight };
})()`;

// A glide: the page moves itself to the next position on each animation
// frame (every skip-th one), and notes where it really went and when.
const GLIDE = `((positions, inner, skip) => new Promise((done) => {
  const el = inner ? window.__easyscreenshotScroller : null;
  const out = [];
  let i = 0;
  let n = 0;
  const tick = () => {
    if (n++ % skip === 0) {
      if (i >= positions.length) return done(out);
      if (el) el.scrollTop = positions[i];
      else window.scrollTo({ top: positions[i], left: 0, behavior: "instant" });
      out.push([el ? el.scrollTop : scrollY, Date.now()]);
      i++;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}))`;

// What a fixed or sticky bar at the top of the screen covers: a scroll to
// an element stops below it.
const TOP_COVER = `(() => {
  let bottom = 0;
  for (const x of [0.25, 0.5, 0.75]) {
    for (let el = document.elementFromPoint(innerWidth * x, 4); el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const s = getComputedStyle(el);
      if (s.position === "fixed" || s.position === "sticky") {
        const r = el.getBoundingClientRect();
        if (r.top <= 4 && r.height < innerHeight * 0.4) bottom = Math.max(bottom, r.bottom);
        break;
      }
    }
  }
  return Math.round(bottom);
})()`;

// A box that floats up later (a newsletter offer after a few seconds, a
// chat bubble that loads late) is hidden the way the first clean-up hid the
// others: anything new fixed to the screen that is not the page's own top
// bar or side bar. What the demo opened on purpose stays: whatever comes up
// within a few seconds of a click or a key (a menu, a dialog), and what
// comes up next to the pointer as it moves (a tooltip, a hover card).
const WATCH_FLOATING = `(function (keepMs) {
  if (window.__easyscreenshotFloating) return;
  let input = -1e9, moved = -1e9, px = -1e9, py = -1e9;
  addEventListener("pointerdown", () => { input = performance.now(); }, true);
  addEventListener("keydown", () => { input = performance.now(); }, true);
  addEventListener("pointermove", (e) => { moved = performance.now(); px = e.clientX; py = e.clientY; }, true);
  const nearPointer = (r) => performance.now() - moved < keepMs && px >= r.left - 240 && px <= r.right + 240 && py >= r.top - 240 && py <= r.bottom + 240;
  const chromeOf = (r) => {
    const topBar = r.top <= 20 && r.height <= innerHeight * 0.3;
    const sideBar = r.height >= innerHeight * 0.5 && r.width <= innerWidth * 0.35 && (r.left <= 2 || r.right >= innerWidth - 2);
    return topBar || sideBar;
  };
  // A fixed box of no size is measured by what it holds, as the first
  // clean-up does: a site's header can sit in one.
  const boxOf = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width >= 1 && r.height >= 1) return r;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const child of Array.prototype.slice.call(el.querySelectorAll("*"), 0, 200)) {
      const c = child.getBoundingClientRect();
      if (c.width < 1 || c.height < 1) continue;
      left = Math.min(left, c.left); top = Math.min(top, c.top); right = Math.max(right, c.right); bottom = Math.max(bottom, c.bottom);
    }
    return right > left ? { left, top, right, bottom, width: right - left, height: bottom - top } : null;
  };
  const check = (el) => {
    if (!(el instanceof Element) || el === document.body || el === document.documentElement) return;
    const s = getComputedStyle(el);
    if (s.position !== "fixed" || s.display === "none" || parseInt(s.zIndex, 10) < 0) return;
    const r = boxOf(el);
    if (!r || chromeOf(r) || nearPointer(r)) return;
    el.style.setProperty("display", "none", "important");
  };
  const seen = new Set();
  let queued = false;
  const observer = new MutationObserver((records) => {
    if (performance.now() - input < keepMs) return;
    for (const record of records) {
      if (record.type === "childList") record.addedNodes.forEach((node) => node.nodeType === 1 && seen.add(node));
      else seen.add(record.target);
    }
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      for (const el of seen) {
        check(el);
        if (el.querySelectorAll) Array.prototype.slice.call(el.querySelectorAll("*"), 0, 300).forEach(check);
      }
      seen.clear();
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open"] });
  window.__easyscreenshotFloating = observer;
})`;

// Scroll snapping and smooth scrolling would fight the frame-by-frame scroll.
const STEADY = `(() => {
  const style = document.getElementById("easyscreenshot-steady") || document.createElement("style");
  style.id = "easyscreenshot-steady";
  style.textContent = "html,body{scroll-snap-type:none!important;scroll-behavior:auto!important}";
  (document.head || document.documentElement).appendChild(style);
})()`;

const KEY_CODES = {
  Enter: [13, "Enter", "\r"], Tab: [9, "Tab"], Escape: [27, "Escape"], Backspace: [8, "Backspace"], Delete: [46, "Delete"], Space: [32, "Space", " "],
  ArrowUp: [38, "ArrowUp"], ArrowDown: [40, "ArrowDown"], ArrowLeft: [37, "ArrowLeft"], ArrowRight: [39, "ArrowRight"],
  Home: [36, "Home"], End: [35, "End"], PageUp: [33, "PageUp"], PageDown: [34, "PageDown"],
  Control: [17, "ControlLeft"], Alt: [18, "AltLeft"], Shift: [16, "ShiftLeft"], Meta: [91, "MetaLeft"],
};
const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const KEY_LABELS = { Meta: "⌘", Control: "Ctrl", Alt: "⌥", Shift: "⇧", Enter: "Enter", Escape: "Esc", Backspace: "⌫", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Space: "Space" };

function keyEvent(key) {
  const known = KEY_CODES[key] || (/^F([1-9]|1[0-2])$/.test(key) ? [111 + Number(key.slice(1)), key] : null);
  if (known) return { key: key === "Space" ? " " : key, code: known[1], windowsVirtualKeyCode: known[0], text: known[2] };
  const upper = key.toUpperCase();
  const code = /^[A-Z]$/.test(upper) ? `Key${upper}` : /^[0-9]$/.test(key) ? `Digit${key}` : "";
  return { key, code, windowsVirtualKeyCode: /^[A-Z0-9]$/.test(upper) ? upper.charCodeAt(0) : 0, text: key };
}

const describe = (target) => (target.text !== undefined ? `text=${target.text}` : target.href ? `the link to ${target.href}` : target.css);

class Recorder {
  // chrome: a browser launched with the pixel density wanted; dir: where the
  // frames go; viewport: the page's screen in CSS px.
  constructor(chrome, { dir, base, fps = 30, viewport = { width: 1600, height: 900 }, hide = [], clean: tidy = true, theme = "light", lang = "", reducedMotion = false, log = () => {} }) {
    Object.assign(this, { chrome, dir, base, fps, viewport, hide, tidy, theme, lang, reducedMotion, log });
    this.v = 0;
    this.live = null;
    this.windows = [];
    this.frames = [];
    this.count = 0;
    this.writes = [];
    this.pending = null;
    this.waiters = [];
    this.factor = 1;
    this.stepMs = 0;
    this.navAt = 0;
    this.quiet = false;
    this.url = "";
    this.cursor = { x: viewport.width * 0.64, y: viewport.height * 0.76 };
    this.take = { start: { ...this.cursor }, shownAt: null, moves: [], clicks: [], typing: [], keys: [], scrolls: [], cuts: [], urls: [] };
    this.pages = [];
  }

  async open() {
    this.tab = await openTab(this.chrome, { width: this.viewport.width, height: this.viewport.height, scale: 0, mobile: false, touch: false, agent: "desktop" }, { lang: this.lang, theme: this.theme, reducedMotion: this.reducedMotion });
    const tab = this.tab;
    const { frameTree } = await tab.send("Page.getFrameTree");
    this.frameId = frameTree.frame.id;
    tab.on("Page.screencastFrame", (p) => this.onFrame(p));
    // A navigation the page asks for (a link, a form, a script), which may
    // or may not load a new document: the page itself changing its address
    // (the history API, a #hash) starts "loading" too, on some sites at
    // every frame of a scroll, so only a new document committing counts.
    tab.on("Page.frameRequestedNavigation", (p) => {
      if (p.frameId !== this.frameId || (p.disposition && p.disposition !== "currentTab") || this.quiet || this.navAt) return;
      this.navAt = Date.now();
      this.navUrl = p.url;
    });
    tab.on("Page.frameNavigated", (p) => {
      if (p.frame && !p.frame.parentId && p.type !== "BackForwardCacheRestore") this.committedAt = Date.now();
    });
    tab.on("Page.loadEventFired", () => (this.loadedAt = Date.now()));
    // An app that changes its address without loading a page (its own
    // router): the title bar follows. A new #hash alone is the same page.
    tab.on("Page.navigatedWithinDocument", (p) => {
      if (p.frameId !== this.frameId) return;
      this.sameAt = Date.now();
      this.sameUrl = p.url;
      const same = p.url.split("#")[0] === String(this.url).split("#")[0];
      this.url = p.url;
      if (!same) this.take.urls.push({ t: this.now(), url: p.url });
    });
    await tab.send("Page.startScreencast", { format: "jpeg", quality: 90 });
  }

  async close() {
    if (this.tab) {
      await this.tab.send("Page.stopScreencast", {}, 3_000).catch(() => {});
      await closeTab(this.chrome, this.tab);
      this.tab = null;
    }
  }

  // ─── time ────────────────────────────────────────────────────────────────
  now() {
    return this.live ? this.live.startV + (Date.now() - this.live.startReal) / 1000 / this.live.factor : this.v;
  }

  // Real milliseconds for seconds of video, at the pace being recorded.
  real(seconds) {
    return seconds * 1000 * (this.live ? this.live.factor : 1);
  }

  // Waits for seconds of video, or until a navigation starts.
  async hold(seconds) {
    const until = Date.now() + this.real(seconds);
    while (Date.now() < until && !this.navAt) await sleep(Math.min(40, until - Date.now()));
  }

  // ─── frames ──────────────────────────────────────────────────────────────
  onFrame(p) {
    this.tab.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
    const frame = { ts: p.metadata.timestamp * 1000, y: p.metadata.scrollOffsetY || 0, data: p.data };
    if (this.tap) return void this.tap.push(frame);
    const waiter = this.waiters.find((w) => w.accepts(frame));
    if (waiter) {
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
    for (let i = this.windows.length - 1; i >= 0; i--) {
      const win = this.windows[i];
      if (frame.ts >= win.startReal && frame.ts <= win.endReal) return void this.keep(frame, win.startV + (frame.ts - win.startReal) / 1000 / win.factor);
    }
    if (!this.pending || frame.ts >= this.pending.ts) this.pending = frame;
  }

  // The first frame that passes test, or null after ms.
  nextFrame(accepts, ms) {
    return new Promise((resolve) => {
      const waiter = { accepts, resolve };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        resolve(null);
      }, ms);
      this.waiters.push(waiter);
    });
  }

  // A frame of the video, written to the frames folder. A full disk is
  // told when the step ends, not left to fail the encoding later.
  keep(frame, v, cut = false) {
    const file = path.join(this.dir, `f${String(++this.count).padStart(6, "0")}.jpg`);
    this.writes.push(
      fs.promises.writeFile(file, Buffer.from(frame.data, "base64")).catch((err) => {
        const full = err.code === "ENOSPC" || err.code === "EDQUOT" || err.errno === -122;
        this.writeError = this.writeError || `Could not save the frames in ${this.dir}: ${full ? "the disk, or your disk quota, is full" : err.message}`;
      }),
    );
    this.frames.push({ v, file, cut });
    this.lastFile = file;
  }

  // The screen as it is now: the stream is restarted, which sends a frame
  // even when nothing moves.
  async fresh() {
    const asked = Date.now();
    const got = this.nextFrame((frame) => frame.ts >= asked - 50, 2_000);
    await this.tab.send("Page.stopScreencast").catch(() => {});
    await this.tab.send("Page.startScreencast", { format: "jpeg", quality: 90 });
    const frame = await got;
    if (frame) this.pending = frame;
  }

  // Slow motion: the page's animations, transitions and videos run at
  // 1/factor of their speed while it is recorded at that pace.
  async pace(rate) {
    await this.tab.send("Animation.setPlaybackRate", { playbackRate: rate }).catch(() => {});
    await this.eval(`document.querySelectorAll("video, audio").forEach((m) => { m.playbackRate = ${rate}; })`);
  }

  async startLive({ fade = 0 } = {}) {
    await this.pace(1 / this.factor);
    if (fade) this.take.cuts.push({ t: this.v, fade });
    if (this.pending) {
      this.keep(this.pending, this.v, fade > 0);
      this.pending = null;
    }
    const win = { startReal: Date.now(), endReal: Infinity, startV: this.v, factor: this.factor };
    this.windows.push(win);
    this.live = win;
  }

  stopLive(at = Date.now()) {
    const win = this.live;
    if (!win) return;
    win.endReal = Math.max(win.startReal, at);
    this.v = win.startV + (win.endReal - win.startReal) / 1000 / win.factor;
    this.live = null;
  }

  // ─── the page ────────────────────────────────────────────────────────────
  async eval(expression, timeout = 10_000) {
    const { result, exceptionDetails } = await this.tab.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeout).catch(() => ({ result: {} }));
    if (exceptionDetails) return undefined;
    return result ? result.value : undefined;
  }

  // Gets a page that just loaded ready to be recorded, off camera: waits for
  // it to show its content, walks it so lazy parts load, hides what floats
  // over it, and measures how fast it draws.
  async ready(depth = 0) {
    const tab = this.tab;
    const began = Date.now();
    const loaded = await waitForContent(tab, 20_000);
    await settle(tab, 6_000);
    const info = await readInfo(tab);
    const status = Number(await this.eval("(performance.getEntriesByType('navigation')[0] || {}).responseStatus || 0")) || 0;
    const { currentIndex, entries } = await tab.send("Page.getNavigationHistory");
    const url = (entries[currentIndex] || {}).url || this.url;
    if (/^chrome-error:/.test(String(await this.eval("location.href")))) throw new Error(`${url} could not be opened.`);
    if (info.challenge) throw new Error(`${url} answered with a bot check ("${info.title || "a challenge page"}") instead of its page, so it cannot be recorded. Open the site in a normal browser to check it.`);
    if (status >= 400) throw new Error(`${url} answered ${status}.`);
    const m = await metrics(tab);
    await walk(tab, Math.min(m.height, this.viewport.height * WALK_SCREENS));
    let hidden = 0;
    if (this.tidy) {
      hidden = (await clean(tab, { hide: this.hide, viewport: this.viewport })).hidden;
      await this.eval(`${WATCH_FLOATING}(4000)`);
    }
    await this.eval(STEADY);
    await waitForFonts(tab);
    await this.eval(`window.scrollTo({ top: 0, left: 0, behavior: "instant" })`);
    await this.pointer(this.take.shownAt === null ? { x: this.viewport.width - 2, y: this.viewport.height - 2 } : this.cursor);
    resetPictureWait(tab);
    await waitForPictures(tab, { x: 0, y: 0, width: this.viewport.width, height: this.viewport.height });
    // A page that sent itself on to another one meanwhile (a script's
    // redirect): the other one is made ready instead.
    if (this.navAt >= began && depth < 2) {
      const at = this.navAt;
      while (Date.now() - began < 40_000 && !(this.committedAt >= at)) await sleep(30);
      if (this.committedAt >= at) {
        while (Date.now() - began < 45_000 && !(this.loadedAt > at)) await sleep(50);
        this.navAt = 0;
        return this.ready(depth + 1);
      }
    }
    // The first page sets the backdrop: dark behind a light site.
    if (this.lightness === undefined) this.lightness = await lightnessOf(tab, this.viewport);
    await this.measure();
    this.navAt = 0;
    this.url = url;
    const page = { url, title: info.title, heading: info.heading, siteName: info.siteName, description: info.description, loaded, hidden };
    this.pages.push(page);
    return page;
  }

  // How long one frame takes this page, from a glide of a few pixels.
  // Slower than about 18 frames a second, it is recorded in slow motion.
  async measure() {
    this.factor = 1;
    this.skip = 1;
    const state = await this.eval(SCROLLER);
    if (!state || state.inner || state.max < 16) return;
    const { ms } = await this.glide([2, 4, 6, 8, 10, 12, 6, 0], state);
    this.pending = null;
    this.stepMs = ms;
    this.factor = ms > 55 ? 2 : 1;
    if (this.factor > 1) this.slow = true;
  }

  // Puts the real mouse where the pointer is drawn.
  async pointer(at) {
    await this.tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y }, 3_000).catch(() => {});
  }

  // ─── steps ───────────────────────────────────────────────────────────────
  // Opens an address off camera and starts the part that shows it.
  async visit(url, { fade = true } = {}) {
    const first = this.windows.length === 0;
    this.stopLive();
    await this.pace(1);
    this.quiet = true;
    let nav;
    try {
      nav = await navigate(this.tab, url);
    } finally {
      this.quiet = false;
    }
    if (nav.status >= 400) throw new Error(`${nav.url} answered ${nav.status}.`);
    const page = await this.ready();
    await this.fresh();
    this.take.urls.push({ t: this.v, url: this.url });
    await this.startLive({ fade: fade && !first ? FADE : 0 });
    return page;
  }

  // A navigation the last action started. When it loads a new document,
  // the page as it was when the click landed stays up a moment so the click
  // is seen, the next page loads off camera and comes in with a crossfade.
  // One that stays in the document, or leads nowhere (a download, a
  // cancelled request), is let go and the recording goes on.
  async follow() {
    const at = this.navAt;
    if (!at) return null;
    // Nothing after the request is kept until it is known what it was.
    const live = Boolean(this.live);
    if (live) this.stopLive(at);
    const started = Date.now();
    const inDocument = () => this.sameAt >= at && String(this.sameUrl).split("#")[0] === String(this.navUrl).split("#")[0];
    while (Date.now() - started < 15_000 && !(this.committedAt >= at) && !inDocument()) await sleep(30);
    if (!(this.committedAt >= at)) {
      this.navAt = 0;
      if (live) {
        await this.fresh();
        await this.startLive({ fade: 0.15 });
      }
      return null;
    }
    if (live) this.v += NAV_HOLD;
    await this.pace(1);
    while (Date.now() - started < 20_000 && !(this.loadedAt > at)) await sleep(50);
    // Free to note a redirect the new page makes while it is made ready.
    this.navAt = 0;
    const page = await this.ready();
    await this.fresh();
    this.take.urls.push({ t: this.v, url: this.url });
    await this.startLive({ fade: FADE });
    return page;
  }

  // Where the page is scrolled and how far it goes.
  async scrollState() {
    return (await this.eval(SCROLLER)) || { inner: false, y: 0, max: 0 };
  }

  // Moves the page through positions (CSS px from the top), one each time
  // it draws a frame: the page does it itself on every animation frame, so
  // the browser draws each position once, in order, as fast as it can, and
  // the stream sends each drawing. Every frame sent meanwhile is kept aside
  // and matched to the position it shows (a frame of the page's own scroll
  // says where it was drawn; one of a box scrolling inside it is matched by
  // its time). Returns a frame or null for each position, how long each
  // took, and where the page really went.
  async glide(positions, state) {
    const caught = [];
    this.tap = caught;
    const started = Date.now();
    let applied;
    try {
      applied = await this.eval(`${GLIDE}(${JSON.stringify(positions.map((y) => Math.round(y * 100) / 100))}, ${state.inner}, ${this.skip || 1})`, Math.max(30_000, positions.length * 1_500));
      // The last drawings are still on their way.
      await sleep(120);
    } finally {
      this.tap = null;
    }
    const ms = (Date.now() - started) / Math.max(1, positions.length);
    if (!Array.isArray(applied)) return { frames: positions.map(() => null), ms, applied: [] };
    const frames = [];
    let from = 0;
    for (let i = 0; i < applied.length; i++) {
      const [y, at] = applied[i];
      const next = i + 1 < applied.length ? applied[i + 1][1] : Infinity;
      let match = -1;
      for (let j = from; j < caught.length; j++) {
        const f = caught[j];
        if (f.ts + 5 < at) continue;
        if (state.inner ? f.ts < next + 5 : Math.abs(f.y - y) < 0.75) {
          match = j;
          break;
        }
      }
      frames.push(match >= 0 ? caught[match] : null);
      if (match >= 0) from = match + 1;
    }
    // Drawings the stream could not keep up with: a page that draws faster
    // than it can send is moved every second or third frame instead.
    const shown = frames.filter(Boolean).length / Math.max(1, frames.length);
    if (shown < 0.85 && positions.length > 8) this.skip = Math.min(3, (this.skip || 1) + 1);
    return { frames, ms, applied };
  }

  // A smooth scroll to y (CSS px from the top), a frame of the video at a
  // time. Recorded live with the wheel when the page moves its content
  // some other way.
  async scrollTo(y, duration) {
    const state = await this.scrollState();
    if (state.max <= 0) return this.wheel(y, duration);
    const from = state.y;
    const to = clamp(Math.round(y), 0, state.max);
    if (Math.abs(to - from) < 2) return;
    const seconds = duration || scrollDuration(to - from);
    const n = Math.max(2, Math.round(seconds * this.fps));
    const positions = Array.from({ length: n }, (_, i) => from + (to - from) * ease((i + 1) / n));
    const t0 = this.now();
    this.stopLive();
    // Animations keep their speed relative to the video.
    if (this.stepMs) await this.pace(clamp(1000 / this.fps / this.stepMs, 0.1, 1));
    const { frames, ms, applied } = await this.glide(positions, state);
    this.pending = null;
    // A page that will not move this way (its own scrolling script holds
    // it) is scrolled with the wheel instead.
    const moved = applied.length && Math.abs(applied[applied.length - 1][0] - from) >= 1;
    if (!moved) {
      await this.eval(`window.scrollTo({ top: ${from}, left: 0, behavior: "instant" })`);
      await this.startLive();
      return this.wheel(y, duration);
    }
    frames.forEach((frame, i) => {
      if (frame) this.keep(frame, t0 + (i + 1) / this.fps);
      else if (this.lastFile) this.frames.push({ v: t0 + (i + 1) / this.fps, file: this.lastFile, cut: false });
    });
    this.stepMs = ms;
    this.v = t0 + n / this.fps;
    this.take.scrolls.push({ t0, t1: this.v });
    await this.startLive();
  }

  // The wheel, for pages that scroll their content by their own means.
  async wheel(y, duration) {
    const m = await metrics(this.tab);
    const distance = y - m.scrollY;
    const seconds = duration || scrollDuration(distance);
    const t0 = this.now();
    const steps = Math.max(4, Math.round(seconds * 30));
    let done = 0;
    const started = Date.now();
    for (let i = 1; i <= steps; i++) {
      const delta = distance * ease(i / steps) - done;
      done += delta;
      await this.tab.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: this.cursor.x, y: this.cursor.y, deltaX: 0, deltaY: delta });
      const wait = started + (i / steps) * this.real(seconds) - Date.now();
      if (wait > 0) await sleep(wait);
    }
    this.take.scrolls.push({ t0, t1: this.now() });
  }

  // Finds what a step points at, waiting on camera a moment and off camera
  // after that, up to timeout seconds. Scrolls it into view when it is not.
  async locate(target, { timeout = 8, scroll = true } = {}) {
    const spec = JSON.stringify(target);
    let found = await this.eval(`${LOCATE}(${spec})`);
    if (found && found.error) throw new Error(`${describe(target)} ${found.error}`);
    if (!found) {
      const started = Date.now();
      const limit = timeout * 1000 * (this.live ? this.live.factor : 1);
      let shown = Date.now();
      let away = false;
      while (!found && Date.now() - started < limit) {
        // A page that goes on to another one meanwhile (a click whose
        // script navigates late): that one comes in as any other.
        if (this.navAt && (await this.follow()) && this.live) {
          away = false;
          shown = Date.now();
        }
        if (!away && this.live && Date.now() - shown > this.real(LIVE_WAIT)) {
          this.stopLive();
          away = true;
        }
        await sleep(150);
        found = await this.eval(`${LOCATE}(${spec})`);
      }
      if (away) {
        await this.fresh();
        await this.startLive({ fade: 0.25 });
      }
      if (!found) return null;
    }
    if (!scroll) return found;
    // On the screen and not under anything (a sticky header over it is
    // caught by the hit test): no need to scroll. A link in that header is
    // on the screen wherever the page is.
    const fits = !found.covered && found.top >= 0 && found.top + found.height <= this.viewport.height - 8;
    if (!fits) {
      const cover = (await this.eval(TOP_COVER)) || 0;
      const state = await this.scrollState();
      const want = state.y + found.top - Math.max(cover + 24, this.viewport.height * 0.3 - found.height / 2);
      await this.scrollTo(want);
      found = (await this.eval(`${LOCATE}(${spec})`)) || found;
    }
    return found;
  }

  // The pointer goes to (x, y), the real mouse along the same path.
  async move(to) {
    const from = { ...this.cursor };
    if (this.take.shownAt === null) {
      // The pointer comes in from a little way off the first thing it does.
      const start = Math.hypot(to.x - from.x, to.y - from.y) < 220 ? { x: this.viewport.width * 0.36, y: this.viewport.height * 0.8 } : from;
      Object.assign(from, start);
      this.take.start = { ...from };
      this.take.shownAt = this.now();
      await this.pointer(from);
    }
    const seconds = moveDuration(from, to);
    const path = curve(from, to);
    const t0 = this.now();
    const move = { t0, t1: t0 + seconds, path };
    this.take.moves.push(move);
    const started = Date.now();
    const total = this.real(seconds);
    const steps = Math.max(3, Math.round(seconds * 40));
    for (let i = 1; i <= steps; i++) {
      const wait = started + (i / steps) * total - Date.now();
      if (wait > 0) await sleep(wait);
      await this.pointer(pointAt(path, ease(i / steps)));
    }
    this.cursor = { x: to.x, y: to.y };
    return move;
  }

  async press(at) {
    const event = { x: at.x, y: at.y, button: "left", clickCount: 1 };
    await this.tab.send("Input.dispatchMouseEvent", { type: "mousePressed", ...event });
    await sleep(Math.min(120, this.real(0.06)));
    await this.tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...event });
  }

  async click(step) {
    const found = await this.locate(step.target);
    if (!found) throw new Error(`nothing on the page matches ${describe(step.target)}`);
    // Kept in this window: a demo in a second tab would not be recorded.
    if (found.newTab) await this.eval(`(() => { const a = window.__easyscreenshotTarget && window.__easyscreenshotTarget.closest("a"); if (a) a.target = "_self"; })()`);
    const point = { x: found.x, y: found.y };
    const move = await this.move(point);
    await this.hold(DWELL);
    const t = this.now();
    this.take.clicks.push({ t, x: point.x, y: point.y, from: move.t0, move, zoom: step.zoom });
    await this.press(point);
    await this.hold(step.pause !== undefined ? step.pause : AFTER.click);
    return { at: point, pressed: t, text: found.text };
  }

  async hover(step) {
    const found = await this.locate(step.target);
    if (!found) throw new Error(`nothing on the page matches ${describe(step.target)}`);
    const point = { x: found.x, y: found.y };
    const move = await this.move(point);
    if (step.zoom > 1) this.take.typing.push({ t0: move.t0, t1: this.now() + AFTER.hover, x: point.x, y: point.y, zoom: step.zoom });
    await this.hold(step.pause !== undefined ? step.pause : AFTER.hover);
    return { at: point, text: found.text };
  }

  async type(step) {
    let field;
    let pressed;
    if (step.into) {
      const clicked = await this.click({ target: step.into, zoom: step.zoom, pause: 0.15 });
      field = clicked.at;
      pressed = clicked.pressed;
    } else {
      const box = await this.eval(`(() => { const el = document.activeElement; if (!el || el === document.body) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      field = box || this.cursor;
    }
    const t0 = this.now();
    let i = 0;
    for (const ch of step.text) {
      if (this.navAt) break;
      if (ch === "\n") await this.keys("Enter", false);
      else {
        await this.tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
        await this.tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
      }
      // A person types unevenly: a little slower after a space.
      const gap = 0.055 + ((i * 37) % 11) / 200 + (ch === " " ? 0.05 : 0);
      i++;
      await this.hold(gap);
    }
    this.take.typing.push({ t0, t1: this.now(), x: field.x, y: field.y, zoom: step.zoom });
    await this.hold(step.pause !== undefined ? step.pause : AFTER.type);
    return { at: field, pressed };
  }

  // Presses a key or a combination such as Meta+K, shown in the video.
  async keys(combo, show = true) {
    const parts = combo.split("+").filter((part, i, all) => part || i === all.length - 1);
    const key = parts.pop() || "+";
    let modifiers = 0;
    for (const mod of parts) {
      modifiers |= MODIFIER_BITS[mod];
      const event = keyEvent(mod);
      await this.tab.send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers, key: event.key, code: event.code, windowsVirtualKeyCode: event.windowsVirtualKeyCode });
    }
    const event = keyEvent(key);
    const typed = modifiers & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta | MODIFIER_BITS.Alt) ? {} : event.text ? { text: event.text, unmodifiedText: event.text } : {};
    if (show) this.take.keys.push({ t: this.now(), label: [...parts, key].map((part) => KEY_LABELS[part] || (part.length === 1 ? part.toUpperCase() : part)).join(" ") });
    await this.tab.send("Input.dispatchKeyEvent", { type: typed.text ? "keyDown" : "rawKeyDown", modifiers, key: event.key, code: event.code, windowsVirtualKeyCode: event.windowsVirtualKeyCode, ...typed });
    await this.tab.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key: event.key, code: event.code, windowsVirtualKeyCode: event.windowsVirtualKeyCode });
    for (const mod of parts.reverse()) {
      modifiers &= ~MODIFIER_BITS[mod];
      const up = keyEvent(mod);
      await this.tab.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key: up.key, code: up.code, windowsVirtualKeyCode: up.windowsVirtualKeyCode });
    }
  }

  async waitFor(step) {
    const found = await this.locate(step.for, { timeout: step.timeout, scroll: false });
    if (!found) throw new Error(`${describe(step.for)} did not show up within ${step.timeout} s`);
    return { text: found.text };
  }

  // An app that swapped its content in place after a click (a new address,
  // no new page): it is given a moment on camera to draw it, then the rest
  // off camera. Nothing is cleaned up here: the clean-up's rules for the
  // known tools and the watch for late boxes are still on, and what the
  // click opened (a dialog on a route of its own) is meant to be seen.
  async redrawn() {
    const started = Date.now();
    let away = false;
    for (let waited = 0, last = "", same = 0; waited < 6_000 && same < 3; waited += 250) {
      const now = String(await this.eval("document.getElementsByTagName('*').length + ':' + document.documentElement.scrollHeight"));
      same = now === last ? same + 1 : 0;
      last = now;
      if (!away && Date.now() - started > this.real(LIVE_WAIT)) {
        this.stopLive();
        away = true;
      }
      await sleep(250);
    }
    if (away) {
      await this.fresh();
      await this.startLive({ fade: 0.25 });
    }
  }

  // Runs one step; returns what happened, with its start and end in the
  // video.
  async run(step) {
    if (this.writeError) throw new Error(this.writeError);
    if (this.navAt) await this.follow();
    const start = this.now();
    const record = { start };
    const before = this.url;
    if (step.action === "visit") {
      const url = new URL(step.url, this.url || this.base).href;
      const page = await this.visit(url);
      Object.assign(record, { start: this.v, title: page.title });
    } else if (step.action === "scroll") {
      const state = await this.scrollState();
      let y;
      if (step.by !== undefined) y = state.y + step.by;
      else if (step.to === "top") y = 0;
      else if (step.to === "bottom") y = state.max;
      else if (typeof step.to === "number") y = step.to;
      else {
        const found = await this.locate(step.to, { scroll: false });
        if (!found) throw new Error(`nothing on the page matches ${describe(step.to)}`);
        const cover = (await this.eval(TOP_COVER)) || 0;
        y = state.y + found.top - cover - 24;
      }
      record.start = this.now();
      await this.scrollTo(y, step.duration);
    } else if (step.action === "click") {
      Object.assign(record, await this.click(step));
    } else if (step.action === "hover") {
      Object.assign(record, await this.hover(step));
    } else if (step.action === "type") {
      Object.assign(record, await this.type(step));
    } else if (step.action === "key") {
      await this.keys(step.key);
      await this.hold(step.pause !== undefined ? step.pause : AFTER.key);
    } else if (step.action === "wait") {
      if (step.for) Object.assign(record, await this.waitFor(step));
      else await this.hold(step.seconds);
    }
    if (step.pause !== undefined && ["visit", "scroll", "wait"].includes(step.action)) await this.hold(step.pause);
    record.end = this.now();
    record.url = this.url;
    // A click or a key that opened another page: it comes in now, and the
    // step ends where the old page left.
    if (this.navAt) {
      const live = this.live;
      const at = this.navAt;
      const left = live && at >= live.startReal ? live.startV + (at - live.startReal) / 1000 / live.factor + NAV_HOLD : record.end;
      const page = await this.follow();
      if (page) Object.assign(record, { end: Math.max(record.start, left), opened: page.url });
    }
    if (!record.opened && this.url.split("#")[0] !== before.split("#")[0] && ["click", "key", "type"].includes(step.action)) {
      await this.redrawn();
      Object.assign(record, { end: this.now(), opened: this.url });
    }
    return record;
  }

  // The recording, for compose.js.
  async finish() {
    this.stopLive();
    await this.tab.send("Page.stopScreencast", {}, 3_000).catch(() => {});
    await Promise.all(this.writes);
    if (this.writeError) throw new Error(this.writeError);
    this.frames.sort((a, b) => a.v - b.v);
    return { fps: this.fps, viewport: this.viewport, duration: this.v, frames: this.frames, pages: this.pages, lightness: this.lightness, slow: this.slow || false, ...this.take };
  }
}

module.exports = { Recorder, keyEvent, LOCATE, SCROLLER, TOP_COVER, FADE, NAV_HOLD };
