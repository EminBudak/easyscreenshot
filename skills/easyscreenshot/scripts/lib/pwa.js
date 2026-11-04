"use strict";

// Screenshots for a web app manifest. Chrome shows a manifest's screenshots
// in its richer install dialog; a manifest without them gets the plain one,
// and DevTools warns "Richer PWA Install UI won't be available". The rules
// below are Chrome's own, read from its source (the installable data
// fetcher, the manifest icon downloader and the webapps constants) and from
// the warnings DevTools gives:
//
//   - each side from 320 to 3840 pixels, the long side at most 2.3 times
//     the short one; web.dev names JPEG and PNG as the formats
//   - a desktop shows the screenshots whose form_factor is "wide", a phone
//     all the others ("narrow" or none)
//   - Chrome looks at the first 8 entries of the list and no further,
//     whatever their form factor, and leaves out one whose shape is not the
//     first one's it kept; DevTools warns past 5 on a phone
//   - Chrome scales a screenshot down to the first of its sizes, and to 320
//     pixels high when it has none; DevTools checks sizes against the file
//   - the description shows above the screenshots, about 300 characters
//
// checkScreenshots() applies them to any list of screenshots; planPwa()
// turns the captures of a run with --pwa into a list that keeps them; and
// checkManifest() reads a manifest from a file or the web for --pwa-check,
// with no browser.

const fs = require("fs");
const path = require("path");
const { pngSize } = require("./png");
const version = require("./version");

const MIN_SIDE = 320;
const MAX_SIDE = 3840;
const MAX_RATIO = 2.3;
const LOOKED_AT = 8;
const PHONE_SHOWS = 5;
const DESCRIPTION_SHOWN = 300;

// What --pwa takes of each page: the first screen of the 1600x900 desktop
// at 1.2x, 1920x1080 (the full menu, in about a third of the pixels of the
// 2x desktop capture), and of the phone at 3x, 1080x1920. Both are 16:9,
// well inside the 2.3 limit.
const PWA_SHOTS = {
  wide: { width: 1600, height: 900, scale: 1.2, mobile: false },
  narrow: { width: 360, height: 640, scale: 3, mobile: true },
};

const NAMES = { png: "PNG", jpeg: "JPEG", gif: "GIF", webp: "WebP", avif: "AVIF", heic: "HEIC", svg: "SVG" };
const MIME = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", heic: "image/heic", svg: "image/svg+xml" };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The format and size of an image from its first bytes. Sizes are read for
// PNG, JPEG, GIF and WebP; AVIF, HEIC and SVG are only named.
function imageInfo(buf) {
  const none = { format: "", width: 0, height: 0 };
  if (!Buffer.isBuffer(buf) || buf.length < 12) return none;
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG) && buf.toString("latin1", 12, 16) === "IHDR") {
    return { format: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { format: "jpeg", ...jpegSize(buf) };
  const head = buf.toString("latin1", 0, 12);
  if (/^GIF8[79]a/.test(head)) return { format: "gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (head.startsWith("RIFF") && head.slice(8) === "WEBP") return { format: "webp", ...webpSize(buf) };
  if (head.slice(4, 8) === "ftyp") {
    const brand = head.slice(8, 12);
    if (/^avi[fs]$/.test(brand)) return { format: "avif", width: 0, height: 0 };
    if (/^(heic|heix|hevc|mif1)$/.test(brand)) return { format: "heic", width: 0, height: 0 };
  }
  const text = buf.toString("utf8", 0, Math.min(buf.length, 2048)).replace(/^\uFEFF/, "").trimStart().toLowerCase();
  if (text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg"))) return { format: "svg", width: 0, height: 0 };
  return none;
}

// The size in a JPEG's start-of-frame segment.
function jpegSize(buf) {
  for (let at = 2; at + 9 < buf.length; ) {
    if (buf[at] !== 0xff) {
      at++;
      continue;
    }
    const marker = buf[at + 1];
    // Fill bytes, and the markers that carry no length.
    if (marker === 0xff) at++;
    else if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) at += 2;
    else if (marker === 0xd9 || marker === 0xda) break;
    else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(at + 7), height: buf.readUInt16BE(at + 5) };
    } else at += 2 + buf.readUInt16BE(at + 2);
  }
  return { width: 0, height: 0 };
}

function webpSize(buf) {
  const chunk = buf.toString("latin1", 12, 16);
  if (chunk === "VP8X" && buf.length >= 30) return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  if (chunk === "VP8L" && buf.length >= 25) {
    const bits = buf.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (chunk === "VP8 " && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  return { width: 0, height: 0 };
}

const isWide = (shot) => shot.formFactor.toLowerCase() === "wide";
const dims = (image) => `${image.width}x${image.height}`;
// 4, "1 and 2", "1, 3 and 5", "2 to 6".
const span = (list) => {
  if (list.length >= 3 && list.every((n, i) => i === 0 || n === list[i - 1] + 1)) return `${list[0]} to ${list[list.length - 1]}`;
  return list.length === 1 ? String(list[0]) : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
};
const numbers = (list) => `${list.length === 1 ? "screenshot" : "screenshots"} ${span(list)}`;

// One entry of the list. image: {format, width, height} as read from its
// file, {error} when it could not be read, undefined when it was not looked
// at.
function readEntry(raw, i, image) {
  const entry = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const text = (key) => (typeof entry[key] === "string" ? entry[key].trim() : "");
  return {
    n: i + 1,
    src: text("src"),
    sizes: text("sizes"),
    type: text("type"),
    label: text("label"),
    formFactor: text("form_factor"),
    image: image && !image.error ? image : null,
    error: image && image.error ? image.error : "",
    shownOn: [],
    leftOut: "",
    problems: [],
    tips: [],
  };
}

// Why Chrome can show a screenshot nowhere, or "".
function unusable(shot) {
  if (!shot.src) return "no src";
  if (shot.error) return `could not be loaded (${shot.error})`;
  if (!shot.image) return "";
  const { format, width, height } = shot.image;
  if (!format) return "not an image";
  if (!width || !height) return `${NAMES[format]}, whose size this check cannot read`;
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  if (short < MIN_SIDE) return `${dims(shot.image)}, a side under ${MIN_SIDE} pixels`;
  if (long > MAX_SIDE) return `${dims(shot.image)}, a side over ${MAX_SIDE} pixels`;
  if (long > short * MAX_RATIO) return `${dims(shot.image)}, ${(long / short).toFixed(2)} times as ${width > height ? "wide as high" : "high as wide"}, more than ${MAX_RATIO}`;
  return "";
}

// What Chrome scales a picture down to for a size it was told: that many
// pixels high, as wide as its shape makes it. null when it stays as it is.
function scaledTo(image, ideal) {
  if (!image || !image.width || !image.height) return null;
  const width = Math.round((image.width / image.height) * ideal);
  return image.height > ideal || image.width > width ? `${width}x${ideal}` : null;
}

function sizeProblem(shot) {
  const image = shot.image && shot.image.width && shot.image.height ? shot.image : null;
  if (!shot.sizes) {
    const to = scaledTo(image, MIN_SIDE);
    return `no sizes, so Chrome shows a copy scaled down to ${to || `${MIN_SIDE} pixels high`}`;
  }
  const first = shot.sizes.split(/\s+/)[0];
  if (/^any$/i.test(first)) return `sizes starts with "any"; give the size in pixels, ${image ? dims(image) : "WIDTHxHEIGHT"}`;
  const m = /^(\d+)[xX](\d+)$/.exec(first);
  if (!m) return `sizes "${shot.sizes}" is not WIDTHxHEIGHT`;
  if (image && (Number(m[1]) !== image.width || Number(m[2]) !== image.height)) {
    const to = scaledTo(image, Math.max(Number(m[1]), Number(m[2])));
    return `sizes says ${m[1]}x${m[2]} and the file is ${dims(image)}${to ? `, so Chrome shows a copy scaled down to ${to}` : ""}`;
  }
  return "";
}

// Applies Chrome's rules to a manifest's screenshots: which ones a desktop
// and a phone show, and what to fix (problems) or add (tips). images[i] is
// what was read of screenshot i's file (see readEntry); description, the
// manifest's own, when the whole manifest is checked.
function checkScreenshots(list, images = [], options = {}) {
  const problems = [];
  const tips = [];
  if (list !== undefined && list !== null && !Array.isArray(list)) problems.push('"screenshots" is not a list, so Chrome reads none of it.');
  const shots = (Array.isArray(list) ? list : []).map((raw, i) => readEntry(raw, i, images[i]));
  for (const shot of shots) {
    if (shot.n > LOOKED_AT) {
      shot.leftOut = `Chrome looks at the first ${LOOKED_AT} screenshots only`;
      continue;
    }
    shot.leftOut = unusable(shot);
    const format = shot.image ? shot.image.format : "";
    if (shot.leftOut) shot.problems.push(shot.leftOut);
    else if (shot.image) {
      if (format !== "png" && format !== "jpeg") shot.problems.push(`${NAMES[format]}, and Chrome's rules take JPEG and PNG`);
      const size = sizeProblem(shot);
      if (size) shot.problems.push(size);
    }
    if (!shot.src) continue;
    if (!shot.type) shot.tips.push(`no type; add "${MIME[format] || "image/png"}"`);
    else if (MIME[format] && shot.type.toLowerCase() !== MIME[format] && !(format === "jpeg" && /^image\/jpg$/i.test(shot.type))) {
      shot.tips.push(`type says ${shot.type} and the file is ${NAMES[format]}`);
    }
    if (!shot.label) shot.tips.push("no label, the text screen readers read out");
    if (shot.formFactor && !/^(wide|narrow)$/i.test(shot.formFactor)) {
      shot.tips.push(`form_factor "${shot.formFactor}" is neither "wide" nor "narrow", which Chrome takes as none: phones only`);
    }
  }
  const shown = { desktop: [], phone: [] };
  for (const platform of ["desktop", "phone"]) {
    let first = null;
    for (const shot of shots.slice(0, LOOKED_AT)) {
      if (isWide(shot) !== (platform === "desktop") || shot.leftOut || !shot.image) continue;
      const { width, height } = shot.image;
      if (first && width * first.image.height !== height * first.image.width) {
        shot.problems.push(`a different shape from screenshot ${first.n} (${dims(first.image)}), the first one ${platform === "desktop" ? "desktops" : "phones"} show, and Chrome shows one shape only`);
        continue;
      }
      if (platform === "phone" && shown.phone.length >= PHONE_SHOWS) {
        shot.problems.push(`past the ${PHONE_SHOWS} that DevTools says a phone shows`);
        continue;
      }
      first = first || shot;
      shown[platform].push(shot.n);
      shot.shownOn.push(platform);
    }
  }
  if (!shots.length) problems.push("There are no screenshots, so Chrome shows its plain install dialog on desktops and on phones.");
  else {
    const wide = shots.filter(isWide);
    if (!shown.desktop.length) {
      problems.push(
        wide.length
          ? "Desktops get the plain install dialog: Chrome can show none of the wide screenshots."
          : 'Desktops get the plain install dialog: no screenshot has form_factor "wide".',
      );
    }
    if (!shown.phone.length) {
      problems.push(
        wide.length < shots.length
          ? "Phones get the plain install dialog: Chrome can show none of the screenshots for phones."
          : 'Phones get the plain install dialog: every screenshot is "wide". Add one with form_factor "narrow".',
      );
    }
    if (shots.length > LOOKED_AT) {
      problems.push(`Chrome looks at the first ${LOOKED_AT} screenshots of the list only, wide and narrow together, so ${numbers(shots.slice(LOOKED_AT).map((shot) => shot.n))} never show.`);
    }
  }
  // The same words for several screenshots come once, with their numbers.
  const grouped = (key) => {
    const texts = new Map();
    for (const shot of shots) for (const text of shot[key]) texts.set(text, [...(texts.get(text) || []), shot]);
    return [...texts].map(([text, list]) => {
      const one = list.length === 1 && list[0].src ? ` (${list[0].src.length > 60 ? `${list[0].src.slice(0, 57)}...` : list[0].src})` : "";
      const name = numbers(list.map((shot) => shot.n));
      return `${name.charAt(0).toUpperCase()}${name.slice(1)}${one}: ${text}.`;
    });
  };
  problems.push(...grouped("problems"));
  tips.push(...grouped("tips"));
  if ("description" in options) {
    const text = typeof options.description === "string" ? options.description.trim() : "";
    if (!text) tips.push(`There is no description. Chrome shows it above the screenshots, about ${DESCRIPTION_SHOWN} characters of it.`);
    else if (text.length > DESCRIPTION_SHOWN) tips.push(`The description has ${text.length} characters, and Chrome shows about ${DESCRIPTION_SHOWN} of them.`);
  }
  return { ok: problems.length === 0, desktop: shown.desktop, phone: shown.phone, screenshots: shots, problems, tips };
}

// A screenshot's label, read out by screen readers: the main heading on that
// screen, else the page's own heading or title.
function labelOf(headings, page) {
  const found = (headings || []).filter((heading) => heading && heading.text);
  const main = found.find((heading) => heading.level === 1) || found.slice().sort((a, b) => a.level - b.level)[0];
  const text = String((main && main.text) || page.heading || page.title || page.slug || "").replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 117).trimEnd()}...` : text;
}

// The screenshots a run hands over for a manifest. pages: [{n, slug,
// heading, title, captures: {wide, narrow}}], each capture {png, headings}.
// Every capture is checked with Chrome's rules first. Chrome looks at the
// first 8 entries only, wide and narrow together, so at most 8 go in: 4 of
// each when there are, the room one leaves going to the other, and no more
// than 5 narrow ones. Returns {files: [{name, form, page, png, entry}],
// entries, leftOut: [{page, form, reason}], check}.
function planPwa(pages) {
  const leftOut = [];
  const usable = { wide: [], narrow: [] };
  for (const form of ["wide", "narrow"]) {
    let first = null;
    for (const page of pages) {
      const capture = page.captures && page.captures[form];
      if (!capture) continue;
      const size = pngSize(capture.png);
      const image = size ? { format: "png", ...size } : { format: "", width: 0, height: 0 };
      const reason = unusable({ src: "file", error: "", image });
      if (reason) {
        leftOut.push({ page: page.n, form, reason });
        continue;
      }
      if (first && image.width * first.height !== image.height * first.width) {
        leftOut.push({ page: page.n, form, reason: `a different shape from the first ${form} one (${dims(first)})` });
        continue;
      }
      first = first || image;
      usable[form].push({ page, form, png: capture.png, image, label: labelOf(capture.headings, page) });
    }
  }
  const wide = Math.min(usable.wide.length, LOOKED_AT - Math.min(usable.narrow.length, LOOKED_AT / 2));
  const narrow = Math.min(usable.narrow.length, PHONE_SHOWS, LOOKED_AT - wide);
  const files = [];
  for (const [form, keep] of [["wide", wide], ["narrow", narrow]]) {
    usable[form].forEach((item, i) => {
      if (i >= keep) {
        leftOut.push({ page: item.page.n, form, reason: `Chrome looks at the first ${LOOKED_AT} screenshots of a manifest only, wide and narrow together` });
        return;
      }
      const name = `${form}-${String(i + 1).padStart(2, "0")}.png`;
      const entry = { src: `screenshots/${name}`, sizes: dims(item.image), type: "image/png", form_factor: form, label: item.label };
      files.push({ name, form, page: item.page.n, png: item.png, entry });
    });
  }
  const entries = files.map((file) => file.entry);
  leftOut.sort((a, b) => a.page - b.page || (a.form === "wide" ? -1 : 1));
  return { files, entries, leftOut, check: checkScreenshots(entries, files.map((file) => ({ format: "png", ...pngSize(file.png) }))) };
}

// ─── reading a manifest ────────────────────────────────────────────────────

const FETCH_MS = 15_000;
const MAX_BYTES = 30 * 1024 * 1024;
const AGENT = `easyscreenshot/${version} (+https://github.com/EminBudak/easyscreenshot)`;

function reasonOf(err) {
  if (err && (err.name === "TimeoutError" || err.name === "AbortError")) return `no answer in ${FETCH_MS / 1000} s`;
  const cause = err && err.cause;
  if (cause && cause.code === "ENOTFOUND") return `${cause.hostname || "the host"} was not found`;
  if (cause && cause.code) return cause.code;
  if (err && err.code === "ENOENT") return `there is no file ${err.path}`;
  return (err && err.message) || String(err);
}

async function get(url, accept) {
  const res = await fetch(url, { headers: { "User-Agent": AGENT, Accept: accept }, redirect: "follow", signal: AbortSignal.timeout(FETCH_MS) });
  if (!res.ok) throw new Error(`answered ${res.status}`);
  if (Number(res.headers.get("content-length") || 0) > MAX_BYTES) throw new Error(`over ${MAX_BYTES / 1024 / 1024} MB`);
  return { url: res.url || url, type: res.headers.get("content-type") || "", body: Buffer.from(await res.arrayBuffer()) };
}

function parseJson(text, where) {
  try {
    return JSON.parse(String(text).replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`${where} is not JSON, so it is not a web app manifest`);
  }
}

// The manifest a page links with <link rel="manifest">, as an address.
function manifestLink(html, base) {
  const attr = (tag, name) => {
    const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
    return m ? (m[1] ?? m[2] ?? m[3] ?? "").replace(/&amp;/g, "&").trim() : "";
  };
  for (const [tag] of String(html).matchAll(/<link\b[^>]*>/gi)) {
    if (!attr(tag, "rel").toLowerCase().split(/\s+/).includes("manifest")) continue;
    const href = attr(tag, "href");
    if (!href) continue;
    try {
      return new URL(href, base).href;
    } catch {
      return "";
    }
  }
  return "";
}

// target: {file} or {url}. A web address may be the manifest itself or a
// page that links it.
async function loadManifest(target) {
  if (target.file) {
    let text;
    try {
      text = fs.readFileSync(target.file, "utf8");
    } catch (err) {
      throw new Error(`Could not read ${target.file}: ${reasonOf(err)}`);
    }
    return { where: target.file, base: { dir: path.dirname(path.resolve(target.file)) }, json: parseJson(text, target.file) };
  }
  let got;
  try {
    got = await get(target.url, "application/manifest+json, application/json;q=0.9, text/html;q=0.8, */*;q=0.5");
  } catch (err) {
    throw new Error(`Could not read ${target.url}: ${reasonOf(err)}`);
  }
  const text = got.body.toString("utf8").replace(/^\uFEFF/, "");
  if (/^\s*\{/.test(text) || (!/html/i.test(got.type) && !/^\s*</.test(text))) return { where: got.url, base: { url: got.url }, json: parseJson(text, got.url) };
  const href = manifestLink(text, got.url);
  if (!href) throw new Error(`${got.url} links no web app manifest (no <link rel="manifest"> in its HTML). Give the manifest's own address or file.`);
  let manifest;
  try {
    manifest = await get(href, "application/manifest+json, application/json;q=0.9, */*;q=0.5");
  } catch (err) {
    throw new Error(`Could not read ${href}, the manifest ${got.url} links: ${reasonOf(err)}`);
  }
  return { where: manifest.url, page: got.url, base: { url: manifest.url }, json: parseJson(manifest.body.toString("utf8"), manifest.url) };
}

// A screenshot's file, from the web or next to a manifest file. Next to a
// file, a src that starts with "/" is taken from the manifest's folder: a
// manifest usually sits at the site's root.
async function loadImage(src, base) {
  const data = /^data:([^,]*?)(;base64)?,(.*)$/is.exec(src);
  if (data) return imageInfo(data[2] ? Buffer.from(data[3], "base64") : Buffer.from(decodeURIComponent(data[3]), "utf8"));
  if (base.url || /^https?:\/\//i.test(src)) {
    const url = new URL(src, base.url).href;
    if (!/^https?:/i.test(url)) throw new Error(`${url} is not a web address`);
    return imageInfo((await get(url, "image/png,image/jpeg;q=0.9,image/*;q=0.8,*/*;q=0.5")).body);
  }
  let name = src.split(/[?#]/)[0];
  try {
    name = decodeURIComponent(name);
  } catch {
    // Kept as written.
  }
  return imageInfo(fs.readFileSync(path.join(base.dir, name.replace(/^\/+/, ""))));
}

// --pwa-check: the manifest read, its screenshots' files read (the first 8,
// as Chrome does), and Chrome's rules applied.
async function checkManifest(target) {
  const found = await loadManifest(target);
  const json = found.json && typeof found.json === "object" && !Array.isArray(found.json) ? found.json : {};
  const list = Array.isArray(json.screenshots) ? json.screenshots : [];
  const images = await Promise.all(
    list.slice(0, LOOKED_AT).map((entry) => {
      const src = entry && typeof entry.src === "string" ? entry.src.trim() : "";
      return src ? loadImage(src, found.base).catch((err) => ({ error: reasonOf(err) })) : undefined;
    }),
  );
  // A file with screenshots and nothing else, such as the
  // manifest-screenshots.json of a run, is a part of a manifest: its
  // description is not looked for.
  const whole = ["name", "short_name", "description", "start_url", "icons"].some((key) => key in json);
  return {
    manifest: found.where,
    page: found.page || "",
    name: String(json.name || json.short_name || ""),
    ...checkScreenshots(json.screenshots, images, whole ? { description: json.description } : {}),
  };
}

// A check as text, for people.
function describeCheck(report) {
  const lines = [`Checked ${report.manifest}${report.page ? `, the manifest of ${report.page}` : ""}`, ""];
  const dialog = (shown) => (shown.length ? `the richer install dialog, with ${numbers(shown)}` : "the plain install dialog");
  lines.push(`  Desktop  ${dialog(report.desktop)}`, `  Phone    ${dialog(report.phone)}`);
  if (report.screenshots.length) {
    lines.push("");
    const width = Math.min(44, Math.max(...report.screenshots.map((shot) => shot.src.length), 3));
    for (const shot of report.screenshots) {
      const src = shot.src.length > width ? `${shot.src.slice(0, width - 3)}...` : shot.src || "(no src)";
      const file = shot.image ? `${shot.image.width && shot.image.height ? dims(shot.image) : "?"} ${NAMES[shot.image.format] || "not an image"}` : shot.error ? "not loaded" : "not read";
      const where = shot.shownOn.length ? `shown on ${shot.shownOn.map((platform) => `${platform}s`).join(" and ")}` : "left out";
      lines.push(`  ${String(shot.n).padStart(2)}  ${src.padEnd(width)}  ${file.padEnd(14)}  ${(shot.formFactor || "none").padEnd(6)}  ${where}`);
    }
  }
  if (report.problems.length) lines.push("", "To fix:", ...report.problems.map((text) => `  - ${text}`));
  else lines.push("", "Nothing to fix: Chrome shows them as they are.");
  if (report.tips.length) lines.push("", "Worth adding:", ...report.tips.map((text) => `  - ${text}`));
  return lines.join("\n");
}

module.exports = {
  PWA_SHOTS,
  LOOKED_AT,
  PHONE_SHOWS,
  imageInfo,
  checkScreenshots,
  labelOf,
  planPwa,
  manifestLink,
  checkManifest,
  describeCheck,
};
