"use strict";

// easyscreenshot demo: a short video of a website. A tour of the pages the
// screenshots would take, or the steps written in a file, recorded in the
// user's own Chrome and encoded with their own ffmpeg. What comes out, in
// one folder:
//
//   demo.mp4     1920x1080, H.264: the page in a browser window on a
//                backdrop, with a pointer, smooth scrolling and a zoom on
//                each click
//   demo.gif     the same, small enough for a README
//   poster.png   a still of the first page, for a video's cover
//   steps.json   every step with where it starts and ends, in seconds and in
//                frames, for narration, music or captions laid over it
//   demo.yaml    the tour as steps, to edit and record again (tours only)

const fs = require("fs");
const path = require("path");
const { launch } = require("./chrome");
const { normalizeUrl } = require("./shots");
const { siteOf, pageKey } = require("./pick");
const { Recorder } = require("./record");
const { readSteps, toYaml, targetText } = require("./steps");
const { pickPages, tourSteps } = require("./tour");
const { layoutOf, LOOKS, backdropOf, renderVideo, renderStill } = require("./compose");
const { cameraAt } = require("./motion");
const { findFfmpeg, pickEncoder, startVideo, makeGif, MISSING } = require("./ffmpeg");
const { tagPng, pngSize } = require("./png");
const { setTimeLimit, timeLeft } = require("./time");
const version = require("./version");

const USAGE = `Usage: easyscreenshot demo <url> [options]

Records a short demo video of a website: a tour of the pages worth showing,
or the steps you write in a file. The page plays in a browser window on a
backdrop, with a visible pointer, smooth scrolling and a zoom on each
click. Cookie banners and chat bubbles are hidden, never clicked. Saves
demo.mp4 (1920x1080, H.264), demo.gif, poster.png and steps.json, which
says where every step starts and ends, in seconds and in frames.

Options:
  --steps <file>      follow the steps in this YAML or JSON file instead of
                      a tour: visit, scroll, click, type, wait, hover, key
  --out <dir>         where to save (default: ./easyscreenshot-demo-<host>)
  --pages <n>         pages in the tour, the home page included (default: 4,
                      at most 8)
  --page <path>       take this page in the tour, e.g. --page /pricing
  --zoom <n>          how far a click zooms in, 1 to 2.5 (default: 1.5)
  --no-zoom           no zoom on clicks
  --background <bg>   behind the window: a colour, two colours for a
                      gradient, or a picture file
  --no-frame          the page alone, filling the video
  --fps <n>           frames a second, 24 to 60 (default: 30)
  --theme <name>      light or dark (default: light)
  --lang <code>       the site's version in this language, when it has one
  --hide <css>        hide one more element (repeat for more)
  --reduced-motion    ask the site for its reduced-motion version
  --no-clean          keep the banners and bubbles
  --no-gif            skip demo.gif
  --json              print steps.json instead of a summary
  --timeout <s>       give up after this many seconds (default: 900)
  -h, --help          show this help

Needs Node 22 or newer, Chrome, Chromium, Edge or Brave, and ffmpeg. Set
CHROME_PATH or FFMPEG_PATH to pick them.`;

function parseDemo(argv) {
  const options = { pages: 4, extra: [], hide: [], zoom: 1.5, frame: true, background: "", fps: 30, theme: "light", lang: "", reducedMotion: false, clean: true, gif: true, json: false, timeout: 900 };
  const rest = [];
  const VALUED = new Set(["--steps", "--out", "--pages", "--page", "--zoom", "--background", "--fps", "--theme", "--lang", "--hide", "--timeout"]);
  const set = (name, value) => {
    if (name === "--steps") options.steps = value;
    else if (name === "--out") options.out = value;
    else if (name === "--pages") options.pages = Number(value);
    else if (name === "--page") options.extra.push(value);
    else if (name === "--zoom") options.zoom = Number(value);
    else if (name === "--background") options.background = value;
    else if (name === "--fps") options.fps = Number(value);
    else if (name === "--theme") options.theme = value.toLowerCase();
    else if (name === "--lang") options.lang = value;
    else if (name === "--hide") options.hide.push(value);
    else if (name === "--timeout") options.timeout = Number(value);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "-v" || arg === "--version") options.version = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--no-zoom") options.zoom = 1;
    else if (arg === "--no-frame") options.frame = false;
    else if (arg === "--no-gif") options.gif = false;
    else if (arg === "--no-clean") options.clean = false;
    else if (arg === "--reduced-motion") options.reducedMotion = true;
    else if (VALUED.has(name)) {
      const value = name !== arg ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === "" || (name === arg && value.startsWith("--"))) throw new Error(`${name} needs a value`);
      set(name, value);
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else rest.push(arg);
  }
  if (!(Number.isInteger(options.pages) && options.pages >= 1 && options.pages <= 8)) throw new Error("--pages takes 1 to 8");
  if (!(options.zoom >= 1 && options.zoom <= 2.5)) throw new Error("--zoom takes 1 to 2.5");
  if (!(Number.isInteger(options.fps) && options.fps >= 24 && options.fps <= 60)) throw new Error("--fps takes 24 to 60");
  if (!(options.timeout >= 60 && options.timeout <= 1800)) throw new Error("--timeout takes 60 to 1800 seconds");
  if (!["light", "dark"].includes(options.theme)) throw new Error("--theme takes light or dark");
  if (options.lang && !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(options.lang)) throw new Error(`--lang takes a language code such as tr or pt-BR, not ${options.lang}`);
  if (options.steps && (options.extra.length || argv.some((arg) => arg === "--pages" || arg.startsWith("--pages=")))) throw new Error("--pages and --page are for the tour; a steps file says which pages to visit");
  if (!options.help && !options.version && (rest.length > 1 || (!rest.length && !options.steps))) throw new Error("Give one website address, for example: easyscreenshot demo acme.com");
  return { ...options, url: rest[0] || "" };
}

// Files a demo run writes, by name, and the folder its frames are kept in
// while it runs. demo.yaml is a tour's: a run from a steps file never
// touches it, since that may be the very file it follows.
const RUN_FILE = /^(demo\.mp4|demo\.gif|poster\.png|steps\.json)$/;
const TOUR_FILE = "demo.yaml";
const FRAMES = /^\.frames-[A-Za-z0-9]{6}$/;

// The run's folder: created when missing, reused when an earlier demo made
// it (its files are replaced), refused when it holds anything else, so a
// run never mixes into someone's own files. The steps file the run reads
// may sit in it.
function prepareDemoDir(dir, { steps = "", tour = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const keep = steps ? path.resolve(steps) : "";
  const names = fs.readdirSync(dir).filter((name) => path.resolve(dir, name) !== keep);
  if (names.some((name) => !FRAMES.test(name))) {
    let old = null;
    try {
      old = JSON.parse(fs.readFileSync(path.join(dir, "steps.json"), "utf8"));
    } catch {
      // Not a demo of ours.
    }
    if (!old || old.kind !== "demo" || !/^easyscreenshot /.test(String(old.tool || ""))) {
      throw new Error(`${dir} is not empty and holds no earlier easyscreenshot demo. Pick another folder with --out.`);
    }
  }
  for (const name of names) {
    if (FRAMES.test(name) || RUN_FILE.test(name) || (tour && name === TOUR_FILE)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

// A failed run leaves nothing half made: its own files and frames go, and
// the folder too when this run created it.
function cleanUp(dir, existed, { frames = "", tour = false } = {}) {
  if (!fs.existsSync(dir)) return;
  if (frames) fs.rmSync(frames, { recursive: true, force: true });
  for (const name of fs.readdirSync(dir)) {
    if (RUN_FILE.test(name) || (tour && name === TOUR_FILE)) fs.rmSync(path.join(dir, name), { force: true });
  }
  if (!existed) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // Not empty: what is left there is not this run's.
    }
  }
}

const round = (value, places = 3) => Math.round(value * 10 ** places) / 10 ** places;

function what(step) {
  if (step.label) return step.label;
  if (step.action === "visit") return `Open ${step.url}`;
  if (step.action === "scroll") return step.by !== undefined ? `Scroll ${step.by > 0 ? "down" : "up"} ${Math.abs(step.by)} px` : typeof step.to === "object" ? `Scroll to ${targetText(step.to)}` : `Scroll to ${step.to}`;
  if (step.action === "click") return `Click ${targetText(step.target)}`;
  if (step.action === "hover") return `Point at ${targetText(step.target)}`;
  if (step.action === "type") return `Type "${step.text.length > 30 ? `${step.text.slice(0, 30)}…` : step.text}"`;
  if (step.action === "key") return `Press ${step.key}`;
  if (step.action === "wait") return step.for ? `Wait for ${targetText(step.for)}` : `Wait ${step.seconds} s`;
  return step.action;
}

// A tour's internal steps as a steps file writes them: a click on a link by
// its words when it has some, else by its address.
function asWritten(step) {
  if (step.action !== "click" || !step.target.href) return step;
  const target = step.text ? { text: step.text } : { css: `a[href*="${new URL(step.target.href).pathname}"]` };
  return { action: "click", target, label: step.label };
}

const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

async function makeDemo(rawUrl, options = {}) {
  const {
    dir,
    steps: stepsFile = "",
    pages: wanted = 4,
    extra = [],
    zoom = 1.5,
    frame = true,
    background = "",
    fps = 30,
    theme = "light",
    lang = "",
    hide = [],
    reducedMotion = false,
    clean: tidy = true,
    gif = true,
    timeLimit = 900_000,
    log = () => {},
  } = options;
  setTimeLimit(timeLimit);
  const script = stepsFile ? readSteps(stepsFile) : null;
  const asked = normalizeUrl(rawUrl || (script && script.url) || "");
  const backdrop = backdropOf(background);
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error(MISSING);
  const encoder = await pickEncoder(ffmpeg);
  if (!encoder) throw new Error(`${ffmpeg} has no H.264 encoder (x264, VideoToolbox, OpenH264 or Media Foundation). Install a full build of ffmpeg.`);
  const target = dir || `easyscreenshot-demo-${siteOf(asked)}`;
  const existed = fs.existsSync(target);
  prepareDemoDir(target, { steps: stepsFile, tour: !script });
  const frames = fs.mkdtempSync(path.join(target, ".frames-"));
  const viewport = { width: 1600, height: 900 };
  // Drawn at least as sharp as the zoom goes deep, so a zoomed-in view is
  // not blown up: 1.5 pixels per CSS pixel for the default zoom.
  const density = Math.min(2, Math.max(zoom, frame ? 1 : 1.2));
  const notes = [];
  const records = [];
  let take;
  let tour = null;
  let name = "";
  try {
    const chrome = await launch({ lang, args: [`--force-device-scale-factor=${density}`] });
    const recorder = new Recorder(chrome, { dir: frames, base: asked, fps, viewport, hide: [...hide, ...(script ? script.hide : [])], clean: tidy, theme, lang, reducedMotion, log });
    try {
      if (!script) {
        tour = await pickPages(chrome, asked, { pages: wanted, extra, lang, theme, reducedMotion, log });
        name = tour.site;
        for (const skip of tour.skipped.slice(0, 8)) notes.push(`Left out ${skip.url}: ${skip.reason}.`);
      }
      await recorder.open();
      log("Recording");
      // A steps file that does not start somewhere starts at the address
      // given; its own steps keep their numbers in what goes wrong.
      const added = script && script.steps[0].action !== "visit" ? 1 : 0;
      const steps = script ? [...(added ? [{ action: "visit", url: asked }] : []), ...script.steps] : tourSteps(recorder, tour.pages);
      let n = 0;
      for await (const step of steps) {
        n++;
        if (timeLeft() < 60_000) throw new Error("time ran out while recording; give more with --timeout");
        log(`${added && n === 1 ? "  " : String(n - added).padStart(2, "0")} ${what(step)}`);
        let record;
        try {
          record = await recorder.run(step);
        } catch (err) {
          throw new Error(added && n === 1 ? `opening ${asked}: ${err.message}` : `step ${n - added} (${step.action}): ${err.message}`);
        }
        records.push({ n: n - added, step, ...record });
        if (step.expect && record.opened && new URL(record.opened).pathname !== new URL(step.expect).pathname) notes.push(`The link for ${step.expect} led to ${record.opened}.`);
      }
      take = await recorder.finish();
      if (!name && take.pages[0]) name = take.pages[0].siteName || new URL(asked).hostname.replace(/^www\./, "");
    } finally {
      await recorder.close();
      await chrome.close();
    }
    if (!take.frames.length) throw new Error("No frame was recorded.");
    if (take.slow) notes.push("A page drew slowly in this browser, so it was recorded in slow motion and played back at speed; its own animations look right, scripted ones may run fast.");

    // The video.
    const look = { ...LOOKS[take.lightness < 0.45 ? "dark" : "light"], ...(backdrop ? { backdrop } : {}) };
    const layout = layoutOf({ frame, viewport });
    const composer = await launch();
    let drawn;
    let poster;
    const video = path.join(target, "demo.mp4");
    try {
      if (timeLeft() < 120_000) setTimeLimit(Math.max(120_000, take.duration * 6_000));
      const sink = startVideo(ffmpeg, video, { fps, encoder, title: `${name} demo` });
      try {
        drawn = await renderVideo(composer, take, { layout, look, zoom, dir: frames, sink, log });
        log("Encoding demo.mp4");
        await sink.end();
      } catch (err) {
        sink.kill();
        throw err;
      }
      // The poster: the first page at rest, before anything moves on it.
      const still = Math.min(take.duration, ...take.scrolls.map((s) => s.t0), ...take.cuts.map((c) => c.t), take.shownAt === null ? Infinity : take.shownAt);
      const posterAt = Math.max(0, Math.min(1, still - 0.05, take.duration - 1 / fps));
      poster = { at: round(posterAt), png: await renderStill(composer, take, { layout, look, zoom, dir: frames, t: posterAt }) };
    } finally {
      await composer.close();
    }
    const png = tagPng(poster.png, { Title: `${name} demo`, Source: asked, "Creation Time": new Date().toISOString(), Software: `easyscreenshot ${version}` });
    fs.writeFileSync(path.join(target, "poster.png"), png);
    let gifInfo = null;
    if (gif) {
      log("Making demo.gif");
      gifInfo = await makeGif(ffmpeg, video, path.join(target, "demo.gif"), { dir: frames });
      if (gifInfo.overBudget) notes.push(`demo.gif is ${(gifInfo.bytes / 1048576).toFixed(1)} MB even at ${gifInfo.width} px wide; a shorter demo makes a smaller GIF.`);
    }

    // Where each step lands in the video.
    const frameOf = (t) => Math.round(t * fps);
    const toVideo = (t, point) => {
      const cam = cameraAt(drawn.regions, t, viewport);
      const k = layout.scale * cam.z;
      return [Math.round(layout.content.x + (point.x - cam.x) * k), Math.round(layout.content.y + (point.y - cam.y) * k)];
    };
    const steps = records.map((record) => {
      const { step } = record;
      const written = asWritten(step);
      const entry = { n: record.n, action: step.action, label: what(step) };
      if (step.action === "visit") entry.url = record.url;
      if (written.target) entry.target = targetText(written.target);
      if (step.into) entry.target = targetText(step.into);
      if (step.text !== undefined && step.action === "type") entry.text = step.text;
      if (step.key) entry.key = step.key;
      if (step.note) entry.note = step.note;
      Object.assign(entry, { start: round(record.start), end: round(Math.max(record.start, record.end)), startFrame: frameOf(record.start), endFrame: frameOf(Math.max(record.start, record.end)) });
      // Where and when the pointer pressed, in the video's pixels: for a
      // callout, or a click sound laid on that frame.
      if (record.at && record.pressed !== undefined) Object.assign(entry, { at: toVideo(record.pressed, record.at), pressedAt: round(record.pressed), pressedFrame: frameOf(record.pressed) });
      else if (record.at) entry.at = toVideo(record.end, record.at);
      if (record.opened) entry.opened = record.opened;
      entry.page = record.url;
      return entry;
    });
    // The pages in the order they were shown; an address that comes again
    // right after itself is the same page.
    const changes = take.urls.filter((change, i) => i === 0 || change.url.split("#")[0] !== take.urls[i - 1].url.split("#")[0]);
    const pagesShown = changes.map((change, i) => {
      const end = i + 1 < changes.length ? changes[i + 1].t : take.duration;
      const known = take.pages.find((page) => page.url === change.url);
      const picked = tour && tour.pages.find((page) => pageKey(page.url) === pageKey(change.url));
      return {
        n: i + 1,
        url: change.url,
        title: known ? known.title : "",
        ...(picked ? { kind: picked.kind, why: picked.why } : {}),
        start: round(change.t),
        end: round(end),
        startFrame: frameOf(change.t),
        endFrame: frameOf(end),
      };
    });
    const total = drawn.frames;
    const manifest = {
      version: 1,
      kind: "demo",
      tool: `easyscreenshot ${version}`,
      url: asked,
      site: name,
      madeAt: new Date().toISOString(),
      video: { file: "demo.mp4", width: layout.width, height: layout.height, fps, frames: total, duration: round(total / fps), codec: "h264", encoder: encoder.name },
      gif: gifInfo ? { file: "demo.gif", width: gifInfo.width, height: gifInfo.height, fps: gifInfo.fps, bytes: gifInfo.bytes } : null,
      poster: { file: "poster.png", ...pngSize(png), at: poster.at },
      page: { viewport, density, box: [layout.content.x, layout.content.y, layout.content.width, layout.content.height], framed: layout.frame },
      zoom,
      pages: pagesShown,
      steps,
      notes,
    };
    fs.writeFileSync(path.join(target, "steps.json"), JSON.stringify(manifest, null, 2) + "\n");
    if (tour) {
      const header = [`The tour easyscreenshot ${version} took of ${new URL(asked).hostname.replace(/^www\./, "")}.`, "Edit it and record again: easyscreenshot demo --steps demo.yaml"];
      fs.writeFileSync(path.join(target, "demo.yaml"), toYaml({ url: asked, steps: records.map((record) => asWritten(record.step)) }, header));
    }
    fs.rmSync(frames, { recursive: true, force: true });
    return { dir: target, manifest };
  } catch (err) {
    cleanUp(target, existed, { frames, tour: !script });
    throw err;
  }
}

function summary({ dir, manifest }) {
  const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
  const size = (file) => {
    try {
      return mb(fs.statSync(path.join(dir, file)).size);
    } catch {
      return "";
    }
  };
  const lines = [`Recorded a ${Math.round(manifest.video.duration)} s demo of ${new URL(manifest.url).hostname.replace(/^www\./, "")} in ${dir}`, ""];
  lines.push(`  demo.mp4    ${manifest.video.width}x${manifest.video.height}, ${manifest.video.fps} fps, ${size("demo.mp4")}`);
  if (manifest.gif) lines.push(`  demo.gif    ${manifest.gif.width}x${manifest.gif.height}, ${manifest.gif.fps} fps, ${mb(manifest.gif.bytes)}`);
  lines.push(`  poster.png  ${manifest.poster.width}x${manifest.poster.height}`);
  lines.push(`  steps.json  ${manifest.steps.length} steps with their start and end, in seconds and frames`);
  if (fs.existsSync(path.join(dir, "demo.yaml"))) lines.push("  demo.yaml   the tour as steps: edit it and record again with --steps");
  lines.push("");
  for (const step of manifest.steps) lines.push(`  ${clock(step.start).padStart(5)}  ${step.label}`);
  for (const note of manifest.notes) lines.push("", `  Note: ${note}`);
  return lines.join("\n");
}

async function main(argv) {
  let options;
  try {
    options = parseDemo(argv);
  } catch (err) {
    process.stderr.write(`easyscreenshot demo: ${err.message}\n\n${USAGE}\n`);
    process.exit(2);
  }
  if (options.help) return void process.stdout.write(`${USAGE}\n`);
  if (options.version) return void process.stdout.write(`${version}\n`);
  try {
    const result = await makeDemo(options.url, {
      dir: options.out,
      steps: options.steps,
      pages: options.pages,
      extra: options.extra,
      zoom: options.zoom,
      frame: options.frame,
      background: options.background,
      fps: options.fps,
      theme: options.theme,
      lang: options.lang,
      hide: options.hide,
      reducedMotion: options.reducedMotion,
      clean: options.clean,
      gif: options.gif,
      timeLimit: options.timeout * 1000,
      log: options.json ? () => {} : (line) => process.stderr.write(`${line}\n`),
    });
    process.stdout.write(options.json ? JSON.stringify(result.manifest, null, 2) + "\n" : summary(result) + "\n");
  } catch (err) {
    if (options.json) process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + "\n");
    process.stderr.write(`easyscreenshot demo: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { main, makeDemo, parseDemo, prepareDemoDir, summary, USAGE };
