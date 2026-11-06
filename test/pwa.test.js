"use strict";

// Screenshots for a web app manifest, without a browser: reading image
// files, Chrome's rules, the screenshots a run hands over, finding and
// checking a manifest, and --pwa-check on the command line.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { imageInfo, checkScreenshots, labelOf, planPwa, manifestLink, checkManifest, describeCheck } = require("../skills/easyscreenshotkit/scripts/lib/pwa");
const { parseSizes, addPwaShots, prepareDir } = require("../skills/easyscreenshotkit/scripts/lib/shots");
const { parse } = require("../skills/easyscreenshotkit/scripts/easyscreenshotkit");
const { pngOf, serve } = require("./helpers");

const CLI = path.resolve(__dirname, "../skills/easyscreenshotkit/scripts/easyscreenshotkit.js");

// The first bytes of an image, as much as its size is read from.
function pngHead(width, height) {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  head[24] = 8;
  head[25] = 2;
  return head;
}

function jpegHead(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

function webpHead(width, height) {
  const head = Buffer.alloc(30);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(22, 4);
  head.write("WEBPVP8X", 8, "latin1");
  head.writeUInt32LE(10, 16);
  head.writeUIntLE(width - 1, 24, 3);
  head.writeUIntLE(height - 1, 27, 3);
  return head;
}

const WIDE = { format: "png", width: 1920, height: 1080 };
const NARROW = { format: "png", width: 1080, height: 1920 };
const entry = (n, form, size = form === "wide" ? "1920x1080" : "1080x1920") => ({ src: `s/${form}-${n}.png`, sizes: size, type: "image/png", form_factor: form, label: `Screen ${n}` });

test("image files: format and size from their first bytes", () => {
  assert.deepEqual(imageInfo(pngOf(4, 3, () => [0, 0, 0])), { format: "png", width: 4, height: 3 });
  assert.deepEqual(imageInfo(jpegHead(1280, 720)), { format: "jpeg", width: 1280, height: 720 });
  assert.deepEqual(imageInfo(webpHead(1080, 1920)), { format: "webp", width: 1080, height: 1920 });
  assert.deepEqual(imageInfo(Buffer.concat([Buffer.from("GIF89a"), Buffer.from([0x40, 0x01, 0xf0, 0x00]), Buffer.alloc(8)])), { format: "gif", width: 320, height: 240 });
  assert.equal(imageInfo(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')).format, "svg");
  assert.equal(imageInfo(Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavif"), Buffer.alloc(8)])).format, "avif");
  assert.deepEqual(imageInfo(Buffer.from("<!doctype html><html></html>")), { format: "", width: 0, height: 0 });
});

test("Chrome's rules: wide ones on desktops, the rest on phones, sizes from 320 to 3840, at most 2.3 to 1", () => {
  const good = checkScreenshots([entry(1, "wide"), entry(2, "wide"), entry(3, "narrow"), entry(4, "narrow")], [WIDE, WIDE, NARROW, NARROW]);
  assert.equal(good.ok, true);
  assert.deepEqual([good.desktop, good.phone, good.problems, good.tips], [[1, 2], [3, 4], [], []]);

  // No form factor counts for phones only.
  const plain = checkScreenshots([{ ...entry(1, "wide"), form_factor: undefined }], [WIDE]);
  assert.deepEqual([plain.desktop, plain.phone], [[], [1]]);
  assert.match(plain.problems[0], /Desktops get the plain install dialog: no screenshot has form_factor "wide"/);

  const sizes = [
    [{ format: "png", width: 300, height: 600 }, /300x600, a side under 320 pixels/],
    [{ format: "png", width: 4000, height: 2000 }, /4000x2000, a side over 3840 pixels/],
    [{ format: "png", width: 1000, height: 2400 }, /1000x2400, 2\.40 times as high as wide, more than 2\.3/],
  ];
  for (const [image, words] of sizes) {
    const report = checkScreenshots([{ ...entry(1, "narrow"), sizes: `${image.width}x${image.height}` }], [image]);
    assert.deepEqual(report.phone, [], words.source);
    assert.match(report.problems.join("\n"), words);
  }
  const edge = checkScreenshots([{ ...entry(1, "narrow"), sizes: "1000x2300" }], [{ format: "png", width: 1000, height: 2300 }]);
  assert.deepEqual(edge.phone, [1], "2.3 times is still in");

  // One shape per form factor: the first one kept sets it.
  const shapes = checkScreenshots([entry(1, "wide"), entry(2, "wide", "1280x800"), entry(3, "narrow")], [WIDE, { format: "png", width: 1280, height: 800 }, NARROW]);
  assert.deepEqual([shapes.desktop, shapes.phone], [[1], [3]]);
  assert.match(shapes.problems.join("\n"), /Screenshot 2 \(s\/wide-2\.png\): a different shape from screenshot 1 \(1920x1080\)/);
});

test("Chrome's rules: only the first 8 of the list, whatever their form factor, and 5 on a phone", () => {
  const list = [...Array.from({ length: 8 }, (_, i) => entry(i + 1, "wide")), entry(9, "narrow"), entry(10, "narrow")];
  const report = checkScreenshots(list, [...Array(8).fill(WIDE), NARROW, NARROW]);
  assert.deepEqual([report.desktop, report.phone], [[1, 2, 3, 4, 5, 6, 7, 8], []]);
  assert.match(report.problems.join("\n"), /Phones get the plain install dialog/);
  assert.match(report.problems.join("\n"), /so screenshots 9 and 10 never show/);

  const phones = checkScreenshots(Array.from({ length: 6 }, (_, i) => entry(i + 1, "narrow")), Array(6).fill(NARROW));
  assert.deepEqual(phones.phone, [1, 2, 3, 4, 5]);
  assert.match(phones.problems.join("\n"), /Screenshot 6 \(s\/narrow-6\.png\): past the 5 that DevTools says a phone shows/);
});

test("Chrome's rules: sizes, type, label and description, the same words grouped", () => {
  const list = [
    { src: "a.png", form_factor: "wide" },
    { src: "b.png", sizes: "540x960", form_factor: "narrow" },
    { src: "c.webp", sizes: "any", type: "image/png", form_factor: "narrow" },
    { src: "d.png", sizes: "big", type: "image/png", form_factor: "phone", label: "D" },
    { src: "e.png", sizes: "1280x720", type: "image/png", form_factor: "wide", label: "E" },
  ];
  const report = checkScreenshots(list, [WIDE, NARROW, { format: "webp", width: 1080, height: 1920 }, NARROW, WIDE], { description: "x".repeat(320) });
  const problems = report.problems.join("\n");
  assert.match(problems, /Screenshot 1 \(a\.png\): no sizes, so Chrome shows a copy scaled down to 569x320\./);
  assert.match(problems, /Screenshot 2 \(b\.png\): sizes says 540x960 and the file is 1080x1920, so Chrome shows a copy scaled down to 540x960\./);
  // Chrome takes the longer side given as the height it scales to, so a
  // wide picture given as smaller keeps its size.
  assert.ok(problems.includes("Screenshot 5 (e.png): sizes says 1280x720 and the file is 1920x1080."), problems);
  assert.match(problems, /Screenshot 3 \(c\.webp\): WebP, and Chrome's rules take JPEG and PNG\./);
  assert.match(problems, /Screenshot 3 \(c\.webp\): sizes starts with "any"; give the size in pixels, 1080x1920\./);
  assert.match(problems, /Screenshot 4 \(d\.png\): sizes "big" is not WIDTHxHEIGHT\./);
  const tips = report.tips.join("\n");
  assert.match(tips, /Screenshots 1 and 2: no type; add "image\/png"\./);
  assert.match(tips, /Screenshots 1 to 3: no label, the text screen readers read out\./);
  assert.match(tips, /Screenshot 3 \(c\.webp\): type says image\/png and the file is WebP\./);
  assert.match(tips, /Screenshot 4 \(d\.png\): form_factor "phone" is neither "wide" nor "narrow", which Chrome takes as none: phones only\./);
  assert.match(tips, /The description has 320 characters, and Chrome shows about 300 of them\./);
  assert.match(checkScreenshots([], [], { description: "" }).tips.join("\n"), /There is no description/);

  assert.match(checkScreenshots(undefined).problems[0], /There are no screenshots/);
  assert.match(checkScreenshots({ src: "a.png" }).problems[0], /"screenshots" is not a list/);
  const broken = checkScreenshots([{ sizes: "1x1" }, { src: "gone.png" }], [undefined, { error: "answered 404" }]);
  assert.match(broken.problems.join("\n"), /Screenshot 1: no src\./);
  assert.match(broken.problems.join("\n"), /Screenshot 2 \(gone\.png\): could not be loaded \(answered 404\)\./);
});

test("a run's screenshots: checked, labelled from the screen's main heading, 4 wide and 4 narrow at most", () => {
  assert.equal(labelOf([{ text: "Plans", level: 2 }, { text: "Pricing", level: 1 }], {}), "Pricing");
  assert.equal(labelOf([{ text: "Menu", level: 3 }, { text: "Plans", level: 2 }], {}), "Plans");
  assert.equal(labelOf([], { heading: "", title: "Acme | Home", slug: "home" }), "Acme | Home");
  const capture = (width, height, text) => ({ png: pngHead(width, height), headings: [{ text, level: 1 }] });
  const pages = Array.from({ length: 5 }, (_, i) => ({
    n: i + 1,
    slug: `page-${i + 1}`,
    captures: { wide: capture(1920, 1080, `Wide ${i + 1}`), narrow: capture(1080, 1920, `Narrow ${i + 1}`) },
  }));
  pages[1].captures.narrow = capture(300, 300, "Too small");
  const plan = planPwa(pages);
  assert.deepEqual(
    plan.entries.map((e) => [e.src, e.sizes, e.form_factor, e.label]),
    [
      ["screenshots/wide-01.png", "1920x1080", "wide", "Wide 1"],
      ["screenshots/wide-02.png", "1920x1080", "wide", "Wide 2"],
      ["screenshots/wide-03.png", "1920x1080", "wide", "Wide 3"],
      ["screenshots/wide-04.png", "1920x1080", "wide", "Wide 4"],
      ["screenshots/narrow-01.png", "1080x1920", "narrow", "Narrow 1"],
      ["screenshots/narrow-02.png", "1080x1920", "narrow", "Narrow 3"],
      ["screenshots/narrow-03.png", "1080x1920", "narrow", "Narrow 4"],
      ["screenshots/narrow-04.png", "1080x1920", "narrow", "Narrow 5"],
    ],
  );
  assert.ok(plan.entries.every((e) => e.type === "image/png"));
  assert.deepEqual(
    plan.leftOut.map((item) => [item.page, item.form, item.reason]),
    [
      [2, "narrow", "300x300, a side under 320 pixels"],
      [5, "wide", "Chrome looks at the first 8 screenshots of a manifest only, wide and narrow together"],
    ],
  );
  assert.equal(plan.check.ok, true, plan.check.problems.join("\n"));
  assert.deepEqual([plan.check.desktop, plan.check.phone], [[1, 2, 3, 4], [5, 6, 7, 8]]);

  // The room one form factor leaves goes to the other.
  const wideOnly = planPwa(Array.from({ length: 12 }, (_, i) => ({ n: i + 1, slug: "p", captures: { wide: capture(1920, 1080, "W") } })));
  assert.equal(wideOnly.entries.length, 8);
  const phonesOnly = planPwa(Array.from({ length: 12 }, (_, i) => ({ n: i + 1, slug: "p", captures: { narrow: capture(1080, 1920, "N") } })));
  assert.equal(phonesOnly.entries.length, 5);
});

test("--pwa adds its captures to the windows a run opens anyway, else opens its own", () => {
  const plan = (sizes) => addPwaShots(parseSizes(sizes)).map((group) => [group.key, group.device.scale, group.shots.map((shot) => `${shot.size}${shot.scale ? `@${shot.scale}` : ""}`)]);
  assert.deepEqual(plan("desktop,mobile,full"), [
    ["desktop", 2, ["desktop", "pwa-wide@1.2", "full@1"]],
    ["mobile", 3, ["mobile", "pwa-narrow@3"]],
  ]);
  assert.deepEqual(plan("desktop"), [
    ["desktop", 2, ["desktop", "pwa-wide@1.2"]],
    ["pwa-narrow", 3, ["pwa-narrow@3"]],
  ]);
  assert.deepEqual(plan("iphone,mobile@2"), [
    ["iphone", 3, ["iphone"]],
    ["mobile", 2, ["mobile"]],
    ["pwa-wide", 1.2, ["pwa-wide@1.2"]],
    ["pwa-narrow", 3, ["pwa-narrow@3"]],
  ]);
  const options = parse(["acme.com", "--pwa"]);
  assert.equal(options.pwa, true);
  assert.equal(parse(["--pwa-check", "public/manifest.json"]).pwaCheck, "public/manifest.json");
  assert.throws(() => parse(["acme.com", "--pwa-check", "acme.com"]), /runs on its own/);
});

test("a run's folder: an earlier run's screenshots for a manifest go, other files in pwa/ stay", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easyscreenshotkit-pwa-dir-"));
  try {
    const run = () => {
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: 1, tool: "easyscreenshotkit 0.1.0" }));
      fs.mkdirSync(path.join(dir, "pwa", "screenshots"), { recursive: true });
      fs.writeFileSync(path.join(dir, "pwa", "manifest-screenshots.json"), "{}");
      fs.writeFileSync(path.join(dir, "pwa", "screenshots", "wide-01.png"), "old");
      fs.writeFileSync(path.join(dir, "pwa", "screenshots", "narrow-01.png"), "old");
    };
    run();
    prepareDir(dir);
    assert.deepEqual(fs.readdirSync(dir), []);
    run();
    fs.writeFileSync(path.join(dir, "pwa", "screenshots", "mine.png"), "mine");
    prepareDir(dir);
    assert.deepEqual(fs.readdirSync(path.join(dir, "pwa", "screenshots")), ["mine.png"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--pwa-check: a manifest file and its screenshots next to it, on the command line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easyscreenshotkit-pwa-check-"));
  try {
    fs.mkdirSync(path.join(dir, "screenshots"));
    fs.writeFileSync(path.join(dir, "screenshots", "wide-01.png"), pngHead(1920, 1080));
    fs.writeFileSync(path.join(dir, "screenshots", "narrow-01.jpg"), jpegHead(1080, 1920));
    const manifest = (screenshots, extra = {}) => {
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ name: "Acme", description: "Tools for teams.", screenshots, ...extra }));
      return spawnSync(process.execPath, [CLI, "--pwa-check", path.join(dir, "manifest.json")], { encoding: "utf8" });
    };
    const good = manifest([
      { src: "screenshots/wide-01.png", sizes: "1920x1080", type: "image/png", form_factor: "wide", label: "Home" },
      { src: "/screenshots/narrow-01.jpg", sizes: "1080x1920", type: "image/jpeg", form_factor: "narrow", label: "Home on a phone" },
    ]);
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.match(good.stdout, /Desktop {2}the richer install dialog, with screenshot 1/);
    assert.match(good.stdout, /Phone {4}the richer install dialog, with screenshot 2/);
    assert.match(good.stdout, /Nothing to fix/);

    const bad = manifest([{ src: "screenshots/wide-01.png", form_factor: "wide" }, { src: "screenshots/missing.png", sizes: "1080x1920" }], { description: undefined });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /Phone {4}the plain install dialog/);
    assert.match(bad.stdout, /Screenshot 2 \(screenshots\/missing\.png\): could not be loaded \(there is no file .*missing\.png\)/);
    assert.match(bad.stdout, /There is no description/);

    const none = spawnSync(process.execPath, [CLI, "--pwa-check", path.join(dir, "screenshots", "wide-01.png")], { encoding: "utf8" });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /is not JSON, so it is not a web app manifest/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--pwa-check: a site's address leads to the manifest its page links", async () => {
  assert.equal(manifestLink('<link href="/app.webmanifest" rel="manifest">', "https://acme.com/a/"), "https://acme.com/app.webmanifest");
  assert.equal(manifestLink("<link rel='icon' href='/i.png'><link rel=manifest href=m.json?v=1&amp;x=2>", "https://acme.com/a/"), "https://acme.com/a/m.json?v=1&x=2");
  assert.equal(manifestLink('<link rel="preload manifest" href="/m.json">', "https://acme.com/"), "https://acme.com/m.json");
  assert.equal(manifestLink('<link rel="stylesheet" href="/s.css">', "https://acme.com/"), "");

  const { server, origin } = await serve((req, res) => {
    if (req.url === "/") return res.writeHead(200, { "Content-Type": "text/html" }).end('<!doctype html><link rel="manifest" href="/static/app.webmanifest"><h1>Acme</h1>');
    if (req.url === "/bare") return res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><h1>No manifest</h1>");
    if (req.url === "/static/app.webmanifest") {
      return res.writeHead(200, { "Content-Type": "application/manifest+json" }).end(JSON.stringify({ name: "Acme", screenshots: [{ src: "shots/w.png", sizes: "1920x1080", type: "image/png", form_factor: "wide", label: "Home" }] }));
    }
    if (req.url === "/static/shots/w.png") return res.writeHead(200, { "Content-Type": "image/png" }).end(pngHead(1920, 1080));
    res.writeHead(404).end();
  });
  try {
    const report = await checkManifest({ url: `${origin}/` });
    assert.equal(report.manifest, `${origin}/static/app.webmanifest`);
    assert.equal(report.page, `${origin}/`);
    assert.deepEqual([report.desktop, report.phone], [[1], []]);
    assert.deepEqual(report.screenshots[0].image, { format: "png", width: 1920, height: 1080 });
    assert.match(describeCheck(report), /Checked .*\/static\/app\.webmanifest, the manifest of /);
    await assert.rejects(checkManifest({ url: `${origin}/bare` }), /links no web app manifest/);
    await assert.rejects(checkManifest({ url: `${origin}/nothing` }), /answered 404/);
  } finally {
    server.close();
  }
});
