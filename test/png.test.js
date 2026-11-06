"use strict";

// Joining screens into one image and the text written into it, without a
// browser.

const assert = require("node:assert/strict");
const test = require("node:test");
const { joinScreens, tagPng, pngText, pngSize } = require("../skills/easyscreenshotkit/scripts/lib/png");
const { screenTops } = require("../skills/easyscreenshotkit/scripts/lib/page");
const { readPng, pngOf } = require("./helpers");

// A page 100 px tall whose every row has its own color, captured as
// overlapping screens written with a different filter on every row; each
// screen's first row uses another of the five filters.
const PAGE_COLOR = (x, y) => [(y * 7) % 256, (x * 13 + y) % 256, (1000 - y * 3) % 256];

test("screens join row for row, whatever filter each row was written with", () => {
  const width = 24;
  const tops = [0, 20, 40, 55, 70];
  const shots = tops.map((top, i) => ({ top, png: pngOf(width, 30, (x, y) => PAGE_COLOR(x, top + y), (y) => (y + i) % 5) }));
  const joined = joinScreens(shots, width, 100);
  assert.equal(joined.height, 100);
  const png = readPng(joined.png);
  assert.equal(png.width, width);
  assert.equal(png.height, 100);
  for (let y = 0; y < 100; y++) {
    for (const x of [0, 5, 23]) assert.deepEqual(png.pixel(x, y), PAGE_COLOR(x, y), `row ${y}, column ${x}`);
  }
});

test("screens at 2x join at the right rows", () => {
  const shots = [0, 30].map((top) => ({ top, png: pngOf(20, 60, (x, y) => PAGE_COLOR(x, top * 2 + y), () => 4) }));
  const joined = joinScreens(shots, 10, 60);
  const png = readPng(joined.png);
  assert.equal(png.height, 120);
  assert.equal(joined.height, 60);
  for (let y = 0; y < 120; y++) assert.deepEqual(png.pixel(3, y), PAGE_COLOR(3, y));
});

test("a screen that came back as RGBA joins the RGB ones, its see-through pixels on white", () => {
  const rgb = (top) => pngOf(10, 20, (x, y) => PAGE_COLOR(x, top + y), (y) => y % 5);
  // The first screen as RGBA: the top-left pixel half see-through black.
  const rgba = (() => {
    const png = pngOf(10, 20, (x, y) => PAGE_COLOR(x, y), () => 0);
    const { width, height } = { width: 10, height: 20 };
    const raw = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = x === 0 && y === 0 ? [0, 0, 0] : PAGE_COLOR(x, y);
        raw.set([r, g, b, x === 0 && y === 0 ? 128 : 255], y * (1 + width * 4) + 1 + x * 4);
      }
    }
    const zlib = require("node:zlib");
    const { pngChunk } = require("../skills/easyscreenshotkit/scripts/lib/png");
    const header = Buffer.from(png.subarray(16, 29));
    header[9] = 6;
    return Buffer.concat([png.subarray(0, 8), pngChunk("IHDR", header), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
  })();
  const joined = joinScreens([{ top: 0, png: rgba }, { top: 20, png: rgb(20) }], 10, 40);
  const png = readPng(joined.png);
  assert.equal(png.height, 40);
  assert.deepEqual(png.pixel(0, 0), [127, 127, 127]);
  for (let y = 1; y < 40; y++) assert.deepEqual(png.pixel(4, y), PAGE_COLOR(4, y), `row ${y}`);
});

test("screen tops: the first screen whole, then three quarters of each, the last one at the page's end", () => {
  assert.deepEqual(screenTops(900, 900), [0]);
  assert.deepEqual(screenTops(2000, 900), [0, 900, 1100]);
  assert.deepEqual(screenTops(4000, 900), [0, 900, 1575, 2250, 2925, 3100]);
  for (const [height, viewport] of [[5000, 640], [1234, 900], [30, 40]]) {
    const tops = screenTops(height, viewport);
    assert.equal(tops[0], 0);
    assert.ok(tops.at(-1) + viewport >= height, "reaches the end");
    for (let i = 1; i < tops.length; i++) assert.ok(tops[i] <= tops[i - 1] + viewport, "no gap");
  }
});

test("the source, the time and the tool go into the PNG as UTF-8 text, and the image stays readable", () => {
  const png = pngOf(8, 8, () => [10, 20, 30]);
  const tagged = tagPng(png, { Title: "Fiyatlar – Acme Şirketi", Source: "https://acme.com/fiyatlar", Empty: "" });
  assert.deepEqual(pngText(tagged), { Title: "Fiyatlar – Acme Şirketi", Source: "https://acme.com/fiyatlar" });
  assert.deepEqual(pngSize(tagged), { width: 8, height: 8 });
  assert.deepEqual(readPng(tagged).pixel(4, 4), [10, 20, 30]);
  assert.equal(pngSize(Buffer.from("not a png")), null);
  assert.equal(tagPng(Buffer.from("not a png"), { A: "b" }).toString(), "not a png");
});
