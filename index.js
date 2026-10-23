/**
 * Sidebar Agent Browser — Host half.
 *
 * Registers the `browser` tool the model drives, and a loopback bridge that
 * delivers each tool action to the Client half, which owns the sidebar webview
 * (leased through the desktop shell) and performs real input dispatch and
 * in-page cursor rendering.
 *
 * The HTTP contract lives in ./bridge.js so it is unit-testable without a Host.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { createBridge } from "./bridge.js";

export const name = "sidebar-browser-control";
export const inject = ["tools"];

const PORT = Number(process.env.DSH_BROWSER_CONTROL_PORT ?? 47834);
const TOKEN = process.env.DSH_BROWSER_CONTROL_TOKEN ?? "dsh-browser-control-local";
const STATE_FILE = process.env.DSH_BROWSER_CONTROL_STATE ?? join(tmpdir(), "dsh-browser-control-state.json");
const COMMAND_TIMEOUT_MS = Number(process.env.DSH_BROWSER_CONTROL_COMMAND_TIMEOUT_MS ?? 25_000);
const SHOT_DIR = process.env.DSH_BROWSER_CONTROL_SHOT_DIR ?? join(tmpdir(), "dsh-browser-shots");

const ACTIONS = ["open", "navigate", "snapshot", "click", "type", "key", "scroll", "wait", "status", "screenshot"];
const CLIENT_FRESH_MS = 60_000;

const DESCRIPTION =
  "Drive the Agent Browser in the DSH sidebar: a real Chromium webview that the user can watch, with a visible agent cursor that never moves the user's mouse. " +
  "Workflow: action=open with a URL, then action=snapshot to read the page (visible interactive elements get refs), then action=click/type by ref; call snapshot again after each action that changes the page. " +
  "Refs are only valid for the most recent snapshot. " +
  "action=screenshot saves a PNG of the page and returns its path (view it with read_image). " +
  "action=status reports whether the sidebar panel is open. Coordinates are CSS pixels inside the page viewport.";

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

/** Translate one tool call into the command the Client half executes. */
function toCommand(action, args) {
  switch (action) {
    case "open":
      return { type: "open", url: requireHttpUrl(args.url, "url") };
    case "navigate":
      return { type: "navigate", url: requireHttpUrl(args.url, "url") };
    case "snapshot":
      return { type: "snapshot" };
    case "screenshot":
      return { type: "screenshot" };
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
    case "scroll": {
      const deltaY = Number(args.deltaY ?? 400);
      if (!Number.isFinite(deltaY)) throw new Error("browser: scroll requires a numeric deltaY");
      const command = { type: "scroll", deltaY };
      if (args.ref !== undefined && args.ref !== null) command.ref = String(args.ref);
      return command;
    }
    case "wait": {
      const ms = Number(args.ms ?? 500);
      const selector = typeof args.selector === "string" && args.selector !== "" ? args.selector : undefined;
      if (!Number.isFinite(ms) && selector === undefined) throw new Error("browser: wait requires ms or selector");
      return { type: "wait", ms: Number.isFinite(ms) ? ms : 500, selector };
    }
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

/** Persist a captured data URL and return its path. */
function saveScreenshot(dataUrl) {
  const match = /^data:image\/(png|jpeg|webp);base64,(.+)$/u.exec(String(dataUrl ?? ""));
  if (match === null) throw new Error("browser: screenshot returned an unsupported data URL");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0) throw new Error("browser: screenshot image is empty");
  mkdirSync(SHOT_DIR, { recursive: true });
  const file = join(SHOT_DIR, `sidebar-${Date.now()}.${match[1] === "jpeg" ? "jpg" : match[1]}`);
  writeFileSync(file, bytes);
  return { file, bytes: bytes.length };
}

function formatResult(action, value) {
  switch (action) {
    case "open":
      return `opened ${String(value.url ?? "")}${value.title ? ` (${value.title})` : ""}`;
    case "navigate":
      return `navigated to ${String(value.url ?? "")}${value.title ? ` (${value.title})` : ""}`;
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
    case "scroll":
      return `scrolled ${String(value.deltaY ?? "")}${
        typeof value.scrollY === "number"
          ? ` → scrollY ${value.scrollY}${typeof value.scrollHeight === "number" ? ` / ${value.scrollHeight}` : ""}${
              typeof value.innerHeight === "number" ? ` (viewport ${value.innerHeight})` : ""
            }${value.method === "script" ? " [script fallback]" : ""}`
          : ""
      }`;
    case "wait":
      return `waited ${String(value.waitedMs ?? "")}ms`;
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
  const freshClients = () =>
    [...bridge.clients.entries()].filter(([, record]) => Date.now() - record.seenAt < CLIENT_FRESH_MS);

  /** Give a just-mounted panel a moment to register before reporting failure. */
  async function waitForClient(timeoutMs = 1500) {
    const started = Date.now();
    for (;;) {
      if (freshClients().length > 0) return true;
      if (Date.now() - started >= timeoutMs) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
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
            url: { type: "string", description: "Absolute http(s) URL for open/navigate." },
            ref: {
              type: "string",
              description: "Element ref from the latest snapshot, e.g. e1a2b3 (preferred over raw coordinates for click/type).",
            },
            x: { type: "number", description: "Viewport x coordinate for a coordinate click." },
            y: { type: "number", description: "Viewport y coordinate for a coordinate click." },
            text: { type: "string", description: "Text to type into the focused element." },
            key: { type: "string", description: "Key name to press, e.g. Enter, Tab, Escape, ArrowDown." },
            deltaY: { type: "number", description: "Wheel delta in pixels for scroll (positive = down)." },
            ms: { type: "number", description: "Wait duration in milliseconds." },
            selector: { type: "string", description: "Optional CSS selector to wait for instead of a fixed delay." },
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
          if (action === "status") {
            return {
              text: JSON.stringify(
                {
                  listening: bridge.port !== undefined,
                  port: bridge.port,
                  clients: [...bridge.clients.keys()],
                  freshClients: freshClients().map(([id]) => id),
                  queued: bridge.queue.length,
                  pending: bridge.pending.size,
                },
                null,
                2,
              ),
            };
          }
          if (!(await waitForClient(1500))) {
            return {
              text:
                "browser: no connected client — the Agent Browser sidebar panel is not open. " +
                "Call action=open with a URL first (or ask the user to reopen the panel).",
            };
          }
          const command = toCommand(action, args);
          const outcome = await bridge.pushCommand(command);
          const value = outcome.value;
          if (value === undefined || value === null || value.ok !== true) {
            return { text: `browser ${action} failed: ${String(value?.error ?? "no result from the client")}` };
          }
          if (action === "screenshot") {
            const saved = saveScreenshot(value.dataUrl);
            return { text: `screenshot saved: ${saved.file} (${saved.bytes} bytes) — call read_image with this path to view it.` };
          }
          return { text: formatResult(action, value) };
        },
      }),
    "sidebar-browser-control.tool",
  );
}

/** Formatting helpers exposed for tests. */
export const __test = { formatResult, formatSnapshot, toCommand };
