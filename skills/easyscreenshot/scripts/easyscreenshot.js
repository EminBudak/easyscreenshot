#!/usr/bin/env node
"use strict";

const { takeShots } = require("./lib/shots");
const version = require("./lib/version");

const USAGE = `Usage: easyscreenshot <url> [options]

Opens a website the way a browser draws it, picks the pages worth showing
(home, pricing, features and the like), hides cookie banners, chat bubbles
and other floating boxes, and saves desktop, phone and whole-page
screenshots in one folder. manifest.json is for tools, SCREENSHOTS.md for
people and coding agents, sheet.png shows every page on one picture.

Options:
  --out <dir>       where to save (default: ./easyscreenshot-<host>)
  --pages <n>       how many pages, the home page included (default: 5, at most 12)
  --page <path>     take this page too, e.g. --page /pricing (repeat for more)
  --sizes <list>    desktop, mobile, iphone, full, mobile-full or WxH, each with
                    an optional @scale (default: desktop,mobile,full)
  --theme <name>    light, dark or both (default: light)
  --lang <code>     the site's version in this language, when it has one
  --hide <css>      hide one more element (repeat for more)
  --reduced-motion  ask the site for its reduced-motion version
  --no-clean        take the pages as they come, banners and bubbles included
  --json            print manifest.json instead of a summary
  --timeout <s>     give up after this many seconds (default: 300)
  -h, --help        show this help
  -v, --version     show the version

Sizes: desktop is 1600x900 at 2x, mobile 360x640 at 3x (1080x1920), iphone
440x956 at 3x (1320x2868), full the whole page at 1x, mobile-full the whole
phone page at 2x. 1270x760@2 is a Product Hunt gallery image.

Needs Node 22 or newer and Chrome, Chromium, Edge or Brave. Set CHROME_PATH
to pick the browser.`;

function parse(argv) {
  const options = { pages: 5, extra: [], hide: [], sizes: "desktop,mobile,full", theme: "light", lang: "", reducedMotion: false, clean: true, json: false, timeout: 300 };
  const rest = [];
  const VALUED = new Set(["--out", "--pages", "--page", "--sizes", "--theme", "--lang", "--hide", "--timeout"]);
  const set = (name, value) => {
    if (name === "--out") options.out = value;
    else if (name === "--pages") options.pages = Number(value);
    else if (name === "--page") options.extra.push(value);
    else if (name === "--sizes") options.sizes = value;
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
    else if (arg === "--no-clean") options.clean = false;
    else if (arg === "--reduced-motion") options.reducedMotion = true;
    else if (VALUED.has(name)) {
      const value = name !== arg ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === "" || (name === arg && value.startsWith("--"))) throw new Error(`${name} needs a value`);
      set(name, value);
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else rest.push(arg);
  }
  if (!(Number.isInteger(options.pages) && options.pages >= 1 && options.pages <= 12)) throw new Error("--pages takes 1 to 12");
  if (!(options.timeout >= 30 && options.timeout <= 900)) throw new Error("--timeout takes 30 to 900 seconds");
  if (!["light", "dark", "both"].includes(options.theme)) throw new Error("--theme takes light, dark or both");
  if (options.lang && !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(options.lang)) throw new Error(`--lang takes a language code such as tr or pt-BR, not ${options.lang}`);
  if (!options.help && !options.version && rest.length !== 1) throw new Error("Give one website address, for example: easyscreenshot acme.com");
  return { ...options, url: rest[0] };
}

function summary({ dir, manifest }) {
  const lines = [`Saved ${manifest.pages.length === 1 ? "1 page" : `${manifest.pages.length} pages`} of ${new URL(manifest.url).hostname.replace(/^www\./, "")} to ${dir}`, ""];
  const width = Math.max(...manifest.pages.map((page) => page.slug.length));
  for (const page of manifest.pages) {
    const where = new URL(page.url).pathname;
    lines.push(`  ${String(page.n).padStart(2, "0")} ${page.slug.padEnd(width)}  ${where}  (${page.why})`);
    lines.push(`     ${" ".repeat(width)}  ${page.shots.map((shot) => shot.file).join(", ") || "no files"}`);
  }
  if (manifest.sheet) lines.push("", `  Sheet   ${manifest.sheet.file} (${manifest.sheet.width}x${manifest.sheet.height})`);
  const left = manifest.skipped.slice(0, 6).map((skip) => `${new URL(skip.url).pathname} (${skip.reason})`);
  if (left.length) lines.push(`  Skipped ${left.join(", ")}${manifest.skipped.length > 6 ? ` and ${manifest.skipped.length - 6} more` : ""}`);
  for (const note of manifest.notes) lines.push(`  Note    ${note}`);
  lines.push("", `Read ${dir}/SCREENSHOTS.md for the details.`);
  return lines.join("\n");
}

async function main() {
  let options;
  try {
    options = parse(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`easyscreenshot: ${err.message}\n\n${USAGE}\n`);
    process.exit(2);
  }
  if (options.help) return void process.stdout.write(`${USAGE}\n`);
  if (options.version) return void process.stdout.write(`${version}\n`);
  try {
    const result = await takeShots(options.url, {
      dir: options.out,
      pages: options.pages,
      extra: options.extra,
      sizes: options.sizes,
      theme: options.theme,
      lang: options.lang,
      hide: options.hide,
      reducedMotion: options.reducedMotion,
      clean: options.clean,
      timeLimit: options.timeout * 1000,
      log: options.json ? () => {} : (line) => process.stderr.write(`${line}\n`),
    });
    process.stdout.write(options.json ? JSON.stringify(result.manifest, null, 2) + "\n" : summary(result) + "\n");
  } catch (err) {
    if (options.json) process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + "\n");
    process.stderr.write(`easyscreenshot: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { parse, summary };
