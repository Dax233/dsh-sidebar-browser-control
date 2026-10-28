/**
 * Sidebar Agent Browser — Host half.
 *
 * Registers the `browser` tool the model drives, and a loopback bridge that
 * delivers each tool action to the Client half, which owns the sidebar webview
 * (leased through the desktop shell) and performs real input dispatch and
 * in-page cursor rendering.
 *
 * The HTTP contract lives in ./bridge.js so it is unit-testable without a Host;
 * the local preview server lives in ./lib/preview.js for the same reason.
 *
 * Platform facts this half is built around (see research/feedback-triage-2026-10-26.md):
 * - the shell only admits http(s) frame navigation and cancels file: requests,
 *   so local previews go through ./lib/preview.js or setContent;
 * - there is no CDP from a renderer-side <webview>, so real DPR / device
 *   metrics emulation does not exist and is not faked;
 * - offscreen/headless rendering is not available to a plugin.
 */
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { createBridge } from "./bridge.js";
import { createPreviewServer } from "./lib/preview.js";

export const name = "sidebar-browser-control";
export const inject = ["tools"];

const PORT = Number(process.env.DSH_BROWSER_CONTROL_PORT ?? 47834);
const TOKEN = process.env.DSH_BROWSER_CONTROL_TOKEN ?? "dsh-browser-control-local";
const STATE_FILE = process.env.DSH_BROWSER_CONTROL_STATE ?? join(tmpdir(), "dsh-browser-control-state.json");
const COMMAND_TIMEOUT_MS = Number(process.env.DSH_BROWSER_CONTROL_COMMAND_TIMEOUT_MS ?? 25_000);
const QA_COMMAND_TIMEOUT_MS = Number(process.env.DSH_BROWSER_CONTROL_QA_TIMEOUT_MS ?? 120_000);
// fullPage screenshots scroll-stitch many viewport captures; on real external
// pages this can legitimately run long, so the outgoing command gets its own
// long bridge timeout (the client additionally bounds every internal step and
// carries a 60s total budget so this mostly protects slow stitches).
const FULLPAGE_SCREENSHOT_TIMEOUT_MS = Number(process.env.DSH_BROWSER_CONTROL_FULLPAGE_TIMEOUT_MS ?? 120_000);
const SHOT_DIR = process.env.DSH_BROWSER_CONTROL_SHOT_DIR ?? join(tmpdir(), "dsh-browser-shots");

const MAX_EVALUATE_BYTES = 16 * 1024;
const MAX_SET_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_QA_VARIANTS = 6;
const QA_DEFAULT_WIDTHS = [1280, 768, 375];
const QA_DEFAULT_THEMES = ["light", "dark"];
const SCREENSHOT_FORMATS = ["png", "jpeg"];
const COLOR_SCHEMES = ["light", "dark", "auto"];
const SCROLL_BLOCKS = ["start", "center", "end", "nearest"];

const ACTIONS = [
  "open",
  "navigate",
  "snapshot",
  "click",
  "type",
  "key",
  "scroll",
  "scrollIntoView",
  "wait",
  "status",
  "screenshot",
  "viewport",
  "evaluate",
  "metrics",
  "logs",
  "emulate",
  "setContent",
  "preview",
  "qa",
  "close",
];
const CLIENT_FRESH_MS = 60_000;

const DESCRIPTION =
  "Drive the Agent Browser in the DSH sidebar: a real Chromium webview that the user can watch, with a visible agent cursor that never moves the user's mouse. " +
  "Workflow: action=open with a URL (opens recovers once from a stale never-ready panel by remounting; still failing asks for close/open), then action=snapshot to read the page (visible interactive elements get refs), then action=click/type by ref; call snapshot again after each action that changes the page. Refs are only valid for the most recent snapshot. " +
  "QA actions: viewport {width,height,reset,scrollbars} sets the real CSS viewport (the panel scales to fit), optionally hides the page scrollbars, and reports actual innerWidth/innerHeight + contentWidth (classic scrollbar note), evaluate {expression} returns JSON, metrics {selectors,includeOverflow} reports layout/image/font/console numbers, wait {selector,text,networkIdle,idleMs,images,fonts,ms} polls in-page, scroll/scrollIntoView report exact positions, logs {clear,filter,limit} shows console + failed-image probes, screenshot {fullPage,clip,ref,selector,format,quality,path,hideCursor} saves PNG/JPEG evidence (fullPage scroll-stitches viewport captures with per-stage diagnostics and step timeouts, then reports timings; a taller-than-viewport element is scroll-stitched instead of clipped; fixed/sticky elements may repeat), emulate {colorScheme} applies a best-effort light/dark preference with a DOM fallback for native <picture>/<source media> and <link media> (including open shadow roots), setContent {html,baseUrl} renders self-contained HTML, preview {dir,file,port} serves a local directory over a tokenized 127.0.0.1 URL, qa {url,widths,themes,...} runs a width x theme matrix in one call, close releases the panel, status merges bridge + panel state and its JSON exposes the attempted open/navigate URL, the guest's last load failure (lastLoadFailure) and (in DSH Desktop) the blocked DSH Host origin so the shell isolation can be predicted instead of hit. " +
  "Boundaries: only http(s) navigation — file:// is blocked by the desktop shell (use setContent or preview); the desktop shell also isolates the Agent Browser from the DSH Host itself — loading the Host's own origin (any loopback hostname on the Host's port) is refused with a policy error instead of a bare ERR_FAILED (-2); use setContent/preview for local content, or a separate standalone 'dsh web' instance to inspect the GUI; deviceScaleFactor/DPR cannot be emulated (no CDP from a renderer <webview>) and screenshots report their real pixel size instead; emulate is best-effort (matchMedia shim + same-origin media-rule rewrite; cross-origin stylesheets cannot be patched); there is no offscreen/CI mode — qa runs in the visible panel. Screenshots save to disk; call read_image with the returned path. Coordinates are CSS pixels inside the page viewport.";

function requireHttpUrl(raw, field) {
  if (typeof raw !== "string" || raw.trim() === "") throw new Error(`browser: ${field} is required`);
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`browser: ${field} is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`browser: ${field} must use http:// or https://, got ${url.protocol}//`);
  }
  return url.href;
}

function numberInRange(raw, field, min, max, fallback) {
  const value = raw === undefined || raw === null || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`browser: ${field} must be a number`);
  if (value < min || value > max) throw new Error(`browser: ${field} must be between ${min} and ${max}`);
  return Math.round(value);
}

/** Normalize a list of non-empty unique strings (selector lists). */
function uniqueStrings(raw, field, maxEntries) {
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of list) {
    if (typeof item !== "string" || item.trim() === "") throw new Error(`browser: ${field} entries must be non-empty strings`);
    const value = item.trim();
    if (!out.includes(value)) out.push(value);
    if (out.length > maxEntries) throw new Error(`browser: ${field} supports at most ${maxEntries} entries`);
  }
  if (out.length === 0) throw new Error(`browser: ${field} must not be empty`);
  return out;
}

function clampClip(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("browser: screenshot clip must be an object like {x,y,width,height}");
  }
  const clip = {};
  for (const key of ["x", "y", "width", "height"]) {
    const fallback = key === "x" || key === "y" ? 0 : undefined;
    const value = raw[key] === undefined ? fallback : Number(raw[key]);
    if (!Number.isFinite(value)) throw new Error(`browser: screenshot clip.${key} must be a number`);
    if ((key === "width" || key === "height") && value <= 0) throw new Error(`browser: screenshot clip.${key} must be positive`);
    clip[key] = Math.round(value);
  }
  return clip;
}

/**
 * Build the qa plan (pure, test-friendly): width x theme matrix, guarded by the
 * variant cap so a single tool call cannot silently run for minutes.
 */
function buildQaPlan(args) {
  const url = requireHttpUrl(args.url, "url");
  let widths;
  if (args.widths === undefined || args.widths === null) {
    widths = [...QA_DEFAULT_WIDTHS];
  } else {
    if (!Array.isArray(args.widths) || args.widths.length === 0) throw new Error("browser: qa widths must be a non-empty array of numbers");
    widths = [...new Set(args.widths.map((value) => numberInRange(value, "qa widths", 64, 10000)))];
  }
  let themes;
  if (args.themes === undefined || args.themes === null) {
    themes = [...QA_DEFAULT_THEMES];
  } else {
    if (!Array.isArray(args.themes) || args.themes.length === 0) throw new Error("browser: qa themes must be a non-empty array");
    themes = [];
    for (const value of args.themes) {
      const theme = String(value);
      if (!COLOR_SCHEMES.includes(theme)) throw new Error(`browser: qa themes must be one of ${COLOR_SCHEMES.join(", ")}`);
      if (!themes.includes(theme)) themes.push(theme);
    }
  }
  const maxVariants =
    args.maxVariants === undefined || args.maxVariants === null ? MAX_QA_VARIANTS : numberInRange(args.maxVariants, "qa maxVariants", 1, MAX_QA_VARIANTS);
  const variantCount = widths.length * themes.length;
  if (variantCount > maxVariants) {
    throw new Error(`browser: qa would capture ${variantCount} variants but maxVariants is ${maxVariants} (hard cap ${MAX_QA_VARIANTS}); reduce widths/themes`);
  }
  const height = args.height === undefined || args.height === null ? 800 : numberInRange(args.height, "qa height", 100, 10000);
  let outDir;
  if (args.outDir === undefined || args.outDir === null || args.outDir === "") {
    outDir = join(SHOT_DIR, `qa-${Date.now()}`);
  } else {
    const raw = String(args.outDir);
    outDir = isAbsolute(raw) ? raw : join(SHOT_DIR, raw);
  }
  const selectors = args.selectors === undefined || args.selectors === null ? [] : uniqueStrings(args.selectors, "qa selectors", 20);
  const scrollbars = args.scrollbars === undefined || args.scrollbars === null ? "auto" : String(args.scrollbars);
  if (scrollbars !== "auto" && scrollbars !== "hidden") {
    throw new Error(`browser: qa scrollbars must be "auto" or "hidden"`);
  }
  return {
    type: "qa",
    url,
    widths,
    themes,
    height,
    fullPage: args.fullPage === true,
    scrollbars,
    maxVariants,
    outDir,
    selectors,
    variants: widths.flatMap((width) => themes.map((theme) => ({ width, theme }))),
  };
}

/** Translate one tool call into the command the Client half executes. */
function toCommand(action, args) {
  switch (action) {
    case "open":
      return { type: "open", url: requireHttpUrl(args.url, "url") };
    case "navigate":
      return { type: "navigate", url: requireHttpUrl(args.url, "url") };
    case "snapshot":
      return { type: "snapshot" };
    case "close":
      return { type: "close" };
    case "status":
      return { type: "status" };
    case "click": {
      if (args.ref !== undefined && args.ref !== null) return { type: "click", ref: String(args.ref) };
      if (!Number.isFinite(Number(args.x)) || !Number.isFinite(Number(args.y))) {
        throw new Error("browser: click requires a snapshot ref or x and y coordinates");
      }
      return { type: "click", x: Number(args.x), y: Number(args.y) };
    }
    case "type": {
      if (typeof args.text !== "string") throw new Error("browser: type requires text");
      const command = { type: "type", text: args.text };
      if (args.ref !== undefined && args.ref !== null) command.ref = String(args.ref);
      return command;
    }
    case "key": {
      if (typeof args.key !== "string" || args.key === "") throw new Error("browser: key requires a key name such as Enter or Tab");
      return { type: "key", key: args.key };
    }
    case "screenshot": {
      const command = { type: "screenshot" };
      const format = args.format === undefined || args.format === null ? "png" : String(args.format).toLowerCase();
      if (!SCREENSHOT_FORMATS.includes(format)) throw new Error(`browser: screenshot format must be one of ${SCREENSHOT_FORMATS.join(", ")}`);
      command.format = format;
      if (args.quality !== undefined && args.quality !== null) {
        command.quality = numberInRange(args.quality, "screenshot quality", 1, 100);
      }
      if (args.path !== undefined && args.path !== null) {
        const path = String(args.path);
        if (path === "" || !isAbsolute(path)) throw new Error("browser: screenshot path must be an absolute file path");
        command.path = path;
      }
      command.hideCursor = args.hideCursor !== false;
      if (args.fullPage === true) command.fullPage = true;
      if (args.clip !== undefined && args.clip !== null) command.clip = clampClip(args.clip);
      if (args.ref !== undefined && args.ref !== null) command.ref = String(args.ref);
      if (typeof args.selector === "string" && args.selector.trim() !== "") command.selector = args.selector.trim();
      if (command.fullPage === true && (command.clip !== undefined || command.ref !== undefined || command.selector !== undefined)) {
        throw new Error("browser: screenshot fullPage cannot be combined with clip, ref or selector");
      }
      return command;
    }
    case "viewport": {
      if (args.reset === true) return { type: "viewport", reset: true };
      if (args.width === undefined || args.width === null) throw new Error("browser: viewport requires width (or reset:true)");
      const scrollbars = args.scrollbars === undefined || args.scrollbars === null ? undefined : String(args.scrollbars);
      if (scrollbars !== undefined && scrollbars !== "auto" && scrollbars !== "hidden") {
        throw new Error(`browser: viewport scrollbars must be "auto" or "hidden"`);
      }
      return {
        type: "viewport",
        width: numberInRange(args.width, "viewport width", 64, 10000),
        height: numberInRange(args.height, "viewport height", 64, 10000, 800),
        ...(scrollbars === undefined ? {} : { scrollbars }),
      };
    }
    case "evaluate": {
      if (typeof args.expression !== "string" || args.expression.trim() === "") throw new Error("browser: evaluate requires a non-empty expression");
      return { type: "evaluate", expression: args.expression };
    }
    case "metrics": {
      const command = { type: "metrics", includeOverflow: args.includeOverflow !== false };
      if (args.selectors !== undefined && args.selectors !== null) command.selectors = uniqueStrings(args.selectors, "metrics selectors", 20);
      return command;
    }
    case "wait": {
      const command = { type: "wait" };
      const selector = typeof args.selector === "string" && args.selector.trim() !== "" ? args.selector.trim() : undefined;
      const text = typeof args.text === "string" && args.text !== "" ? args.text : undefined;
      const networkIdle = args.networkIdle === true;
      const images = args.images === true;
      const fonts = args.fonts === true;
      const idleMs = args.idleMs === undefined || args.idleMs === null ? 500 : Number(args.idleMs);
      if (!Number.isFinite(idleMs) || idleMs < 0 || idleMs > 60_000) throw new Error("browser: wait idleMs must be between 0 and 60000");
      const ms = args.ms === undefined || args.ms === null ? undefined : Number(args.ms);
      if (ms !== undefined && (!Number.isFinite(ms) || ms < 0 || ms > 120_000)) throw new Error("browser: wait ms must be between 0 and 120000");
      const conditional = selector !== undefined || text !== undefined || networkIdle || images || fonts;
      if (!conditional) {
        // Old behaviour: a plain sleep. Keep the same default so existing
        // prompts keep working.
        command.ms = ms === undefined ? 500 : Math.round(ms);
        return command;
      }
      if (selector !== undefined) command.selector = selector;
      if (text !== undefined) command.text = text;
      if (networkIdle) {
        command.networkIdle = true;
        command.idleMs = Math.round(idleMs);
      }
      if (images) command.images = true;
      if (fonts) command.fonts = true;
      command.ms = ms === undefined ? 8000 : Math.round(ms);
      return command;
    }
    case "scroll": {
      const deltaY = Number(args.deltaY ?? 400);
      if (!Number.isFinite(deltaY)) throw new Error("browser: scroll requires a numeric deltaY");
      const command = { type: "scroll", deltaY };
      if (args.ref !== undefined && args.ref !== null) command.ref = String(args.ref);
      return command;
    }
    case "scrollIntoView": {
      const ref = args.ref !== undefined && args.ref !== null ? String(args.ref) : undefined;
      const selector = typeof args.selector === "string" && args.selector.trim() !== "" ? args.selector.trim() : undefined;
      if (ref === undefined && selector === undefined) throw new Error("browser: scrollIntoView requires a ref or selector");
      const block = args.block === undefined || args.block === null ? "center" : String(args.block);
      if (!SCROLL_BLOCKS.includes(block)) throw new Error(`browser: scrollIntoView block must be one of ${SCROLL_BLOCKS.join(", ")}`);
      return { type: "scrollIntoView", ...(ref === undefined ? {} : { ref }), ...(selector === undefined ? {} : { selector }), block };
    }
    case "logs": {
      const command = {
        type: "logs",
        clear: args.clear === true,
        limit: numberInRange(args.limit, "logs limit", 1, 200, 50),
      };
      if (typeof args.filter === "string" && args.filter !== "") command.filter = args.filter;
      return command;
    }
    case "emulate": {
      const colorScheme = args.colorScheme === undefined || args.colorScheme === null ? undefined : String(args.colorScheme);
      if (!COLOR_SCHEMES.includes(colorScheme)) throw new Error(`browser: emulate colorScheme must be one of ${COLOR_SCHEMES.join(", ")}`);
      return { type: "emulate", colorScheme };
    }
    case "setContent": {
      if (typeof args.html !== "string") throw new Error("browser: setContent requires html");
      const bytes = Buffer.byteLength(args.html, "utf8");
      if (bytes > MAX_SET_CONTENT_BYTES) throw new Error(`browser: setContent html is ${bytes} bytes; the limit is ${MAX_SET_CONTENT_BYTES} bytes`);
      const command = { type: "setContent", html: args.html };
      if (args.baseUrl !== undefined && args.baseUrl !== null) command.baseUrl = requireHttpUrl(args.baseUrl, "baseUrl");
      return command;
    }
    case "preview": {
      if (typeof args.dir !== "string" || args.dir.trim() === "") throw new Error("browser: preview requires dir");
      // A Host-process relative path would resolve against the DSH install
      // directory, not the session workspace, so require an explicit absolute
      // directory (the agent knows the workspace path).
      if (!isAbsolute(args.dir.trim())) throw new Error("browser: preview dir must be an absolute directory path");
      const command = { type: "preview", dir: args.dir.trim() };
      if (args.file !== undefined && args.file !== null) {
        if (typeof args.file !== "string" || args.file.trim() === "") throw new Error("browser: preview file must be a non-empty path");
        command.file = args.file.trim();
      }
      if (args.port !== undefined && args.port !== null) {
        const port = Number(args.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("browser: preview port must be an integer between 1 and 65535");
        command.port = port;
      }
      return command;
    }
    case "qa":
      return buildQaPlan(args);
    default:
      throw new Error(`browser: unknown action "${String(action)}"`);
  }
}

function formatSnapshot(value) {
  const snapshot = value.snapshot ?? {};
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
  const lines = [];
  lines.push(`title: ${String(snapshot.title ?? "")}`);
  lines.push(`url: ${String(snapshot.url ?? "")}`);
  const viewport = snapshot.viewport ?? {};
  const scroll = snapshot.scroll ?? {};
  const pagesBelow = Number(scroll.pagesBelow ?? 0);
  lines.push(
    `viewport: ${viewport.w}x${viewport.h} scrollY=${viewport.scrollY ?? 0}` +
      (pagesBelow > 0 ? ` (~${pagesBelow} page(s) below)` : ""),
  );
  const skipped = Number(snapshot.skipped ?? 0);
  const omitted = Number(snapshot.omitted ?? 0);
  const details = [];
  if (skipped > 0) details.push(`${skipped} hidden skipped`);
  if (omitted > 0) details.push(`${omitted} over limit`);
  lines.push(`elements (${elements.length}${details.length > 0 ? `, ${details.join(", ")}` : ""}):`);
  const MAX_LINES = 80;
  for (const element of elements.slice(0, MAX_LINES)) {
    const depth = Math.max(0, Math.min(Number(element.depth ?? 0), 8));
    const ref = element.ref !== undefined && element.ref !== null ? `[${element.ref}] ` : "— ";
    const role = String(element.role ?? element.tag ?? "?");
    const text = String(element.text ?? "").replace(/\s+/g, " ").slice(0, 90);
    const href = element.href ? ` -> ${String(element.href).slice(0, 120)}` : "";
    const pos = Number.isFinite(Number(element.x)) ? ` @${element.x},${element.y}` : "";
    const value = element.value === undefined ? "" : ` = ${JSON.stringify(String(element.value))}`;
    const checked = element.checked === true ? " [checked]" : "";
    lines.push(`${"  ".repeat(1 + depth)}${ref}${role} "${text}"${pos}${value}${checked}${href}`);
  }
  if (elements.length > MAX_LINES) {
    lines.push(`  ... ${elements.length - MAX_LINES} more in this snapshot; scroll or narrow the page`);
  }
  if (omitted > 0) {
    lines.push(`  ... ${omitted} more elements not shown (limit reached); action=scroll then snapshot again`);
  }
  if (pagesBelow > 0) {
    lines.push(`  scroll: about ${pagesBelow} viewport(s) below; action=scroll with deltaY, then snapshot again`);
  }
  lines.push("Refs are valid only for this snapshot; call snapshot again after the page changes.");
  return lines.join("\n");
}

/** Parse PNG or JPEG pixel dimensions from the saved bytes (authoritative size). */
function parseImageSize(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24) return undefined;
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A, then IHDR with width/height at 16/20.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    if (bytes.toString("ascii", 12, 16) !== "IHDR") return undefined;
    return { format: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  // JPEG: walk segments to the first SOFn marker (which carries the size).
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      let marker = bytes[offset + 1];
      while (marker === 0xff) {
        offset += 1;
        marker = bytes[offset + 1];
      }
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) return undefined;
      const length = bytes.readUInt16BE(offset);
      if (length < 2) return undefined;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        if (offset + 7 > bytes.length) return undefined;
        return { format: "jpeg", height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
      }
      offset += length;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Persist a captured data URL. `options.path` (absolute) wins; otherwise the
 * file lands in the shot directory with a collision-safe name.
 */
function saveScreenshot(dataUrl, options = {}) {
  const match = /^data:image\/(png|jpeg|webp);base64,(.+)$/u.exec(String(dataUrl ?? ""));
  if (match === null) throw new Error("browser: screenshot returned an unsupported data URL");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0) throw new Error("browser: screenshot image is empty");
  const format = match[1];
  const extension = format === "jpeg" ? "jpg" : format;
  let file;
  if (typeof options.path === "string" && options.path !== "") {
    if (!isAbsolute(options.path)) throw new Error("browser: screenshot path must be absolute");
    file = options.path;
  } else if (typeof options.dir === "string" && typeof options.name === "string") {
    file = join(options.dir, `${options.name}.${extension}`);
  } else {
    mkdirSync(SHOT_DIR, { recursive: true });
    const base = typeof options.name === "string" && options.name !== "" ? options.name : `sidebar-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    file = join(SHOT_DIR, `${base}.${extension}`);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  const size = parseImageSize(bytes);
  return { file, bytes: bytes.length, format, width: size?.width, height: size?.height };
}

/** JSON-stringify a page value with a hard byte budget (evaluate receipts). */
function truncateJson(value, maxBytes = MAX_EVALUATE_BYTES) {
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = "null";
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false, bytes, limit: maxBytes };
  let cut = text.slice(0, maxBytes);
  while (cut.length > 0 && Buffer.byteLength(cut, "utf8") > maxBytes) {
    cut = cut.slice(0, Math.floor(cut.length * 0.9));
  }
  return {
    text: `${cut}\n… (truncated: result is ${bytes} bytes, limit ${maxBytes} bytes)`,
    truncated: true,
    bytes,
    limit: maxBytes,
  };
}

function formatMetrics(value) {
  const metrics = value.metrics ?? {};
  const viewport = metrics.viewport ?? {};
  const viewportDocument = metrics.document ?? {};
  const images = metrics.images ?? {};
  const fonts = metrics.fonts ?? {};
  const consoleInfo = metrics.console ?? {};
  const lines = [];
  lines.push(
    `metrics: ${String(metrics.title ?? "")} ${String(metrics.url ?? "")}`.trim(),
  );
  lines.push(
    `viewport: ${viewport.width ?? "?"}x${viewport.height ?? "?"} dpr=${viewport.devicePixelRatio ?? "?"}` +
      (Number.isFinite(Number(viewport.scrollY)) ? ` scrollY=${viewport.scrollY}` : ""),
  );
  lines.push(
    `document: ${viewportDocument.scrollWidth ?? "?"}x${viewportDocument.scrollHeight ?? "?"}` +
      (Number.isFinite(Number(viewportDocument.contentWidth)) ? ` (content width ${viewportDocument.contentWidth})` : ""),
  );
  const overflow = Array.isArray(metrics.overflow) ? metrics.overflow : [];
  const overflowCount = Number(metrics.overflowCount ?? overflow.length);
  if (overflowCount > 0) {
    lines.push(`overflow: ${overflowCount} element(s) wider than the viewport`);
    for (const item of overflow.slice(0, 8)) {
      lines.push(`  ${String(item.selector ?? item.tag ?? "?")} right=${item.right ?? "?"} (+${item.overshoot ?? "?"})`);
    }
  } else {
    lines.push("overflow: none");
  }
  lines.push(
    `images: ${images.total ?? 0} total, ${images.loaded ?? 0} loaded, ${images.failed ?? 0} failed` +
      (Array.isArray(images.failedSrc) && images.failedSrc.length > 0 ? ` (${images.failedSrc.slice(0, 6).join(", ")})` : ""),
  );
  lines.push(`fonts: ${fonts.status ?? "unknown"}${Number.isFinite(Number(fonts.size)) ? ` (${fonts.size} faces)` : ""}`);
  lines.push(`console: ${consoleInfo.errors ?? 0} error(s), ${consoleInfo.warnings ?? 0} warning(s) since panel mount`);
  const selectors = Array.isArray(metrics.selectors) ? metrics.selectors : [];
  if (selectors.length > 0) {
    lines.push("selectors:");
    for (const item of selectors) {
      if (!item || item.found !== true) {
        lines.push(`  ${String(item?.selector ?? "?")}: not found`);
        continue;
      }
      const rect = item.rect ?? {};
      const natural = item.natural ? ` natural ${item.natural.width}x${item.natural.height}` : "";
      lines.push(
        `  ${String(item.selector)}: ${rect.width ?? "?"}x${rect.height ?? "?"} @${rect.x ?? "?"},${rect.y ?? "?"}${natural}` +
          (item.display ? ` display=${item.display}` : ""),
      );
    }
  }
  return lines.join("\n");
}

function formatLogs(value) {
  const lines = [];
  if (Number(value.clearedCount) > 0) lines.push(`logs: cleared ${value.clearedCount} buffered entr${value.clearedCount === 1 ? "y" : "ies"}`);
  const entries = Array.isArray(value.entries) ? value.entries : [];
  const filter = typeof value.filter === "string" && value.filter !== "" ? ` filter="${value.filter}"` : "";
  lines.push(`logs: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}${filter} (buffer ${value.bufferSize ?? "?"}/${value.bufferLimit ?? 200} total ${value.totalSeen ?? "?"})`);
  for (const entry of entries.slice(0, 40)) {
    const level = String(entry.level ?? "info");
    const source = entry.source ? ` ${String(entry.source).slice(-120)}:${entry.line ?? 0}` : "";
    lines.push(`  [${level}] ${String(entry.message ?? "").slice(0, 500)}${source}`);
  }
  if (entries.length > 40) lines.push(`  ... ${entries.length - 40} more`);
  const probe = value.probe ?? {};
  const failedImages = Array.isArray(probe.failedImages) ? probe.failedImages : [];
  if (failedImages.length > 0) {
    lines.push(`failed images (${failedImages.length}):`);
    for (const image of failedImages.slice(0, 10)) lines.push(`  ${String(image.src ?? "").slice(0, 240)}`);
  }
  const resources = Array.isArray(probe.resources) ? probe.resources : [];
  if (resources.length > 0) {
    lines.push(`resource entries (${resources.length}${probe.resourceCount !== undefined ? ` of ${probe.resourceCount}` : ""}; no HTTP status is observable from a renderer webview — sizes/timings only):`);
    for (const resource of resources.slice(0, 10)) {
      lines.push(`  ${String(resource.initiatorType ?? "?")} ${String(resource.name ?? "").slice(0, 200)} (${resource.duration ?? "?"}ms, transfer ${resource.transferSize ?? "?"}B)`);
    }
  }
  if (entries.length === 0 && failedImages.length === 0 && resources.length === 0) {
    lines.push("no console output and no failed images/resources observed since the panel was mounted");
  }
  return lines.join("\n");
}

function formatQaResult(plan, variants) {
  const lines = [];
  lines.push(`qa: ${plan.url}`);
  lines.push(
    `variants: ${variants.length} (widths ${plan.widths.join(",")}; themes ${plan.themes.join(",")}; height ${plan.height}` +
      `${plan.fullPage ? "; fullPage" : ""}${plan.scrollbars === "hidden" ? "; scrollbars hidden" : ""}` +
      `${plan.selectors.length > 0 ? `; selectors ${plan.selectors.length}` : ""})`,
  );
  lines.push(`output: ${plan.outDir}`);
  lines.push("");
  lines.push("width | theme | viewport | content | doc(w x h) | overflow | images(failed/total) | fonts | console(e/w) | file");
  for (const variant of variants) {
    const metrics = variant.metrics ?? {};
    const viewport = metrics.viewport ?? {};
    const documentInfo = metrics.document ?? {};
    const images = metrics.images ?? {};
    const fonts = metrics.fonts ?? {};
    const consoleInfo = metrics.console ?? {};
    lines.push(
      [
        String(variant.width),
        String(variant.theme),
        `${viewport.width ?? "?"}x${viewport.height ?? "?"}`,
        Number.isFinite(Number(documentInfo.contentWidth)) ? String(documentInfo.contentWidth) : "?",
        `${documentInfo.scrollWidth ?? "?"}x${documentInfo.scrollHeight ?? "?"}`,
        String(metrics.overflowCount ?? 0),
        `${images.failed ?? 0}/${images.total ?? 0}`,
        String(fonts.status ?? "?"),
        `${consoleInfo.errors ?? 0}/${consoleInfo.warnings ?? 0}`,
        `${basename(String(variant.screenshot ?? ""))} (${variant.screenshotWidth ?? "?"}x${variant.screenshotHeight ?? "?"} px, ${variant.bytes ?? "?"} B)`,
      ].join(" | "),
    );
  }
  lines.push("");
  lines.push("screenshots:");
  for (const variant of variants) lines.push(`  ${variant.width}x${plan.height} ${variant.theme}: ${variant.screenshot}`);
  return lines.join("\n");
}

/** Pure notes builder for screenshot receipts (testable without a client). */
function buildScreenshotNotes(value) {
  const notes = [];
  if (value.fullPage !== undefined) {
    const fullPage = value.fullPage ?? {};
    const timings = fullPage.timings ?? {};
    notes.push(
      `full page: ${fullPage.stitched === true ? `stitched ${fullPage.segments ?? "?"} viewport capture(s), ` : ""}captured ${
        fullPage.capturedHeight ?? "?"
      } of ${fullPage.requestedHeight ?? "?"} CSS px` +
        (fullPage.capped === true ? " (capped at 12000; scroll and capture again for the rest)" : "") +
        (fullPage.scrollbarsHidden === true ? "; page scrollbars hidden during capture" : "") +
        (fullPage.stitched === true ? "; position:fixed/sticky elements may repeat in the stitched image" : "") +
        (Number.isFinite(Number(timings.totalMs)) ? `; took ${timings.totalMs}ms across ${timings.segments ?? fullPage.segments ?? "?"} segment(s)` : ""),
    );
  }
  if (value.mode === "element") {
    const element = value.element ?? {};
    notes.push("element capture");
    if (element.stitched === true) {
      notes.push(
        `stitched ${element.segments ?? "?"} scroll capture(s) for the element's full height (${element.capturedHeight ?? "?"}${
          element.capped === true ? " capped" : ""
        } of ${element.fullHeight ?? "?"} CSS px)` +
          (Number(element.croppedWidth ?? 0) > 0 ? `; ${element.croppedWidth}px beyond the viewport width were cropped` : "") +
          (element.scrollbarsHidden === true ? "; page scrollbars hidden during capture" : ""),
      );
    } else if (element.clippedToViewport === true) {
      notes.push("clipped to the viewport element box");
    }
  } else if (value.mode === "clip") notes.push("clip capture");
  if (Number.isFinite(Number(value.devicePixelRatio))) notes.push(`devicePixelRatio ${value.devicePixelRatio} (not emulated)`);
  return notes;
}

/**
 * Extra receipt notes for open/navigate results (0.2.11): the URL that was
 * actually requested when the guest resolved somewhere else, and a warning
 * when the guest landed on Chromium's error page instead of the content.
 */
function loadReceiptNotes(value) {
  const notes = [];
  const attemptedUrl = value.attemptedUrl;
  if (typeof attemptedUrl === "string" && attemptedUrl !== "" && attemptedUrl !== value.url) {
    notes.push(`requested ${attemptedUrl}`);
  }
  const failure = value.loadFailure;
  if (value.loaded === false && failure !== undefined && failure !== null) {
    notes.push(
      `warning: the guest could not load this URL (${failure.errorDescription ?? failure.errorCode}${
        failure.errorCode !== undefined ? ` (${failure.errorCode})` : ""
      }); the panel shows Chromium's error page (see action=status lastLoadFailure)`,
    );
  }
  return notes;
}

function formatResult(action, value) {
  switch (action) {
    case "open": {
      const notes = loadReceiptNotes(value);
      return `opened ${String(value.url ?? "")}${value.title ? ` (${value.title})` : ""}${
        notes.length > 0 ? ` — ${notes.join(" — ")}` : ""
      }`;
    }
    case "navigate": {
      const notes = loadReceiptNotes(value);
      return `navigated to ${String(value.url ?? "")}${value.title ? ` (${value.title})` : ""}${
        notes.length > 0 ? ` — ${notes.join(" — ")}` : ""
      }`;
    }
    case "snapshot":
      return formatSnapshot(value);
    case "click":
      return `clicked ${value.label ? `"${String(value.label).slice(0, 60)}" ` : ""}at (${value.x},${value.y})${
        value.navigated ? ` — page changed to ${String(value.url ?? "")}` : ""
      }${value.hitTrusted === false ? " — warning: the target appears covered by another element; take a snapshot and try a coordinate click" : ""}${
        value.navigated !== true && value.changed === false && value.settle?.settled !== false
          ? " — no observable change; the target may be covered or inert (check the snapshot, or try a coordinate click)"
          : ""
      }`;
    case "type":
      return `typed ${JSON.stringify(String(value.typed ?? ""))}${
        typeof value.value === "string" && value.value !== "" ? ` (focused value: ${JSON.stringify(value.value.slice(0, 120))})` : ""
      }`;
    case "key":
      return `pressed ${String(value.key ?? "")}`;
    case "scroll": {
      const requested = Number(value.requestedDelta ?? value.deltaY ?? 0);
      const parts = [`requested ${requested}px`];
      if (Number.isFinite(Number(value.actualDelta))) parts.push(`actual ${value.actualDelta}px`);
      if (typeof value.scrollY === "number") {
        parts.push(
          `scrollY ${value.scrollY}` +
            (typeof value.scrollHeight === "number" ? ` / ${value.scrollHeight}` : "") +
            (typeof value.innerHeight === "number" ? ` (viewport ${value.innerHeight})` : ""),
        );
      }
      const notes = [];
      if (value.clamped === true) notes.push("clamped at document edge");
      if (value.method === "script") notes.push("[script fallback]");
      return `scrolled ${parts.join(", ")}${notes.length > 0 ? ` — ${notes.join(" ")}` : ""}`;
    }
    case "scrollIntoView": {
      const target = value.target ?? {};
      // label/ref are top-level in the client result; accept the nested form too.
      const labelText = value.label ?? target.label;
      const label = labelText ? `"${String(labelText).slice(0, 60)}" ` : "";
      const ref = target.ref ? `[${target.ref}] ` : "";
      return (
        `scrolled into view ${ref}${label}`.trimEnd() +
        (typeof value.scrollY === "number" ? ` — scrollY ${value.scrollY}` : "") +
        (typeof value.scrollHeight === "number" ? ` / ${value.scrollHeight}` : "") +
        (typeof value.innerHeight === "number" ? ` (viewport ${value.innerHeight})` : "") +
        (value.inViewport === false ? " — warning: target is still outside the viewport" : "")
      );
    }
    case "wait": {
      const notes = [];
      const conditions = value.conditions ?? {};
      if (conditions.selector === true) notes.push("selector found");
      if (conditions.text === true) notes.push("text found");
      if (conditions.networkIdle === true) notes.push("network idle");
      if (conditions.images === true) notes.push("images complete");
      if (conditions.fonts === true) notes.push("fonts loaded");
      return `waited ${String(value.waitedMs ?? "")}ms${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
    }
    case "viewport": {
      const actual = value.actual ?? {};
      const dpr = actual.devicePixelRatio ?? value.devicePixelRatio ?? "?";
      const warning =
        value.matched === false
          ? ` — warning: the guest viewport did not settle to the requested size within ${value.settledMs ?? "?"}ms (actual ${actual.innerWidth ?? "?"}x${actual.innerHeight ?? "?"})`
          : "";
      const contentWidth = Number(actual.contentWidth ?? value.contentWidth);
      const plainScrollbar =
        Number.isFinite(contentWidth) && contentWidth > 0 && Number(actual.innerWidth) > contentWidth
          ? `; content width ${contentWidth} (innerWidth is larger by ${Number(actual.innerWidth) - contentWidth}px: classic scrollbar)`
          : "";
      if (value.reset === true) {
        return `viewport reset to panel size: ${actual.innerWidth ?? value.width ?? "?"}x${actual.innerHeight ?? value.height ?? "?"} (devicePixelRatio ${dpr})${plainScrollbar}${warning}`;
      }
      const scrollbarsNote =
        value.scrollbars === "hidden"
          ? `; page scrollbars hidden${
              Number.isFinite(contentWidth) && contentWidth > 0
                ? ` (content width ${contentWidth} == viewport width; restored by viewport reset or action=close)`
                : " (restored by viewport reset or action=close)"
            }`
          : "";
      return (
        `viewport: ${value.width}x${value.height} requested; actual ${actual.innerWidth ?? "?"}x${actual.innerHeight ?? "?"}` +
        ` (devicePixelRatio ${dpr})` +
        (Number.isFinite(Number(value.scale)) ? `; panel scale ${Number(value.scale).toFixed(3)}` : "") +
        plainScrollbar +
        scrollbarsNote +
        `; settled in ${value.settledMs ?? "?"}ms` +
        warning +
        " — deviceScaleFactor is not emulated (no CDP); screenshots report real pixels"
      );
    }
    case "evaluate": {
      const truncated = truncateJson(value.result);
      return truncated.truncated
        ? `evaluate result (${truncated.bytes} bytes, truncated to ${truncated.limit}):\n${truncated.text}`
        : `evaluate result:\n${truncated.text}`;
    }
    case "metrics":
      return formatMetrics(value);
    case "logs":
      return formatLogs(value);
    case "emulate": {
      const sheets = value.sheets ?? {};
      const rules = value.mediaRules ?? {};
      const verified = value.verified ?? {};
      const dom = value.dom ?? {};
      const matchHint =
        verified.darkMatches === undefined
          ? ""
          : `; matchMedia check: dark=${String(verified.darkMatches)}, light=${String(verified.lightMatches)}`;
      const domHint =
        value.dom === undefined
          ? ""
          : `; DOM fallback: ${dom.picturesPatched ?? 0} <picture> re-picked, ${dom.linkMediaPatched ?? 0} <link media> normalized, ${dom.restored ?? 0} restored` +
            (dom.limitReached === true ? ` (node scan hit its limit after ${dom.visited ?? "?"} nodes; deep shadow DOMs may be incomplete)` : "");
      return (
        `emulated prefers-color-scheme: ${String(value.scheme ?? "?")} (best-effort, not CDP media emulation)` +
        `; stylesheets ${sheets.scanned ?? "?"} scanned, ${sheets.patched ?? "?"} patched` +
        `${Number(sheets.crossOrigin ?? 0) > 0 ? `, ${sheets.crossOrigin} cross-origin unreadable` : ""}` +
        `; media rules patched ${rules.patched ?? 0}` +
        `${rules.restored !== undefined ? `, restored ${rules.restored}` : ""}` +
        matchHint +
        domHint
      );
    }
    case "setContent": {
      const viewport = value.viewport ?? {};
      const base = value.baseUrl ? `; base ${value.baseUrl}` : "";
      const notes = [];
      if (value.context === "in-place") notes.push("rendered in place of the current page (about:blank navigation was unavailable)");
      if (value.injectedBase === true) notes.push("<base> injected");
      return (
        `setContent: "${String(value.title ?? "")}" in ${value.context === "about:blank" ? "about:blank" : "the current context"}` +
        ` — viewport ${viewport.width ?? "?"}x${viewport.height ?? "?"}${base}` +
        (notes.length > 0 ? ` (${notes.join("; ")})` : "") +
        "; file:// is unavailable in the desktop shell — inline CSS/data: URLs or action=preview for a local directory"
      );
    }
    case "close":
      return value.closed === true ? "browser closed — the sidebar panel was released; action=open reopens it" : "browser close: no panel was open";
    case "status":
      return JSON.stringify(value, null, 2);
    default:
      return `${action}: ok`;
  }
}

export function apply(ctx) {
  const bridge = createBridge({
    port: PORT,
    token: TOKEN,
    stateFile: STATE_FILE,
    pollTimeoutMs: 20_000,
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
    log: (message) => console.warn(`[sidebar-browser-control] ${message}`),
  });
  bridge.start().catch((error) => {
    console.error("[sidebar-browser-control] bridge failed to start", error);
    bridge.writeState({ error: String(error && error.message ? error.message : error) });
  });
  ctx.effect(() => () => bridge.close(), "sidebar-browser-control.bridge");
  const freshClients = () => [...bridge.clients.entries()].filter(([, record]) => Date.now() - record.seenAt < CLIENT_FRESH_MS);

  let previewSession;
  let previewConfig;

  ctx.effect(
    () => () => {
      const session = previewSession;
      previewSession = undefined;
      previewConfig = undefined;
      session?.close?.().catch?.(() => {});
    },
    "sidebar-browser-control.preview",
  );

  /** Give a just-mounted panel a moment to register before reporting failure. */
  async function waitForClient(timeoutMs = 1500) {
    const started = Date.now();
    for (;;) {
      if (freshClients().length > 0) return true;
      if (Date.now() - started >= timeoutMs) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  function noClientText(what) {
    return `browser ${what}: no connected client — the Agent Browser sidebar panel is not open. Call action=open with a URL first (or ask the user to reopen the panel).`;
  }

  async function push(action, command, timeoutMs) {
    try {
      const outcome = await bridge.pushCommand(command, timeoutMs);
      return { value: outcome.value, latencyMs: outcome.latencyMs };
    } catch (error) {
      let message = String(error && error.message ? error.message : error);
      if (/no client result before timeout/iu.test(message)) {
        // The panel stopped answering but the bridge itself is still up: say so
        // instead of leaving the agent to guess whether the whole plugin died.
        message +=
          " — the sidebar client did not answer in time (the panel may be wedged); the bridge stays alive, retry action=status, or action=close then action=open.";
      }
      return { value: { ok: false, error: message } };
    }
  }

  function requireOk(outcome, label) {
    const value = outcome?.value;
    if (value === undefined || value === null || value.ok !== true) {
      throw new Error(`${label} failed: ${String(value?.error ?? "no result from the client")}`);
    }
    return value;
  }

  /** Start or reuse the single preview server owned by this plugin instance. */
  async function ensurePreview(command) {
    const config = { dir: resolve(command.dir), file: command.file ?? null, port: command.port ?? 0 };
    const same =
      previewConfig !== undefined &&
      previewSession !== undefined &&
      previewConfig.dir === config.dir &&
      previewConfig.file === config.file &&
      previewConfig.port === config.port;
    if (same) return { session: previewSession, created: false };
    if (previewSession !== undefined) {
      const previous = previewSession;
      previewSession = undefined;
      previewConfig = undefined;
      await previous.close().catch(() => {});
    }
    const session = await createPreviewServer({ dir: config.dir, file: config.file ?? undefined, port: config.port });
    previewSession = session;
    previewConfig = config;
    return { session, created: true };
  }

  async function executeStatus() {
    const status = {
      listening: bridge.port !== undefined,
      port: bridge.port,
      clients: [...bridge.clients.keys()],
      freshClients: freshClients().map(([id]) => id),
      queued: bridge.queue.length,
      pending: bridge.pending.size,
    };
    if (freshClients().length > 0) {
      const outcome = await push("status", { type: "status" }, 3000);
      const clientValue = outcome.value;
      if (clientValue !== undefined && clientValue !== null && clientValue.ok === true) {
        status.client = { ready: clientValue.ready === true, hasWebview: clientValue.hasWebview === true };
        status.viewport = clientValue.viewport;
        status.theme = clientValue.theme;
        status.console = clientValue.console;
        status.lastUrl = clientValue.lastUrl;
        status.lastTitle = clientValue.lastTitle;
        if (clientValue.lastLoadFailure !== undefined) status.lastLoadFailure = clientValue.lastLoadFailure;
        if (clientValue.attemptedUrl !== undefined) status.attemptedUrl = clientValue.attemptedUrl;
        if (clientValue.hostOrigin !== undefined) status.hostOrigin = clientValue.hostOrigin;
      } else {
        status.clientError = String(clientValue?.error ?? "no client status");
      }
    }
    return { text: formatResult("status", status) };
  }

  async function executePreview(args) {
    const command = toCommand("preview", args);
    if (!(await waitForClient(1500))) return { text: noClientText("preview") };
    let session;
    let created = false;
    try {
      const ensured = await ensurePreview(command);
      session = ensured.session;
      created = ensured.created;
      const opened = await push("open", { type: "open", url: session.url }, COMMAND_TIMEOUT_MS);
      requireOk(opened, "preview open");
    } catch (error) {
      if (created && session !== undefined) {
        const failed = session;
        session = undefined;
        if (previewSession === failed) {
          previewSession = undefined;
          previewConfig = undefined;
        }
        await failed.close().catch(() => {});
      }
      return { text: `browser preview failed: ${String(error && error.message ? error.message : error)}` };
    }
    return {
      text:
        `preview served: ${session.url}\n` +
        `directory: ${session.dir}${command.file ? ` (root file: ${command.file})` : ""}\n` +
        `${created ? "started" : "reused"} a 127.0.0.1 static server with a random token path; GET/HEAD only, no directory listing. ` +
        "The panel was navigated to it. The server closes when the plugin is disposed.",
    };
  }

  async function executeQa(args) {
    const plan = toCommand("qa", args);
    if (!(await waitForClient(1500))) return { text: noClientText("qa") };
    mkdirSync(plan.outDir, { recursive: true });
    const variants = [];
    const stepTimeoutMs = QA_COMMAND_TIMEOUT_MS;
    try {
      for (const width of plan.widths) {
        requireOk(await push("navigate", { type: "navigate", url: plan.url }, stepTimeoutMs), "qa navigate");
        requireOk(
          await push("viewport", { type: "viewport", width, height: plan.height, scrollbars: plan.scrollbars }, stepTimeoutMs),
          "qa viewport",
        );
        for (const theme of plan.themes) {
          requireOk(await push("emulate", { type: "emulate", colorScheme: theme }, stepTimeoutMs), "qa emulate");
          await push("wait", { type: "wait", ms: 250 }, stepTimeoutMs);
          const metrics = requireOk(
            await push("metrics", { type: "metrics", selectors: plan.selectors, includeOverflow: true }, stepTimeoutMs),
            "qa metrics",
          );
          const screenshot = requireOk(
            await push(
              "screenshot",
              { type: "screenshot", fullPage: plan.fullPage === true, format: "png", hideCursor: true },
              stepTimeoutMs,
            ),
            "qa screenshot",
          );
          if (typeof screenshot.dataUrl !== "string") throw new Error("qa screenshot: the client returned no image data");
          const saved = saveScreenshot(screenshot.dataUrl, {
            path: join(plan.outDir, `qa-${width}x${plan.height}-${theme}.png`),
          });
          variants.push({
            width,
            height: plan.height,
            theme,
            metrics: metrics.metrics,
            screenshot: saved.file,
            screenshotWidth: saved.width,
            screenshotHeight: saved.height,
            bytes: saved.bytes,
          });
        }
      }
    } finally {
      // Leave the panel in its default state even when a step failed.
      await push("viewport", { type: "viewport", reset: true }, 8000);
      await push("emulate", { type: "emulate", colorScheme: "auto" }, 8000);
    }
    return { text: formatQaResult(plan, variants) };
  }

  async function executeScreenshot(command) {
    // A fullPage stitch legitimately runs longer than the per-command default
    // (many viewport captures over an external page), so it rides a dedicated
    // long bridge timeout; the client bounds every internal step plus a 60s
    // budget, so this window only protects slow-but-healthy stitches.
    const outcome = await push("screenshot", command, command.fullPage === true ? FULLPAGE_SCREENSHOT_TIMEOUT_MS : COMMAND_TIMEOUT_MS);
    const value = outcome.value;
    if (value === undefined || value === null || value.ok !== true) {
      return { text: `browser screenshot failed: ${String(value?.error ?? "no result from the client")}` };
    }
    let saved;
    try {
      saved = saveScreenshot(value.dataUrl, { path: command.path });
    } catch (error) {
      return { text: `browser screenshot failed: ${String(error && error.message ? error.message : error)}` };
    }
    const dimensions = saved.width !== undefined && saved.height !== undefined ? `${saved.width}x${saved.height}px` : "size unknown";
    const notes = buildScreenshotNotes(value);
    return {
      text:
        `screenshot saved: ${saved.file} (${dimensions}, ${saved.bytes} bytes, ${saved.format})` +
        (notes.length > 0 ? ` — ${notes.join("; ")}` : "") +
        " — call read_image with this path to view it.",
    };
  }

  ctx.effect(
    () =>
      ctx.tools.register({
        name: "browser",
        description: DESCRIPTION,
        parameters: {
          // Plain-JS registration bypasses defineTool's spec conversion, so this
          // must already be wire-ready JSON Schema (object root, required array).
          type: "object",
          properties: {
            action: { type: "string", enum: ACTIONS, description: "The browser action to perform." },
            url: { type: "string", description: "Absolute http(s) URL for open/navigate/qa." },
            ref: {
              type: "string",
              description: "Element ref from the latest snapshot, e.g. e1a2b3 (preferred over raw coordinates for click/type; also accepted by screenshot/scrollIntoView).",
            },
            x: { type: "number", description: "Viewport x coordinate for a coordinate click." },
            y: { type: "number", description: "Viewport y coordinate for a coordinate click." },
            text: { type: "string", description: "Text to type into the focused element (action=type) or the text to wait for (action=wait)." },
            key: { type: "string", description: "Key name to press, e.g. Enter, Tab, Escape, ArrowDown." },
            deltaY: { type: "number", description: "Wheel delta in pixels for scroll (positive = down)." },
            ms: { type: "number", description: "Wait duration for action=wait; with conditions it is the timeout." },
            selector: { type: "string", description: "CSS selector for wait/scrollIntoView/screenshot element capture/metrics measurement." },
            width: { type: "number", description: "Viewport width in CSS px for action=viewport (64..10000)." },
            height: { type: "number", description: "Viewport height in CSS px for action=viewport (default 800); qa height uses the same field." },
            reset: { type: "boolean", description: "For action=viewport: restore the panel-sized viewport." },
            scrollbars: {
              type: "string",
              enum: ["auto", "hidden"],
              description: "For action=viewport (and qa): 'hidden' hides the page scrollbars persistently so contentWidth == viewport width; restore with reset or default 'auto'.",
            },
            expression: { type: "string", description: "JavaScript expression for action=evaluate; the JSON result is capped at 16KB." },
            selectors: {
              type: "array",
              items: { type: "string" },
              description: "Selectors to measure with action=metrics (or include in qa variants).",
            },
            includeOverflow: { type: "boolean", description: "For action=metrics: report elements wider than the viewport (default true)." },
            networkIdle: { type: "boolean", description: "For action=wait: wait until resource/mutation activity is quiet for idleMs (approximation, no CDP)." },
            idleMs: { type: "number", description: "Quiet window for wait networkIdle in ms (default 500)." },
            images: { type: "boolean", description: "For action=wait: wait until every <img> is complete." },
            fonts: { type: "boolean", description: "For action=wait: wait until document.fonts reports loaded." },
            block: { type: "string", enum: SCROLL_BLOCKS, description: "For action=scrollIntoView: block position (default center)." },
            clear: { type: "boolean", description: "For action=logs: clear the console ring buffer." },
            filter: { type: "string", description: "For action=logs: case-insensitive match over entry JSON." },
            limit: { type: "number", description: "For action=logs: max entries to return (1..200, default 50)." },
            fullPage: { type: "boolean", description: "For screenshot/qa: capture the full scroll height (capped at 12000 CSS px; vh layout caveat)." },
            clip: {
              type: "object",
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                width: { type: "number" },
                height: { type: "number" },
              },
              description: "For screenshot: capture this rectangle of the viewport (CSS px).",
            },
            format: { type: "string", enum: SCREENSHOT_FORMATS, description: "Screenshot image format (default png)." },
            quality: { type: "number", description: "JPEG quality 1..100 (screenshot format=jpeg)." },
            path: { type: "string", description: "Absolute file path to save the screenshot; the default is the plugin shot directory." },
            hideCursor: { type: "boolean", description: "Hide the agent cursor before capture (default true)." },
            colorScheme: { type: "string", enum: COLOR_SCHEMES, description: "For action=emulate: light/dark preference, or auto to restore." },
            html: { type: "string", description: "Self-contained HTML for action=setContent (inline CSS and data: URLs; max 2MB)." },
            baseUrl: { type: "string", description: "Optional http(s) base URL injected as <base> for setContent relative links." },
            dir: { type: "string", description: "For action=preview: local directory to serve over a tokenized 127.0.0.1 URL." },
            file: { type: "string", description: "For action=preview: file served at the base URL (relative to dir)." },
            port: { type: "number", description: "For action=preview: fixed port; default is a free port." },
            scrollbars: {
              type: "string",
              enum: ["auto", "hidden"],
              description: "For action=qa: hide the page scrollbars in every variant viewport (default auto).",
            },
            widths: {
              type: "array",
              items: { type: "number" },
              description: "For action=qa: viewport widths to test (default 1280,768,375).",
            },
            themes: {
              type: "array",
              items: { type: "string", enum: COLOR_SCHEMES },
              description: "For action=qa: colour schemes to test (default light,dark).",
            },
            maxVariants: { type: "number", description: "For action=qa: variant cap (default and hard cap 6)." },
            outDir: { type: "string", description: "For action=qa: absolute output directory for screenshots (default under the shot directory)." },
          },
          required: ["action"],
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: "string" },
            },
            required: ["text"],
          },
          render: (_args, value) => [{ type: "text", text: value.text }],
        },
        async execute(args) {
          const action = String(args.action ?? "");
          if (!ACTIONS.includes(action)) throw new Error(`browser: unknown action "${action}"`);
          if (action === "status") return executeStatus();
          if (!(await waitForClient(1500))) return { text: noClientText(action) };
          if (action === "preview") return executePreview(args);
          if (action === "qa") return executeQa(args);
          const command = toCommand(action, args);
          if (action === "screenshot") return executeScreenshot(command);
          const outcome = await push(action, command);
          const value = outcome.value;
          if (value === undefined || value === null || value.ok !== true) {
            return { text: `browser ${action} failed: ${String(value?.error ?? "no result from the client")}` };
          }
          return { text: formatResult(action, value) };
        },
      }),
    "sidebar-browser-control.tool",
  );
}

/** Formatting helpers exposed for tests. */
export const __test = {
  ACTIONS,
  formatResult,
  formatSnapshot,
  formatQaResult,
  toCommand,
  buildQaPlan,
  parseImageSize,
  truncateJson,
  saveScreenshot,
  formatMetrics,
  formatLogs,
  MAX_EVALUATE_BYTES,
  MAX_SET_CONTENT_BYTES,
  MAX_QA_VARIANTS,
  FULLPAGE_SCREENSHOT_TIMEOUT_MS,
  buildScreenshotNotes,
};
