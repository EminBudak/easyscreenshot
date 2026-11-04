"use strict";

// The demo command: its options and folder without a browser, then whole
// recordings in a real headless browser with ffmpeg (skipped when either is
// missing) against a small site served from this process. The video is
// checked frame by frame by its colours: what was scrolled to, clicked,
// typed and hidden, and that a click zooms in.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");
const { parseDemo, prepareDemoDir, makeDemo } = require("../skills/easyscreenshot/scripts/lib/demo");
const { readSteps } = require("../skills/easyscreenshot/scripts/lib/steps");
const { findChrome } = require("../skills/easyscreenshot/scripts/lib/chrome");
const { findFfmpeg } = require("../skills/easyscreenshot/scripts/lib/ffmpeg");
const { readPng, serve, near } = require("./helpers");

const CLI = path.resolve(__dirname, "../skills/easyscreenshot/scripts/easyscreenshot.js");
const ffmpeg = findFfmpeg();
const missing = !findChrome() ? "no Chrome, Chromium, Edge or Brave installed" : !ffmpeg ? "no ffmpeg installed" : false;

const GREEN = [0, 160, 0];
const PURPLE = [120, 0, 200];
const RED = [200, 0, 0];
const ORANGE = [255, 140, 0];
const YELLOW = [250, 220, 0];
const BLUE = [0, 0, 220];
const MAGENTA = [255, 0, 255];
const TEAL = [0, 200, 200];

test("demo options: defaults, flags, and what is refused", () => {
  const plain = parseDemo(["acme.com"]);
  assert.equal(plain.url, "acme.com");
  assert.equal(plain.pages, 4);
  assert.equal(plain.zoom, 1.5);
  assert.equal(plain.fps, 30);
  assert.equal(plain.frame, true);
  assert.equal(plain.gif, true);
  const set = parseDemo(["acme.com", "--pages=6", "--page", "/pricing", "--zoom", "2", "--no-frame", "--no-gif", "--background", "#111,#333", "--fps", "60", "--hide", ".promo", "--theme", "Dark", "--json", "--out", "x"]);
  assert.deepEqual([set.pages, set.extra, set.zoom, set.frame, set.gif, set.background, set.fps, set.hide, set.theme, set.json, set.out], [6, ["/pricing"], 2, false, false, "#111,#333", 60, [".promo"], "dark", true, "x"]);
  assert.equal(parseDemo(["acme.com", "--no-zoom"]).zoom, 1);
  // A steps file may carry the address itself.
  assert.equal(parseDemo(["--steps", "demo.yaml"]).url, "");
  assert.throws(() => parseDemo([]), /Give one website address/);
  assert.throws(() => parseDemo(["acme.com", "--pages", "12"]), /--pages takes 1 to 8/);
  assert.throws(() => parseDemo(["acme.com", "--zoom", "4"]), /--zoom takes 1 to 2.5/);
  assert.throws(() => parseDemo(["acme.com", "--fps", "29.97"]), /--fps takes 24 to 60/);
  assert.throws(() => parseDemo(["acme.com", "--steps", "a.yaml", "--page", "/x"]), /a steps file says which pages/);
  assert.throws(() => parseDemo(["acme.com", "--theme", "both"]), /light or dark/);
  assert.throws(() => parseDemo(["acme.com", "--wat"]), /Unknown option/);
});

test("the CLI hands demo to its own command, with its own help", () => {
  const help = spawnSync(process.execPath, [CLI, "demo", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: easyscreenshot demo <url>/);
  const none = spawnSync(process.execPath, [CLI, "demo"], { encoding: "utf8" });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /easyscreenshot demo: Give one website address/);
  assert.match(spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" }).stdout, /easyscreenshot demo <url>/);
});

test("a demo never writes into a folder that holds someone else's files, and replaces an earlier demo's", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easyscreenshot-demo-dir-"));
  const earlier = () => fs.writeFileSync(path.join(dir, "steps.json"), JSON.stringify({ version: 1, kind: "demo", tool: "easyscreenshot 0.1.0" }));
  try {
    fs.writeFileSync(path.join(dir, "notes.txt"), "mine");
    // A folder of someone else's is refused, and nothing in it is touched,
    // not even a folder that looks like the frames of a run.
    fs.mkdirSync(path.join(dir, ".frames-cache"));
    assert.throws(() => prepareDemoDir(dir), /not empty/);
    assert.ok(fs.existsSync(path.join(dir, ".frames-cache")));
    fs.rmSync(path.join(dir, "notes.txt"));
    fs.rmSync(path.join(dir, ".frames-cache"), { recursive: true });
    earlier();
    fs.writeFileSync(path.join(dir, "demo.mp4"), "old");
    fs.writeFileSync(path.join(dir, "demo.yaml"), "steps:\n  - wait: 1\n");
    fs.writeFileSync(path.join(dir, "keep-me.txt"), "mine");
    // The frames a stopped run left behind go too.
    fs.mkdirSync(path.join(dir, ".frames-abc123"));
    fs.writeFileSync(path.join(dir, ".frames-abc123", "f000001.jpg"), "x");
    // Recording again from the tour's own demo.yaml, edited: it stays.
    prepareDemoDir(dir, { steps: path.join(dir, "demo.yaml") });
    assert.deepEqual(fs.readdirSync(dir).sort(), ["demo.yaml", "keep-me.txt"]);
    // A new tour replaces the old tour's demo.yaml.
    earlier();
    prepareDemoDir(dir, { tour: true });
    assert.deepEqual(fs.readdirSync(dir).sort(), ["keep-me.txt"]);
    // A folder that holds only the steps file is the run's to use.
    fs.rmSync(path.join(dir, "keep-me.txt"));
    fs.writeFileSync(path.join(dir, "flow.yaml"), "steps:\n  - wait: 1\n");
    prepareDemoDir(dir, { steps: path.join(dir, "flow.yaml") });
    assert.deepEqual(fs.readdirSync(dir), ["flow.yaml"]);
    // A screenshots run is not a demo.
    fs.writeFileSync(path.join(dir, "steps.json"), JSON.stringify({ version: 1, tool: "easyscreenshot 0.1.0" }));
    assert.throws(() => prepareDemoDir(dir), /no earlier easyscreenshot demo/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const page = (title, body, style = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;font-family:sans-serif}${style}</style></head><body>${body}</body></html>`;

// The home page: a menu, a green hero with a black button that turns it
// purple and a form, a red and an orange section, and floating over it a
// blue cookie bar and a magenta chat bubble.
const HOME = page(
  "Acme | Tools for teams",
  `<header><a href="/">Acme</a><nav><a href="/features">Features</a><a href="/pricing">Pricing</a><a href="/login">Log in</a></nav></header>
  <div class="hero"><h1>Tools for teams</h1><button id="go" aria-label="Go"></button>
  <form action="/thanks"><input id="email" name="email" placeholder="Email"></form></div>
  <section class="fast"><h2>Fast</h2></section>
  <section class="simple"><h2>Simple</h2></section>
  <footer>Acme</footer>
  <div class="cookie">We use cookies</div><div class="chat"></div>
  <script>document.getElementById("go").onclick = () => { document.querySelector(".hero").style.background = "rgb(120,0,200)"; };</script>`,
  `header{height:70px;display:flex;align-items:center;gap:40px;padding:0 40px;font-size:22px;background:#fff}
  nav{display:flex;gap:30px}
  .hero{height:820px;background:rgb(0,160,0);position:relative}
  h1{margin:0;padding:40px;font-size:48px}
  #go{position:absolute;left:200px;top:300px;width:240px;height:80px;background:rgb(0,0,0);border:0}
  form{position:absolute;left:200px;top:500px}
  input{width:400px;height:50px;font-size:24px}
  section{height:900px}
  h2{margin:0;padding:40px}
  .fast{background:rgb(200,0,0)}
  .simple{background:rgb(255,140,0)}
  footer{height:300px;background:rgb(30,30,30)}
  .cookie{position:fixed;left:0;right:0;bottom:0;height:70px;background:rgb(0,0,220);z-index:9}
  .chat{position:fixed;right:24px;bottom:100px;width:60px;height:60px;border-radius:30px;background:rgb(255,0,255);z-index:9}`,
);

const plain = (title, color) => page(`${title} | Acme`, `<header><a href="/">Acme</a> <a href="/features">Features</a> <a href="/pricing">Pricing</a></header><h1>${title}</h1><div style="height:2400px;background:${color}"><h2 style="margin:0;padding-top:900px">More</h2></div>`, "header{height:70px;font-size:22px}");

async function fixture() {
  const seen = [];
  const { server, origin } = await serve((req, res) => {
    seen.push(req.url);
    const html = (body) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/") return html(HOME);
    if (url.pathname === "/features") return html(plain("Features", "rgb(0,200,200)"));
    if (url.pathname === "/pricing") return html(plain("Pricing", "rgb(0,120,255)"));
    if (url.pathname === "/login") return html(plain("Log in", "#eee"));
    if (url.pathname === "/thanks") return html(page("Thanks | Acme", `<h1>Thanks, ${String(url.searchParams.get("email")).replace(/[<>&]/g, "")}</h1><div style="height:1400px"></div>`, "body{background:rgb(250,220,0)}"));
    res.writeHead(404).end("not found");
  });
  return { server, origin, seen };
}

// A frame of the video as a PNG, decoded by ffmpeg.
function frameOf(video, t) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-v", "error", "-ss", String(t), "-i", video, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"]);
    const chunks = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.on("close", (code) => (code === 0 ? resolve(readPng(Buffer.concat(chunks))) : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

function probe(video) {
  const ffprobe = path.join(path.dirname(ffmpeg), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  const out = spawnSync(fs.existsSync(ffprobe) ? ffprobe : "ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=codec_name,width,height,r_frame_rate,pix_fmt,nb_read_frames", "-of", "json", video], { encoding: "utf8" });
  return JSON.parse(out.stdout).streams[0];
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "easyscreenshot-demo-run-"));
// The page's CSS pixel (x, y) in the video when it is not zoomed: the
// window's content starts at (160, 112), one video pixel per CSS pixel.
const unzoomed = (png, x, y) => png.pixel(160 + x, 112 + y);

test("a scripted demo: scroll, click, type and a form sent with Enter, in an MP4, a GIF, a poster and steps.json", { skip: missing, timeout: 300_000 }, async () => {
  const { server, origin, seen } = await fixture();
  const root = tempDir();
  const dir = path.join(root, "demo");
  const steps = path.join(root, "demo.yaml");
  fs.writeFileSync(
    steps,
    `steps:
  - visit: /
  - wait: 0.6
  - scroll: { to: "text=Simple" }
  - wait: 0.6
  - scroll: top
  - click: "#go"
  - type: ada@example.com
    into: "#email"
  - key: Enter
  - wait: "text=Thanks"
  - wait: 0.6
`,
  );
  try {
    const { manifest } = await makeDemo(origin, { dir, steps, timeLimit: 280_000 });
    assert.deepEqual(fs.readdirSync(dir).sort(), ["demo.gif", "demo.mp4", "poster.png", "steps.json"]);

    // The video: H.264, 1920x1080, 30 frames a second, as long as steps.json says.
    const stream = probe(path.join(dir, "demo.mp4"));
    assert.deepEqual([stream.codec_name, stream.width, stream.height, stream.r_frame_rate, stream.pix_fmt], ["h264", 1920, 1080, "30/1", "yuv420p"]);
    assert.equal(Number(stream.nb_read_frames), manifest.video.frames);
    assert.equal(manifest.video.duration, Math.round((manifest.video.frames / 30) * 1000) / 1000);

    // Every step with its start and end, in seconds and frames, in order.
    assert.deepEqual(manifest.steps.map((s) => s.action), ["visit", "wait", "scroll", "wait", "scroll", "click", "type", "key", "wait", "wait"]);
    for (const [i, s] of manifest.steps.entries()) {
      assert.ok(s.start <= s.end, `${s.n} ${s.label}`);
      assert.equal(s.startFrame, Math.round(s.start * 30));
      assert.equal(s.endFrame, Math.round(s.end * 30));
      if (i) assert.ok(s.start >= manifest.steps[i - 1].start, `${s.n} starts after the step before it`);
    }
    const [, firstWait, , scrolled, , click, typed, enter] = manifest.steps;
    assert.ok(Math.abs(firstWait.end - firstWait.start - 0.6) < 0.05, "a wait lasts its seconds in the video");
    assert.equal(enter.opened, `${origin}/thanks?email=ada%40example.com`);
    assert.deepEqual(manifest.pages.map((p) => new URL(p.url).pathname), ["/", "/thanks"]);
    assert.ok(seen.includes("/thanks?email=ada%40example.com"), "the form was sent with what was typed");

    // The poster: the home page, the cookie bar and the chat bubble hidden.
    const poster = readPng(path.join(dir, "poster.png"));
    assert.deepEqual([poster.width, poster.height], [1920, 1080]);
    assert.ok(near(unzoomed(poster, 800, 400), GREEN), `hero: ${unzoomed(poster, 800, 400)}`);
    assert.ok(!near(unzoomed(poster, 800, 870), BLUE), "cookie bar hidden");
    assert.ok(!near(unzoomed(poster, 1546, 770), MAGENTA), "chat bubble hidden");

    // Scrolled to the orange section, and held there.
    const held = await frameOf(path.join(dir, "demo.mp4"), (scrolled.start + scrolled.end) / 2);
    assert.ok(near(unzoomed(held, 800, 450), ORANGE), `scrolled to Simple: ${unzoomed(held, 800, 450)}`);
    assert.ok(!near(unzoomed(held, 800, 870), BLUE), "cookie bar still hidden");

    // The click: zoomed in 1.5 times by the time it lands, so the 240 px
    // button is 360 px wide in the video, then the hero turns purple and a
    // white ring shows where it landed.
    const [x, y] = click.at;
    assert.ok(x > 160 && x < 1760 && y > 112 && y < 1012, `the click is inside the window: ${click.at}`);
    assert.ok(click.pressedAt > click.start && click.pressedAt < click.end && click.pressedFrame === Math.round(click.pressedAt * 30));
    const zoomed = await frameOf(path.join(dir, "demo.mp4"), click.pressedAt - 0.05);
    let left = x;
    let right = x;
    while (left > 160 && near(zoomed.pixel(left - 1, y - 20), [0, 0, 0], 40)) left--;
    while (right < 1759 && near(zoomed.pixel(right + 1, y - 20), [0, 0, 0], 40)) right++;
    assert.ok(Math.abs(right - left + 1 - 360) <= 12, `the button is ${right - left + 1} px wide`);
    assert.ok(near(zoomed.pixel(x, y - 75), GREEN), `the hero before the click: ${zoomed.pixel(x, y - 75)}`);
    const ring = await frameOf(path.join(dir, "demo.mp4"), click.pressedAt + 0.2);
    assert.ok(near(ring.pixel(x, y - 75), PURPLE), `the hero turned purple: ${ring.pixel(x, y - 75)}`);
    // Over the black button, the fading white ring is the only light thing
    // on either side of where the click landed.
    const light = (dx) => ring.pixel(x + dx, y).reduce((sum, v) => sum + v, 0) / 3 > 70;
    assert.ok([...Array(60).keys()].some((i) => light(20 + i)) && [...Array(60).keys()].some((i) => light(-20 - i)), "a ring is drawn around the click");

    // Typing went into the field, zoomed in on it.
    assert.ok(typed.end - typed.start > 1, "typing takes its time");
    // The end: the thank-you page.
    const end = await frameOf(path.join(dir, "demo.mp4"), manifest.video.duration - 0.1);
    assert.ok(near(unzoomed(end, 800, 600), YELLOW), `the thank-you page: ${unzoomed(end, 800, 600)}`);

    // The GIF.
    const gif = fs.readFileSync(path.join(dir, "demo.gif"));
    assert.equal(gif.toString("latin1", 0, 6), "GIF89a");
    assert.equal(gif.readUInt16LE(6), manifest.gif.width);
    assert.ok(manifest.gif.bytes <= 8 * 1024 * 1024);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a tour: the pages the menu puts forward, clicked through the menu, pricing last, and the tour written as steps", { skip: missing, timeout: 300_000 }, async () => {
  const { server, origin, seen } = await fixture();
  const root = tempDir();
  const dir = path.join(root, "tour");
  try {
    const { manifest } = await makeDemo(origin, { dir, pages: 3, gif: false, timeLimit: 280_000 });
    assert.deepEqual(manifest.pages.map((p) => new URL(p.url).pathname), ["/", "/features", "/pricing"]);
    assert.ok(!seen.includes("/login"), "a sign-in page is never opened");
    const clicks = manifest.steps.filter((s) => s.action === "click");
    assert.deepEqual(clicks.map((s) => s.label), ['Click "Features"', 'Click "Pricing"']);
    assert.ok(manifest.steps.some((s) => s.action === "scroll" && s.label === 'Scroll to "Fast"'), manifest.steps.map((s) => s.label).join(", "));
    assert.equal(manifest.gif, null);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["demo.mp4", "demo.yaml", "poster.png", "steps.json"]);
    // The tour as a steps file, which reads back as the same steps.
    const again = readSteps(path.join(dir, "demo.yaml"));
    assert.equal(again.url, `${origin}/`);
    assert.deepEqual(again.steps.map((s) => s.action), manifest.steps.map((s) => s.action));
    assert.deepEqual(again.steps.filter((s) => s.action === "click").map((s) => s.target), [{ text: "Features" }, { text: "Pricing" }]);
    // The features page, in the middle of the video.
    const middle = await frameOf(path.join(dir, "demo.mp4"), (manifest.pages[1].start + manifest.pages[1].end) / 2);
    assert.ok(near(unzoomed(middle, 800, 700), TEAL) || near(unzoomed(middle, 800, 400), TEAL), `features: ${unzoomed(middle, 800, 700)}`);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a step that points at nothing stops the run with its number and leaves nothing behind", { skip: missing, timeout: 120_000 }, async () => {
  const { server, origin } = await fixture();
  const root = tempDir();
  const dir = path.join(root, "demo");
  const steps = path.join(root, "demo.yaml");
  fs.writeFileSync(steps, "steps:\n  - visit: /\n  - click: 'text=Not on this page'\n");
  try {
    await assert.rejects(makeDemo(origin, { dir, steps, timeLimit: 100_000 }), /step 2 \(click\): nothing on the page matches text=Not on this page/);
    assert.equal(fs.existsSync(dir), false);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
