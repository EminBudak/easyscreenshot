"use strict";

// How things move in a demo: the pointer's path to what it clicks, how long
// a move or a scroll takes, and where the camera looks at each moment. Plain
// functions of time, shared by the recording (record.js moves the real mouse
// along the same path) and the video (compose.js draws it).
//
// Times are seconds of the video; positions are CSS pixels of the page's
// screen (the viewport), x from the left, y from the top.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Minimum jerk: starts and stops without a bump, the way a hand moves a
// mouse. Used for the pointer, the scroll and the zoom alike.
const ease = (p) => {
  const t = clamp(p, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

// A move of the pointer takes longer the farther it goes, within limits.
function moveDuration(from, to) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  return clamp(0.4 + distance / 1500, 0.45, 1.1);
}

// A scroll of the page, by its length in CSS pixels.
function scrollDuration(distance) {
  return clamp(0.6 + Math.abs(distance) / 1100, 0.8, 2.6);
}

// A hand does not move a mouse in a straight line: the path bows a little to
// one side, more on a long move. A cubic curve from `from` to `to`.
function curve(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  const bend = Math.min(70, distance * 0.12);
  const nx = -dy / distance;
  const ny = dx / distance;
  return {
    from: { x: from.x, y: from.y },
    c1: { x: from.x + dx * 0.3 + nx * bend, y: from.y + dy * 0.3 + ny * bend },
    c2: { x: from.x + dx * 0.75 + nx * bend * 0.35, y: from.y + dy * 0.75 + ny * bend * 0.35 },
    to: { x: to.x, y: to.y },
  };
}

// The point at p (0 to 1) along a curve.
function pointAt(path, p) {
  const t = clamp(p, 0, 1);
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * path.from.x + b * path.c1.x + c * path.c2.x + d * path.to.x,
    y: a * path.from.y + b * path.c1.y + c * path.c2.y + d * path.to.y,
  };
}

// Where the pointer is at time t, how visible it is and how pressed. moves:
// [{t0, t1, path}] in order; shownAt: when it first appears (null: never).
// Returns null while it is not shown.
const PRESS = 0.16;

function cursorAt(take, t) {
  if (take.shownAt === null || take.shownAt === undefined || t < take.shownAt) return null;
  let at = take.start;
  for (const move of take.moves) {
    if (t < move.t0) break;
    if (t >= move.t1) {
      at = move.path.to;
      continue;
    }
    at = pointAt(move.path, ease((t - move.t0) / (move.t1 - move.t0)));
    break;
  }
  let press = 1;
  for (const click of take.clicks) {
    const since = t - click.t;
    if (since > -0.05 && since < PRESS) press = Math.min(press, 1 - 0.18 * Math.sin((Math.PI * (since + 0.05)) / (PRESS + 0.05)));
  }
  return { x: at.x, y: at.y, opacity: clamp((t - take.shownAt) / 0.25, 0, 1), press };
}

// ─── the camera ────────────────────────────────────────────────────────────
// A click zooms in on where it lands, and typing on the field it goes into:
// the zoom starts as the pointer sets off, holds through the click and a
// moment after, and goes back out. Clicks close together share one zoom and
// the camera pans from one to the next. A scroll is never zoomed (the zoom
// goes out before it starts), and a cut to another page ends a zoom as it
// stands: the next page comes in whole.
const ZOOM_IN = 0.8;
const ZOOM_OUT = 0.7;
const HOLD = 0.9;
const GAP = 1.4;

function planCamera(take, { zoom = 1.5 } = {}) {
  // The camera can start closing in before the pointer sets off, so the
  // zoom is done when the click lands; not before the end of a scroll or
  // of the crossfade into a page.
  const earliest = (t) => {
    let from = 0;
    for (const scroll of take.scrolls) if (scroll.t1 <= t) from = Math.max(from, scroll.t1);
    for (const cut of take.cuts) if (cut.t <= t) from = Math.max(from, cut.t + cut.fade);
    return from;
  };
  const asks = [];
  for (const click of take.clicks) {
    const scale = click.zoom !== undefined ? click.zoom : zoom;
    const start = Math.max(Math.min(click.from, click.t - ZOOM_IN - 0.1), earliest(click.from));
    if (scale > 1.01) asks.push({ start, end: click.t + HOLD, at: click.t, x: click.x, y: click.y, scale, move: click.move });
  }
  for (const typed of take.typing) {
    const scale = typed.zoom !== undefined ? typed.zoom : zoom;
    if (scale > 1.01) asks.push({ start: Math.max(typed.t0 - ZOOM_IN, earliest(typed.t0)), end: typed.t1 + HOLD * 0.7, at: typed.t0, x: typed.x, y: typed.y, scale });
  }
  asks.sort((a, b) => a.start - b.start);
  const between = (list, a, b) => list.some((item) => item.t1 > a && item.t0 < b);
  const cutBetween = (a, b) => take.cuts.some((cut) => cut.t > a && cut.t <= b);
  const regions = [];
  for (const ask of asks) {
    const last = regions[regions.length - 1];
    if (last && ask.start - last.end < GAP && !between(take.scrolls, last.end - 0.01, ask.start) && !cutBetween(last.start, ask.start)) {
      last.end = Math.max(last.end, ask.end);
      last.scale = Math.max(last.scale, ask.scale);
      last.points.push(ask);
    } else {
      regions.push({ start: ask.start, end: ask.end, scale: ask.scale, points: [ask], cut: false });
    }
  }
  for (const region of regions) {
    // Out before the next scroll starts; no zoom at all when there is no
    // room for one before it.
    const scroll = take.scrolls.find((s) => s.t0 >= region.start - 0.01);
    if (scroll && scroll.t0 < region.end + ZOOM_OUT) {
      if (scroll.t0 - ZOOM_OUT < region.start + 0.2) region.skip = true;
      else region.end = scroll.t0 - ZOOM_OUT;
    }
    // Cut away at the next page, zoomed in as it is.
    const cut = take.cuts.find((c) => c.t > region.start);
    if (cut && cut.t <= region.end + ZOOM_OUT) {
      region.end = cut.t;
      region.cut = true;
    }
  }
  return regions.filter((region) => !region.skip);
}

// Where the camera points in a region: at the pointer before and while it
// moves to a click (so it stays in sight as the view closes in), then at
// the click; at a field while text goes into it.
function focusAt(region, t) {
  let focus = region.points[0];
  for (let i = 0; i < region.points.length; i++) {
    const point = region.points[i];
    if (i > 0 && t < point.start) break;
    focus = point;
  }
  const move = focus.move;
  if (move && t < move.t0) return move.path.from;
  if (move && t < move.t1) return pointAt(move.path, ease((t - move.t0) / (move.t1 - move.t0)));
  return { x: focus.x, y: focus.y };
}

// The camera at time t: its zoom z and the top-left corner (x, y) of the
// part of the screen it shows, which is viewport/z wide and high.
function cameraAt(regions, t, viewport) {
  const region = regions.find((r) => t >= r.start && t < r.end + (r.cut ? 0 : ZOOM_OUT));
  if (!region) return { z: 1, x: 0, y: 0 };
  const into = ease((t - region.start) / ZOOM_IN);
  const out = region.cut ? 0 : ease((t - region.end) / ZOOM_OUT);
  const k = Math.min(into, 1 - out);
  const z = 1 + (region.scale - 1) * k;
  const focus = focusAt(region, t);
  const width = viewport.width / z;
  const height = viewport.height / z;
  return {
    z,
    x: clamp(focus.x - width / 2, 0, viewport.width - width),
    y: clamp(focus.y - height / 2, 0, viewport.height - height),
  };
}

// The rings a click leaves: [{x, y, radius, opacity}] at time t.
const RING = 0.5;

function ringsAt(take, t) {
  const out = [];
  for (const click of take.clicks) {
    const p = (t - click.t) / RING;
    if (p < 0 || p >= 1) continue;
    out.push({ x: click.x, y: click.y, radius: 8 + 30 * (1 - Math.pow(1 - p, 3)), opacity: 0.9 * (1 - p) });
  }
  return out;
}

// The key pressed last, shown for a moment: {label, opacity} or null.
const KEY_SHOWN = 1.4;

function keyAt(take, t) {
  let shown = null;
  for (const key of take.keys) {
    const since = t - key.t;
    if (since < 0 || since >= KEY_SHOWN) continue;
    shown = { label: key.label, opacity: clamp(Math.min(since / 0.12, (KEY_SHOWN - since) / 0.3), 0, 1) };
  }
  return shown;
}

module.exports = { clamp, ease, moveDuration, scrollDuration, curve, pointAt, cursorAt, planCamera, cameraAt, ringsAt, keyAt, ZOOM_IN, ZOOM_OUT };
