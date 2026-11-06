"use strict";

// What floats over a page and is not the page: cookie and consent banners,
// chat bubbles, promo boxes, "back to top" buttons, modal backdrops. They
// are hidden for the capture, never clicked: pressing "Accept" would give
// consent on the user's behalf, and hiding gives the same picture.

const { sleep } = require("./time");

// The consent and chat tools seen most, by the ids and classes that are
// theirs alone. The rule below catches anything fixed to the screen; these
// catch what it misses: a cookie bar at the very top that looks like a menu,
// a sticky or in-flow banner, a frame.
const KNOWN = [
  // Consent banners
  "#onetrust-consent-sdk", "#onetrust-banner-sdk", ".onetrust-pc-dark-filter",
  "#CybotCookiebotDialog", "#CybotCookiebotDialogBodyUnderlay",
  "#didomi-host", "#didomi-notice",
  "#usercentrics-root", "#usercentrics-cmp-ui",
  ".qc-cmp2-container", "#qc-cmp2-container",
  "#truste-consent-track", "#consent_blackbar", ".truste_overlay", ".truste_box_overlay",
  ".osano-cm-window", ".osano-cm-dialog",
  ".cky-consent-container", ".cky-overlay", "#cookie-law-info-bar",
  "#iubenda-cs-banner",
  "#cmplz-cookiebanner-container", ".cmplz-cookiebanner",
  "#axeptio_overlay", ".axeptio_mount",
  "div[id^='sp_message_container']",
  "#shopify-pc__banner",
  "#BorlabsCookieBox",
  "#cookiescript_injected",
  "#lanyard_root",
  "#cookie-notice",
  "#moove_gdpr_cookie_info_bar",
  "#ccc", "#ccc-overlay",
  "#cmpbox", "#cmpbox2",
  ".fc-consent-root",
  ".cookiefirst-root",
  "#coiOverlay",
  ".klaro .cookie-notice", ".klaro .cookie-modal",
  // Chat bubbles and their windows
  "#intercom-container", ".intercom-lightweight-app", "#intercom-frame", "iframe[name='intercom-launcher-frame']",
  "#crisp-chatbox", ".crisp-client",
  "#drift-widget-container", "#drift-frame-controller", "#drift-frame-chat",
  "#hubspot-messages-iframe-container",
  "iframe#launcher", "#webWidget", "iframe[title='Button to launch messaging window']", "iframe[title='Messaging window']",
  "iframe[title='chat widget']",
  "#chat-widget-container",
  "#tidio-chat",
  "#fc_frame", "#freshworks-container",
  "#gorgias-chat-container",
  "#beacon-container", ".BeaconFabButtonFrame",
  ".woot-widget-holder", ".woot--bubble-holder",
  "#olark-wrapper",
  "#front-chat-container",
  "#smartsupp-widget-container",
  "jdiv", "#jivo-iframe-container",
  ".fb_dialog", ".fb-customerchat",
  // The reCAPTCHA badge in the corner
  ".grecaptcha-badge",
];

// Hides every element the selectors match, with a rule for ones that come
// later and inline for ones the page styled inline. A selector the browser
// cannot read is skipped and named. Returns how many elements were showing.
const HIDE_SELECTORS = `(function (selectors) {
  var style = document.getElementById("easyscreenshotkit-hide") || document.createElement("style");
  style.id = "easyscreenshotkit-hide";
  var rules = [], bad = [], hidden = 0, big = false;
  selectors.forEach(function (selector) {
    var found;
    try {
      found = document.querySelectorAll(selector);
    } catch (e) {
      bad.push(selector);
      return;
    }
    rules.push(selector + "{display:none!important}");
    found.forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        hidden++;
        if (r.width * r.height >= 0.5 * innerWidth * innerHeight) big = true;
      }
      el.style.setProperty("display", "none", "important");
    });
  });
  style.textContent = rules.join("\\n");
  (document.head || document.documentElement).appendChild(style);
  return { hidden: hidden, bad: bad, big: big };
})`;

// Floating overlays repeat over the content in every capture. Hide every
// position:fixed element except the page's own chrome: a short bar on the
// top edge (navigation) and a tall, narrow bar on the left or right edge (an
// app's sidebar). The page itself is never hidden, even when a consent
// dialog pins <body> with position:fixed to stop it scrolling.
function isPageChrome([x, y, width, height], viewportWidth, viewportHeight) {
  const topBar = y <= 20 && height <= viewportHeight * 0.3;
  const sideBar =
    height >= viewportHeight * 0.5 &&
    width <= viewportWidth * 0.35 &&
    (x <= 2 || x + width >= viewportWidth - 2);
  return topBar || sideBar;
}

// A fixed layer with a negative z-index sits behind the page (a gradient or
// a video under the content) and stays.
async function hideFixed(cdp, viewportWidth, viewportHeight) {
  const snap = await cdp.send("DOMSnapshot.captureSnapshot", { computedStyles: ["position", "display", "z-index"] });
  const doc = (snap.documents || [])[0];
  if (!doc || !doc.layout) return { hidden: 0, big: false };
  const strings = snap.strings || [];
  const names = (doc.nodes.nodeName || []).map((i) => strings[i] || "");
  const backendIds = [];
  const fixed = new Map();
  doc.layout.nodeIndex.forEach((nodeIndex, i) => {
    if (names[nodeIndex] === "HTML" || names[nodeIndex] === "BODY") return;
    const [position, display, zIndex] = (doc.layout.styles[i] || []).map((k) => strings[k]);
    if (position === "fixed" && display !== "none" && !(parseInt(zIndex, 10) < 0)) fixed.set(nodeIndex, doc.layout.bounds[i] || []);
  });
  // A fixed box of no size still shows what overflows it: a shop's cookie
  // banner sat in a 0 px wide fixed wrapper. Such a box is measured by what
  // it holds.
  const held = new Map();
  const parentOf = doc.nodes.parentIndex || [];
  doc.layout.nodeIndex.forEach((nodeIndex, i) => {
    const [x, y, w, h] = doc.layout.bounds[i] || [];
    if (!(w > 0 && h > 0)) return;
    for (let n = parentOf[nodeIndex]; n >= 0; n = parentOf[n]) {
      if (!fixed.has(n)) continue;
      const [x0, y0, x1, y1] = held.get(n) || [x, y, x + w, y + h];
      held.set(n, [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x + w), Math.max(y1, y + h)]);
      break;
    }
  });
  let big = false;
  for (const [nodeIndex, own] of fixed) {
    const box = held.get(nodeIndex);
    const bounds = own[2] > 0 && own[3] > 0 ? own : box ? [box[0], box[1], box[2] - box[0], box[3] - box[1]] : null;
    if (bounds && !isPageChrome(bounds, viewportWidth, viewportHeight)) {
      backendIds.push(doc.nodes.backendNodeId[nodeIndex]);
      const seen = Math.max(0, Math.min(bounds[0] + bounds[2], viewportWidth) - Math.max(bounds[0], 0)) * Math.max(0, Math.min(bounds[1] + bounds[3], viewportHeight) - Math.max(bounds[1], 0));
      if (seen >= 0.5 * viewportWidth * viewportHeight) big = true;
    }
  }
  if (backendIds.length === 0) return { hidden: 0, big };
  await cdp.send("DOM.getDocument", { depth: 0 });
  const { nodeIds = [] } = await cdp.send("DOM.pushNodesByBackendIdsToFrontend", {
    backendNodeIds: backendIds,
  });
  let hidden = 0;
  for (const nodeId of nodeIds) {
    if (!nodeId) continue;
    try {
      const { attributes = [] } = await cdp.send("DOM.getAttributes", { nodeId });
      const at = attributes.indexOf("style");
      const style = at >= 0 && at % 2 === 0 ? attributes[at + 1] : "";
      await cdp.send("DOM.setAttributeValue", {
        nodeId,
        name: "style",
        value: `${style};display:none !important`,
      });
      hidden++;
    } catch {
      // A node that vanished meanwhile needs no hiding.
    }
  }
  return { hidden, big };
}

// A consent dialog often stops the page from scrolling while it is open:
// overflow:hidden on <html> or <body>, or <body> pinned with position:fixed.
// With the dialog hidden the page would still not scroll, and a whole-page
// capture would end at the first screen. Undone only after a dialog-sized
// overlay was hidden: some apps scroll inside a pane of their own on purpose.
const UNLOCK = `(function () {
  var changed = 0;
  [document.documentElement, document.body].forEach(function (el) {
    if (!el) return;
    var s = getComputedStyle(el);
    if (s.overflowY === "hidden" || s.overflowY === "clip") {
      el.style.setProperty("overflow-y", "auto", "important");
      changed++;
    }
    if (el === document.body && s.position === "fixed") {
      el.style.setProperty("position", "static", "important");
      el.style.setProperty("top", "auto", "important");
      changed++;
    }
  });
  return changed;
})()`;

// Cleans the page as it stands (scrolled to its top, after the walk, so a
// box that comes up on scrolling is caught too). hide: more selectors the
// user asked to hide. Returns {hidden, unlocked, badSelectors}.
async function clean(cdp, { hide = [], viewport }) {
  const selectors = [...KNOWN, ...hide];
  const { result } = await cdp
    .send("Runtime.evaluate", { expression: `${HIDE_SELECTORS}(${JSON.stringify(selectors)})`, returnByValue: true }, 10_000)
    .catch(() => ({ result: {} }));
  const known = (result && result.value) || { hidden: 0, bad: [], big: false };
  const fixed = await hideFixed(cdp, viewport.width, viewport.height).catch(() => ({ hidden: 0, big: false }));
  let unlocked = 0;
  if (known.big || fixed.big) {
    const answer = await cdp.send("Runtime.evaluate", { expression: UNLOCK, returnByValue: true }, 5_000).catch(() => ({ result: {} }));
    unlocked = Number(answer.result && answer.result.value) || 0;
  }
  await sleep(300);
  return { hidden: known.hidden + fixed.hidden, unlocked: unlocked > 0, badSelectors: known.bad || [] };
}

module.exports = { KNOWN, isPageChrome, hideFixed, clean };
