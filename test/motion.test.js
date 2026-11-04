"use strict";

// How a demo moves and how its frames are laid out, without a browser: the
// pointer's path, the zoom on clicks, and what each frame of the video shows.

const assert = require("node:assert/strict");
const test = require("node:test");
const { ease, curve, pointAt, moveDuration, scrollDuration, cursorAt, planCamera, cameraAt, ringsAt, keyAt, ZOOM_IN } = require("../skills/easyscreenshot/scripts/lib/motion");
const { layoutOf, backdropOf, addressOf, frameAt, stateAt } = require("../skills/easyscreenshot/scripts/lib/compose");

const viewport = { width: 1600, height: 900 };
const near = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;

// A take as record.js writes it: a pointer that moves to (1200, 100) and
// clicks there at 2 s, a scroll from 4 to 5.5 s, a cut to another page at 7 s.
function sample() {
  const move = { t0: 1, t1: 1.8, path: curve({ x: 400, y: 700 }, { x: 1200, y: 100 }) };
  return {
    fps: 30,
    viewport,
    duration: 9,
    start: { x: 400, y: 700 },
    shownAt: 1,
    moves: [move],
    clicks: [{ t: 2, x: 1200, y: 100, from: 1, move }],
    typing: [],
    keys: [{ t: 6, label: "⌘ K" }],
    scrolls: [{ t0: 4, t1: 5.5 }],
    cuts: [{ t: 7, fade: 0.35 }],
    urls: [{ t: 0, url: "https://www.acme.com/" }, { t: 7, url: "https://acme.com/pricing/" }],
    frames: [
      { v: 0, file: "/f/1.jpg", cut: false },
      { v: 3, file: "/f/2.jpg", cut: false },
      { v: 6.9, file: "/f/3.jpg", cut: false },
      { v: 7, file: "/f/4.jpg", cut: true },
      { v: 8, file: "/f/5.jpg", cut: false },
    ],
  };
}

test("easing starts and stops at rest; a pointer's path bows a little and ends where it should", () => {
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.ok(near(ease(0.5), 0.5));
  assert.equal(ease(-1), 0);
  assert.equal(ease(2), 1);
  for (let p = 0; p < 1; p += 0.05) assert.ok(ease(p + 0.05) >= ease(p));
  const path = curve({ x: 0, y: 0 }, { x: 1000, y: 0 });
  assert.deepEqual(pointAt(path, 0), { x: 0, y: 0 });
  assert.deepEqual(pointAt(path, 1), { x: 1000, y: 0 });
  assert.ok(Math.abs(pointAt(path, 0.5).y) > 20, "the path is not a straight line");
  assert.equal(moveDuration({ x: 0, y: 0 }, { x: 3, y: 4 }), 0.45);
  assert.equal(moveDuration({ x: 0, y: 0 }, { x: 5000, y: 0 }), 1.1);
  assert.equal(scrollDuration(100), 0.8);
  assert.equal(scrollDuration(-9000), 2.6);
});

test("the pointer appears, moves along its path, and dips when it clicks", () => {
  const take = sample();
  assert.equal(cursorAt(take, 0.5), null);
  const start = cursorAt(take, 1);
  assert.deepEqual([start.x, start.y, start.opacity], [400, 700, 0]);
  assert.ok(cursorAt(take, 1.4).x > 400 && cursorAt(take, 1.4).x < 1200);
  const there = cursorAt(take, 1.9);
  assert.deepEqual([there.x, there.y, there.opacity, there.press], [1200, 100, 1, 1]);
  assert.ok(cursorAt(take, 2.06).press < 0.9, "pressed while clicking");
  assert.equal(cursorAt(take, 2.5).press, 1);
});

test("a click zooms in by the time it lands, holds, and goes back out before the scroll", () => {
  const take = sample();
  const regions = planCamera(take, { zoom: 1.5 });
  assert.equal(regions.length, 1);
  const [region] = regions;
  assert.equal(region.start, 1, "starts as the pointer sets off");
  assert.equal(cameraAt(regions, 0.5, viewport).z, 1);
  const at = cameraAt(regions, 2, viewport);
  assert.ok(near(at.z, 1.5, 1e-3), `zoomed at the click: ${at.z}`);
  // The click at (1200, 100) is in the visible part, which stays inside the screen.
  assert.ok(at.x <= 1200 && at.x + 1600 / at.z >= 1200 && at.y === 0);
  assert.ok(at.x + 1600 / at.z <= 1600 + 1e-9);
  assert.equal(cameraAt(regions, 4, viewport).z, 1, "out before the scroll starts");
  assert.equal(cameraAt(regions, 4.5, viewport).z, 1);
  // A short move: the camera sets off first, so the zoom is done by the
  // click; never before the end of the scroll that came before it.
  const short = { t0: 6, t1: 6.45, path: curve({ x: 600, y: 400 }, { x: 640, y: 420 }) };
  const later = { ...take, moves: [short], clicks: [{ t: 6.6, x: 640, y: 420, from: 6, move: short }] };
  assert.ok(near(planCamera(later, { zoom: 1.5 })[0].start, 6.6 - ZOOM_IN - 0.1));
  later.scrolls = [{ t0: 5, t1: 5.9 }];
  assert.equal(planCamera(later, { zoom: 1.5 })[0].start, 5.9);
  // No room to zoom before the next scroll: no zoom, rather than one that
  // runs into the scroll.
  later.scrolls.push({ t0: 6.7, t1: 8 });
  assert.deepEqual(planCamera(later, { zoom: 1.5 }), []);
  // No zoom at all when asked.
  assert.deepEqual(planCamera(take, { zoom: 1 }), []);
  take.clicks[0].zoom = 1;
  assert.deepEqual(planCamera(take, { zoom: 1.5 }), []);
});

test("clicks close together share a zoom; a cut to another page ends it as it stands", () => {
  const take = sample();
  const second = { t0: 2.4, t1: 2.9, path: curve({ x: 1200, y: 100 }, { x: 300, y: 800 }) };
  take.moves.push(second);
  take.clicks.push({ t: 3, x: 300, y: 800, from: 2.4, move: second });
  take.scrolls = [];
  take.cuts = [{ t: 3.5, fade: 0.35 }];
  const regions = planCamera(take, { zoom: 2 });
  assert.equal(regions.length, 1);
  assert.equal(regions[0].points.length, 2);
  assert.equal(regions[0].cut, true);
  assert.equal(regions[0].end, 3.5);
  const before = cameraAt(regions, 2, viewport);
  const later = cameraAt(regions, 3.2, viewport);
  assert.ok(near(later.z, 2, 1e-3) && later.x < before.x && later.y > before.y, "panned to the second click");
  assert.ok(cameraAt(regions, 3.49, viewport).z > 1.9, "still zoomed at the cut");
  assert.equal(cameraAt(regions, 3.6, viewport).z, 1, "the next page comes in whole");
});

test("rings after a click and the key just pressed fade on time", () => {
  const take = sample();
  assert.deepEqual(ringsAt(take, 1.9), []);
  const [ring] = ringsAt(take, 2.1);
  assert.equal(ring.x, 1200);
  assert.ok(ring.radius > 8 && ring.opacity > 0 && ring.opacity < 0.9);
  assert.deepEqual(ringsAt(take, 2.6), []);
  assert.equal(keyAt(take, 5.9), null);
  assert.equal(keyAt(take, 6.5).label, "⌘ K");
  assert.equal(keyAt(take, 6.5).opacity, 1);
  assert.equal(keyAt(take, 7.5), null);
});

test("layout, backdrop and the address in the title bar", () => {
  const framed = layoutOf({ frame: true, viewport });
  assert.deepEqual(framed.content, { x: 160, y: 112, width: 1600, height: 900 });
  assert.deepEqual(framed.window, { x: 160, y: 68, width: 1600, height: 944 });
  assert.equal(framed.scale, 1);
  const bare = layoutOf({ frame: false, viewport });
  assert.deepEqual(bare.content, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.equal(bare.scale, 1.2);
  assert.equal(backdropOf(""), "");
  assert.equal(backdropOf("#0f172a"), "#0f172a");
  assert.equal(backdropOf("#a1c4fd, rgb(194, 233, 251)"), "linear-gradient(135deg, #a1c4fd, rgb(194, 233, 251))");
  assert.throws(() => backdropOf("red; } body { display:none"), /--background takes a colour/);
  assert.throws(() => backdropOf("missing.png"), /no such picture file/);
  assert.equal(addressOf("https://www.acme.com/"), "acme.com");
  assert.equal(addressOf("https://acme.com/pricing/"), "acme.com/pricing");
  assert.equal(addressOf("http://localhost:3000/app?x=1"), "localhost:3000/app");
});

test("each frame of the video: the right recorded frame, the crossfade at a cut, the pointer under the zoom", () => {
  const take = sample();
  const layout = layoutOf({ frame: true, viewport });
  const regions = planCamera(take, { zoom: 1.5 });
  assert.equal(frameAt(take.frames, 0), 0);
  assert.equal(frameAt(take.frames, 2.99), 0);
  assert.equal(frameAt(take.frames, 3), 1);
  assert.equal(frameAt(take.frames, 7.1), 3);
  assert.equal(frameAt(take.frames, 100), 4);
  const quiet = stateAt(take, regions, layout, 0.5);
  assert.deepEqual(quiet.cur, { src: "file:///f/1.jpg", k: 1, x: 0, y: 0 });
  assert.equal(quiet.cursor, null);
  assert.equal(quiet.url, "acme.com");
  // At the click: zoomed 1.5x, and the pointer drawn where the click lands
  // in the zoomed view.
  const click = stateAt(take, regions, layout, 2);
  assert.equal(click.cur.k, 1.5);
  assert.equal(click.cursor.x, Math.round((1200 - click.cur.x) * 1.5 * 100) / 100);
  assert.equal(click.cursor.y, Math.round((100 - click.cur.y) * 1.5 * 100) / 100);
  assert.equal(click.rings.length, 1);
  // Just after the cut: the last frame of the old page under the first of
  // the new one, fading in.
  const fade = stateAt(take, regions, layout, 7.1);
  assert.equal(fade.prev.src, "file:///f/3.jpg");
  assert.equal(fade.cur.src, "file:///f/4.jpg");
  assert.ok(fade.alpha > 0 && fade.alpha < 1);
  assert.equal(fade.url, "acme.com/pricing");
  assert.equal(stateAt(take, regions, layout, 7.5).prev, null);
});
