"use strict";

// A demo's steps: visit, scroll, click, type, wait, hover and key. They come
// from a file the user writes (YAML or JSON) or from the tour easyscreenshotkit
// plans by itself, and are checked before the browser opens, so a typo fails
// at once with the step's number instead of halfway through a recording.
//
//   url: https://acme.com
//   steps:
//     - visit: /pricing
//     - scroll: 800                  # px down; or top, bottom, a selector
//     - click: "text=Start free"     # a CSS selector, or text= for words
//     - type: ada@example.com
//       into: "input[name=email]"
//     - key: Enter
//     - wait: 1.5                    # seconds; or a selector to wait for

const fs = require("fs");
const path = require("path");
const { parseYaml } = require("./yaml");

const ACTIONS = ["visit", "scroll", "click", "type", "wait", "hover", "key"];
// Keys any step may carry, and the ones each action adds.
const COMMON = ["label", "note", "pause"];
const OWN = { visit: [], scroll: ["duration"], click: ["zoom"], type: ["into", "zoom"], wait: ["timeout"], hover: ["zoom"], key: [] };
const TOP = ["url", "steps", "hide"];

const KEYS = {
  enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape", backspace: "Backspace", delete: "Delete", space: " ",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
};
const MODIFIERS = { control: "Control", ctrl: "Control", alt: "Alt", option: "Alt", shift: "Shift", meta: "Meta", cmd: "Meta", command: "Meta" };

class StepError extends Error {}

const fail = (where, message) => {
  throw new StepError(`${where}: ${message}`);
};

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// A number written as text ("1.50", "2.0") where a number is wanted.
const NUMERIC = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
const num = (value) => (typeof value === "string" && NUMERIC.test(value.trim()) ? Number(value) : value);

// What a step points at on the page: a CSS selector, or the words shown on
// it ("text=Pricing", or {text: Pricing}).
function targetOf(value, where) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) fail(where, "the target is empty");
    if (/^text\s*=/i.test(text)) {
      const words = text.replace(/^text\s*=\s*/i, "").replace(/^(["'])(.*)\1$/, "$2").trim();
      if (!words) fail(where, "text= needs the words to look for");
      return { text: words };
    }
    return { css: text };
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value.text === "string" && value.text.trim()) return { text: value.text.trim() };
    if (keys.length === 1 && typeof (value.css || value.selector) === "string" && (value.css || value.selector).trim()) return { css: (value.css || value.selector).trim() };
  }
  fail(where, `a target is a CSS selector or text=<words>, not ${JSON.stringify(value)}`);
}

function seconds(raw, where, name, { min = 0, max = 120 } = {}) {
  const value = num(raw);
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail(where, `${name} takes ${min} to ${max} seconds`);
  return value;
}

function zoomOf(raw, where) {
  const value = num(raw);
  if (value === undefined || value === true) return undefined;
  if (value === false) return 1;
  if (typeof value === "number" && value >= 1 && value <= 3) return value;
  fail(where, "zoom takes false or a number from 1 to 3");
}

// "Meta+K", "ctrl+shift+p", "Enter": the modifiers in a fixed order, then the key.
function keyOf(value, where) {
  if (typeof value !== "string" || !value.trim()) fail(where, "key needs a key name, e.g. Enter or Meta+K");
  const parts = value.split("+").map((part) => part.trim());
  // "+" itself, or a combination ending in it.
  if (parts.length > 1 && parts[parts.length - 1] === "" && parts[parts.length - 2] === "") parts.splice(-2, 2, "+");
  const last = parts.pop();
  const mods = new Set();
  for (const part of parts) {
    const mod = MODIFIERS[part.toLowerCase()];
    if (!mod) fail(where, `${part} is not a modifier; use Control, Alt, Shift or Meta`);
    mods.add(mod);
  }
  let key = KEYS[last.toLowerCase()] || (/^f([1-9]|1[0-2])$/i.test(last) ? last.toUpperCase() : "");
  if (!key && [...last].length === 1) key = last;
  if (!key) fail(where, `unknown key ${last}; use a single character or one of Enter, Tab, Escape, Backspace, Delete, Space, the arrows, Home, End, PageUp, PageDown, F1 to F12`);
  return [...["Control", "Alt", "Shift", "Meta"].filter((mod) => mods.has(mod)), key === " " ? "Space" : key].join("+");
}

function normalizeStep(raw, index) {
  const where = `step ${index + 1}`;
  if (typeof raw === "string") {
    // A bare word: "- wait" is not enough, but a lone "visit /x" is a likely slip.
    fail(where, `expected an action such as "- click: <target>", got "${raw}"`);
  }
  if (!isObject(raw)) fail(where, "expected an action such as - visit: /, - click: <target> or - wait: 1");
  const actions = Object.keys(raw).filter((key) => ACTIONS.includes(key));
  if (actions.length !== 1) fail(where, actions.length ? `one action per step, got ${actions.join(" and ")}` : `no action; use one of ${ACTIONS.join(", ")}`);
  const action = actions[0];
  const here = `${where} (${action})`;
  for (const key of Object.keys(raw)) {
    if (key !== action && !COMMON.includes(key) && !OWN[action].includes(key)) fail(here, `unknown key ${key}; ${action} takes ${[...OWN[action], ...COMMON].join(", ")}`);
  }
  const value = raw[action];
  const step = { action };
  if (action === "visit") {
    const url = isObject(value) ? value.url : value;
    if (typeof url !== "string" || !url.trim()) fail(here, "visit needs an address or a path, e.g. /pricing");
    step.url = url.trim();
  } else if (action === "scroll") {
    const spec = isObject(value) ? { ...value, by: num(value.by), to: num(value.to) } : typeof num(value) === "number" ? { by: num(value) } : { to: value };
    if (spec.by === undefined) delete spec.by;
    if (spec.to === undefined) delete spec.to;
    for (const key of Object.keys(spec)) if (!["by", "to", "duration"].includes(key)) fail(here, `unknown key ${key}; scroll takes by, to and duration`);
    if (spec.by !== undefined && spec.to !== undefined) fail(here, "give by or to, not both");
    if (spec.by !== undefined) {
      if (typeof spec.by !== "number" || !Number.isFinite(spec.by) || spec.by === 0) fail(here, "by takes a number of pixels, negative to go up");
      step.by = spec.by;
    } else if (typeof spec.to === "number") {
      if (!(spec.to >= 0)) fail(here, "to takes a position from the top in pixels");
      step.to = spec.to;
    } else if (typeof spec.to === "string" && /^(top|bottom)$/i.test(spec.to.trim())) {
      step.to = spec.to.trim().toLowerCase();
    } else if (spec.to !== undefined) {
      step.to = targetOf(spec.to, here);
    } else fail(here, "scroll needs pixels, top, bottom or a target");
    const duration = spec.duration !== undefined ? spec.duration : raw.duration;
    if (duration !== undefined) step.duration = seconds(duration, here, "duration", { min: 0.2, max: 20 });
  } else if (action === "click" || action === "hover") {
    step.target = targetOf(value, here);
    const zoom = zoomOf(raw.zoom, here);
    if (zoom !== undefined) step.zoom = zoom;
  } else if (action === "type") {
    const spec = isObject(value) ? value : { text: value, into: raw.into };
    if (isObject(value)) for (const key of Object.keys(value)) if (!["text", "into"].includes(key)) fail(here, `unknown key ${key}; type takes text and into`);
    if (typeof spec.text === "number") spec.text = String(spec.text);
    if (typeof spec.text !== "string" || !spec.text) fail(here, "type needs the text to type");
    if (spec.text.length > 500) fail(here, "type takes at most 500 characters");
    step.text = spec.text;
    const into = spec.into !== undefined ? spec.into : raw.into;
    if (into !== undefined && into !== null) step.into = targetOf(into, here);
    const zoom = zoomOf(raw.zoom, here);
    if (zoom !== undefined) step.zoom = zoom;
  } else if (action === "wait") {
    if (typeof num(value) === "number") step.seconds = seconds(value, here, "wait", { max: 60 });
    else if (isObject(value) && value.seconds !== undefined && Object.keys(value).length === 1) step.seconds = seconds(value.seconds, here, "wait", { max: 60 });
    else if (isObject(value) && value.seconds !== undefined) fail(here, "give seconds, or for with a timeout, not both");
    else {
      const spec = isObject(value) ? value : { for: value };
      for (const key of Object.keys(spec)) if (!["for", "timeout"].includes(key)) fail(here, `unknown key ${key}; wait takes seconds, or for and timeout`);
      if (spec.for === undefined || spec.for === null) fail(here, "wait needs seconds or a target to wait for");
      step.for = targetOf(spec.for, here);
      const timeout = spec.timeout !== undefined ? spec.timeout : raw.timeout;
      step.timeout = timeout === undefined ? 15 : seconds(timeout, here, "timeout", { min: 1, max: 120 });
    }
  } else if (action === "key") {
    step.key = keyOf(value, here);
  }
  if (raw.label !== undefined) {
    if (typeof raw.label !== "string") fail(here, "label takes text");
    step.label = raw.label.trim();
  }
  if (raw.note !== undefined) {
    if (typeof raw.note !== "string") fail(here, "note takes text");
    step.note = raw.note.trim();
  }
  if (raw.pause !== undefined) step.pause = seconds(raw.pause, here, "pause", { max: 30 });
  return step;
}

// A parsed steps file, as {url, hide, steps}.
function normalizeSteps(doc) {
  const top = Array.isArray(doc) ? { steps: doc } : doc;
  if (!isObject(top)) throw new StepError("a steps file holds a list of steps, or url: and steps:");
  for (const key of Object.keys(top)) if (!TOP.includes(key)) throw new StepError(`unknown key ${key} at the top; a steps file takes ${TOP.join(", ")}`);
  if (!Array.isArray(top.steps) || !top.steps.length) throw new StepError("steps: needs at least one step");
  if (top.steps.length > 200) throw new StepError("a demo takes at most 200 steps");
  if (top.url !== undefined && (typeof top.url !== "string" || !top.url.trim())) throw new StepError("url takes a web address");
  const hide = top.hide === undefined || top.hide === null ? [] : Array.isArray(top.hide) ? top.hide : [top.hide];
  if (hide.some((selector) => typeof selector !== "string" || !selector.trim())) throw new StepError("hide takes CSS selectors");
  return { url: top.url ? top.url.trim() : "", hide: hide.map((selector) => selector.trim()), steps: top.steps.map(normalizeStep) };
}

function readSteps(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new StepError(`could not read ${file}: ${err.code === "ENOENT" ? "no such file" : err.message}`);
  }
  let doc;
  try {
    doc = /\.json$/i.test(file) ? JSON.parse(text) : parseYaml(text);
  } catch (err) {
    throw new StepError(`${path.basename(file)}: ${err.message}`);
  }
  try {
    return normalizeSteps(doc);
  } catch (err) {
    throw new StepError(`${path.basename(file)}: ${err.message}`);
  }
}

// A target as a steps file writes it.
function targetText(target) {
  return target.text !== undefined ? `text=${target.text}` : target.css;
}

// Steps back as a steps file, so a tour can be edited and recorded again.
function toYaml({ url, hide = [], steps }, header = []) {
  const q = (value) => (typeof value === "number" ? String(value) : JSON.stringify(value));
  const lines = header.map((line) => `# ${line}`);
  if (url) lines.push(`url: ${q(url)}`);
  if (hide.length) lines.push("hide:", ...hide.map((selector) => `  - ${q(selector)}`));
  lines.push("steps:");
  for (const step of steps) {
    let first;
    const more = [];
    if (step.action === "visit") first = `visit: ${q(step.url)}`;
    else if (step.action === "scroll") {
      const parts = [];
      if (step.by !== undefined) parts.push(`by: ${step.by}`);
      else parts.push(`to: ${typeof step.to === "object" ? q(targetText(step.to)) : q(step.to)}`);
      if (step.duration !== undefined) parts.push(`duration: ${step.duration}`);
      first = `scroll: { ${parts.join(", ")} }`;
    } else if (step.action === "click" || step.action === "hover") first = `${step.action}: ${q(targetText(step.target))}`;
    else if (step.action === "type") {
      first = `type: ${q(step.text)}`;
      if (step.into) more.push(`into: ${q(targetText(step.into))}`);
    } else if (step.action === "wait") first = step.for ? `wait: { for: ${q(targetText(step.for))}, timeout: ${step.timeout} }` : `wait: ${step.seconds}`;
    else if (step.action === "key") first = `key: ${q(step.key)}`;
    if (step.zoom !== undefined && step.action !== "scroll") more.push(`zoom: ${step.zoom === 1 ? "false" : step.zoom}`);
    if (step.label) more.push(`label: ${q(step.label)}`);
    if (step.note) more.push(`note: ${q(step.note)}`);
    if (step.pause !== undefined) more.push(`pause: ${step.pause}`);
    lines.push(`  - ${first}`, ...more.map((line) => `    ${line}`));
  }
  return lines.join("\n") + "\n";
}

module.exports = { ACTIONS, StepError, targetOf, keyOf, normalizeStep, normalizeSteps, readSteps, toYaml, targetText };
