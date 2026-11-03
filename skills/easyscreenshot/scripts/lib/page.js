"use strict";

// Reading a page as the browser draws it: its size, a walk from top to
// bottom so lazy and scroll-revealed parts render, and screenshots that wait
// for their pictures. The walk, the waits and the capture come from
// easybrandkit 0.2.1; a whole page is taken a screen at a time and joined.

const { timeLeft, sleep } = require("./time");
const { joinScreens } = require("./png");

const STEP_PAUSE_MS = 350;

async function metrics(cdp) {
  const m = await cdp.send("Page.getLayoutMetrics");
  const viewport = m.cssLayoutViewport || m.layoutViewport || {};
  const visual = m.cssVisualViewport || m.visualViewport || {};
  const content = m.cssContentSize || m.contentSize || {};
  return {
    width: Math.max(1, Math.floor(viewport.clientWidth || 0)),
    viewportHeight: Math.max(1, Math.floor(viewport.clientHeight || 0)),
    scrollY: Math.max(0, Math.floor(visual.pageY || 0)),
    height: Math.max(1, Math.ceil(content.height || 0)),
    // What the screen shows, in CSS pixels: wider than the device when a
    // phone page is zoomed out to fit content wider than the screen.
    visualWidth: visual.clientWidth || viewport.clientWidth || 1,
    visualHeight: visual.clientHeight || viewport.clientHeight || 1,
  };
}

function wheel(cdp, x, y, deltaY) {
  return cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
}

function scrollTo(cdp, top) {
  return cdp.send("Runtime.evaluate", { expression: `window.scrollTo({ top: ${Math.round(top)}, left: 0, behavior: "instant" })` }).catch(() => {});
}

// Wheel down a screen at a time until the bottom, re-reading the height so
// lazily loaded content extends the walk. If the page does not move (the
// pointer sits on an inner scroller), retry once from the left edge. A walk
// for a capture that keeps only the page's top goes no further than that.
// Then back to the top in one turn of the wheel. The walk only has to bring
// lazy parts in and let boxes that come up on scrolling come up: a whole
// page is taken screen by screen afterwards, and each screen waits for its
// own pictures.
const WALK_PAUSE_MS = 250;

async function walk(cdp, until = Infinity) {
  let m = await metrics(cdp);
  const step = Math.max(200, m.viewportHeight);
  const midY = Math.floor(m.viewportHeight / 2);
  for (let i = 0; i < 80 && timeLeft() > 20_000; i++) {
    if (m.scrollY + m.viewportHeight >= Math.min(m.height, until) - 2) break;
    const before = m.scrollY;
    await wheel(cdp, Math.floor(m.width / 2), midY, step);
    await sleep(WALK_PAUSE_MS);
    m = await metrics(cdp);
    if (m.scrollY === before) {
      await wheel(cdp, 8, midY, step);
      await sleep(STEP_PAUSE_MS);
      m = await metrics(cdp);
      if (m.scrollY === before) break;
    }
  }
  await sleep(800);
  await wheel(cdp, 8, midY, -(m.height + m.viewportHeight));
  await sleep(600);
  // A page that snaps or eases its scrolling may not be at the very top yet.
  await scrollTo(cdp, 0);
}

// A single-page app can show a bare loading screen for a long time (25 s on
// one site, in a fresh browser). Wait, up to 30 s, until the page is taller
// than the screen or has a link or an image. True once the page shows
// content; false when it is still a bare loader.
async function waitForContent(cdp, limitMs = 30_000) {
  for (let waited = 0; waited < limitMs && timeLeft() > 50_000; waited += 1_000) {
    const m = await metrics(cdp);
    if (m.height > m.viewportHeight + 50) return true;
    const snap = await cdp.send("DOMSnapshot.captureSnapshot", { computedStyles: [] });
    const names = (((snap.documents || [])[0] || {}).nodes || {}).nodeName || [];
    if (names.some((i) => snap.strings[i] === "A" || snap.strings[i] === "IMG")) return true;
    await sleep(1_000);
  }
  return false;
}

// A single-page app goes on building its screen after the load event: wait
// until its node count and height hold for a second and a half.
async function settle(cdp, limitMs = 8_000) {
  let last = "";
  let same = 0;
  for (let waited = 0; waited < limitMs && timeLeft() > 45_000; waited += 500) {
    const { result } = await cdp
      .send("Runtime.evaluate", { expression: "document.getElementsByTagName('*').length + ':' + document.documentElement.scrollHeight", returnByValue: true }, 5_000)
      .catch(() => ({ result: {} }));
    const now = String(result && result.value);
    same = now === last ? same + 1 : 0;
    if (same >= 3) return;
    last = now;
    await sleep(500);
  }
}

// Web fonts that are still on their way would be drawn in a fallback face.
async function waitForFonts(cdp) {
  await cdp
    .send(
      "Runtime.evaluate",
      { expression: "Promise.race([document.fonts ? document.fonts.ready.then(() => true) : true, new Promise((r) => setTimeout(r, 3000))])", awaitPromise: true },
      5_000,
    )
    .catch(() => {});
}

// The pointer goes to the screen's bottom-right corner first: left where a
// wheel turned last, it can keep a hover tooltip or a dropdown in a capture.
async function clearHover(cdp, width, height) {
  const moved = await cdp
    .send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.max(0, width - 2), y: Math.max(0, height - 2) }, 1_500)
    .then(() => true, () => false);
  if (moved) await sleep(250);
}

// Pictures still on their way when a capture starts: a capture first waits
// until every video in its frame shows a picture, every picture in it has
// loaded, no fade-in in it is still running and (once the page is watched)
// nothing in it changed in the last 200 ms. 8 s at most for the page in all.
// This only reads the page.
const PICTURE_WAIT_MS = 8_000;
// A picture that has no address yet, and a frame that keeps changing, are
// waited for this long and no more: some placeholders never get an address,
// and some pages never stop moving.
const PATIENCE_MS = 1_500;
const pictureWait = new WeakMap();
const PENDING_PICTURES = `(clip, patient) => {
  const inFrame = (r) => r.width >= 16 && r.height >= 16 &&
    r.left + scrollX < clip.x + clip.width && r.right + scrollX > clip.x &&
    r.top + scrollY < clip.y + clip.height && r.bottom + scrollY > clip.y;
  // A picture in a closed menu (see-through, hidden) is not waited for.
  const shown = (el) => el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden";
  let pending = 0;
  for (const el of document.querySelectorAll("video, img")) {
    if (!inFrame(el.getBoundingClientRect()) || !shown(el)) continue;
    if (el.tagName === "VIDEO") {
      // A video with a picture, a poster, an error or no source is done.
      if (el.readyState >= 2 || el.poster || el.error || el.networkState === 3) continue;
      if (el.currentSrc || el.getAttribute("src") || el.querySelector("source[src]")) pending++;
    } else if (!el.complete) {
      // Still loading.
      pending++;
    } else if (!(el.currentSrc || el.getAttribute("src")) && patient) {
      // A lazy picture whose address the page sets once it sees it.
      pending++;
    }
  }
  for (const animation of document.getAnimations()) {
    const effect = animation.effect;
    const timing = effect && effect.getComputedTiming ? effect.getComputedTiming() : null;
    // A fade-in ends; a spinner, a marquee or a carousel's loop does not.
    if (animation.playState !== "running" || !timing || !(timing.endTime <= 3000)) continue;
    if (effect.target && effect.target.getBoundingClientRect && inFrame(effect.target.getBoundingClientRect())) pending++;
  }
  return pending;
}`;

function resetPictureWait(cdp, ms = PICTURE_WAIT_MS) {
  pictureWait.set(cdp, ms);
}

async function waitForPictures(cdp, clip) {
  const frame = JSON.stringify(clip);
  const started = Date.now();
  let left = pictureWait.has(cdp) ? pictureWait.get(cdp) : PICTURE_WAIT_MS;
  let waited = false;
  while (left > 0 && timeLeft() > 30_000) {
    const patient = Date.now() - started < PATIENCE_MS;
    const expression = `(${PENDING_PICTURES})(${frame}, ${patient}) + (window.__easyscreenshot && ${patient} ? window.__easyscreenshot.moving(${frame}) : 0)`;
    const pending = await cdp
      .send("Runtime.evaluate", { expression, returnByValue: true }, 5_000)
      .then(({ result }) => Number(result && result.value) || 0, () => 0);
    if (!pending) break;
    waited = true;
    await sleep(250);
    left -= 250;
  }
  pictureWait.set(cdp, left);
  // The last picture to arrive is painted on the next frame.
  if (waited) await sleep(200);
}

// A frame that lies on the screen is captured as the screen shows it: drawn
// again beyond the viewport, videos and some pictures came out as blank
// boxes. Only a frame that does not fit on the screen is drawn beyond it.
// scale is the capture's own: pixels per CSS pixel are scale times the
// device's.
async function capture(cdp, x, y, width, height, scale = 1, beyondViewport = true) {
  await waitForPictures(cdp, { x, y, width, height });
  if (beyondViewport) {
    const m = await metrics(cdp);
    const onScreen = x >= 0 && x + width <= m.width + 1 && y >= m.scrollY - 1 && y + height <= m.scrollY + m.viewportHeight + 1;
    if (onScreen) beyondViewport = false;
  }
  return cdp.send(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: beyondViewport, clip: { x, y, width, height, scale } },
    60_000,
  );
}

// The screen as the device shows it: no clip, so the image is the device's
// own size (1080x1920 for a phone) even when the page is zoomed out.
async function captureScreen(cdp) {
  const m = await metrics(cdp);
  await waitForPictures(cdp, { x: 0, y: m.scrollY, width: m.visualWidth, height: m.visualHeight });
  return cdp.send("Page.captureScreenshot", { format: "png" }, 60_000);
}

// ─── screen by screen ──────────────────────────────────────────────────────
// A whole page is captured a screen at a time, each screen as the screen
// shows it. Drawn beyond the viewport in one piece, a page left every video
// and every lazy picture out: a catalogue of cards came back as blank boxes
// and alt texts, while a capture of the screen showed their covers. So the
// page is scrolled to each screen, which plays its videos and loads its lazy
// pictures there, and that screen is captured; the page is the screens
// joined.
//
// A screen also waits while the page is still changing what it shows: a
// count-up that runs when its section comes into view (figures came out at
// half their values), a fade-in a script drives. A record of the page's
// changes (text, children, classes and styles; not data-* or aria-*, not
// <html> or <body>, nothing hidden) answers whether anything in the screen's
// frame changed in the last 200 ms. An element that has kept changing for
// over a second and a half is a loop (a carousel, a ticker, an animated
// background) that never settles, and is no longer waited for: on a page
// full of them, every screen waited its whole three seconds.
const WATCH = `(function () {
  if (window.__easyscreenshot) return;
  var kept = window.__easyscreenshot = { done: new Set(), undo: [], changes: [], lastMove: 0, streaks: new Map() };
  var root = document.documentElement;
  kept.undo.push([root, "scroll-snap-type", root.style.getPropertyValue("scroll-snap-type"), root.style.getPropertyPriority("scroll-snap-type")]);
  root.style.setProperty("scroll-snap-type", "none", "important");
  kept.observer = new MutationObserver(function (records) {
    var now = performance.now();
    records.forEach(function (r) {
      if (r.type !== "attributes" || !/^(data|aria)-/.test(r.attributeName)) kept.changes.push([r.target, now]);
    });
    if (kept.changes.length > 5000) kept.changes.splice(0, kept.changes.length - 5000);
  });
  kept.observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  kept.moving = function (clip) {
    var seen = new Set();
    for (var i = kept.changes.length - 1; i >= 0; i--) {
      var node = kept.changes[i][0], at = kept.changes[i][1];
      var el = node.nodeType === 1 ? node : node.parentElement;
      if (!el || seen.has(el) || el === document.body || el === root || !el.isConnected) continue;
      seen.add(el);
      var streak = kept.streaks.get(el);
      if (!streak || at - streak[1] > 400) streak = [at, at];
      else streak[1] = Math.max(streak[1], at);
      kept.streaks.set(el, streak);
      if (streak[1] - streak[0] > 1500 || at <= kept.lastMove) continue;
      if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      var r = el.getBoundingClientRect();
      if (r.right + scrollX > clip.x && r.left + scrollX < clip.x + clip.width && r.bottom + scrollY > clip.y && r.top + scrollY < clip.y + clip.height) kept.lastMove = at;
    }
    kept.changes = [];
    return performance.now() - kept.lastMove < 200 ? 1 : 0;
  };
})()`;

// What stays on the screen while the page scrolls would come back on every
// screen of the image. For the captures, sticky parts (a header, a table's
// head) stay where the page puts them, backgrounds fixed to the screen
// scroll with their block, and from the second screen on fixed bars (the
// navigation, an app's sidebar, a "back to top" button) are made
// see-through: one image of the page shows them once, at its top. Scroll
// snapping is off. All is put back afterwards.
const SET_ASIDE = `(function (fixedToo) {
  var kept = window.__easyscreenshot;
  if (!kept) return;
  var put = function (el, name, value) {
    kept.undo.push([el, name, el.style.getPropertyValue(name), el.style.getPropertyPriority(name)]);
    el.style.setProperty(name, value, "important");
  };
  var visit = function (scope) {
    var all = scope.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.shadowRoot) visit(el.shadowRoot);
      if (!el.style) continue;
      var style = getComputedStyle(el);
      if (style.position === "sticky") {
        ["top", "right", "bottom", "left"].forEach(function (side) { put(el, side, "auto"); });
        put(el, "position", "relative");
      } else if (style.position === "fixed" && fixedToo && !kept.done.has(el)) {
        kept.done.add(el);
        put(el, "transition", "none");
        put(el, "opacity", "0");
      }
      if (style.backgroundAttachment.indexOf("fixed") >= 0) put(el, "background-attachment", "scroll");
    }
  };
  visit(document);
  // These changes are ours, not the page's.
  kept.observer.takeRecords();
})`;
const PUT_BACK = `(function () {
  var kept = window.__easyscreenshot;
  window.__easyscreenshot = null;
  if (kept) {
    kept.observer.disconnect();
    for (var i = kept.undo.length - 1; i >= 0; i--) {
      var u = kept.undo[i];
      if (u[2]) u[0].style.setProperty(u[1], u[2], u[3]);
      else u[0].style.removeProperty(u[1]);
    }
  }
  window.scrollTo({ top: 0, left: 0, behavior: "instant" });
})()`;

function watch(cdp) {
  return cdp.send("Runtime.evaluate", { expression: WATCH }, 10_000).catch(() => {});
}

// Each screen waits up to 3 s for its own videos, pictures and changes, out
// of the time the run has left. A whole page's first screen is taken whole,
// as the page stands at its top: a hero that fades as the page scrolls came
// out half faded when taken partly from the next screen. The later screens
// overlap by a quarter, each giving its top three quarters: scroll-reveal
// libraries show a block only once its top is well inside the screen and
// hide it again when it is not, and joined edge to edge a block starting in
// a screen's bottom band came out with its top missing.
const SCREEN_WAIT_MS = 3_000;
const PAGE_SCREEN_STEP = 0.75;

function screenTops(height, viewportHeight) {
  const step = Math.max(1, Math.round(viewportHeight * PAGE_SCREEN_STEP));
  const tops = [];
  for (let y = 0; y < height; y += tops.length === 1 ? viewportHeight : step) {
    tops.push(Math.max(0, Math.min(y, height - viewportHeight)));
    if (y + viewportHeight >= height) break;
  }
  return tops;
}

// The whole page down to maxHeight CSS px, at the given capture scale.
// Returns {png, height (CSS px shown), truncated} or null when no screen was
// taken. The page must have been walked and watched.
async function capturePage(cdp, { scale = 1, maxHeight = 15_000 } = {}) {
  const m = await metrics(cdp);
  const height = Math.min(m.height, maxHeight);
  const tops = screenTops(height, m.viewportHeight);
  const shots = [];
  const evaluate = (expression) => cdp.send("Runtime.evaluate", { expression, returnByValue: true }, 10_000);
  await clearHover(cdp, m.width, m.viewportHeight);
  try {
    await watch(cdp);
    for (let i = 0; i < tops.length; i++) {
      if (i > 0 && timeLeft() < 25_000) break;
      try {
        await evaluate(`window.scrollTo({ top: ${tops[i]}, left: 0, behavior: "instant" })`);
        // Scroll handlers swap headers, lazy pictures get their address and
        // fade-ins start.
        await sleep(STEP_PAUSE_MS);
        await evaluate(`${SET_ASIDE}(${i > 0})`);
        const now = await metrics(cdp);
        const top = Math.max(0, Math.min(now.scrollY, Math.max(0, now.height - m.viewportHeight)));
        resetPictureWait(cdp, Math.min(SCREEN_WAIT_MS, Math.max(0, (timeLeft() - 30_000) / (tops.length - i) - 1_000)));
        const shot = await capture(cdp, 0, top, m.width, Math.min(m.viewportHeight, now.height - top), scale, false);
        shots.push({ top, png: Buffer.from(shot.data || "", "base64") });
      } catch (err) {
        // A page too busy to answer partway down keeps the screens taken so
        // far, and says it was cut.
        if (!shots.length) throw err;
        break;
      }
    }
  } finally {
    await evaluate(PUT_BACK).catch(() => {});
    await sleep(300);
  }
  if (!shots.length) return null;
  const joined = joinScreens(shots, m.width, height);
  return { png: joined.png, height: joined.height, truncated: m.height > maxHeight || shots.length < tops.length };
}

module.exports = {
  metrics,
  scrollTo,
  walk,
  waitForContent,
  settle,
  waitForFonts,
  clearHover,
  resetPictureWait,
  capture,
  captureScreen,
  watch,
  screenTops,
  capturePage,
};
