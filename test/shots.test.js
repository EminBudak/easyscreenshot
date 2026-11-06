"use strict";

// The whole run in a real headless browser (skipped when none is installed),
// against a small site served from this process: which pages are picked and
// which are left out, what the clean-up hides, the sizes, themes and
// languages, and the files written.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { takeShots } = require("../skills/easyscreenshotkit/scripts/lib/shots");
const { findChrome } = require("../skills/easyscreenshotkit/scripts/lib/chrome");
const { pngText } = require("../skills/easyscreenshotkit/scripts/lib/png");
const { readPng, serve, near } = require("./helpers");

const CLI = path.resolve(__dirname, "../skills/easyscreenshotkit/scripts/easyscreenshotkit.js");
const noBrowser = !findChrome() && "no Chrome, Chromium, Edge or Brave installed";

const RED = [200, 0, 0];
const GREEN = [0, 160, 0];
const ORANGE = [255, 140, 0];
const BLUE = [0, 0, 220];
const MAGENTA = [255, 0, 255];
const WHITE = [255, 255, 255];
const PURPLE = [120, 0, 200];
const PICTURE = [230, 120, 0];
const SKY = [0, 120, 255];
const TEAL = [0, 200, 200];

const page = (title, body, { head = "", lang = "en", style = "" } = {}) =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${head}<style>body{margin:0;font-family:sans-serif}${style}</style></head><body>${body}</body></html>`;

// The home page: a fixed red header with the menu, a static consent banner
// with a known tool's id, a green hero with a button, a picture that gets
// its address only once it is seen, a bar that counts up when it comes into
// view, a dark footer, and floating over it all a blue cookie bar and a
// magenta chat bubble.
const HOME = page(
  "Acme | Tools for teams",
  `<header><a href="/">Acme</a><nav>
    <a href="/pricing">Pricing</a><a href="/features">Features</a><a href="/old-features">Product tour</a>
    <a href="/customers">Customers</a><a href="/blog">Blog</a><a href="/docs">Docs</a><a href="/login">Log in</a>
    <div class="drop"><a href="/integrations">Integrations</a></div>
  </nav></header>
  <div id="onetrust-banner-sdk">We use cookies</div>
  <div class="hero"><h1>Tools for teams</h1><a class="btn" href="/start">How it works</a></div>
  <section id="s1"><img class="lazy" alt=""></section>
  <section id="s2"><h2>Fast</h2><div class="counter"><div class="fill"></div></div></section>
  <footer><a href="/about">About</a><a href="/careers">Careers</a><a href="/privacy">Privacy</a><a href="/blog/first-post">First post</a><a href="/pricing">Pricing</a></footer>
  <div class="cookie">We use cookies. Accept?</div><div class="chat"></div>
  <script>
    const img = document.querySelector(".lazy");
    new IntersectionObserver((entries, io) => { if (entries[0].isIntersecting) { img.src = "/picture.svg"; io.disconnect(); } }).observe(img);
    const fill = document.querySelector(".fill");
    new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      let width = 0;
      const timer = setInterval(() => { width += 30; fill.style.width = Math.min(300, width) + "px"; if (width >= 300) clearInterval(timer); }, 90);
    }).observe(fill);
  </script>`,
  {
    head: '<meta name="description" content="Acme makes tools for teams."><meta property="og:site_name" content="Acme"><link rel="alternate" hreflang="tr" href="/tr/"><link rel="manifest" href="/app.webmanifest">',
    style: `
    header{position:fixed;top:0;left:0;right:0;height:60px;background:rgb(200,0,0);z-index:10}
    header a{color:#fff;margin:0 6px}
    .drop{display:none}
    #onetrust-banner-sdk{height:120px;background:rgb(255,140,0)}
    .hero{height:700px;background:rgb(0,160,0);padding-top:60px;box-sizing:border-box}
    .hero h1{margin:0}
    .btn{display:inline-block;padding:14px 20px;background:rgb(0,0,0);color:#fff}
    section{height:900px;background:rgb(255,255,255);overflow:hidden}
    section h2{margin:0;height:40px}
    .lazy{display:block;width:400px;height:300px;margin:100px auto 0}
    .counter{width:300px;height:20px;background:rgb(235,235,235)}
    .fill{width:0;height:20px;background:rgb(120,0,200)}
    footer{height:200px;background:rgb(30,30,30)}
    .cookie{position:fixed;left:0;right:0;bottom:0;height:70px;background:rgb(0,0,220);z-index:20}
    .chat{position:fixed;right:20px;bottom:90px;width:60px;height:60px;border-radius:30px;background:rgb(255,0,255);z-index:20}
    @media (prefers-color-scheme: dark){ body{background:rgb(10,10,10)} .hero{background:rgb(0,60,0)} }
    @media (max-width: 600px){ .hero{background:rgb(250,220,0)} }`,
  },
);

// Pricing: a consent dialog over a backdrop, with the page pinned so it
// cannot scroll until the dialog is answered.
const PRICING = page(
  "Pricing | Acme",
  `<h1>Pricing <a href="/">Home</a></h1><div class="plans"></div><div class="end"></div>
  <div class="backdrop"></div><div class="dialog">We value your privacy <button>Accept</button></div>`,
  {
    style: `
    body{position:fixed;top:0;left:0;right:0;overflow:hidden}
    h1{margin:0;height:100px}
    .plans{height:3000px;background:rgb(0,120,255)}
    .end{height:100px;background:rgb(0,0,0)}
    .backdrop{position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:50}
    .dialog{position:fixed;left:500px;top:300px;width:600px;height:300px;background:#fff;z-index:51}`,
  },
);

const simple = (title, color = "rgb(240,240,240)", extra = "") => page(`${title} | Acme`, `<h1>${title}</h1><div style="height:1400px;background:${color}"></div><a href="/">Home</a>${extra}`);

async function fixture() {
  const seen = [];
  let origin = "";
  const { server, origin: base } = await serve((req, res) => {
    const agent = String(req.headers["user-agent"] || "");
    seen.push({ url: req.url, agent, lang: String(req.headers["accept-language"] || "") });
    const html = (body) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
    const go = (code, to) => res.writeHead(code, { Location: to }).end();
    switch (req.url) {
      case "/":
        return html(HOME);
      case "/pricing":
        return html(PRICING);
      case "/features":
        // The server picks the phone layout by the browser, as some sites do.
        return html(/Android/.test(agent) ? simple("Features", "rgb(0,200,200)") : /iPhone/.test(agent) ? simple("Features", "rgb(0,200,200)") : simple("Features"));
      case "/old-features":
        return go(301, "/features");
      case "/start":
        return go(302, "/login");
      case "/docs":
        return html(page("Just a moment...", "<p>Checking your browser before accessing the site.</p>"));
      case "/integrations":
        return html(simple("Integrations"));
      case "/blog":
        return html(simple("Blog"));
      case "/changelog":
        return html(simple("Changelog"));
      case "/about":
      case "/customers":
      case "/careers":
      case "/privacy":
      case "/login":
        return html(simple(req.url.slice(1)));
      case "/tr/":
        return html(page("Acme | Ekipler için araçlar", '<h1>Ekipler için araçlar</h1><nav><a href="/tr/fiyatlar">Fiyatlar</a><a href="/tr/giris">Giriş</a></nav><div style="height:1400px;background:rgb(0,160,0)"></div>', { lang: "tr" }));
      case "/tr/fiyatlar":
        return html(page("Fiyatlar | Acme", '<h1>Fiyatlar</h1><div style="height:1400px"></div><a href="/tr/">Ana sayfa</a>', { lang: "tr" }));
      case "/picture.svg":
        return setTimeout(() => res.writeHead(200, { "Content-Type": "image/svg+xml" }).end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="rgb(230,120,0)"/></svg>'), 300);
      case "/app.webmanifest":
        return res.writeHead(200, { "Content-Type": "application/manifest+json" }).end(JSON.stringify({ name: "Acme", start_url: "/", display: "standalone" }));
      case "/robots.txt":
        return res.end(`User-agent: *\nDisallow: /customers\n\nSitemap: ${origin}/sitemap.xml\n`);
      case "/sitemap.xml":
        return res.end(`<urlset><url><loc>${origin}/</loc></url><url><loc>${origin}/pricing</loc></url><url><loc>${origin}/changelog</loc></url></urlset>`);
      default:
        res.writeHead(404).end("not found");
    }
  });
  origin = base;
  return { server, origin, seen };
}

// The CLI in a child process. Not spawnSync: the test's own server must go on
// answering while the child runs.
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "easyscreenshotkit-run-"));
const css = (png, scale, x, y) => png.pixel(Math.round(x * scale), Math.round(y * scale));

test("picks the pages worth showing and leaves the rest out with reasons", { skip: noBrowser, timeout: 280_000 }, async () => {
  const { server, origin, seen } = await fixture();
  const dir = path.join(tempDir(), "shots");
  try {
    const { manifest } = await takeShots(origin, { dir, timeLimit: 240_000 });
    const pathOf = (url) => new URL(url).pathname;
    assert.deepEqual(
      manifest.pages.map((p) => [p.n, p.slug, pathOf(p.url), p.kind]),
      [
        [1, "home", "/", "home"],
        [2, "pricing", "/pricing", "pricing"],
        [3, "features", "/features", "product"],
        [4, "integrations", "/integrations", "integrations"],
        [5, "blog", "/blog", "blog"],
      ],
    );
    assert.equal(manifest.site, "Acme");
    assert.equal(manifest.pages[1].why, 'menu link "Pricing"');
    const reasons = Object.fromEntries(manifest.skipped.map((s) => [pathOf(s.url), s.reason]));
    assert.equal(reasons["/old-features"], "the same page as features");
    assert.equal(reasons["/start"], "redirected to a sign-in page");
    assert.equal(reasons["/docs"], "a bot check instead of the page");
    assert.equal(reasons["/customers"], "robots.txt asks crawlers to stay out");
    assert.equal(reasons["/login"], "sign-in or sign-up page");
    assert.equal(reasons["/privacy"], "legal page");
    assert.equal(reasons["/careers"], "not a product page");
    assert.equal(reasons["/blog/first-post"], "a single post");
    assert.ok(!seen.some((r) => r.url === "/customers"), "a page robots.txt closes is never opened");
    assert.ok(manifest.candidates.some((c) => pathOf(c.url) === "/changelog"), "the sitemap's page is offered");

    // Every page on the desktop, its whole page, and the phone.
    for (const p of manifest.pages) {
      assert.deepEqual(p.shots.map((s) => s.size), ["desktop", "full", "mobile"], p.slug);
      for (const s of p.shots) assert.ok(fs.existsSync(path.join(dir, s.file)), s.file);
    }
    const home = Object.fromEntries(manifest.pages[0].shots.map((s) => [s.size, s]));
    assert.equal(home.desktop.file, "01-home-desktop.png");
    assert.deepEqual([home.desktop.width, home.desktop.height], [3200, 1800]);
    assert.deepEqual([home.mobile.width, home.mobile.height], [1080, 1920]);
    assert.equal(home.full.width, 1600);

    // The first screen: the header stays; the consent banner, the cookie bar
    // and the chat bubble are gone.
    const desktop = readPng(path.join(dir, home.desktop.file));
    assert.ok(near(css(desktop, 2, 800, 30), RED), "header kept");
    assert.ok(near(css(desktop, 2, 800, 100), GREEN), `consent banner hidden: ${css(desktop, 2, 800, 100)}`);
    assert.ok(!near(css(desktop, 2, 200, 880), BLUE), "cookie bar hidden");
    assert.ok(near(css(desktop, 2, 200, 880), WHITE), `below the hero: ${css(desktop, 2, 200, 880)}`);
    assert.ok(!near(css(desktop, 2, 1550, 780), MAGENTA), "chat bubble hidden");
    assert.ok(manifest.pages[0].hidden >= 3, `hidden: ${manifest.pages[0].hidden}`);
    const h1 = home.desktop.headings.find((h) => h.level === 1);
    assert.equal(h1.text, "Tools for teams");
    assert.equal(h1.box[1], 120, "the heading's box is in the image's pixels");

    // The whole page: the lazy picture, the finished count-up, the header
    // once, the footer at the end.
    const full = readPng(path.join(dir, home.full.file));
    assert.equal(full.height, 2700);
    assert.ok(near(full.pixel(800, 950), PICTURE), `lazy picture: ${full.pixel(800, 950)}`);
    assert.ok(near(full.pixel(290, 1650), PURPLE), `count-up finished: ${full.pixel(290, 1650)}`);
    assert.ok(near(full.pixel(800, 30), RED), "header at the top");
    assert.ok(near(full.pixel(200, 930), WHITE), `header not again further down: ${full.pixel(200, 930)}`);
    assert.ok(near(full.pixel(800, 2650), [30, 30, 30]), "footer at the end");
    assert.ok(home.full.sections.some((s) => s.heading === "Fast"), JSON.stringify(home.full.sections));

    // The phone: the site's phone layout.
    const phone = readPng(path.join(dir, home.mobile.file));
    assert.ok(near(css(phone, 3, 180, 300), [250, 220, 0]), `phone layout: ${css(phone, 3, 180, 300)}`);
    const features = manifest.pages[2].shots.find((s) => s.size === "mobile");
    assert.ok(near(css(readPng(path.join(dir, features.file)), 3, 180, 300), TEAL), "the server saw an Android phone");
    assert.ok(seen.some((r) => r.url === "/features" && /Android 14; Pixel 8/.test(r.agent)));

    // Pricing: the dialog and its backdrop are gone and the page scrolls
    // again, so the whole page is there.
    const pricing = Object.fromEntries(manifest.pages[1].shots.map((s) => [s.size, s]));
    assert.ok(near(css(readPng(path.join(dir, pricing.desktop.file)), 2, 300, 600), SKY), "no backdrop over the first screen");
    const pricingFull = readPng(path.join(dir, pricing.full.file));
    assert.equal(pricingFull.height, 3200);
    assert.ok(near(pricingFull.pixel(800, 3150), [0, 0, 0]), "the end of the pinned page");
    assert.ok(manifest.pages[1].notes.includes("scroll unlocked"));

    // The files tell where they came from; the summary files are written.
    assert.equal(pngText(fs.readFileSync(path.join(dir, home.desktop.file))).Source, `${origin}/`);
    const md = fs.readFileSync(path.join(dir, "SCREENSHOTS.md"), "utf8");
    assert.match(md, /^# Screenshots of Acme/);
    assert.match(md, /## 02 pricing/);
    assert.match(md, /\/docs: a bot check instead of the page/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).pages.length, 5);
    assert.ok(manifest.sheet && manifest.sheet.width === 1600 && fs.existsSync(path.join(dir, "sheet.png")));
  } finally {
    server.close();
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test("one page on an iPhone and a custom size, in the dark", { skip: noBrowser, timeout: 120_000 }, async () => {
  const { server, origin, seen } = await fixture();
  const dir = path.join(tempDir(), "shots");
  try {
    const { manifest } = await takeShots(`${origin}/`, { dir, pages: 1, sizes: "iphone,1270x760@2", theme: "dark", timeLimit: 100_000 });
    assert.equal(manifest.pages.length, 1);
    const shots = Object.fromEntries(manifest.pages[0].shots.map((s) => [s.size, s]));
    assert.equal(shots.iphone.file, "01-home-iphone-dark.png");
    assert.deepEqual([shots.iphone.width, shots.iphone.height], [1320, 2868]);
    assert.deepEqual([shots["1270x760"].width, shots["1270x760"].height], [2540, 1520]);
    assert.ok(seen.some((r) => /iPhone OS/.test(r.agent)), "the server saw an iPhone");
    const wide = readPng(path.join(dir, shots["1270x760"].file));
    assert.ok(near(css(wide, 2, 600, 300), [0, 60, 0]), `dark hero: ${css(wide, 2, 600, 300)}`);
    assert.ok(manifest.notes.some((note) => /prefers-color-scheme/.test(note)));
  } finally {
    server.close();
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test("--pwa: screenshots for a web app manifest, cleaned like the rest, and the site's own manifest read", { skip: noBrowser, timeout: 150_000 }, async () => {
  const { server, origin } = await fixture();
  const dir = path.join(tempDir(), "shots");
  try {
    const { manifest } = await takeShots(origin, { dir, pages: 2, sizes: "desktop", pwa: true, timeLimit: 130_000 });
    // The run's own files are what they are without --pwa.
    assert.deepEqual(manifest.sizes.map((s) => s.size), ["desktop"]);
    for (const p of manifest.pages) assert.deepEqual(p.shots.map((s) => s.size), ["desktop"], p.slug);
    const { pwa } = manifest;
    assert.equal(pwa.file, "pwa/manifest-screenshots.json");
    assert.deepEqual(
      pwa.screenshots.map((s) => [s.file, s.page, s.src, s.sizes, s.type, s.form_factor]),
      [
        ["pwa/screenshots/wide-01.png", 1, "screenshots/wide-01.png", "1920x1080", "image/png", "wide"],
        ["pwa/screenshots/wide-02.png", 2, "screenshots/wide-02.png", "1920x1080", "image/png", "wide"],
        ["pwa/screenshots/narrow-01.png", 1, "screenshots/narrow-01.png", "1080x1920", "image/png", "narrow"],
        ["pwa/screenshots/narrow-02.png", 2, "screenshots/narrow-02.png", "1080x1920", "image/png", "narrow"],
      ],
    );
    assert.equal(pwa.screenshots[0].label, "Tools for teams");
    assert.deepEqual(pwa.leftOut, []);
    const written = JSON.parse(fs.readFileSync(path.join(dir, pwa.file), "utf8"));
    assert.deepEqual(written.screenshots, pwa.screenshots.map(({ file, page, ...entry }) => entry));

    // 1920x1080 from the 2x desktop window: the header stays, the consent
    // banner and the cookie bar go.
    const wide = readPng(path.join(dir, "pwa/screenshots/wide-01.png"));
    assert.deepEqual([wide.width, wide.height], [1920, 1080]);
    assert.ok(near(css(wide, 1.2, 800, 30), RED), "header kept");
    assert.ok(near(css(wide, 1.2, 800, 300), GREEN), `consent banner hidden: ${css(wide, 1.2, 800, 300)}`);
    assert.ok(near(css(wide, 1.2, 200, 880), WHITE), `cookie bar hidden: ${css(wide, 1.2, 200, 880)}`);
    // The phone, in a window of its own as --sizes has none: its layout.
    const narrow = readPng(path.join(dir, "pwa/screenshots/narrow-01.png"));
    assert.deepEqual([narrow.width, narrow.height], [1080, 1920]);
    assert.ok(near(css(narrow, 3, 180, 300), [250, 220, 0]), `phone layout: ${css(narrow, 3, 180, 300)}`);
    assert.equal(pngText(fs.readFileSync(path.join(dir, "pwa/screenshots/narrow-01.png"))).Source, `${origin}/`);

    // The site's own manifest, found on the home page and read.
    assert.equal(pwa.site.manifest, `${origin}/app.webmanifest`);
    assert.equal(pwa.site.screenshots, 0);
    assert.match(pwa.note, /lists no screenshots yet\. Put pwa\/screenshots next to it, in \/ on the site/);
    assert.match(fs.readFileSync(path.join(dir, "SCREENSHOTS.md"), "utf8"), /## Screenshots for a web app manifest[\s\S]*\| pwa\/screenshots\/wide-01\.png \| 1920x1080 \| wide \| 01 home \| Tools for teams \|/);
  } finally {
    server.close();
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test("a language the site names: its own page in that language, and the browser asks for it", { skip: noBrowser, timeout: 120_000 }, async () => {
  const { server, origin, seen } = await fixture();
  const dir = path.join(tempDir(), "shots");
  try {
    const { manifest } = await takeShots(origin, { dir, pages: 2, sizes: "desktop", lang: "tr", timeLimit: 100_000 });
    assert.deepEqual(manifest.pages.map((p) => new URL(p.url).pathname), ["/tr/", "/tr/fiyatlar"]);
    assert.equal(manifest.pages[1].slug, "fiyatlar");
    assert.equal(manifest.pages[1].kind, "pricing");
    assert.equal(manifest.lang, "tr");
    assert.ok(seen.some((r) => r.url === "/tr/fiyatlar" && /^tr\b/.test(r.lang)), JSON.stringify(seen.map((r) => r.lang)));
  } finally {
    server.close();
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test("--no-clean keeps the floating boxes; --hide hides more; --json prints the manifest", { skip: noBrowser, timeout: 120_000 }, async () => {
  const { server, origin } = await fixture();
  const root = tempDir();
  try {
    const raw = await runCli([origin, "--pages", "1", "--sizes", "desktop", "--no-clean", "--json", "--out", path.join(root, "raw")]);
    assert.equal(raw.status, 0, raw.stderr);
    const manifest = JSON.parse(raw.stdout);
    const kept = readPng(path.join(root, "raw", manifest.pages[0].shots[0].file));
    assert.ok(near(css(kept, 2, 200, 880), BLUE), "cookie bar kept");
    assert.ok(near(css(kept, 2, 800, 100), ORANGE), "consent banner kept");

    const { manifest: hidden } = await takeShots(origin, { dir: path.join(root, "hide"), pages: 1, sizes: "desktop", hide: [".hero", "]bad["], timeLimit: 100_000 });
    const png = readPng(path.join(root, "hide", hidden.pages[0].shots[0].file));
    assert.ok(near(css(png, 2, 200, 300), WHITE), `the hero hidden: ${css(png, 2, 200, 300)}`);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a bot check instead of the home page stops the run and leaves nothing behind", { skip: noBrowser, timeout: 60_000 }, async () => {
  const { server, origin } = await fixture();
  const root = tempDir();
  const dir = path.join(root, "shots");
  try {
    await assert.rejects(takeShots(`${origin}/docs`, { dir, pages: 1, timeLimit: 50_000 }), /bot check \("Just a moment\.\.\."\)/);
    assert.equal(fs.existsSync(dir), false);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
