"use strict";

// ffmpeg, the one already on the machine, for the two encodings a demo
// needs: the drawn frames into an H.264 MP4, and the MP4 into a GIF small
// enough for a README. Nothing is downloaded.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { onPath } = require("./chrome");

// Where package managers put it, for an agent or app whose PATH is short.
const PLACES = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg", "/snap/bin/ffmpeg"];

function findFfmpeg() {
  if (process.env.FFMPEG_PATH) return fs.existsSync(process.env.FFMPEG_PATH) ? process.env.FFMPEG_PATH : "";
  const found = onPath(process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  if (found) return found;
  return process.platform === "win32" ? "" : PLACES.find((file) => fs.existsSync(file)) || "";
}

const MISSING = "The demo needs ffmpeg, and none was found. Install it (brew install ffmpeg, sudo apt install ffmpeg, winget install ffmpeg) or point FFMPEG_PATH at it.";

function run(binary, args, { timeout = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-20_000)));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const lastLine = (text) => String(text).trim().split("\n").filter(Boolean).slice(-1)[0] || "no message";

// The H.264 encoder this ffmpeg has, best first: x264 where it is built in
// (Homebrew, most Linux packages), the Mac's own, then Cisco's and
// Windows' own. No B-frames: with them the file starts two frames late
// behind an edit list, and a tool that reads frames without it would be
// two frames off steps.json. Without them the file is about 6% bigger.
async function pickEncoder(binary) {
  const { stdout } = await run(binary, ["-hide_banner", "-encoders"], { timeout: 20_000 });
  const has = (name) => new RegExp(`^\\s*V\\S*\\s+${name}\\s`, "m").test(stdout);
  if (has("libx264")) return { name: "libx264", args: ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-bf", "0"] };
  if (has("h264_videotoolbox")) return { name: "h264_videotoolbox", args: ["-c:v", "h264_videotoolbox", "-b:v", "14M", "-profile:v", "high", "-bf", "0"] };
  if (has("libopenh264")) return { name: "libopenh264", args: ["-c:v", "libopenh264", "-b:v", "14M"] };
  if (has("h264_mf")) return { name: "h264_mf", args: ["-c:v", "h264_mf", "-b:v", "14M"] };
  return null;
}

// An MP4 written from JPEG frames piped in one after the other. The frames
// are sRGB; the video is tagged BT.709, which players expect of HD.
// Returns {write(buffer), end()}; both wait for ffmpeg.
function startVideo(binary, file, { fps, encoder, title = "" }) {
  const child = spawn(
    binary,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
      "-vf", "scale=in_range=full:in_color_matrix=bt601:out_range=tv:out_color_matrix=bt709,format=yuv420p",
      ...encoder.args,
      "-r", String(fps),
      "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
      "-movflags", "+faststart",
      ...(title ? ["-metadata", `title=${title}`] : []),
      "-metadata", "comment=Recorded with easyscreenshotkit",
      file,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let stderr = "";
  let failed = null;
  child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-20_000)));
  const closed = new Promise((resolve) => {
    child.on("error", (err) => {
      failed = err;
      resolve(-1);
    });
    child.on("close", resolve);
  });
  child.stdin.on("error", () => {});
  return {
    async write(buffer) {
      if (failed || child.exitCode !== null || child.signalCode !== null) throw new Error(`ffmpeg stopped: ${failed ? failed.message : lastLine(stderr)}`);
      // An ffmpeg that stops while its input is full never drains it.
      if (!child.stdin.write(buffer)) await Promise.race([new Promise((resolve) => child.stdin.once("drain", resolve)), closed]);
    },
    async end() {
      child.stdin.end();
      const code = await closed;
      if (code !== 0) throw new Error(`ffmpeg could not write ${path.basename(file)}: ${failed ? failed.message : lastLine(stderr)}`);
    },
    kill() {
      child.kill("SIGKILL");
    },
  };
}

// The GIF: the MP4 made smaller step by step (width, then frames a second)
// until it fits the budget, 8 MB by default: GitHub shows bigger ones, but
// a README loads slowly with them. One palette for the whole video, a fine
// ordered dither (a gradient does not band, and it compresses better than
// error diffusion), and only the part of each frame that changed stored.
const GIF_TRIES = [
  { width: 960, fps: 12 },
  { width: 800, fps: 12 },
  { width: 800, fps: 10 },
  { width: 720, fps: 10 },
  { width: 640, fps: 10 },
  { width: 560, fps: 8 },
  { width: 480, fps: 8 },
];

async function makeGif(binary, video, file, { budget = 8 * 1024 * 1024, dir }) {
  const palette = path.join(dir, "palette.png");
  let last = null;
  try {
    for (const { width, fps } of GIF_TRIES) {
      const scale = `fps=${fps},scale=${width}:-2:flags=lanczos`;
      const made = await run(binary, ["-hide_banner", "-loglevel", "error", "-y", "-i", video, "-vf", `${scale},palettegen=max_colors=256:stats_mode=full`, palette]);
      if (made.code !== 0) throw new Error(`ffmpeg could not make the GIF's palette: ${lastLine(made.stderr)}`);
      const gif = await run(binary, ["-hide_banner", "-loglevel", "error", "-y", "-i", video, "-i", palette, "-lavfi", `${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, "-loop", "0", file]);
      if (gif.code !== 0) throw new Error(`ffmpeg could not write ${path.basename(file)}: ${lastLine(gif.stderr)}`);
      const head = fs.readFileSync(file).subarray(0, 10);
      last = { width: head.readUInt16LE(6), height: head.readUInt16LE(8), fps, bytes: fs.statSync(file).size };
      if (last.bytes <= budget) return last;
    }
    return { ...last, overBudget: true };
  } finally {
    fs.rmSync(palette, { force: true });
  }
}

module.exports = { findFfmpeg, pickEncoder, startVideo, makeGif, run, MISSING, GIF_TRIES };
