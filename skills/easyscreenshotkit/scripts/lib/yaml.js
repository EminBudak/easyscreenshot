"use strict";

// The YAML a steps file is written in, read without a dependency: block
// mappings and lists, inline {…} and […], quoted and plain strings, numbers,
// true, false, null and comments. Anchors, tags and multi-line strings are
// not read; a file that uses them gets an error naming the line instead of a
// guess.

class YamlError extends Error {
  constructor(line, message) {
    super(line ? `line ${line}: ${message}` : message);
    this.line = line;
  }
}

// A comment starts at a # that opens the line or follows a space, outside
// quotes. Returns the line without it, and whether a comment was cut.
function stripComment(text) {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      // A quote only opens a string at the start of a value.
      const before = text.slice(0, i).trimEnd();
      if (!before || /[:\-,[{]$/.test(before)) quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
      return { text: text.slice(0, i).trimEnd(), cut: text.slice(i) };
    }
  }
  return { text: text.trimEnd(), cut: "" };
}

function toLines(source) {
  const lines = [];
  String(source)
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const n = i + 1;
      const indent = raw.length - raw.replace(/^[ \t]*/, "").length;
      if (raw.slice(0, indent).includes("\t") && raw.trim()) throw new YamlError(n, "indent with spaces, not tabs");
      const { text, cut } = stripComment(raw.slice(indent));
      if (!text) return;
      if (text === "---" && !lines.length) return;
      if (text === "---" || text === "...") throw new YamlError(n, "a steps file holds one document");
      lines.push({ n, indent, text, cut });
    });
  return lines;
}

const NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

// A number is read as one only when it reads back the same: "+1555…",
// "02134" or "1.50" stay text, so a phone number or a code is typed as
// written. Where a number is wanted, steps.js takes the text too.
function scalar(text, n) {
  const t = text.trim();
  if (t === "" || t === "~" || /^null$/i.test(t)) return null;
  if (/^true$/i.test(t)) return true;
  if (/^false$/i.test(t)) return false;
  if (NUMBER.test(t) && String(Number(t)) === t) return Number(t);
  if (/^[&*!]/.test(t)) throw new YamlError(n, `anchors, aliases and tags are not supported (${t.split(/\s/)[0]})`);
  if (/^[|>][-+0-9]*$/.test(t)) throw new YamlError(n, "multi-line strings are not supported; write the text in quotes, with \\n for a new line");
  if (/^[@`]/.test(t)) throw new YamlError(n, `${t[0]} cannot start a plain value; put it in quotes`);
  return t;
}

function unescape(body, n) {
  const map = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "/": "/", 0: "\0", b: "\b", f: "\f", " ": " " };
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, code) => {
    if (code.length > 1) return String.fromCharCode(parseInt(code.slice(1), 16));
    if (code in map) return map[code];
    throw new YamlError(n, `unknown escape \\${code} in a double-quoted string`);
  });
}

// Reads a quoted string that starts at text[at]; returns [value, next index].
function quoted(text, at, n) {
  const q = text[at];
  let i = at + 1;
  let body = "";
  while (i < text.length) {
    const c = text[i];
    if (q === '"' && c === "\\") {
      body += c + (text[i + 1] || "");
      i += 2;
      continue;
    }
    if (c === q) {
      if (q === "'" && text[i + 1] === "'") {
        body += "'";
        i += 2;
        continue;
      }
      return [q === '"' ? unescape(body, n) : body, i + 1];
    }
    body += c;
    i++;
  }
  throw new YamlError(n, `a ${q === '"' ? "double" : "single"}-quoted string is not closed`);
}

// An inline collection, {a: 1, b: [x, y]}.
function flow(text, n) {
  let i = 0;
  const space = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const value = (ends) => {
    space();
    const c = text[i];
    if (c === "{" || c === "[") return collection();
    if (c === '"' || c === "'") {
      const [v, next] = quoted(text, i, n);
      i = next;
      return v;
    }
    let start = i;
    while (i < text.length && !ends.includes(text[i])) {
      if (text[i] === "[" || text[i] === "{") throw new YamlError(n, "put values that hold [ ] { } or commas in quotes");
      i++;
    }
    return scalar(text.slice(start, i), n);
  };
  const collection = () => {
    const open = text[i++];
    const close = open === "{" ? "}" : "]";
    const out = open === "{" ? {} : [];
    space();
    if (text[i] === close) {
      i++;
      return out;
    }
    for (;;) {
      if (open === "{") {
        space();
        let key;
        if (text[i] === '"' || text[i] === "'") {
          const [k, next] = quoted(text, i, n);
          key = k;
          i = next;
          space();
          if (text[i] !== ":") throw new YamlError(n, `expected : after "${key}"`);
        } else {
          const start = i;
          while (i < text.length && text[i] !== ":" && text[i] !== "," && text[i] !== "}") i++;
          key = text.slice(start, i).trim();
          if (text[i] !== ":") throw new YamlError(n, `expected key: value inside { }, got "${key}"`);
        }
        i++;
        if (Object.prototype.hasOwnProperty.call(out, key)) throw new YamlError(n, `${key} is given twice`);
        out[key] = value([",", "}"]);
      } else {
        out.push(value([",", "]"]));
      }
      space();
      if (text[i] === ",") {
        i++;
        space();
        if (text[i] === close) {
          i++;
          return out;
        }
        continue;
      }
      if (text[i] === close) {
        i++;
        return out;
      }
      throw new YamlError(n, `expected , or ${close}`);
    }
  };
  const result = collection();
  space();
  if (i < text.length) throw new YamlError(n, `unexpected text after the closing bracket: ${text.slice(i)}`);
  return result;
}

// A value on a line: a quoted string, an inline collection or a plain one.
function inline(text, n) {
  const t = text.trim();
  if (t[0] === '"' || t[0] === "'") {
    const [v, next] = quoted(t, 0, n);
    if (t.slice(next).trim()) throw new YamlError(n, `unexpected text after the closing quote: ${t.slice(next).trim()}`);
    return v;
  }
  if (t[0] === "{" || t[0] === "[") return flow(t, n);
  return scalar(t, n);
}

// Where "key: value" splits, outside quotes and brackets, or -1.
function keySplit(text) {
  let quote = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = "";
      continue;
    }
    if ((c === '"' || c === "'") && i === 0) quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === ":" && depth === 0 && (i + 1 === text.length || text[i + 1] === " ")) return i;
  }
  return -1;
}

const isItem = (text) => text === "-" || text.startsWith("- ");

// "click: #cta" leaves click empty, and "click: .hero #cta" leaves it
// ".hero": YAML reads " #cta" as a comment. Said plainly, since a CSS
// selector is the usual value in a steps file. A comment has a space after
// its #.
function commentedOut(line, lead, value = "") {
  const word = /^#\S+/.exec(line.cut);
  if (!word) return;
  if (!value) throw new YamlError(line.n, `${word[0]} is read as a comment; put a selector that starts with # in quotes: ${lead}"${word[0]}"`);
  if (/^["'[{]/.test(value)) throw new YamlError(line.n, `${word[0]} is read as a comment; a comment needs a space after the #`);
  throw new YamlError(line.n, `${word[0]} is read as a comment; put the whole value in quotes: ${lead}"${value} ${word[0]}"`);
}

class Parser {
  constructor(lines) {
    this.lines = lines;
    this.at = 0;
  }

  peek() {
    return this.lines[this.at];
  }

  // An inline collection may run over several lines until its brackets close.
  joinFlow(line, text) {
    let depth = 0;
    let quote = "";
    const count = (s) => {
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quote) {
          if (c === "\\" && quote === '"') i++;
          else if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === "[" || c === "{") depth++;
        else if (c === "]" || c === "}") depth--;
      }
    };
    count(text);
    let joined = text;
    while (depth > 0 && this.peek()) {
      const next = this.lines[this.at++];
      count(next.text);
      joined += ` ${next.text}`;
    }
    if (depth > 0) throw new YamlError(line.n, "a [ or { is not closed");
    return joined;
  }

  value(line, text) {
    const t = text.trim();
    if (t[0] === "{" || t[0] === "[") return inline(this.joinFlow(line, t), line.n);
    return inline(t, line.n);
  }

  block(indent) {
    const line = this.peek();
    if (!line || line.indent < indent) return null;
    if (isItem(line.text)) return this.sequence(line.indent);
    if (keySplit(line.text) >= 0) return this.mapping(line.indent);
    this.at++;
    const value = this.value(line, line.text);
    const after = this.peek();
    if (after && after.indent >= line.indent && after.indent > 0) throw new YamlError(after.n, "a plain value cannot go on over several lines; put it in quotes on one line");
    return value;
  }

  sequence(indent) {
    const out = [];
    for (;;) {
      const line = this.peek();
      if (!line || line.indent !== indent || !isItem(line.text)) break;
      this.at++;
      const rest = line.text === "-" ? "" : line.text.slice(2);
      const lead = line.text.length - line.text.slice(1).trimStart().length;
      if (!rest.trim()) {
        const next = this.peek();
        if (next && next.indent > indent) out.push(this.block(next.indent));
        else {
          commentedOut(line, "- ");
          out.push(null);
        }
        continue;
      }
      // "- key: value" opens a mapping whose keys line up after the dash.
      if (isItem(rest.trimStart()) || keySplit(rest.trimStart()) >= 0) {
        this.lines.splice(this.at, 0, { n: line.n, indent: indent + lead, text: rest.trimStart(), cut: line.cut });
        out.push(this.block(indent + lead));
        continue;
      }
      commentedOut(line, "- ", rest.trim());
      out.push(this.value(line, rest));
      const next = this.peek();
      if (next && next.indent > indent) throw new YamlError(next.n, "unexpected indent after a list item that has a value");
    }
    return out;
  }

  mapping(indent) {
    const out = {};
    for (;;) {
      const line = this.peek();
      if (!line || line.indent !== indent) break;
      if (isItem(line.text)) throw new YamlError(line.n, "a list item where a key was expected");
      const split = keySplit(line.text);
      if (split < 0) throw new YamlError(line.n, `expected key: value, got "${line.text}"`);
      this.at++;
      let key = line.text.slice(0, split).trim();
      if (key[0] === '"' || key[0] === "'") key = inline(key, line.n);
      if (!key) throw new YamlError(line.n, "a key is missing before the colon");
      if (Object.prototype.hasOwnProperty.call(out, key)) throw new YamlError(line.n, `${key} is given twice`);
      const rest = line.text.slice(split + 1);
      if (rest.trim()) {
        commentedOut(line, `${key}: `, rest.trim());
        out[key] = this.value(line, rest);
        const next = this.peek();
        if (next && next.indent > indent) throw new YamlError(next.n, `unexpected indent: ${key} already has a value`);
        continue;
      }
      const next = this.peek();
      if (next && next.indent > indent) out[key] = this.block(next.indent);
      else if (next && next.indent === indent && isItem(next.text)) out[key] = this.sequence(indent);
      else {
        commentedOut(line, `${key}: `);
        out[key] = null;
      }
    }
    return out;
  }
}

function parseYaml(source) {
  const lines = toLines(source);
  if (!lines.length) return null;
  const parser = new Parser(lines);
  const value = parser.block(lines[0].indent);
  const left = parser.peek();
  if (left) throw new YamlError(left.n, left.indent > lines[0].indent ? "unexpected indent" : "unexpected line; is the indent right?");
  return value;
}

module.exports = { parseYaml, YamlError };
