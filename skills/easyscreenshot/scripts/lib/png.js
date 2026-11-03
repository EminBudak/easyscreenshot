"use strict";

// PNG work without a dependency: joining the screens of a page into one
// image, and writing where an image came from into the image itself.
//
// Chrome writes 8-bit, non-interlaced PNGs whose rows are each filtered
// against the row above. The joined image takes each screen's rows from its
// top down to where the next screen starts, and the last screen's down to the
// page's end, so only the first row of each screen needs to be made plain
// again (it had no row above it); every other row is copied as it is.

const zlib = require("zlib");

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "latin1");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

// Width and height from the header, or null for anything that is not a PNG.
function pngSize(png) {
  if (!Buffer.isBuffer(png) || png.length < 24 || !png.subarray(0, 8).equals(SIGNATURE)) return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function pngRows(png) {
  let header = null;
  const extra = [];
  const data = [];
  for (let at = 8; at + 12 <= png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    if (type === "IHDR") header = png.subarray(at + 8, at + 8 + length);
    else if (type === "IDAT") data.push(png.subarray(at + 8, at + 8 + length));
    else if (type === "IEND") break;
    // Ancillary chunks before the pixels (colour profile, gamma, density).
    else if (!data.length) extra.push(png.subarray(at, at + 12 + length));
    at += 12 + length;
  }
  const channels = header && CHANNELS[header[9]];
  if (!header || header[8] !== 8 || !channels || header[12] !== 0) {
    throw new Error("a screen came back in a picture format that cannot be joined");
  }
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  return { header, extra, width, height, bpp: channels, rows: zlib.inflateSync(Buffer.concat(data)) };
}

// A screen as plain RGB rows (each with filter byte 0), see-through pixels
// laid on white: for joining screens that came back in different formats.
function toRgb(png) {
  const { width, height, bpp, rows } = pngRows(png);
  const stride = width * bpp;
  const plain = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = rows[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = rows[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? plain[y * stride + x - bpp] : 0;
      const b = y > 0 ? plain[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? plain[(y - 1) * stride + x - bpp] : 0;
      let p = 0;
      if (filter === 1) p = a;
      else if (filter === 2) p = b;
      else if (filter === 3) p = (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      plain[y * stride + x] = (v + p) & 0xff;
    }
  }
  const out = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * stride + x * bpp;
      const color = bpp >= 3 ? [plain[at], plain[at + 1], plain[at + 2]] : [plain[at], plain[at], plain[at]];
      const alpha = bpp === 4 ? plain[at + 3] : bpp === 2 ? plain[at + 1] : 255;
      for (let k = 0; k < 3; k++) out[y * (1 + width * 3) + 1 + x * 3 + k] = Math.round((color[k] * alpha + 255 * (255 - alpha)) / 255);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return { header, extra: [], width, height, bpp: 3, rows: out };
}

// shots: [{top, png}] in page order, tops in CSS px; height: the page's end
// in CSS px. Returns the joined PNG and the CSS height it shows.
function joinScreens(shots, cssWidth, height) {
  let screens = shots.map((shot) => ({ top: shot.top, ...pngRows(shot.png) }));
  if (screens.some((screen) => screen.width !== screens[0].width)) throw new Error("the screens came back in different widths");
  // A screen with see-through pixels comes back as RGBA and the next one as
  // RGB: then every screen is made plain RGB first.
  if (screens.some((screen) => screen.bpp !== screens[0].bpp)) screens = shots.map((shot) => ({ top: shot.top, ...toRgb(shot.png) }));
  const first = screens[0];
  // Device pixels per CSS pixel: 1 for a page taken at 1x, 2 at 2x.
  const ratio = first.width / cssWidth;
  const stride = 1 + first.width * first.bpp;
  const parts = [];
  let rows = 0;
  screens.forEach((screen, i) => {
    const end = i + 1 < screens.length ? screens[i + 1].top : height;
    const keep = Math.max(0, Math.min(screen.height, Math.round(end * ratio) - Math.round(screen.top * ratio)));
    if (!keep) return;
    const part = screen.rows.subarray(0, keep * stride);
    // The first row, filtered against no row above it: Sub and Paeth add the
    // byte to its left, Average half of it, None and Up nothing.
    const filter = part[0];
    for (let x = 1 + screen.bpp; x < stride; x++) {
      if (filter === 1 || filter === 4) part[x] = (part[x] + part[x - screen.bpp]) & 0xff;
      else if (filter === 3) part[x] = (part[x] + (part[x - screen.bpp] >> 1)) & 0xff;
    }
    part[0] = 0;
    parts.push(part);
    rows += keep;
  });
  const header = Buffer.from(first.header);
  header.writeUInt32BE(rows, 4);
  const pixels = zlib.deflateSync(Buffer.concat(parts));
  const idat = [];
  for (let at = 0; at < pixels.length; at += 1 << 20) idat.push(pngChunk("IDAT", pixels.subarray(at, at + (1 << 20))));
  const png = Buffer.concat([SIGNATURE, pngChunk("IHDR", header), ...first.extra, ...idat, pngChunk("IEND", Buffer.alloc(0))]);
  return { png, height: Math.round(rows / ratio) };
}

// Text chunks right after the header: where the picture came from, when, and
// what took it, readable with any image tool (exiftool, identify -verbose).
// iTXt, so a page title in any script survives: keyword, no compression, no
// language, then the text as UTF-8.
function tagPng(png, entries) {
  if (!pngSize(png) || png.toString("latin1", 12, 16) !== "IHDR") return png;
  const chunks = Object.entries(entries)
    .filter(([, text]) => text)
    .map(([keyword, text]) => pngChunk("iTXt", Buffer.concat([Buffer.from(`${keyword}\0\0\0\0\0`, "latin1"), Buffer.from(String(text), "utf8")])));
  return Buffer.concat([png.subarray(0, 33), ...chunks, png.subarray(33)]);
}

// The tEXt and iTXt chunks of a PNG, as {keyword: text}.
function pngText(png) {
  const out = {};
  for (let at = 8; at + 12 <= png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    const cut = body.indexOf(0);
    if (type === "tEXt" && cut > 0) out[body.toString("latin1", 0, cut)] = body.toString("latin1", cut + 1);
    if (type === "iTXt" && cut > 0 && body[cut + 1] === 0) {
      // After the keyword: compression flag and method, then a language tag
      // and a translated keyword, each ending in a zero byte.
      const language = body.indexOf(0, cut + 3);
      const translated = language >= 0 ? body.indexOf(0, language + 1) : -1;
      if (translated >= 0) out[body.toString("latin1", 0, cut)] = body.toString("utf8", translated + 1);
    }
    if (type === "IDAT" || type === "IEND") break;
    at += 12 + length;
  }
  return out;
}

module.exports = { crc32, pngChunk, pngSize, pngRows, joinScreens, tagPng, pngText };
