"use strict";

// sheet.png: every page on one picture, to check the run at a glance or to
// show an agent one image instead of fifteen. Drawn in the browser the
// pages were taken with, from the files already saved: no request goes out.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { openTab, closeTab, navigate } = require("./chrome");
const { metrics, capture, resetPictureWait } = require("./page");
const { pngSize } = require("./png");

// A short window, so the page's height is the sheet's own.
const SHEET = { width: 1600, height: 300, scale: 1, mobile: false, touch: false, agent: "desktop" };

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// For each page, its first desktop screen and its first phone screen in the
// light theme when there are, else the first images it has.
function picksFor(page) {
  const firsts = page.shots.filter((shot) => !shot.full);
  const light = firsts.filter((shot) => shot.theme !== "dark");
  const pool = light.length ? light : firsts.length ? firsts : page.shots;
  const wide = pool.find((shot) => shot.width >= shot.height);
  const tall = pool.find((shot) => shot.width < shot.height && shot !== wide);
  return [wide, tall].filter(Boolean);
}

function sheetHtml(manifest, dir) {
  const src = (file) => pathToFileURL(path.resolve(dir, file)).href;
  const host = new URL(manifest.url).hostname.replace(/^www\./, "");
  const cards = manifest.pages
    .map((page) => {
      const picks = picksFor(page);
      const images = picks.map((shot) => `<img class="${shot.width >= shot.height ? "wide" : "tall"}" src="${src(shot.file)}">`).join("");
      const where = new URL(page.url).pathname;
      return `<figure><div class="shots">${images}</div><figcaption><b>${String(page.n).padStart(2, "0")}</b><i>${escape(page.slug)}</i><span>${escape(where)}</span></figcaption></figure>`;
    })
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0}
  html,body{width:${SHEET.width}px;background:#f4f3ef;color:#111;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  main{padding:48px 56px 40px}
  header{display:flex;align-items:baseline;gap:18px;margin-bottom:32px}
  h1{font-size:44px;line-height:1;letter-spacing:-0.02em;font-weight:700}
  header span{font-size:22px;color:#6b6a66}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:36px 40px}
  figure{display:flex;flex-direction:column;gap:12px;min-width:0}
  .shots{display:flex;gap:14px;align-items:flex-start;height:300px}
  .shots img{display:block;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.14);background:#fff}
  .shots img.wide{height:100%;max-width:100%;min-width:0;object-fit:cover;object-position:top}
  .shots img.tall{height:100%;flex:none}
  figcaption{font-size:20px;display:flex;gap:10px;align-items:baseline;min-width:0;white-space:nowrap}
  figcaption i{font-style:normal;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis}
  figcaption span{color:#8a8984;font:16px ui-monospace,SFMono-Regular,Menlo,monospace;flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis}
  footer{margin-top:36px;font:500 18px ui-monospace,SFMono-Regular,Menlo,monospace;color:#6b6a66}
  </style></head><body><main>
  <header><h1>${escape(manifest.site || host)}</h1><span>${escape(host)}</span></header>
  <div class="grid">${cards}</div>
  <footer>github.com/EminBudak/easyscreenshotkit</footer>
  </main></body></html>`;
}

// The sheet as a page of its own: an HTML file in a temp folder that shows
// the saved PNGs, opened in a new window and captured whole.
async function renderSheet(chrome, manifest, dir) {
  if (!manifest.pages.some((page) => picksFor(page).length)) return null;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "easyscreenshotkit-sheet-"));
  const file = path.join(temp, "sheet.html");
  fs.writeFileSync(file, sheetHtml(manifest, dir));
  const tab = await openTab(chrome, SHEET);
  try {
    await navigate(tab, pathToFileURL(file).href);
    resetPictureWait(tab, 15_000);
    const m = await metrics(tab);
    const shot = await capture(tab, 0, 0, m.width, m.height, SHEET.scale, true);
    const png = Buffer.from(shot.data || "", "base64");
    const size = pngSize(png);
    if (!size) return null;
    fs.writeFileSync(path.join(dir, "sheet.png"), png);
    return { file: "sheet.png", ...size };
  } finally {
    await closeTab(chrome, tab);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = { renderSheet, sheetHtml, picksFor };
