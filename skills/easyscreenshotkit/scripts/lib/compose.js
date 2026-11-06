"use strict";

// The video, a frame at a time. Each frame is drawn as a page of its own in
// a second headless browser: the backdrop and the window around the site,
// the frame the site was recorded in (zoomed where the camera looks), the
// pointer, the ring a click leaves and the key just pressed. Each drawing
// is captured and handed to ffmpeg. Frames that would come out the same as
// the one before (a page at rest) are drawn once and sent again.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { openTab, closeTab, navigate } = require("./chrome");
const { planCamera, cameraAt, cursorAt, ringsAt, keyAt, ease, clamp } = require("./motion");
const { toRgb } = require("./png");

const WIDTH = 1920;
const HEIGHT = 1080;
const BAR = 44;

// Where the page sits in the video. Framed: a 1600 px wide window with a
// title bar, centred on the backdrop. Unframed: the page fills the video.
function layoutOf({ frame = true, viewport }) {
  if (!frame) return { frame: false, width: WIDTH, height: HEIGHT, content: { x: 0, y: 0, width: WIDTH, height: HEIGHT }, scale: WIDTH / viewport.width };
  const width = 1600;
  const scale = width / viewport.width;
  const height = Math.round(viewport.height * scale);
  const x = (WIDTH - width) / 2;
  const y = Math.round((HEIGHT - height - BAR) / 2);
  return { frame: true, width: WIDTH, height: HEIGHT, window: { x, y, width, height: height + BAR }, content: { x, y: y + BAR, width, height }, scale };
}

// The backdrop and the title bar: dark behind a light site, light behind a
// dark one.
const LOOKS = {
  light: {
    backdrop: "radial-gradient(120% 130% at 16% 0%, #5c6088 0%, #2c2e47 46%, #15161f 100%)",
    shadow: "0 40px 100px rgba(0,0,0,.5), 0 12px 32px rgba(0,0,0,.28)",
    bar: "#f2f2f4", line: "#e2e2e7", pill: "#ffffff", pillLine: "#e1e1e6", text: "#55565d",
  },
  dark: {
    backdrop: "radial-gradient(120% 130% at 16% 0%, #ffffff 0%, #e4e6f2 48%, #c6cae0 100%)",
    shadow: "0 40px 90px rgba(24,28,64,.32), 0 10px 28px rgba(24,28,64,.18)",
    bar: "#1f2024", line: "#2d2e34", pill: "#2a2b31", pillLine: "#35363d", text: "#a7a9b2",
  },
};

const COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\([\d\s.,%/+-]+\)|[a-z]{3,30})$/i;

// --background: a colour, two colours for a gradient, or a picture file.
function backdropOf(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/\.(png|jpe?g|webp|gif|avif|svg)$/i.test(text)) {
    if (!fs.existsSync(text)) throw new Error(`--background: no such picture file: ${text}`);
    return `url("${pathToFileURL(path.resolve(text)).href}") center / cover no-repeat, #222`;
  }
  const colors = text.split(/\s*,\s*(?![^()]*\))/);
  if (!colors.length || colors.length > 3 || colors.some((c) => !COLOR.test(c))) throw new Error(`--background takes a colour, two colours for a gradient, or a picture file, not ${text}`);
  return colors.length === 1 ? colors[0] : `linear-gradient(135deg, ${colors.join(", ")})`;
}

// How light the site is, from a small capture of its first screen: 0 is
// black, 1 white.
async function lightnessOf(tab, viewport) {
  try {
    const shot = await tab.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale: 0.05 } }, 10_000);
    const png = Buffer.from(shot.data, "base64");
    const { width, height, rows } = toRgb(png);
    let sum = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const at = y * (1 + width * 3) + 1 + x * 3;
        sum += 0.2126 * rows[at] + 0.7152 * rows[at + 1] + 0.0722 * rows[at + 2];
      }
    }
    return sum / (width * height) / 255;
  } catch {
    return 1;
  }
}

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// The page every frame is drawn in. draw(state) puts everything in place and
// resolves once the pictures are decoded; the frame is then captured.
function composeHtml(layout, look, viewport) {
  const { content } = layout;
  const win = layout.frame ? layout.window : content;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:${look.backdrop}}
#win{position:absolute;left:${win.x}px;top:${win.y}px;width:${win.width}px;height:${win.height}px;overflow:hidden;${layout.frame ? `border-radius:14px;box-shadow:${look.shadow};background:${look.bar}` : "background:#fff"}}
#bar{position:absolute;left:0;top:0;right:0;height:${BAR}px;background:${look.bar};border-bottom:1px solid ${look.line}}
#dots{position:absolute;left:18px;top:16px;display:flex;gap:8px}
#dots i{width:12px;height:12px;border-radius:50%;display:block}
#url{position:absolute;left:50%;top:8px;transform:translateX(-50%);height:28px;min-width:440px;max-width:900px;padding:0 18px;border-radius:8px;background:${look.pill};border:1px solid ${look.pillLine};display:flex;align-items:center;justify-content:center;gap:7px;font:500 14.5px/26px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:${look.text};white-space:nowrap}
#url span{overflow:hidden;text-overflow:ellipsis;line-height:26px}
#view{position:absolute;left:0;top:${layout.frame ? BAR : 0}px;width:${content.width}px;height:${content.height}px;overflow:hidden;background:#fff}
#view img{position:absolute;left:0;top:0;width:${viewport.width}px;height:${viewport.height}px;transform-origin:0 0}
#cursor{position:absolute;left:0;top:0;width:32px;height:32px;transform-origin:0 0;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
.ring{position:absolute;border-radius:50%;border:3px solid rgba(255,255,255,.96);box-shadow:0 0 0 1.5px rgba(0,0,0,.2),inset 0 0 0 1.5px rgba(0,0,0,.14)}
#key{position:absolute;left:50%;bottom:40px;transform:translateX(-50%);padding:14px 24px;border-radius:14px;background:rgba(22,22,26,.84);color:#fff;font:600 30px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;letter-spacing:.03em;white-space:nowrap;box-shadow:0 12px 32px rgba(0,0,0,.3);opacity:0}
</style></head><body><div id="win">
${layout.frame ? `<div id="bar"><div id="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div><div id="url"><svg id="lock" width="12" height="14" viewBox="0 0 12 14"><path d="M3 6V4.2a3 3 0 0 1 6 0V6" fill="none" stroke="${look.text}" stroke-width="1.6"/><rect x="1" y="6" width="10" height="7.5" rx="2" fill="${look.text}"/></svg><span id="addr"></span></div></div>` : ""}
<div id="view"><img id="prev"><img id="cur"><div id="rings"></div>
<svg id="cursor" viewBox="0 0 32 32"><path d="M7 3.5 L7 25.5 L12.6 20.2 L16.4 28.8 L20.2 27.2 L16.5 18.8 L24.4 18.8 Z" fill="#111" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>
<div id="key"></div></div></div>
<script>
const $ = (id) => document.getElementById(id);
const shown = {};
async function picture(img, src) {
  if (shown[img.id] === src) return;
  shown[img.id] = src;
  img.src = src;
  try { await img.decode(); } catch (e) {}
}
const place = (img, s) => { img.style.transform = "scale(" + s.k + ") translate(" + (-s.x) + "px," + (-s.y) + "px)"; };
window.draw = async (s) => {
  const cur = $("cur"), prev = $("prev");
  await picture(cur, s.cur.src);
  place(cur, s.cur);
  if (s.prev) {
    await picture(prev, s.prev.src);
    place(prev, s.prev);
    prev.style.opacity = 1;
    cur.style.opacity = s.alpha;
  } else {
    prev.style.opacity = 0;
    cur.style.opacity = 1;
  }
  const c = $("cursor");
  if (s.cursor) {
    c.style.opacity = s.cursor.o;
    c.style.transform = "translate(" + (s.cursor.x - 7 * s.cursor.s) + "px," + (s.cursor.y - 3.5 * s.cursor.s) + "px) scale(" + s.cursor.s + ")";
  } else c.style.opacity = 0;
  $("rings").innerHTML = s.rings.map((r) => '<div class="ring" style="left:' + (r.x - r.r) + "px;top:" + (r.y - r.r) + "px;width:" + 2 * r.r + "px;height:" + 2 * r.r + "px;opacity:" + r.o + '"></div>').join("");
  const key = $("key");
  if (s.key) { key.textContent = s.key.label; key.style.opacity = s.key.o; } else key.style.opacity = 0;
  if ($("addr")) {
    $("addr").textContent = s.url;
    $("lock").style.display = s.lock ? "" : "none";
  }
};
window.ready = true;
</script></body></html>`;
}

// The address as the title bar shows it: no scheme, no trailing slash.
function addressOf(url) {
  try {
    const u = new URL(url);
    return `${u.host.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "")}`;
  } catch {
    return String(url || "");
  }
}

const round = (value) => Math.round(value * 100) / 100;

// The last frame at or before t, by binary search over frames sorted by v.
function frameAt(frames, t) {
  let lo = 0;
  let hi = frames.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].v <= t + 1e-6) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

// Everything the frame at time t shows, in the video's own pixels.
function stateAt(take, regions, layout, t) {
  const { viewport } = take;
  const src = (frame) => pathToFileURL(frame.file).href;
  const cam = cameraAt(regions, t, viewport);
  const k = layout.scale * cam.z;
  const frame = take.frames[frameAt(take.frames, t)];
  const state = { cur: { src: src(frame), k: round(k), x: round(cam.x), y: round(cam.y) }, prev: null, alpha: 1, cursor: null, rings: [], key: null, url: "", lock: false };
  // The crossfade into a page: the last frame before the cut under the first
  // frames after it, going back out to its whole screen if it was zoomed in.
  const cut = take.cuts.find((c) => t >= c.t && t < c.t + c.fade);
  if (cut) {
    const first = take.frames.findIndex((f) => f.cut && Math.abs(f.v - cut.t) < 1e-6);
    if (first > 0) {
      const a = ease((t - cut.t) / cut.fade);
      const before = cameraAt(regions, cut.t - 1e-3, viewport);
      const width = viewport.width / before.z + (viewport.width - viewport.width / before.z) * a;
      state.prev = { src: src(take.frames[first - 1]), k: round((layout.scale * viewport.width) / width), x: round(before.x * (1 - a)), y: round(before.y * (1 - a)) };
      state.alpha = round(a);
    }
  }
  const pointer = cursorAt(take, t);
  if (pointer) state.cursor = { x: round((pointer.x - cam.x) * k), y: round((pointer.y - cam.y) * k), s: round(Math.max(0.9, k) * pointer.press), o: round(pointer.opacity) };
  state.rings = ringsAt(take, t).map((ring) => ({ x: round((ring.x - cam.x) * k), y: round((ring.y - cam.y) * k), r: round(ring.radius * k), o: round(ring.opacity) }));
  const key = keyAt(take, t);
  if (key) state.key = { label: key.label, o: round(key.opacity) };
  let url = "";
  for (const change of take.urls) if (change.t <= t + 1e-6) url = change.url;
  state.url = addressOf(url);
  state.lock = /^https:/i.test(url);
  return state;
}

// Draws every frame of the take and writes it to sink (startVideo), in
// order. tabs: how many drawing pages work at once.
async function renderVideo(chrome, take, { layout, look, zoom, dir, sink, log = () => {}, tabs: count = 0 }) {
  const regions = planCamera(take, { zoom });
  const total = Math.max(1, Math.round(take.duration * take.fps));
  const jobs = [];
  const jobOf = new Array(total);
  let last = "";
  for (let i = 0; i < total; i++) {
    const state = stateAt(take, regions, layout, i / take.fps);
    const key = JSON.stringify(state);
    if (key !== last) jobs.push(state);
    last = key;
    jobOf[i] = jobs.length - 1;
  }
  log(`Drawing ${total} frames (${jobs.length} different)`);
  const page = path.join(dir, "compose.html");
  fs.writeFileSync(page, composeHtml(layout, look, take.viewport));
  const n = count || clamp(Math.floor(os.cpus().length / 3), 2, 4);
  const opened = [];
  const results = jobs.map(() => {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
  });
  let next = 0;
  let written = -1;
  let failure = null;
  const CHUNK = 12;
  const AHEAD = 150;
  try {
    for (let i = 0; i < n; i++) {
      const tab = await openTab(chrome, { width: WIDTH, height: HEIGHT, scale: 1, mobile: false, touch: false, agent: "desktop" });
      opened.push(tab);
      await navigate(tab, pathToFileURL(page).href);
    }
    // Each page takes the next few frames in a row (they share pictures),
    // and stays at most AHEAD frames ahead of what ffmpeg has taken.
    const worker = async (tab) => {
      while (next < jobs.length && !failure) {
        const start = next;
        const end = Math.min(jobs.length, start + CHUNK);
        next = end;
        for (let j = start; j < end && !failure; j++) {
          while (j - (written < 0 ? 0 : jobOf[written]) > AHEAD && !failure) await new Promise((r) => setTimeout(r, 20));
          results[j].resolve(await drawFrame(tab, jobs[j], "jpeg"));
        }
      }
    };
    const stop = (err) => {
      failure = failure || err;
      for (const result of results) if (result) result.resolve(null);
    };
    const writer = async () => {
      for (let i = 0; i < total && !failure; i++) {
        const buffer = await results[jobOf[i]].promise;
        if (!buffer) break;
        await sink.write(buffer);
        written = i;
        if (i + 1 < total && jobOf[i + 1] !== jobOf[i]) results[jobOf[i]] = null;
      }
    };
    await Promise.all([...opened.map((tab) => worker(tab).catch(stop)), writer().catch(stop)]);
    if (failure) throw failure;
  } finally {
    for (const tab of opened) await closeTab(chrome, tab);
  }
  return { frames: total, drawn: jobs.length, regions };
}

// A whole JPEG: ffmpeg finds the frames in its input by their start and end
// markers, so a cut-off one would cost the video a frame.
const whole = (jpeg) => jpeg.length > 4 && jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg[jpeg.length - 2] === 0xff && jpeg[jpeg.length - 1] === 0xd9;

async function drawFrame(tab, state, format) {
  const { exceptionDetails } = await tab.send("Runtime.evaluate", { expression: `draw(${JSON.stringify(state)})`, awaitPromise: true }, 30_000);
  if (exceptionDetails) throw new Error(`a frame could not be drawn: ${exceptionDetails.text}`);
  for (let tries = 0; ; tries++) {
    const shot = await tab.send("Page.captureScreenshot", format === "png" ? { format: "png" } : { format: "jpeg", quality: 92, optimizeForSpeed: true }, 30_000);
    const image = Buffer.from(shot.data || "", "base64");
    if (format === "png" || whole(image)) return image;
    if (tries === 2) throw new Error("a frame came back from the browser cut off");
  }
}

// One frame as a PNG: the poster.
async function renderStill(chrome, take, { layout, look, zoom, dir, t }) {
  const regions = planCamera(take, { zoom });
  const page = path.join(dir, "compose.html");
  if (!fs.existsSync(page)) fs.writeFileSync(page, composeHtml(layout, look, take.viewport));
  const tab = await openTab(chrome, { width: WIDTH, height: HEIGHT, scale: 1, mobile: false, touch: false, agent: "desktop" });
  try {
    await navigate(tab, pathToFileURL(page).href);
    return await drawFrame(tab, stateAt(take, regions, layout, t), "png");
  } finally {
    await closeTab(chrome, tab);
  }
}

module.exports = { layoutOf, LOOKS, backdropOf, lightnessOf, composeHtml, addressOf, frameAt, stateAt, renderVideo, renderStill, WIDTH, HEIGHT };
