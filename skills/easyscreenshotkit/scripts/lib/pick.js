"use strict";

// Which pages of a site are worth showing. Rules, not a model, so the same
// site gives the same pages and every pick says why it was made.
//
// Candidates are the links the home page shows (its menu first, then the
// big buttons on its first screen, the page body and the footer) and, as a
// fallback, the site's sitemap. Each one gets a kind from its address and
// its link text (pricing, product, how it works…) and a score from that kind
// and from where the link sits. Sign-in pages, legal pages, single blog
// posts and the like are left out with a reason, and so is anything the
// site's robots.txt asks crawlers to stay out of.

const zlib = require("zlib");

const fold = (text) =>
  String(text || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .toLowerCase();

const wordsOf = (text) => fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// A language at the start of a path: /tr/, /de-de/, /pt-br/, /zh-hans/.
const LANGS = "en|tr|de|fr|es|pt|it|nl|pl|ru|uk|ja|ko|zh|ar|he|sv|no|nb|da|fi|cs|sk|hu|ro|bg|el|id|ms|th|vi|hi|fa|hr|sr|sl|lt|lv|et|ca|eu|gl|is|bn|ur|af|fil|ka|hy|az|kk|uz";
const LOCALE = new RegExp(`^(${LANGS})([-_]([a-z]{2}|\\d{3}|hans|hant|latn|cyrl))?$`, "i");

// Kinds in the order they are tried; the first that matches wins. Slugs
// match whole words of a path segment ("plans-and-pricing" is pricing),
// words match whole words of the link text.
const KINDS = [
  {
    kind: "pricing",
    score: 90,
    slugs: ["pricing", "prices", "price", "plans", "plan", "fiyat", "fiyatlar", "fiyatlandirma", "ucretlendirme", "paketler", "preise", "preis", "tarife", "tarifs", "tarif", "prix", "precios", "precio", "planes", "precos", "preco", "planos", "prezzi", "prijzen", "cennik"],
    words: ["pricing", "prices", "plans", "fiyatlar", "fiyatlandirma", "paketler", "preise", "tarifs", "prix", "precios", "planes", "precos", "planos", "prezzi"],
  },
  {
    kind: "product",
    score: 80,
    slugs: ["product", "products", "features", "feature", "platform", "solutions", "solution", "capabilities", "use-cases", "usecases", "overview", "ozellikler", "urun", "urunler", "cozumler", "cozum", "funktionen", "produkt", "produkte", "losungen", "loesungen", "fonctionnalites", "produit", "produits", "funciones", "caracteristicas", "producto", "productos", "soluciones", "funcionalidades", "produto", "produtos", "solucoes", "funzionalita", "prodotti", "soluzioni"],
    words: ["product", "products", "features", "platform", "solutions", "ozellikler", "urunler", "cozumler", "funktionen", "produkte", "losungen", "fonctionnalites", "produits", "funciones", "productos", "soluciones", "funcionalidades", "produtos"],
  },
  {
    kind: "tour",
    score: 70,
    slugs: ["how-it-works", "tour", "product-tour", "nasil-calisir", "so-funktionierts", "wie-es-funktioniert", "comment-ca-marche", "como-funciona"],
    words: ["how it works", "product tour", "tour", "nasil calisir", "so funktionierts", "comment ca marche", "como funciona"],
  },
  {
    kind: "enterprise",
    score: 55,
    slugs: ["enterprise", "business", "for-business", "for-teams", "teams", "isletmeler", "entreprise", "entreprises", "empresas"],
    words: ["enterprise", "business", "for teams", "isletmeler", "entreprise", "empresas"],
  },
  {
    kind: "integrations",
    score: 50,
    slugs: ["integrations", "integration", "marketplace", "connectors", "entegrasyonlar", "entegrasyon", "integrationen", "integraciones", "integracoes"],
    words: ["integrations", "marketplace", "entegrasyonlar", "integrationen", "integraciones", "integracoes"],
  },
  {
    kind: "templates",
    score: 50,
    slugs: ["templates", "template", "gallery", "examples", "showcase", "sablonlar", "vorlagen", "modeles", "plantillas", "modelos"],
    words: ["templates", "gallery", "examples", "showcase", "sablonlar", "vorlagen", "plantillas"],
  },
  {
    kind: "changelog",
    score: 45,
    slugs: ["changelog", "releases", "release-notes", "whats-new", "what-s-new", "yenilikler", "nouveautes", "novedades", "novidades"],
    words: ["changelog", "whats new", "what s new", "release notes", "product updates", "updates", "yenilikler"],
  },
  {
    kind: "download",
    score: 45,
    slugs: ["download", "downloads", "apps", "mobile", "desktop", "indir", "uygulama", "uygulamalar", "herunterladen", "telecharger", "descargar", "baixar"],
    words: ["download", "get the app", "apps", "indir", "herunterladen", "telecharger", "descargar"],
  },
  {
    kind: "about",
    score: 30,
    slugs: ["about", "about-us", "company", "our-story", "mission", "hakkimizda", "hakkinda", "kurumsal", "uber-uns", "ueber-uns", "unternehmen", "a-propos", "qui-sommes-nous", "nosotros", "sobre", "sobre-nos", "chi-siamo"],
    words: ["about", "about us", "company", "hakkimizda", "kurumsal", "uber uns", "a propos", "nosotros", "sobre nos"],
  },
  {
    kind: "docs",
    score: 25,
    slugs: ["docs", "documentation", "developers", "developer", "api", "guides", "dokumantasyon", "dokumentation"],
    words: ["docs", "documentation", "developers", "api", "guides"],
  },
  {
    kind: "customers",
    score: 20,
    slugs: ["customers", "customer-stories", "case-studies", "case-study", "stories", "success-stories", "testimonials", "references", "musteriler", "referanslar", "kunden", "referenzen", "clients", "clientes"],
    words: ["customers", "customer stories", "case studies", "musteriler", "referanslar", "kunden", "clients", "clientes"],
  },
  {
    kind: "blog",
    score: 15,
    slugs: ["blog", "news", "articles", "resources", "insights", "haberler", "makaleler", "kaynaklar", "actualites", "noticias"],
    words: ["blog", "news", "resources", "haberler", "makaleler"],
  },
];

// A same-site link in the menu that fits no kind still shows a page the
// site itself puts forward.
const OTHER = { kind: "other", score: 10 };

const EXCLUDED = [
  {
    reason: "sign-in or sign-up page",
    slugs: ["login", "log-in", "signin", "sign-in", "signup", "sign-up", "register", "registration", "join", "account", "accounts", "my-account", "dashboard", "app", "auth", "oauth", "sso", "logout", "password", "reset-password", "forgot-password", "giris", "giris-yap", "uye-ol", "kayit", "kayit-ol", "anmelden", "registrieren", "konto", "connexion", "inscription", "compte", "iniciar-sesion", "registro", "cuenta", "entrar", "cadastro", "conta", "accedi", "registrati"],
    words: ["log in", "login", "sign in", "sign up", "register", "giris yap", "uye ol", "kayit ol", "anmelden", "registrieren", "connexion", "inscription"],
  },
  {
    reason: "legal page",
    slugs: ["privacy", "privacy-policy", "terms", "terms-of-service", "terms-of-use", "tos", "legal", "cookies", "cookie-policy", "cookie-settings", "imprint", "impressum", "gdpr", "dpa", "kvkk", "gizlilik", "gizlilik-politikasi", "cerez", "cerez-politikasi", "kullanim-kosullari", "aydinlatma-metni", "datenschutz", "agb", "mentions-legales", "confidentialite", "cgu", "cgv", "privacidad", "aviso-legal", "terminos", "privacidade", "termos", "accessibility", "acceptable-use", "sitemap"],
    words: ["privacy", "terms", "cookie", "cookies", "imprint", "impressum", "kvkk", "datenschutz", "legal", "gizlilik"],
  },
  {
    reason: "not a product page",
    slugs: ["careers", "career", "jobs", "job", "kariyer", "is-ilanlari", "karriere", "emplois", "carrieres", "empleo", "carreiras", "vagas", "contact", "contact-us", "contacts", "iletisim", "bize-ulasin", "kontakt", "contacto", "contato", "contatti", "support", "help", "help-center", "helpcenter", "status", "press", "newsroom", "media-kit", "brand", "brand-assets", "basin", "presse", "prensa", "imprensa", "investors", "investor-relations", "cart", "checkout", "basket", "sepet", "search", "feed", "rss", "tags", "tag", "category", "categories", "author", "authors"],
    words: ["careers", "jobs", "contact", "contact us", "support", "help center", "status", "press", "kariyer", "iletisim", "karriere", "kontakt"],
  },
];

// Sections whose pages are single posts: the index is a page worth showing,
// one post in it is not.
const POST_SECTIONS = new Set([
  "blog", "news", "articles", "article", "posts", "post", "stories", "story", "customers", "customer-stories", "case-studies",
  "case-study", "changelog", "releases", "release-notes", "updates", "docs", "documentation", "help", "guides", "guide", "learn",
  "resources", "insights", "events", "webinars", "podcast", "videos", "tutorials", "academy", "haberler", "makaleler", "duyurular",
  "kaynaklar", "musteriler", "referanslar",
]);

const FILE = /\.(pdf|zip|rar|7z|gz|dmg|exe|msi|pkg|apk|ipa|iso|docx?|xlsx?|pptx?|csv|txt|xml|json|rss|atom|mp4|mov|webm|mp3|wav|png|jpe?g|gif|svg|webp|ico)$/i;

const WHERE_BONUS = { header: 20, hero: 10, body: 5, footer: 0, sitemap: -10 };
const WHERE_ORDER = ["given", "asked", "header", "hero", "body", "footer", "sitemap"];
const WHERE_NAME = { header: "menu link", hero: "button", body: "link", footer: "footer link" };

// How many pages of one kind make the first pass; a second pass takes what
// is left when there are not enough kinds.
const KIND_LIMIT = { product: 2 };

function segmentsOf(pathname) {
  return String(pathname || "")
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return fold(decodeURIComponent(part));
      } catch {
        return fold(part);
      }
    });
}

// A phrase ("how it works") inside a list of words, as whole words.
function hasPhrase(words, phrase) {
  const want = phrase.split(/[\s-]+/);
  for (let i = 0; i + want.length <= words.length; i++) {
    if (want.every((word, k) => words[i + k] === word)) return true;
  }
  return false;
}

// A kind's slug may sit inside a segment ("plans-and-pricing"); a reason to
// leave a page out only counts as a whole segment, so /features/account-sync
// is not taken for an account page.
function pathMatches(rule, segments, whole = false) {
  for (const segment of segments) {
    if (whole) {
      if (rule.slugs.includes(segment)) return true;
      continue;
    }
    const words = segment.split(/[-_.]+/).filter(Boolean);
    if (rule.slugs.some((slug) => segment === slug || hasPhrase(words, slug))) return true;
  }
  return false;
}

// A menu label is a word or three ("Plans and pricing"). A longer text is a
// teaser or an offer ("DHL eCommerce Avantajlı Fiyatlar!" leads to a
// campaign, not to the prices), and its words say nothing about the page.
function textMatches(rule, text) {
  const words = wordsOf(text);
  return words.length > 0 && words.length <= 3 && rule.words.some((phrase) => hasPhrase(words, phrase));
}

// Kinds that hold product pages below them: /features/sso is a page about a
// product's single sign-on, not a sign-in page.
const SHOWCASE_SECTIONS = new Set(["pricing", "product", "tour", "integrations", "templates"]);

// The site a page belongs to: its host without www.
const siteOf = (url) => new URL(url).hostname.toLowerCase().replace(/^www\./, "");

function localeOf(pathname) {
  const first = String(pathname || "").split("/").filter(Boolean)[0] || "";
  return LOCALE.test(first) ? first.toLowerCase() : "";
}

// The home page for an address: the site's root, or its language root
// (/tr/) when the address is under one.
function homeOf(raw) {
  const url = new URL(raw);
  const locale = localeOf(url.pathname);
  const first = url.pathname.split("/").filter(Boolean)[0];
  return `${url.origin}/${locale ? `${first}/` : ""}`;
}

// One key per page: the site, the path without a trailing slash, no query or
// hash.
function pageKey(raw) {
  const url = new URL(raw);
  return `${siteOf(url.href)}${url.pathname.replace(/\/+$/, "").toLowerCase() || "/"}`;
}

// The address to open for a link: absolute, http(s), no hash, no query.
function linkUrl(raw, base) {
  let url;
  try {
    url = new URL(String(raw || "").trim(), base);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  url.hash = "";
  url.search = "";
  return url;
}

function innerSegments(url) {
  const segments = segmentsOf(url.pathname);
  return localeOf(url.pathname) ? segments.slice(1) : segments;
}

// Why a same-site page is not taken, or "" when it may be. The words on the
// link only count when the address itself says nothing: a "Sign up free"
// button that leads to /pricing still leads to the pricing page.
function excludedBecause(url, text, { homeLocale = "" } = {}) {
  const locale = localeOf(url.pathname);
  if (locale && locale !== homeLocale) return "another language";
  const inner = innerSegments(url);
  const section = KINDS.find((rule) => pathMatches(rule, inner.slice(0, 1)));
  if (!(section && SHOWCASE_SECTIONS.has(section.kind))) {
    for (const rule of EXCLUDED) if (pathMatches(rule, inner, true)) return rule.reason;
  }
  if (inner.length >= 2 && (POST_SECTIONS.has(inner[0]) || inner.some((part) => /^(19|20)\d\d$/.test(part)))) return "a single post";
  const last = inner[inner.length - 1] || "";
  if (last.split(/[-_]+/).length >= 6) return "a single post";
  if (!KINDS.some((rule) => pathMatches(rule, inner.slice(0, 1)))) {
    for (const rule of EXCLUDED) if (textMatches(rule, text)) return rule.reason;
  }
  return "";
}

// The kind a link's words name: the longest phrase wins, so "Product
// updates" is the changelog, not a product page.
function textKind(text) {
  let best = null;
  let length = 0;
  for (const rule of KINDS) {
    for (const phrase of rule.words) {
      const size = phrase.split(/\s+/).length;
      if (size > length && textMatches({ words: [phrase] }, text)) {
        best = rule;
        length = size;
      }
    }
  }
  return best;
}

// A page's kind comes from the first part of its path (/features/sso is a
// product page, /now/why-teams-win is not) and, when the path says nothing,
// from the link's words. byText tells which.
function kindOf(url, text) {
  const first = innerSegments(url).slice(0, 1);
  const byPath = KINDS.find((rule) => pathMatches(rule, first));
  if (byPath) return byPath;
  const byText = textKind(text);
  return byText ? { ...byText, byText: true } : null;
}

// A section's own page shows more of the product than one page in it:
// /solutions before /solutions/gaming.
const depthOf = (url) => segmentsOf(url.pathname).length - (localeOf(url.pathname) ? 1 : 0);

// A kind read from the address is surer than one read from the link's
// words: /enterprise goes before a "Small business" link to /small-business.
function scoreOf(kind, where, url) {
  const depth = depthOf(url);
  return kind.score + (WHERE_BONUS[where] || 0) - (depth >= 3 ? 15 : depth === 2 ? 5 : 0) - (kind.byText ? 5 : 0);
}

function whyOf(where, text, url) {
  if (where === "sitemap") return "listed in the sitemap";
  const label = String(text || "").replace(/\s+/g, " ").trim().slice(0, 40);
  return label ? `${WHERE_NAME[where]} "${label}"` : `${WHERE_NAME[where]} to ${url.pathname}`;
}

// Ranks the home page's links and the sitemap's addresses. links:
// [{href, text, where}] with where header, hero, body or footer. Returns
// {candidates, skipped}: candidates best first, skipped with reasons (links
// only: a sitemap holds every post the site has).
function rankLinks(links, sitemap, { home, robots = null, alternates = [], exclude = [] }) {
  const homeUrl = new URL(home);
  const homeLocale = localeOf(homeUrl.pathname);
  const site = siteOf(home);
  const taken = new Set([pageKey(home), ...exclude.map(pageKey)]);
  const otherLanguages = new Set(alternates.map((alt) => { try { return pageKey(alt); } catch { return ""; } }));
  const byKey = new Map();
  const skipped = new Map();
  let order = 0;
  const consider = (raw, text, where) => {
    const url = linkUrl(raw, home);
    if (!url || siteOf(url.href) !== site || FILE.test(url.pathname)) return;
    const key = pageKey(url.href);
    if (taken.has(key)) return;
    order++;
    let reason = otherLanguages.has(key) ? "another language" : excludedBecause(url, text, { homeLocale });
    if (!reason && robots && !robotsAllows(url.pathname, robots.rules)) reason = "robots.txt asks crawlers to stay out";
    if (reason) {
      if (where !== "sitemap" && !skipped.has(key)) skipped.set(key, { url: url.href, reason });
      return;
    }
    const kind = kindOf(url, text) || (where === "header" || where === "hero" ? OTHER : null);
    if (!kind) return;
    const candidate = { url: url.href, kind: kind.kind, score: scoreOf(kind, where, url), where, why: whyOf(where, text, url), order };
    const known = byKey.get(key);
    const better = !known || candidate.score > known.score || (candidate.score === known.score && WHERE_ORDER.indexOf(where) < WHERE_ORDER.indexOf(known.where));
    if (better) byKey.set(key, known ? { ...candidate, order: known.order } : candidate);
  };
  for (const link of links) consider(link.href, link.text, link.where);
  for (const raw of sitemap) consider(raw, "", "sitemap");
  // A page left out for one link's words but taken from another link.
  for (const key of byKey.keys()) skipped.delete(key);
  // On a tie the site's own order decides: the first link of a menu is
  // usually the one it puts forward.
  const candidates = [...byKey.values()].sort(
    (a, b) =>
      b.score - a.score ||
      WHERE_ORDER.indexOf(a.where) - WHERE_ORDER.indexOf(b.where) ||
      depthOf(new URL(a.url)) - depthOf(new URL(b.url)) ||
      a.order - b.order,
  );
  return { candidates, skipped: [...skipped.values()] };
}

// The order to visit candidates in: the best of each kind first (two for
// product pages), then whatever is left.
function visitOrder(candidates) {
  const counts = {};
  const first = [];
  const rest = [];
  for (const candidate of candidates) {
    const limit = KIND_LIMIT[candidate.kind] || 1;
    counts[candidate.kind] = (counts[candidate.kind] || 0) + 1;
    (counts[candidate.kind] <= limit ? first : rest).push(candidate);
  }
  return [...first, ...rest];
}

// ─── robots.txt ────────────────────────────────────────────────────────────
// Only the pages easyscreenshotkit finds by itself are held to it: a page the
// user names is always taken, as a browser would open it.
function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
    } else if (key === "user-agent") {
      if (!current || current.rules.length) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && current && value) {
      current.rules.push({ allow: key === "allow", path: value });
    }
  }
  const ours = groups.find((group) => group.agents.some((agent) => agent.includes("easyscreenshotkit"))) || groups.find((group) => group.agents.includes("*"));
  return { sitemaps, rules: ours ? ours.rules : [] };
}

function ruleRegex(rule) {
  const anchored = rule.endsWith("$");
  const body = (anchored ? rule.slice(0, -1) : rule)
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

// The longest rule that matches decides; on a tie, Allow wins.
function robotsAllows(pathname, rules) {
  let best = null;
  for (const rule of rules || []) {
    if (!ruleRegex(rule.path).test(pathname)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  return !best || best.allow;
}

// ─── sitemaps ──────────────────────────────────────────────────────────────
const decodeXml = (text) =>
  text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, code) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[code.toLowerCase()];
    if (named) return named;
    return String.fromCodePoint(code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10));
  });

function parseSitemap(xml) {
  const text = String(xml || "");
  const index = /<sitemapindex[\s>]/i.test(text);
  const locs = [...text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decodeXml(m[1]));
  return index ? { urls: [], sitemaps: locs } : { urls: locs, sitemaps: [] };
}

// Of a sitemap index, the parts most likely to hold the site's own pages.
const PAGES_SITEMAP = /page|main|static|site|core|marketing|default|general/i;
const POSTS_SITEMAP = /post|blog|news|article|product|image|video|tag|categor|author|doc|help|changelog|customer|stor(y|ies)|event|job|career|location/i;

function sitemapOrder(urls) {
  const nameOf = (url) => {
    try {
      return new URL(url).pathname.split("/").pop().replace(/sitemap|\.xml|\.gz/gi, "");
    } catch {
      return String(url);
    }
  };
  const score = (url) => {
    const name = nameOf(url);
    if (PAGES_SITEMAP.test(name)) return 0;
    if (!name.replace(/[-_.\d]/g, "")) return 1;
    return POSTS_SITEMAP.test(name) ? 3 : 2;
  };
  return [...urls].sort((a, b) => score(a) - score(b));
}

const FETCH_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

async function fetchText(url, { limit = 5_000_000, timeout = 8_000 } = {}) {
  const res = await fetch(url, { headers: { "user-agent": FETCH_AGENT, accept: "*/*" }, redirect: "follow", signal: AbortSignal.timeout(timeout) });
  if (!res.ok || !res.body) return "";
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > limit) break;
  }
  let body = Buffer.concat(chunks);
  if (body[0] === 0x1f && body[1] === 0x8b) {
    try {
      body = zlib.gunzipSync(body, { maxOutputLength: limit * 4 });
    } catch {
      return "";
    }
  }
  return body.toString("utf8");
}

// robots.txt and up to 500 addresses from the sitemaps, read with a time
// limit; a site without them gives empty lists.
async function readSiteIndex(origin, { max = 500, sitemapFiles = 4 } = {}) {
  let robots = { sitemaps: [], rules: [] };
  try {
    robots = parseRobots(await fetchText(`${origin}/robots.txt`, { limit: 500_000, timeout: 6_000 }));
  } catch {
    // No robots.txt: nothing is off limits.
  }
  const queue = sitemapOrder(robots.sitemaps.length ? robots.sitemaps : [`${origin}/sitemap.xml`]);
  const urls = [];
  const seen = new Set();
  let read = 0;
  while (queue.length && read < sitemapFiles && urls.length < max) {
    const next = queue.shift();
    if (seen.has(next)) continue;
    seen.add(next);
    read++;
    let parsed;
    try {
      parsed = parseSitemap(await fetchText(next, { timeout: 8_000 }));
    } catch {
      continue;
    }
    queue.unshift(...sitemapOrder(parsed.sitemaps).slice(0, 3));
    for (const url of parsed.urls) {
      if (urls.length >= max) break;
      urls.push(url);
    }
  }
  return { robots, urls };
}

module.exports = {
  fold,
  KINDS,
  homeOf,
  pageKey,
  linkUrl,
  localeOf,
  siteOf,
  excludedBecause,
  kindOf,
  rankLinks,
  visitOrder,
  parseRobots,
  robotsAllows,
  parseSitemap,
  sitemapOrder,
  readSiteIndex,
};
