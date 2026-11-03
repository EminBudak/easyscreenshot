"use strict";

// Page selection without a browser: kinds, reasons to leave a page out,
// ranking, robots.txt and sitemaps.

const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const test = require("node:test");
const pick = require("../skills/easyscreenshot/scripts/lib/pick");
const { serve } = require("./helpers");

const HOME = "https://acme.com/";
const page = (path) => new URL(path, HOME);
const kind = (path, text = "") => (pick.kindOf(page(path), text) || {}).kind || "";
const reason = (path, text = "", homeLocale = "") => pick.excludedBecause(page(path), text, { homeLocale });

test("kinds come from the address first, then from the link's words, in six languages", () => {
  assert.equal(kind("/pricing"), "pricing");
  assert.equal(kind("/plans-and-pricing"), "pricing");
  assert.equal(kind("/fiyatlar"), "pricing");
  assert.equal(kind("/preise"), "pricing");
  assert.equal(kind("/features"), "product");
  assert.equal(kind("/ozellikler"), "product");
  assert.equal(kind("/how-it-works"), "tour");
  assert.equal(kind("/integrations"), "integrations");
  assert.equal(kind("/changelog"), "changelog");
  assert.equal(kind("/hakkimizda"), "about");
  assert.equal(kind("/customers"), "customers");
  assert.equal(kind("/blog"), "blog");
  // An address that says nothing: the link's words decide.
  assert.equal(kind("/x", "Product"), "product");
  assert.equal(kind("/start", "How it works"), "tour");
  assert.equal(kind("/x", "Hakkımızda"), "about");
  assert.equal(kind("/x", "Something else"), "");
  assert.equal(kind("/x", "Plans and pricing"), "pricing");
  assert.equal(kind("/changes/en", "Product updates"), "changelog");
  // A teaser's words are not a menu label.
  assert.equal(kind("/isim-icin/kampanyalar", "DHL eCommerce Avantajlı Fiyatlar!"), "");
  // Only the first part of the path names the kind.
  assert.equal(kind("/now/why-is-quality-so-rare"), "");
  assert.equal(kind("/features/sso"), "product");
  // The address wins over the words.
  assert.equal(kind("/pricing", "Sign up free"), "pricing");
});

test("sign-in, legal and other pages are left out with a reason", () => {
  assert.equal(reason("/login", "Log in"), "sign-in or sign-up page");
  assert.equal(reason("/start", "Sign up"), "sign-in or sign-up page");
  assert.equal(reason("/giris"), "sign-in or sign-up page");
  assert.equal(reason("/privacy-policy"), "legal page");
  assert.equal(reason("/kvkk"), "legal page");
  assert.equal(reason("/impressum"), "legal page");
  assert.equal(reason("/company/careers"), "not a product page");
  assert.equal(reason("/contact-sales", "Contact sales"), "not a product page");
  assert.equal(reason("/blog/first-post"), "a single post");
  assert.equal(reason("/customers/openai"), "a single post");
  assert.equal(reason("/changelog/2026-09-14-loops"), "a single post");
  assert.equal(reason("/2024/05/hello"), "a single post");
  assert.equal(reason("/this-is-a-very-long-post-title-slug"), "a single post");
  assert.equal(reason("/de/pricing"), "another language");
  assert.equal(reason("/tr/fiyatlar", "", "tr"), "");
  // A page under a product section is a product page, whatever its name.
  assert.equal(reason("/features/sso"), "");
  assert.equal(reason("/features/account-sync"), "");
  // A button whose words say "Sign up" but that leads to the pricing page.
  assert.equal(reason("/pricing", "Sign up free"), "");
  assert.equal(reason("/blog"), "");
});

test("home pages: the site's root, or its language root", () => {
  assert.equal(pick.homeOf("https://acme.com/pricing"), "https://acme.com/");
  assert.equal(pick.homeOf("https://acme.com/tr/fiyatlar"), "https://acme.com/tr/");
  assert.equal(pick.homeOf("https://www.acme.com"), "https://www.acme.com/");
  assert.equal(pick.pageKey("https://www.acme.com/Pricing/?a=1#x"), "acme.com/pricing");
  assert.equal(pick.pageKey("https://acme.com"), "acme.com/");
});

test("ranking: menu links first, a sitemap only as a fallback, reasons kept for the links left out", () => {
  const links = [
    { href: "/pricing", text: "Pricing", where: "header" },
    { href: "/features", text: "Features", where: "header" },
    { href: "/login", text: "Log in", where: "header" },
    { href: "/start", text: "How it works", where: "hero" },
    { href: "/about", text: "About", where: "footer" },
    { href: "/careers", text: "Careers", where: "footer" },
    { href: "https://other.com/x", text: "Partner", where: "header" },
    { href: "/pricing", text: "Sign up", where: "hero" },
    { href: "/terms.pdf", text: "Terms", where: "footer" },
    { href: "mailto:hi@acme.com", text: "Mail", where: "footer" },
  ];
  const robots = pick.parseRobots("User-agent: *\nDisallow: /about\n");
  const { candidates, skipped } = pick.rankLinks(links, ["https://acme.com/changelog", "https://acme.com/blog/post-1"], { home: HOME, robots });
  assert.deepEqual(
    candidates.map((c) => [new URL(c.url).pathname, c.kind, c.score, c.where]),
    [
      ["/pricing", "pricing", 110, "header"],
      ["/features", "product", 100, "header"],
      ["/start", "tour", 75, "hero"],
      ["/changelog", "changelog", 35, "sitemap"],
    ],
  );
  assert.equal(candidates[0].why, 'menu link "Pricing"');
  assert.deepEqual(
    skipped.map((s) => [new URL(s.url).pathname, s.reason]),
    [
      ["/login", "sign-in or sign-up page"],
      ["/about", "robots.txt asks crawlers to stay out"],
      ["/careers", "not a product page"],
    ],
  );
});

test("visit order: the best of each kind first, two product pages, then the rest", () => {
  const c = (path, kind, score) => ({ url: `https://acme.com${path}`, kind, score });
  const order = pick.visitOrder([c("/pricing", "pricing", 110), c("/plans", "pricing", 105), c("/features", "product", 100), c("/platform", "product", 100), c("/solutions", "product", 99), c("/about", "about", 30)]);
  assert.deepEqual(order.map((x) => new URL(x.url).pathname), ["/pricing", "/features", "/platform", "/about", "/plans", "/solutions"]);
});

test("robots.txt: the longest rule wins, Allow on a tie, wildcards and $", () => {
  const robots = pick.parseRobots(
    ["User-agent: Googlebot", "Disallow: /", "", "User-agent: *", "Disallow: /admin", "Allow: /admin/public", "Disallow: /*.pdf$", "Disallow:", "Sitemap: https://acme.com/sitemap.xml"].join("\n"),
  );
  assert.deepEqual(robots.sitemaps, ["https://acme.com/sitemap.xml"]);
  assert.equal(pick.robotsAllows("/pricing", robots.rules), true);
  assert.equal(pick.robotsAllows("/admin/users", robots.rules), false);
  assert.equal(pick.robotsAllows("/admin/public/page", robots.rules), true);
  assert.equal(pick.robotsAllows("/files/a.pdf", robots.rules), false);
  assert.equal(pick.robotsAllows("/files/a.pdfx", robots.rules), true);
  const ours = pick.parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: easyscreenshot\nAllow: /\n");
  assert.equal(pick.robotsAllows("/pricing", ours.rules), true);
});

test("sitemaps: url sets, indexes, CDATA and entities; the pages' own sitemap first", () => {
  assert.deepEqual(pick.parseSitemap("<urlset><url><loc>https://a.com/x?a=1&amp;b=2</loc></url><url><loc><![CDATA[https://a.com/y]]></loc></url></urlset>"), {
    urls: ["https://a.com/x?a=1&b=2", "https://a.com/y"],
    sitemaps: [],
  });
  assert.deepEqual(pick.parseSitemap("<sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>"), { urls: [], sitemaps: ["https://a.com/s1.xml"] });
  assert.deepEqual(pick.sitemapOrder(["https://a.com/post-sitemap.xml", "https://a.com/page-sitemap.xml", "https://a.com/sitemap-0.xml", "https://a.com/product-sitemap.xml"]), [
    "https://a.com/page-sitemap.xml",
    "https://a.com/sitemap-0.xml",
    "https://a.com/post-sitemap.xml",
    "https://a.com/product-sitemap.xml",
  ]);
});

test("the site index reads robots.txt and a gzipped sitemap index, and stops at its limits", async () => {
  let origin = "";
  const { server, origin: base } = await serve((req, res) => {
    if (req.url === "/robots.txt") return res.end(`User-agent: *\nDisallow: /secret\nSitemap: ${origin}/sitemap_index.xml\n`);
    if (req.url === "/sitemap_index.xml") return res.end(`<sitemapindex><sitemap><loc>${origin}/post-sitemap.xml.gz</loc></sitemap><sitemap><loc>${origin}/page-sitemap.xml.gz</loc></sitemap></sitemapindex>`);
    if (req.url === "/page-sitemap.xml.gz") return res.end(zlib.gzipSync(`<urlset><url><loc>${origin}/pricing</loc></url><url><loc>${origin}/features</loc></url></urlset>`));
    if (req.url === "/post-sitemap.xml.gz") return res.end(zlib.gzipSync(`<urlset>${Array.from({ length: 900 }, (_, i) => `<url><loc>${origin}/blog/post-${i}</loc></url>`).join("")}</urlset>`));
    res.statusCode = 404;
    res.end();
  });
  origin = base;
  try {
    const index = await pick.readSiteIndex(origin);
    assert.equal(index.robots.rules[0].path, "/secret");
    assert.deepEqual(index.urls.slice(0, 2), [`${origin}/pricing`, `${origin}/features`]);
    assert.equal(index.urls.length, 500);
  } finally {
    server.close();
  }
});
