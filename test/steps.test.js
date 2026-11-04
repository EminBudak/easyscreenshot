"use strict";

// The steps file of a demo: the YAML it is written in, the steps it holds,
// and a tour written back as a file that reads the same.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { parseYaml } = require("../skills/easyscreenshot/scripts/lib/yaml");
const { normalizeSteps, readSteps, toYaml, keyOf, targetOf } = require("../skills/easyscreenshot/scripts/lib/steps");

test("YAML: mappings, lists, inline collections, quotes, numbers and comments", () => {
  const doc = parseYaml(`# a demo
url: https://acme.com   # the site
hide:
- .promo
- "#chat"
steps:
  - visit: /
  - wait: 1.5
  - scroll: { to: "#features", duration: 2 }
  - click: "text=Get started"
    zoom: false
  - type: ada@example.com
    into: 'input[name=email]'
  - key: Enter
  - wait: { for: text=Thanks, timeout: 10 }
  - list: [1, 2,
      3]
  - - nested
    - two
  - "esc\\n\\u00e9"
  - 'it''s'
  - ~
`);
  assert.deepEqual(doc, {
    url: "https://acme.com",
    hide: [".promo", "#chat"],
    steps: [
      { visit: "/" },
      { wait: 1.5 },
      { scroll: { to: "#features", duration: 2 } },
      { click: "text=Get started", zoom: false },
      { type: "ada@example.com", into: "input[name=email]" },
      { key: "Enter" },
      { wait: { for: "text=Thanks", timeout: 10 } },
      { list: [1, 2, 3] },
      ["nested", "two"],
      "esc\né",
      "it's",
      null,
    ],
  });
  assert.equal(parseYaml(""), null);
  assert.deepEqual(parseYaml("---\n- a\n"), ["a"]);
});

test("YAML: errors name the line, and a # selector left unquoted is explained", () => {
  const error = (text) => {
    try {
      parseYaml(text);
    } catch (err) {
      return err.message;
    }
    return "no error";
  };
  assert.equal(error("steps:\n  - click: #cta\n"), 'line 2: #cta is read as a comment; put a selector that starts with # in quotes: click: "#cta"');
  assert.equal(error("hide:\n  - #chat\n"), 'line 2: #chat is read as a comment; put a selector that starts with # in quotes: - "#chat"');
  assert.match(error("a: 1\n  b: 2"), /^line 2: unexpected indent/);
  assert.match(error("a: x\na: y"), /^line 2: a is given twice/);
  assert.match(error('a: "open'), /^line 1: a double-quoted string is not closed/);
  assert.match(error("a: *ref"), /^line 1: anchors, aliases and tags are not supported/);
  assert.match(error("a: |\n  text"), /^line 1: multi-line strings are not supported/);
  assert.match(error("a:\n\t- x"), /^line 2: indent with spaces, not tabs/);
  assert.match(error("a: [1, 2"), /^line 1: a \[ or \{ is not closed/);
  assert.match(error("a: {x: input[name=a]}"), /put values that hold \[ \] \{ \} or commas in quotes/);
  assert.match(error("a: x\n---\nb: y"), /one document/);
  // A comment with a space after # stays a comment; one right after a
  // selector would cut it short, which is said instead.
  assert.deepEqual(parseYaml("steps: # the flow\n  - wait: 1 # seconds"), { steps: [{ wait: 1 }] });
  assert.equal(error("- click: .hero #signup"), 'line 1: #signup is read as a comment; put the whole value in quotes: click: ".hero #signup"');
  assert.equal(error("- '#a' #x"), "line 1: #x is read as a comment; a comment needs a space after the #");
});

test("YAML: a number that does not read back the same stays text, so it is typed as written", () => {
  assert.deepEqual(parseYaml("- 1\n- -2.5\n- 0.5\n- +15551234567\n- 02134\n- 1.50\n- 1e3\n- .5"), [1, -2.5, 0.5, "+15551234567", "02134", "1.50", "1e3", ".5"]);
  const { steps } = normalizeSteps(parseYaml("steps:\n  - type: +15551234567\n  - wait: 1.50\n  - scroll: { by: 2.0, duration: 1e0 }\n  - click: '#a'\n    zoom: 2.0\n    pause: .5"));
  assert.deepEqual(steps, [
    { action: "type", text: "+15551234567" },
    { action: "wait", seconds: 1.5 },
    { action: "scroll", by: 2, duration: 1 },
    { action: "click", target: { css: "#a" }, zoom: 2, pause: 0.5 },
  ]);
});

test("steps: every action in its short and long forms", () => {
  const { url, hide, steps } = normalizeSteps({
    url: "acme.com",
    hide: ".promo",
    steps: [
      { visit: "/pricing", label: "Prices" },
      { scroll: 800 },
      { scroll: -300, duration: 1 },
      { scroll: "bottom" },
      { scroll: { to: "#faq", duration: 2 } },
      { scroll: { to: 1200 } },
      { click: "text= Start free ", zoom: 2 },
      { click: { css: "#buy" }, zoom: false, pause: 0.2 },
      { hover: "nav a" },
      { type: "ada@example.com", into: "#email" },
      { type: { text: 42 } },
      { key: "cmd+k" },
      { key: "Shift+Tab" },
      { wait: 2 },
      { wait: "text=Thanks", note: "the form went through" },
      { wait: { for: ".done", timeout: 30 } },
    ],
  });
  assert.equal(url, "acme.com");
  assert.deepEqual(hide, [".promo"]);
  assert.deepEqual(steps, [
    { action: "visit", url: "/pricing", label: "Prices" },
    { action: "scroll", by: 800 },
    { action: "scroll", by: -300, duration: 1 },
    { action: "scroll", to: "bottom" },
    { action: "scroll", to: { css: "#faq" }, duration: 2 },
    { action: "scroll", to: 1200 },
    { action: "click", target: { text: "Start free" }, zoom: 2 },
    { action: "click", target: { css: "#buy" }, zoom: 1, pause: 0.2 },
    { action: "hover", target: { css: "nav a" } },
    { action: "type", text: "ada@example.com", into: { css: "#email" } },
    { action: "type", text: "42" },
    { action: "key", key: "Meta+k" },
    { action: "key", key: "Shift+Tab" },
    { action: "wait", seconds: 2 },
    { action: "wait", for: { text: "Thanks" }, timeout: 15, note: "the form went through" },
    { action: "wait", for: { css: ".done" }, timeout: 30 },
  ]);
  // A plain list is a steps file too.
  assert.deepEqual(normalizeSteps([{ wait: 1 }]).steps, [{ action: "wait", seconds: 1 }]);
});

test("steps: mistakes are caught with the step's number", () => {
  const error = (doc) => {
    try {
      normalizeSteps(doc);
    } catch (err) {
      return err.message;
    }
    return "no error";
  };
  assert.equal(error({ steps: [{ visit: "/" }, { clik: "#a" }] }), "step 2: no action; use one of visit, scroll, click, type, wait, hover, key");
  assert.equal(error({ steps: [{ click: "#a", type: "x" }] }), "step 1: one action per step, got click and type");
  assert.equal(error({ steps: [{ click: "#a", timeout: 3 }] }), "step 1 (click): unknown key timeout; click takes zoom, label, note, pause");
  assert.equal(error({ steps: [{ wait: 600 }] }), "step 1 (wait): wait takes 0 to 60 seconds");
  assert.equal(error({ steps: [{ scroll: { by: 10, to: "top" } }] }), "step 1 (scroll): give by or to, not both");
  assert.equal(error({ steps: [{ click: "" }] }), "step 1 (click): the target is empty");
  assert.equal(error({ steps: [{ click: "text=" }] }), "step 1 (click): text= needs the words to look for");
  assert.equal(error({ steps: [{ key: "Hyper+K" }] }), "step 1 (key): Hyper is not a modifier; use Control, Alt, Shift or Meta");
  assert.match(error({ steps: [{ key: "Launch" }] }), /^step 1 \(key\): unknown key Launch/);
  assert.equal(error({ steps: [{ click: "#a", zoom: 9 }] }), "step 1 (click): zoom takes false or a number from 1 to 3");
  assert.equal(error({ steps: [] }), "steps: needs at least one step");
  assert.equal(error({ url: "x", steps: [{ wait: 1 }], pages: 3 }), "unknown key pages at the top; a steps file takes url, steps, hide");
  assert.equal(error({ steps: ["click #a"] }), 'step 1: expected an action such as "- click: <target>", got "click #a"');
  assert.equal(keyOf("ctrl+shift+p", "x"), "Control+Shift+p");
  assert.equal(keyOf("Space", "x"), "Space");
  assert.equal(keyOf("Control++", "x"), "Control++");
  assert.deepEqual(targetOf("text='Sign in'", "x"), { text: "Sign in" });
});

test("a steps file is read from YAML or JSON, and a tour written back reads the same", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easyscreenshot-steps-"));
  try {
    const yaml = path.join(dir, "demo.yaml");
    fs.writeFileSync(yaml, "url: https://acme.com\nsteps:\n  - visit: /\n  - click: '#go'\n");
    assert.deepEqual(readSteps(yaml).steps, [{ action: "visit", url: "/" }, { action: "click", target: { css: "#go" } }]);
    const json = path.join(dir, "demo.json");
    fs.writeFileSync(json, JSON.stringify({ steps: [{ wait: 1 }] }));
    assert.deepEqual(readSteps(json).steps, [{ action: "wait", seconds: 1 }]);
    fs.writeFileSync(yaml, "steps:\n  - click: #go\n");
    assert.throws(() => readSteps(yaml), /^Error: demo\.yaml: line 2: #go is read as a comment/);
    assert.throws(() => readSteps(path.join(dir, "none.yaml")), /could not read .*none\.yaml: no such file/);

    const tour = {
      url: "https://acme.com/",
      hide: ["#promo"],
      steps: [
        { action: "visit", url: "https://acme.com/", label: "Open acme.com" },
        { action: "wait", seconds: 1.6 },
        { action: "scroll", to: 1350, label: 'Scroll to "Features \\ more"' },
        { action: "scroll", by: -200, duration: 1 },
        { action: "scroll", to: { text: "FAQ" } },
        { action: "click", target: { text: "Pricing" }, label: 'Click "Pricing"' },
        { action: "type", text: 'say "hi"\nbye', into: { css: "input[name=q]" }, zoom: 2 },
        { action: "key", key: "Meta+k", note: "opens the menu" },
        { action: "wait", for: { css: ".done" }, timeout: 15 },
        { action: "hover", target: { css: "nav a" }, zoom: 1, pause: 0.5 },
      ],
    };
    fs.writeFileSync(yaml, toYaml(tour, ["Made by a test", "Edit me"]));
    const text = fs.readFileSync(yaml, "utf8");
    assert.match(text, /^# Made by a test\n# Edit me\nurl: "https:\/\/acme.com\/"\n/);
    assert.deepEqual(readSteps(yaml), tour);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
