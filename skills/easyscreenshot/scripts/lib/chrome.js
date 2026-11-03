"use strict";

// The browser: a Chrome, Chromium, Edge or Brave already on this machine,
// started headless with a throwaway profile and driven over the DevTools
// protocol with the WebSocket built into Node 22. Nothing is downloaded.
// Finding, starting and closing the browser come from easybrandkit 0.2.1;
// every page here opens in a window of its own, set up as the device it is
// captured on.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { timeLeft, sleep } = require("./time");

const MAC = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];
const LINUX = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
const WINDOWS = [
  ["PROGRAMFILES", "Google\\Chrome\\Application\\chrome.exe"],
  ["PROGRAMFILES(X86)", "Google\\Chrome\\Application\\chrome.exe"],
  ["LOCALAPPDATA", "Google\\Chrome\\Application\\chrome.exe"],
  ["PROGRAMFILES(X86)", "Microsoft\\Edge\\Application\\msedge.exe"],
  ["PROGRAMFILES", "Microsoft\\Edge\\Application\\msedge.exe"],
];

function onPath(name) {
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // Not in this directory.
    }
  }
  return "";
}

function findChrome() {
  if (process.env.CHROME_PATH) return fs.existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : "";
  if (process.platform === "darwin") return MAC.find((file) => fs.existsSync(file)) || "";
  if (process.platform === "win32") {
    for (const [root, rest] of WINDOWS) {
      const file = process.env[root] ? path.join(process.env[root], rest) : "";
      if (file && fs.existsSync(file)) return file;
    }
    return "";
  }
  for (const name of LINUX) {
    const file = onPath(name);
    if (file) return file;
  }
  return "";
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 0;
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (msg && msg.method) {
        for (const listener of listeners.get(msg.method) || []) listener(msg.params || {});
        return;
      }
      const waiter = msg && pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) waiter.reject(new Error(msg.error.message || "DevTools protocol error"));
      else waiter.resolve(msg.result || {});
    };
    ws.onerror = () => reject(new Error("The browser connection failed."));
    ws.onclose = () => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("The browser connection closed."));
      }
      pending.clear();
    };
    ws.onopen = () =>
      resolve({
        send(method, params = {}, timeoutMs = 30_000) {
          const id = ++nextId;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`${method} timed out`));
            }, Math.max(1_000, Math.min(timeoutMs, timeLeft())));
            pending.set(id, { resolve: res, reject: rej, timer });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        on(method, listener) {
          listeners.set(method, [...(listeners.get(method) || []), listener]);
        },
        off(method, listener) {
          listeners.set(method, (listeners.get(method) || []).filter((known) => known !== listener));
        },
        close() {
          ws.close();
        },
      });
  });
}

// --use-mock-keychain and --password-store=basic keep Chrome on macOS from
// asking for the login keychain, which it does for a fresh profile. The
// profile is a temp folder; the user's own home and browser are untouched.
// Windows in the background keep drawing (the three --disable-*background*
// flags), so a page waiting its turn is not left half loaded, and colors are
// written in sRGB whatever the machine's display.
async function launch({ lang = "" } = {}) {
  const binary = findChrome();
  if (!binary) {
    throw new Error("No Chrome, Chromium, Edge or Brave found. Install one, or point CHROME_PATH at its binary.");
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "easyscreenshot-chrome-"));
  const child = spawn(
    binary,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--window-size=1600,900",
      "--hide-scrollbars",
      "--mute-audio",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--force-color-profile=srgb",
      "--use-mock-keychain",
      "--password-store=basic",
      ...(lang ? [`--lang=${lang}`] : []),
      // Chrome refuses to start as root without it (a container, a CI box).
      ...(process.getuid && process.getuid() === 0 ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let exited = false;
  child.on("exit", () => (exited = true));
  child.on("error", () => (exited = true));
  let base = "";
  let browser = null;
  // Chrome is asked to quit first: killed outright, its helper processes go
  // on writing to the profile for a while and the folder cannot be removed.
  // A profile that still cannot be removed is left in the temp folder; the
  // screenshots are not lost over it.
  const close = async () => {
    if (browser && !exited) {
      await browser.send("Browser.close", {}, 3_000).catch(() => {});
      for (let i = 0; i < 50 && !exited; i++) await sleep(100);
    }
    if (browser) browser.close();
    if (!exited) child.kill("SIGKILL");
    for (let i = 0; i < 20 && !exited; i++) await sleep(100);
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Left for the system's temp clean-up.
    }
  };
  // Chrome writes the port it picked to DevToolsActivePort in the profile.
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let waited = 0; waited < 20_000 && !exited; waited += 100) {
    try {
      const port = fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
      if (/^\d+$/.test(port)) {
        base = `http://127.0.0.1:${port}`;
        const version = await (await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(5_000) })).json();
        browser = await connect(version.webSocketDebuggerUrl);
        const { userAgent = "" } = await browser.send("Browser.getVersion").catch(() => ({}));
        return { base, browser, userAgent, close };
      }
    } catch {
      // Not written yet, or not answering yet.
    }
    await sleep(100);
  }
  await close();
  throw new Error(`${path.basename(binary)} did not start. Try again, or point CHROME_PATH at another browser.`);
}

// The devices a page is captured on. A phone is a phone to the site: its
// size, a touch screen, and the user agent (with the client hints Chrome
// sends) of that phone's browser, so a site that picks its mobile layout by
// the browser sends it too. A narrowed desktop window is not enough: tables
// came out wrapped word by word, and some sites kept their desktop layout.
const ANDROID_MODEL = "Pixel 8";

function userAgentFor(device, chromeAgent) {
  const major = (/Chrome\/(\d+)/.exec(chromeAgent) || [])[1] || "141";
  if (device.agent === "android") {
    return {
      userAgent: `Mozilla/5.0 (Linux; Android 14; ${ANDROID_MODEL}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
      platform: "Linux aarch64",
      userAgentMetadata: {
        brands: [{ brand: "Chromium", version: major }, { brand: "Not?A_Brand", version: "24" }],
        fullVersionList: [{ brand: "Chromium", version: `${major}.0.0.0` }, { brand: "Not?A_Brand", version: "24.0.0.0" }],
        platform: "Android",
        platformVersion: "14.0.0",
        architecture: "",
        model: ANDROID_MODEL,
        mobile: true,
      },
    };
  }
  if (device.agent === "iphone") {
    return {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
      platform: "iPhone",
    };
  }
  // Headless Chrome says "HeadlessChrome" in its user agent, and some sites
  // answer that with a stripped page; the tab says "Chrome", as the same
  // browser with a window would.
  return { userAgent: chromeAgent.replace("HeadlessChrome", "Chrome") };
}

// A new window holding one tab, set up as the device: its screen, touch,
// user agent and language, light or dark, and reduced motion when asked.
async function openTab(chrome, device, { lang = "", theme = "light", reducedMotion = false } = {}) {
  const { targetId } = await chrome.browser.send("Target.createTarget", { url: "about:blank", newWindow: true });
  const cdp = await connect(`${chrome.base.replace(/^http/, "ws")}/devtools/page/${targetId}`);
  cdp.targetId = targetId;
  try {
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: device.width,
      height: device.height,
      deviceScaleFactor: device.scale,
      mobile: device.mobile,
      screenWidth: device.width,
      screenHeight: device.height,
      ...(device.mobile ? { screenOrientation: { type: "portraitPrimary", angle: 0 } } : {}),
    });
    if (device.touch) await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await cdp.send("Emulation.setUserAgentOverride", { ...userAgentFor(device, chrome.userAgent), ...(lang ? { acceptLanguage: lang } : {}) });
    if (lang) await cdp.send("Emulation.setLocaleOverride", { locale: lang }).catch(() => {});
    const features = [{ name: "prefers-color-scheme", value: theme === "dark" ? "dark" : "light" }];
    if (reducedMotion) features.push({ name: "prefers-reduced-motion", value: "reduce" });
    await cdp.send("Emulation.setEmulatedMedia", { features });
    // Under a page that paints no background of its own, the browser's own
    // (white, or dark grey in the dark theme): otherwise those pixels come
    // out see-through, and one screen of a page is RGBA while the next is
    // RGB.
    const ground = theme === "dark" ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
    await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: ground }).catch(() => {});
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  } catch (err) {
    await closeTab(chrome, cdp);
    throw err;
  }
  return cdp;
}

async function closeTab(chrome, cdp) {
  cdp.close();
  await chrome.browser.send("Target.closeTarget", { targetId: cdp.targetId }, 5_000).catch(() => {});
}

// Opens the address and waits for its load event, at most 20 s: a page that
// never finishes loading (a stuck tracking script) is read as it stands.
// Returns the address the tab ended on, after any redirects, and the HTTP
// status the page came with.
async function navigate(cdp, url) {
  let onLoad;
  const loaded = new Promise((resolve) => cdp.on("Page.loadEventFired", (onLoad = resolve)));
  try {
    const { errorText } = await cdp.send("Page.navigate", { url });
    if (errorText) throw new Error(`Could not open ${url}: ${errorText}`);
    await Promise.race([loaded, sleep(Math.max(1_000, Math.min(20_000, timeLeft() - 60_000)))]);
  } finally {
    cdp.off("Page.loadEventFired", onLoad);
  }
  let finalUrl = url;
  try {
    const { currentIndex, entries } = await cdp.send("Page.getNavigationHistory");
    finalUrl = (entries[currentIndex] || {}).url || url;
  } catch {
    // Keep the address asked for.
  }
  const { result } = await cdp
    .send("Runtime.evaluate", { expression: "(performance.getEntriesByType('navigation')[0] || {}).responseStatus || 0", returnByValue: true }, 5_000)
    .catch(() => ({ result: {} }));
  return { url: finalUrl, status: Number(result && result.value) || 0 };
}

module.exports = { findChrome, launch, connect, openTab, closeTab, navigate, userAgentFor };
