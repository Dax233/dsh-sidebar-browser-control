import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const TEST_TOKEN = "browser-control-test-token";
process.env.DSH_BROWSER_CONTROL_PORT = "0";
process.env.DSH_BROWSER_CONTROL_TOKEN = TEST_TOKEN;
process.env.DSH_BROWSER_CONTROL_COMMAND_TIMEOUT_MS = "2000";
// The behavioral fullPage-timeout test below answers after 3s: longer than the
// 2s default command timeout, shorter than the dedicated fullPage window.
process.env.DSH_BROWSER_CONTROL_FULLPAGE_TIMEOUT_MS = "5000";
process.env.DSH_BROWSER_CONTROL_STATE = join(mkdtempSync(join(tmpdir(), "dsh-bc-host-")), "state.json");
process.env.DSH_BROWSER_CONTROL_SHOT_DIR = join(mkdtempSync(join(tmpdir(), "dsh-bc-shots-")), "shots");

const plugin = await import("../index.js");

const EXPECTED_ACTIONS = [
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

function makeContext() {
  const tools = [];
  const disposers = [];
  const ctx = {
    effect(execute) {
      const dispose = execute();
      if (typeof dispose === "function") disposers.push(dispose);
      return dispose;
    },
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
    timer: {
      timeout() {
        return () => {};
      },
      interval() {
        return () => {};
      },
    },
  };
  return {
    ctx,
    tools,
    disposeAll() {
      for (const dispose of disposers.splice(0).reverse()) dispose();
    },
  };
}

test("host apply() is synchronous and registers the browser tool", () => {
  const harness = makeContext();
  assert.equal(plugin.apply(harness.ctx), undefined);
  assert.equal(harness.tools.length, 1);
  assert.equal(harness.tools[0].name, "browser");
  harness.disposeAll();
});

test("DS COMPAT: browser tool parameters are an object-rooted JSON Schema", () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  const tool = harness.tools[0];
  assert.equal(tool.parameters.type, "object");
  assert.deepEqual(tool.parameters.required, ["action"]);
  assert.deepEqual([...tool.parameters.properties.action.enum].sort(), [...EXPECTED_ACTIONS].sort());
  for (const [name, property] of Object.entries(tool.parameters.properties)) {
    assert.notEqual(property.required, true, `parameter "${name}" must not carry the dialect required flag`);
  }
  assert.equal(tool.output.schema.type, "object");
  assert.deepEqual(tool.output.schema.required, ["text"]);
  harness.disposeAll();
});

test("snapshot without a connected client returns an actionable message", async () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  try {
    const result = await harness.tools[0].execute({ action: "snapshot" });
    assert.match(result.text, /no connected client/i);
  } finally {
    harness.disposeAll();
  }
});

test("unknown actions are rejected", async () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  try {
    await assert.rejects(() => harness.tools[0].execute({ action: "dance" }));
  } finally {
    harness.disposeAll();
  }
});

test("tool commands round-trip through a fake client (open/snapshot/click)", async () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  let stopped = false;
  const received = [];
  let pollLoop;
  try {
    const port = await waitForPort(harness.tools[0]);
    const client = startFakeClient(port, received, () => stopped);
    pollLoop = client.promise;
    const open = await harness.tools[0].execute({ action: "open", url: "https://example.com/" });
    assert.match(open.text, /opened/i);
    const snapshot = await harness.tools[0].execute({ action: "snapshot" });
    assert.match(snapshot.text, /Example Domain/);
    assert.match(snapshot.text, /viewport: 575x742 scrollY=0/);
    assert.match(snapshot.text, /\[e0\] link "Learn more"/);
    assert.match(snapshot.text, /\[e1\] textbox "" .* = "hello"/);
    assert.match(snapshot.text, /— heading "Example Domain"/);
    assert.match(snapshot.text, /3 more elements not shown/);
    assert.match(snapshot.text, /action=scroll/);
    const click = await harness.tools[0].execute({ action: "click", ref: "e0" });
    assert.match(click.text, /click/i);
    const typed = await harness.tools[0].execute({ action: "type", text: "hi" });
    assert.match(typed.text, /focused value: "hi"/);
    const scrolled = await harness.tools[0].execute({ action: "scroll", deltaY: 300 });
    assert.match(scrolled.text, /scrollY 250/);
    const shot = await harness.tools[0].execute({ action: "screenshot" });
    assert.match(shot.text, /screenshot saved/);
    const shotPath = /screenshot saved: (.+?) \(/u.exec(shot.text)?.[1];
    assert.ok(shotPath, "screenshot text must contain a path");
    assert.equal(existsSync(shotPath), true, "the screenshot file must exist");
    assert.deepEqual(
      received.map((command) => command.type),
      ["open", "snapshot", "click", "type", "scroll", "screenshot"],
    );
  } finally {
    stopped = true;
    try {
      pollLoop?.catch(() => {});
    } catch {
      // ignore
    }
    harness.disposeAll();
  }
});

async function waitForPort(tool) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const status = JSON.parse((await tool.execute({ action: "status" })).text);
    if (status.listening && status.port > 0) return status.port;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("bridge did not start");
}

function startFakeClient(port, received, isStopped, options = {}) {
  const answer = async (command) => {
    if (command.fullPage === true && command.type === "screenshot" && options.slowFullPageMs) {
      await new Promise((resolve) => setTimeout(resolve, options.slowFullPageMs));
    }
    switch (command.type) {
      case "open":
        return { ok: true, url: command.url };
      case "snapshot":
        return {
          ok: true,
          snapshot: {
            title: "Example Domain",
            url: "https://example.com/",
            viewport: { w: 575, h: 742, scrollY: 0 },
            elements: [
            { ref: "e0", role: "link", tag: "a", text: "Learn more", x: 120, y: 240, depth: 1 },
            { ref: "e1", role: "textbox", tag: "input", text: "", value: "hello", x: 10, y: 20, depth: 0 },
            { role: "heading", tag: "h1", text: "Example Domain", x: 200, y: 80, depth: 0 },
          ],
          omitted: 3,
          scroll: { scrollHeight: 2400, pagesBelow: 2 },
          },
        };
      case "click":
        return { ok: true };
      case "type":
        return { ok: true, typed: command.text, value: command.text, settle: { settled: true, mutations: 1 }, changed: true };
      case "key":
        return { ok: true, key: command.key, settle: { settled: true, mutations: 0 }, changed: false };
      case "scroll":
        return { ok: true, deltaY: command.deltaY, requestedDelta: command.deltaY, actualDelta: 250, scrollY: 250, scrollHeight: 2400, innerHeight: 742 };
      case "screenshot":
        return {
          ok: true,
          dataUrl: makePng(320, 240),
          format: "png",
          mode: command.fullPage === true ? "fullPage" : "viewport",
          devicePixelRatio: 1,
          ...(command.fullPage === true
            ? {
                fullPage: {
                  requestedHeight: 24000,
                  capturedHeight: 12000,
                  capped: true,
                  segments: 17,
                  stitched: true,
                  viewportHeight: 742,
                  timings: { totalMs: 4231, segments: 17, captureMs: [10, 12], encodeMs: [14, 16] },
                },
              }
            : {}),
        };
      case "viewport":
        return {
          ok: true,
          width: command.width,
          height: command.height,
          scale: 0.5,
          ...(command.reset === true ? { reset: true } : {}),
          matched: true,
          settledMs: 12,
          actual: { innerWidth: command.width ?? 575, innerHeight: command.height ?? 742, devicePixelRatio: 1 },
        };
      case "evaluate":
        return { ok: true, result: { answer: 42 } };
      case "metrics":
        return {
          ok: true,
          metrics: {
            title: "Example Domain",
            url: "https://example.com/",
            viewport: { width: 1280, height: 800, devicePixelRatio: 1, scrollY: 0 },
            document: { scrollWidth: 1280, scrollHeight: 2400, contentWidth: 1280 },
            overflow: [{ selector: "div#wide", right: 1500, overshoot: 220 }],
            overflowCount: 1,
            images: { total: 3, loaded: 2, failed: 1, failedSrc: ["https://example.com/broken.png"] },
            fonts: { status: "loaded", size: 2 },
            console: { errors: 1, warnings: 2, total: 3, entries: 3 },
            selectors: [{ selector: ".hero", found: true, rect: { x: 0, y: 0, width: 300, height: 200 } }],
          },
        };
      case "wait":
        return { ok: true, waitedMs: command.ms ?? 500, mode: command.selector === undefined ? "sleep" : "conditions", conditions: { selector: true } };
      case "scrollIntoView":
        return {
          ok: true,
          scrollY: 640,
          scrollHeight: 2400,
          innerHeight: 800,
          inViewport: true,
          target: { selector: command.selector, ref: command.ref },
        };
      case "logs":
        return {
          ok: true,
          entries: [
            { level: "error", message: "Uncaught boom", line: 1, source: "a.js" },
            { level: "warning", message: "deprecated", line: 2, source: "b.js" },
          ],
          matched: 2,
          bufferSize: 2,
          bufferLimit: 200,
          totalSeen: 2,
          clearedCount: command.clear === true ? 2 : 0,
          probe: { failedImages: [{ src: "https://example.com/broken.png" }], resourceCount: 6, resources: [] },
        };
      case "emulate":
        return {
          ok: true,
          scheme: command.colorScheme,
          matchMediaOverridden: command.colorScheme !== "auto",
          sheets: { scanned: 2, patched: 1, crossOrigin: 0, unreadable: 0 },
          mediaRules: { patched: 1, restored: 0 },
          verified: { darkMatches: command.colorScheme === "dark", lightMatches: command.colorScheme === "light" },
        };
      case "setContent":
        return {
          ok: true,
          context: "about:blank",
          title: "Local Content",
          url: "about:blank",
          viewport: { width: 575, height: 742, devicePixelRatio: 1 },
          baseUrl: command.baseUrl ?? null,
          injectedBase: command.baseUrl !== undefined,
          bytes: command.html.length,
        };
      case "close":
        return { ok: true, closed: true };
      case "status":
        return {
          ok: true,
          ready: true,
          hasWebview: true,
          viewport: { width: 1280, height: 800, scale: 0.5, auto: false },
          theme: "light",
          console: { errors: 2, warnings: 1, total: 3, buffer: 3 },
          lastUrl: "https://example.com/",
          lastTitle: "Example Domain",
          ...(options.statusLastLoadFailure !== undefined
            ? { lastLoadFailure: options.statusLastLoadFailure }
            : {}),
        };
      default:
        return { ok: true };
    }
  };  const promise = (async () => {
    while (!isStopped()) {
      try {
        const auth = { authorization: `Bearer ${TEST_TOKEN}` };
        const response = await fetch(`http://127.0.0.1:${port}/poll?client=fake`, { headers: auth });
        if (!response.ok) break;
        const message = await response.json();
        if (message && typeof message.id === "string" && message.cmd) {
          received.push(message.cmd);
          await fetch(`http://127.0.0.1:${port}/result?id=${encodeURIComponent(message.id)}`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify(await answer(message.cmd)),
          });
        }
      } catch {
        if (isStopped()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  })();
  return { promise };
}

test("click receipt warns when the action produced no observable change", () => {
  const click = plugin.__test.formatResult("click", {
    x: 10,
    y: 20,
    label: "Covered",
    hitTrusted: true,
    navigated: false,
    changed: false,
    settle: { settled: true, mutations: 0 },
  });
  assert.match(click, /no observable change/);
  const covered = plugin.__test.formatResult("click", {
    x: 10,
    y: 20,
    label: "Covered",
    hitTrusted: false,
    navigated: false,
    changed: true,
    settle: { settled: true, mutations: 1 },
  });
  assert.match(covered, /appears covered/);
});

// ---------------------------------------------------------------------------
// 0.2.0 QA surface: dispatch, validation, receipts, qa/preview/status/close
// ---------------------------------------------------------------------------

async function withHarness(run) {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  try {
    return await run(harness);
  } finally {
    harness.disposeAll();
  }
}

async function withFakeClient(tool, run, options = {}) {
  let stopped = false;
  const received = [];
  const port = await waitForPort(tool);
  const client = startFakeClient(port, received, () => stopped, options);
  try {
    return await run(received, port);
  } finally {
    stopped = true;
    client.promise.catch(() => {});
  }
}

/** Minimal valid PNG header (signature + IHDR) — enough for parseImageSize. */
function makePng(width, height) {
  const bytes = Buffer.alloc(8 + 4 + 4 + 13 + 4);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

/** Minimal JPEG header with a SOF0 segment carrying the frame size. */
function makeJpeg(width, height) {
  const bytes = Buffer.alloc(32);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xc0;
  bytes.writeUInt16BE(17, 4);
  bytes[6] = 8;
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  return bytes;
}

test("0.2.0 host dispatch: toCommand builds and validates every new action", () => {
  const { toCommand } = plugin.__test;
  assert.deepEqual(toCommand("viewport", { width: 390 }), { type: "viewport", width: 390, height: 800 });
  assert.deepEqual(toCommand("viewport", { reset: true }), { type: "viewport", reset: true });
  assert.throws(() => toCommand("viewport", {}), /width/);
  assert.throws(() => toCommand("viewport", { width: 10 }), /between/);
  assert.deepEqual(toCommand("evaluate", { expression: "document.title" }), { type: "evaluate", expression: "document.title" });
  assert.throws(() => toCommand("evaluate", {}), /expression/);
  assert.deepEqual(toCommand("metrics", { selectors: [".hero", ".hero"], includeOverflow: false }), {
    type: "metrics",
    includeOverflow: false,
    selectors: [".hero"],
  });
  assert.deepEqual(toCommand("wait", { selector: "#ready", networkIdle: true, idleMs: 300 }), {
    type: "wait",
    selector: "#ready",
    networkIdle: true,
    idleMs: 300,
    ms: 8000,
  });
  assert.deepEqual(toCommand("wait", { ms: 250 }), { type: "wait", ms: 250 });
  assert.deepEqual(toCommand("wait", {}), { type: "wait", ms: 500 });
  assert.throws(() => toCommand("wait", { idleMs: 999999 }), /idleMs/);
  assert.deepEqual(toCommand("scrollIntoView", { selector: ".x" }), { type: "scrollIntoView", selector: ".x", block: "center" });
  assert.deepEqual(toCommand("scroll", { deltaY: "300" }), { type: "scroll", deltaY: 300 });
  assert.throws(() => toCommand("scrollIntoView", {}), /ref or selector/);
  assert.throws(() => toCommand("scrollIntoView", { ref: "e1", block: "middle" }), /block/);
  assert.deepEqual(toCommand("logs", { filter: "boom" }), { type: "logs", clear: false, limit: 50, filter: "boom" });
  assert.throws(() => toCommand("logs", { limit: 0 }), /limit/);
  assert.deepEqual(toCommand("emulate", { colorScheme: "dark" }), { type: "emulate", colorScheme: "dark" });
  assert.throws(() => toCommand("emulate", {}), /colorScheme/);
  assert.deepEqual(toCommand("setContent", { html: "<h1>hi</h1>", baseUrl: "https://example.com/" }), {
    type: "setContent",
    html: "<h1>hi</h1>",
    baseUrl: "https://example.com/",
  });
  assert.throws(() => toCommand("setContent", { html: "<p>x</p>", baseUrl: "file:///etc/passwd" }), /http/);
  assert.throws(() => toCommand("setContent", { html: "x".repeat(2 * 1024 * 1024 + 1) }), /limit/);
  assert.deepEqual(toCommand("preview", { dir: "C:\\site", file: "index.html", port: 5000 }), {
    type: "preview",
    dir: "C:\\site",
    file: "index.html",
    port: 5000,
  });
  assert.throws(() => toCommand("preview", { dir: "" }), /dir/);
  assert.throws(() => toCommand("preview", { dir: "relative\\site" }), /absolute/);
  assert.throws(() => toCommand("preview", { dir: "C:\\site", port: 70000 }), /port/);
  assert.deepEqual(toCommand("close", {}), { type: "close" });
});

test("0.2.0 host dispatch: screenshot validates format/clip/path/fullPage and hides the cursor by default", () => {
  const { toCommand } = plugin.__test;
  const absoluteShot = join(tmpdir(), "shot.jpg");
  const full = toCommand("screenshot", { fullPage: true, format: "jpeg", quality: 55, path: absoluteShot });
  assert.equal(full.fullPage, true);
  assert.equal(full.format, "jpeg");
  assert.equal(full.quality, 55);
  assert.equal(full.path, absoluteShot);
  assert.equal(full.hideCursor, true);
  assert.throws(() => toCommand("screenshot", { format: "gif" }), /format/);
  assert.throws(() => toCommand("screenshot", { quality: 101 }), /quality/);
  assert.throws(() => toCommand("screenshot", { clip: { width: 100 } }), /clip\.height/);
  assert.throws(() => toCommand("screenshot", { clip: { x: 0, y: 0, width: 100, height: -5 } }), /positive/);
  assert.throws(() => toCommand("screenshot", { path: "relative.png" }), /absolute/);
  assert.throws(() => toCommand("screenshot", { fullPage: true, clip: { x: 0, y: 0, width: 10, height: 10 } }), /cannot be combined/);
  const element = toCommand("screenshot", {
    clip: { x: 10, y: 20, width: 300, height: 200 },
    selector: ".hero",
    hideCursor: false,
  });
  assert.deepEqual(element.clip, { x: 10, y: 20, width: 300, height: 200 });
  assert.equal(element.selector, ".hero");
  assert.equal(element.hideCursor, false);
});

test("0.2.0 host dispatch: qa plan enforces the variant cap and validates widths/themes", () => {
  const { buildQaPlan } = plugin.__test;
  const plan = buildQaPlan({
    url: "https://example.com/",
    widths: [640],
    themes: ["light", "dark"],
    height: 700,
    outDir: join(tmpdir(), "qa-out"),
    fullPage: true,
    selectors: [".hero"],
  });
  assert.equal(plan.variants.length, 2);
  assert.deepEqual(plan.variants, [
    { width: 640, theme: "light" },
    { width: 640, theme: "dark" },
  ]);
  assert.equal(plan.height, 700);
  assert.equal(plan.fullPage, true);
  assert.equal(plan.selectors[0], ".hero");
  assert.throws(
    () => buildQaPlan({ url: "https://example.com/", widths: [640, 768, 800], themes: ["light", "dark", "auto"] }),
    /variants/,
  );
  assert.throws(() => buildQaPlan({ url: "https://example.com/", maxVariants: 7 }), /maxVariants/);
  assert.throws(() => buildQaPlan({ url: "https://example.com/", themes: ["sepia"] }), /themes/);
  assert.throws(() => buildQaPlan({ url: "ftp://example.com/" }), /http/);
  const defaults = buildQaPlan({ url: "https://example.com/" });
  assert.deepEqual(defaults.widths, [1280, 768, 375]);
  assert.deepEqual(defaults.themes, ["light", "dark"]);
  assert.equal(defaults.variants.length, 6, "the default matrix is exactly the hard cap");
});

test("0.2.0 host helpers: parseImageSize reads PNG/JPEG headers and truncateJson enforces the 16KB budget", () => {
  const png = Buffer.from(makePng(321, 123).replace(/^data:image\/png;base64,/u, ""), "base64");
  assert.deepEqual(plugin.__test.parseImageSize(png), { format: "png", width: 321, height: 123 });
  const jpeg = makeJpeg(200, 100);
  assert.deepEqual(plugin.__test.parseImageSize(jpeg), { format: "jpeg", width: 200, height: 100 });
  assert.equal(plugin.__test.parseImageSize(Buffer.from("not an image")), undefined);
  const small = plugin.__test.truncateJson({ ok: true });
  assert.equal(small.truncated, false);
  const big = plugin.__test.truncateJson("x".repeat(plugin.__test.MAX_EVALUATE_BYTES * 2));
  assert.equal(big.truncated, true);
  assert.match(big.text, /truncated: result is \d+ bytes, limit 16384 bytes/);
});

test("0.2.0 host receipts: new actions format compact, actionable text", () => {
  const { formatResult: format } = plugin.__test;
  assert.match(
    format("viewport", { width: 1280, height: 800, scale: 0.375, matched: true, settledMs: 80, actual: { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1 } }),
    /viewport: 1280x800 requested; actual 1280x800 \(devicePixelRatio 1\); panel scale 0\.375; settled in 80ms/,
  );
  assert.match(
    format("viewport", {
      width: 390,
      scale: 1,
      matched: false,
      settledMs: 2000,
      actual: { innerWidth: 575, innerHeight: 742, devicePixelRatio: 1 },
    }),
    /warning: the guest viewport did not settle .*actual 575x742/,
    "a stale guest viewport must be called out instead of reported as success",
  );
  assert.match(
    format("viewport", { reset: true, actual: { innerWidth: 575, innerHeight: 742, devicePixelRatio: 1 } }),
    /viewport reset to panel size: 575x742/,
  );
  const metrics = format("metrics", {
    metrics: {
      title: "T",
      url: "https://e/",
      viewport: { width: 1280, height: 800, devicePixelRatio: 1, scrollY: 0 },
      document: { scrollWidth: 1280, scrollHeight: 2400, contentWidth: 1280 },
      overflow: [{ selector: "div#wide", right: 1500, overshoot: 220 }],
      overflowCount: 1,
      images: { total: 3, loaded: 2, failed: 1, failedSrc: ["https://e/broken.png"] },
      fonts: { status: "loaded", size: 2 },
      console: { errors: 1, warnings: 2 },
      selectors: [
        { selector: ".hero", found: true, rect: { x: 0, y: 0, width: 300, height: 200 } },
        { selector: ".missing", found: false },
      ],
    },
  });
  assert.match(metrics, /metrics: T https:\/\/e\//);
  assert.match(metrics, /overflow: 1 element\(s\) wider than the viewport/);
  assert.match(metrics, /images: 3 total, 2 loaded, 1 failed/);
  assert.match(metrics, /console: 1 error\(s\), 2 warning\(s\)/);
  assert.match(metrics, /\.hero: 300x200/);
  assert.match(metrics, /\.missing: not found/);
  const logs = format("logs", {
    entries: [{ level: "error", message: "boom" }],
    matched: 1,
    bufferSize: 1,
    bufferLimit: 200,
    totalSeen: 1,
    clearedCount: 1,
    probe: { failedImages: [{ src: "https://e/x.png" }], resources: [], resourceCount: 2 },
  });
  assert.match(logs, /cleared 1 buffered entry/);
  assert.match(logs, /\[error\] boom/);
  assert.match(logs, /failed images \(1\)/);
  const emulate = format("emulate", {
    scheme: "dark",
    sheets: { scanned: 2, patched: 1, crossOrigin: 1 },
    mediaRules: { patched: 1 },
    verified: { darkMatches: true, lightMatches: false },
  });
  assert.match(emulate, /emulated prefers-color-scheme: dark/);
  assert.match(emulate, /1 cross-origin unreadable/);
  const content = format("setContent", {
    context: "about:blank",
    title: "Local",
    viewport: { width: 575, height: 742 },
    injectedBase: true,
    baseUrl: "https://e/",
  });
  assert.match(content, /setContent: "Local" in about:blank/);
  assert.match(content, /<base> injected/);
  assert.match(content, /file:\/\/ is unavailable/);
  const inPlace = format("setContent", { context: "in-place", title: "x", viewport: {} });
  assert.match(inPlace, /rendered in place/);
  const scroll = format("scroll", {
    requestedDelta: 400,
    actualDelta: 0,
    scrollY: 0,
    scrollHeight: 2400,
    innerHeight: 742,
    clamped: true,
    method: "script",
  });
  assert.match(scroll, /requested 400px, actual 0px/);
  assert.match(scroll, /clamped at document edge/);
  assert.match(scroll, /\[script fallback\]/);
  assert.match(
    format("scrollIntoView", { scrollY: 640, scrollHeight: 2400, innerHeight: 800, inViewport: true, target: { label: "Section" } }),
    /scrolled into view "Section" — scrollY 640/,
  );
  assert.match(format("wait", { waitedMs: 320, conditions: { selector: true, text: true } }), /waited 320ms \(selector found, text found\)/);
  assert.match(format("close", { closed: true }), /browser closed/);
  assert.match(format("close", { closed: false }), /no panel was open/);
  assert.match(format("evaluate", { result: { answer: 42 } }), /"answer": 42/);
});

test("0.2.0 host round-trip: QA actions dispatch through the bridge and format receipts", async () => {
  await withHarness(async (harness) => {
    const tool = harness.tools[0];
    await withFakeClient(tool, async (received) => {
      const viewport = await tool.execute({ action: "viewport", width: 390 });
      assert.match(viewport.text, /viewport: 390x800 requested; actual 390x800/);
      const evaluate = await tool.execute({ action: "evaluate", expression: "1+1" });
      assert.match(evaluate.text, /"answer": 42/);
      const metrics = await tool.execute({ action: "metrics", selectors: [".hero"] });
      assert.match(metrics.text, /images: 3 total, 2 loaded, 1 failed/);
      const waited = await tool.execute({ action: "wait", selector: "#ready" });
      assert.match(waited.text, /waited 8000ms \(selector found\)/);
      const intoView = await tool.execute({ action: "scrollIntoView", selector: "#section-2" });
      assert.match(intoView.text, /scrolled into view.*scrollY 640/);
      const logs = await tool.execute({ action: "logs", filter: "boom" });
      assert.match(logs.text, /\[error\] Uncaught boom/);
      assert.match(logs.text, /failed images/);
      const emulate = await tool.execute({ action: "emulate", colorScheme: "dark" });
      assert.match(emulate.text, /emulated prefers-color-scheme: dark/);
      const content = await tool.execute({ action: "setContent", html: "<title>Local</title>", baseUrl: "https://example.com/" });
      assert.match(content.text, /setContent: "Local Content"/);
      const closed = await tool.execute({ action: "close" });
      assert.match(closed.text, /browser closed/);
      assert.deepEqual(
        received.map((command) => command.type),
        ["viewport", "evaluate", "metrics", "wait", "scrollIntoView", "logs", "emulate", "setContent", "close"],
      );
      assert.deepEqual(received[0], { type: "viewport", width: 390, height: 800 });
      assert.equal(received[1].expression, "1+1");
      assert.equal(received[5].filter, "boom");
      assert.equal(received[6].colorScheme, "dark");
      assert.equal(received[7].baseUrl, "https://example.com/");
    });
  });
});

test("0.2.0 host screenshot: saves to an absolute path, parses real pixels, and reports fullPage caps", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-bc-shot-"));
  const target = join(dir, "evidence.png");
  await withHarness(async (harness) => {
    const tool = harness.tools[0];
    await withFakeClient(tool, async (received) => {
      const result = await tool.execute({ action: "screenshot", fullPage: true, path: target });
      assert.match(result.text, /screenshot saved:/);
      assert.match(result.text, /320x240px/);
      assert.match(result.text, /full page: stitched 17 viewport capture\(s\), captured 12000 of 24000 CSS px \(capped at 12000/);
      assert.match(result.text, /position:fixed\/sticky elements may repeat/);
      assert.equal(existsSync(target), true, "the screenshot must be written to the requested absolute path");
      assert.deepEqual(plugin.__test.parseImageSize(readFileSync(target)), { format: "png", width: 320, height: 240 });
      assert.equal(received[0].fullPage, true);
      assert.equal(received[0].hideCursor, true);
      assert.match(result.text, /read_image/);
    });
  });
});

test("0.2.0 host qa: runs a width x theme matrix, saves screenshots, and resets the panel", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "dsh-bc-qa-"));
  await withHarness(async (harness) => {
    const tool = harness.tools[0];
    await withFakeClient(tool, async (received) => {
      const result = await tool.execute({
        action: "qa",
        url: "https://example.com/",
        widths: [640],
        themes: ["light", "dark"],
        height: 700,
        outDir,
        selectors: [".hero"],
      });
      assert.match(result.text, /qa: https:\/\/example\.com\//);
      assert.match(result.text, /variants: 2/);
      assert.match(result.text, /640x700 light:/);
      assert.match(result.text, /640x700 dark:/);
      const types = received.map((command) => command.type);
      assert.deepEqual(types.slice(0, 5), ["navigate", "viewport", "emulate", "wait", "metrics"]);
      assert.equal(types.filter((type) => type === "screenshot").length, 2);
      assert.equal(types.at(-2), "viewport");
      assert.equal(types.at(-1), "emulate");
      assert.equal(received.at(-2).reset, true, "qa must leave the viewport back on auto");
      assert.equal(received.at(-1).colorScheme, "auto", "qa must leave the theme back on auto");
      assert.equal(received[1].height, 700);
      for (const theme of ["light", "dark"]) {
        const file = join(outDir, `qa-640x700-${theme}.png`);
        assert.equal(existsSync(file), true, `qa must save ${file}`);
        assert.deepEqual(plugin.__test.parseImageSize(readFileSync(file)), { format: "png", width: 320, height: 240 });
      }
    });
  });
});

test("0.2.0 host preview: serves a local directory over a tokenized loopback URL and reuses the server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-bc-preview-"));
  writeFileSync(join(dir, "index.html"), "<title>Preview</title><h1>local</h1>");
  let servedUrl;
  await withHarness(async (harness) => {
    const tool = harness.tools[0];
    await withFakeClient(tool, async (received) => {
      const first = await tool.execute({ action: "preview", dir });
      const match = /preview served: (http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/)/u.exec(first.text);
      assert.ok(match, `preview receipt must contain the tokenized URL, got: ${first.text}`);
      servedUrl = match[1];
      const response = await fetch(servedUrl);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /local/);
      assert.equal(received[0].type, "open");
      assert.equal(received[0].url, servedUrl);
      const second = await tool.execute({ action: "preview", dir });
      assert.match(second.text, /reused a 127\.0\.0\.1 static server/);
      assert.equal(/preview served: (\S+)/u.exec(second.text)[1], servedUrl, "the same directory reuses the running server");
      assert.equal(received.length, 2);
      const missing = await tool.execute({ action: "preview", dir: join(dir, "does-not-exist") });
      assert.match(missing.text, /browser preview failed/);
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(() => fetch(servedUrl), /fetch failed|ECONNREFUSED|connect/iu, "dispose must close the preview server");
});

test("0.2.0 host status: merges connected-client viewport/theme/console/last url with bridge fields", async () => {
  await withHarness(async (harness) => {
    const tool = harness.tools[0];
    await withFakeClient(tool, async (received) => {
      let status = {};
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const raw = await tool.execute({ action: "status" });
        status = JSON.parse(raw.text);
        if (status.freshClients.length > 0 && status.client !== undefined) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(typeof status.listening, "boolean");
      assert.ok(status.port > 0);
      assert.equal(status.freshClients.length, 1);
      assert.equal(status.viewport.width, 1280);
      assert.equal(status.viewport.scale, 0.5);
      assert.equal(status.theme, "light");
      assert.equal(status.console.errors, 2);
      assert.equal(status.console.warnings, 1);
      assert.equal(status.lastUrl, "https://example.com/");
      assert.equal(status.lastTitle, "Example Domain");
      assert.equal(status.client.hasWebview, true);
      assert.equal(received.at(-1).type, "status");
    });
  });
});

// ---------------------------------------------------------------------------
// 0.2.4 round 2: fullPage long bridge timeout, viewport scrollbars/contentWidth,
// qa scrollbars pass-through, stitched element/fullPage timings receipts.
// ---------------------------------------------------------------------------

test("0.2.4 host dispatch: viewport scrollbars validation and qa plan scrollbars", () => {
  const { toCommand, buildQaPlan } = plugin.__test;
  assert.deepEqual(toCommand("viewport", { width: 390, scrollbars: "hidden" }), {
    type: "viewport",
    width: 390,
    height: 800,
    scrollbars: "hidden",
  });
  assert.equal(toCommand("viewport", { width: 390 }).scrollbars, undefined, "scrollbars defaults to the client's auto mode");
  assert.throws(() => toCommand("viewport", { width: 390, scrollbars: "overlay" }), /scrollbars/);
  const plan = buildQaPlan({ url: "https://example.com/", widths: [640], themes: ["dark"], scrollbars: "hidden" });
  assert.equal(plan.scrollbars, "hidden", "qa must carry scrollbars into each variant's viewport command");
  assert.equal(buildQaPlan({ url: "https://example.com/", widths: [640] }).scrollbars, "auto", "qa scrollbars default to auto");
  assert.throws(() => buildQaPlan({ url: "https://example.com/", widths: [640], scrollbars: "overlay" }), /scrollbars/);
});

test("0.2.4 host screenshot: fullPage rides the dedicated long timeout instead of the command default", async () => {
  assert.equal(plugin.__test.FULLPAGE_SCREENSHOT_TIMEOUT_MS, 5000, "the dedicated fullPage window must be env-configurable");
  const target = join(tmpdir(), "dsh-bc-fullpage-longtime.png");
  await withHarness(async (harness) => {
    const tool = harness.tools[0];
    await withFakeClient(
      tool,
      async (received) => {
        const started = Date.now();
        const result = await tool.execute({ action: "screenshot", fullPage: true, path: target });
        const elapsed = Date.now() - started;
        // The fake client answers after 3s: under the 2s default command
        // timeout this would come back as "no client result before timeout".
        assert.match(result.text, /screenshot saved/, `expected success, got: ${result.text}`);
        assert.ok(elapsed >= 2900, `the slow fullPage answer must not be cut by the command default (elapsed ${elapsed}ms)`);
        assert.ok(elapsed < 15000);
        assert.equal(received[0].fullPage, true);
        assert.match(result.text, /took \d+ms/, "the receipt reports the client's stitch timings");
      },
      { slowFullPageMs: 3000 },
    );
  });
});

test("0.2.4 host receipts: viewport explains contentWidth, stitched elements and DOM fallback", () => {
  const { formatResult: format } = plugin.__test;
  const classic = format("viewport", {
    width: 800,
    height: 600,
    scale: 1,
    matched: true,
    settledMs: 30,
    scrollbars: "hidden",
    actual: { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1, contentWidth: 800 },
  });
  assert.match(classic, /content width 800/);
  assert.match(classic, /page scrollbars hidden/);
  const scrollbarNote = format("viewport", {
    width: 1280,
    height: 800,
    scale: 1,
    matched: true,
    settledMs: 30,
    actual: { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1, contentWidth: 1265 },
  });
  assert.match(scrollbarNote, /content width 1265 \(innerWidth is larger by 15px: classic scrollbar\)/);
  const stitched = plugin.__test.buildScreenshotNotes({
    mode: "element",
    element: {
      target: { label: "Readme" },
      clippedToViewport: false,
      stitched: true,
      segments: 4,
      fullHeight: 1833,
      fullWidth: 831,
      capturedHeight: 1833,
      capped: false,
      croppedWidth: 120,
      scrollbarsHidden: true,
      timings: { totalMs: 2400, segments: 4, captureMs: [], encodeMs: [] },
    },
  }).join("; ");
  assert.match(stitched, /element capture/);
  assert.match(stitched, /stitched 4 scroll capture\(s\) for the element's full height \(1833 of 1833 CSS px\)/);
  assert.match(stitched, /120px beyond the viewport width were cropped/);
  const cappedShot = plugin.__test.buildScreenshotNotes({
    mode: "element",
    element: { stitched: true, segments: 14, capturedHeight: 1200, capped: true, fullHeight: 5000, croppedWidth: 0 },
  }).join("; ");
  assert.match(cappedShot, /1200 capped of 5000 CSS px/);
  const dom = format("emulate", {
    scheme: "dark",
    sheets: { scanned: 2, patched: 1 },
    mediaRules: { patched: 1, restored: 0 },
    dom: { picturesPatched: 2, linkMediaPatched: 1, restored: 0, visited: 900, limitReached: false },
  });
  assert.match(dom, /DOM fallback: 2 <picture> re-picked, 1 <link media> normalized, 0 restored/);
  const domLimited = format("emulate", {
    scheme: "dark",
    dom: { picturesPatched: 1, linkMediaPatched: 0, restored: 0, visited: 6000, limitReached: true },
  });
  assert.match(domLimited, /node scan hit its limit after 6000 nodes/);
});

test("0.2.4 host qa: viewport commands carry scrollbars and the result table reports content width", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "dsh-bc-qa-"));
  await withHarness(async (harness) => {
    const tool = harness.tools[0];
    await withFakeClient(tool, async (received) => {
      const result = await tool.execute({
        action: "qa",
        url: "https://example.com/",
        widths: [640],
        themes: ["dark"],
        height: 700,
        outDir,
        scrollbars: "hidden",
      });
      assert.match(result.text, /scrollbars hidden/);
      assert.match(result.text, /^width \| theme \| viewport \| content \|/m, "the table gains a content width column");
      const viewportCommands = received.filter((command) => command.type === "viewport");
      assert.ok(viewportCommands.length >= 2, "one variant viewport + the reset");
      for (const command of viewportCommands.slice(0, -1)) {
        assert.equal(command.scrollbars, "hidden", "each variant viewport command must carry the plan's scrollbars");
      }
      assert.equal(viewportCommands.at(-1).reset, true, "the reset restores auto scrollbars");
    });
  });
});

// ---------------------------------------------------------------------------
// 0.2.10 desktop-shell DSH Host isolation: status pass-through + tool docs.
// ---------------------------------------------------------------------------

test("0.2.10 host status: passes the client's lastLoadFailure through to the JSON status text", async () => {
  const lastLoadFailure = {
    errorCode: -2,
    errorDescription: "ERR_FAILED",
    validatedURL: "http://127.0.0.1:55544/",
    isMainFrame: true,
    at: 123,
  };
  await withHarness(async (harness) => {
    const tool = harness.tools[0];
    await withFakeClient(
      tool,
      async () => {
        let status = {};
        for (let attempt = 0; attempt < 80; attempt += 1) {
          status = JSON.parse((await tool.execute({ action: "status" })).text);
          if (status.freshClients.length > 0 && status.client !== undefined) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const failure = status.lastLoadFailure ?? status.client?.lastLoadFailure;
        assert.ok(failure, "the tool status JSON must expose the client's lastLoadFailure");
        assert.equal(failure.errorCode, -2);
        assert.equal(failure.errorDescription, "ERR_FAILED");
        assert.equal(failure.validatedURL, "http://127.0.0.1:55544/");
        assert.equal(failure.isMainFrame, true);
        assert.equal(failure.at, 123);
      },
      { statusLastLoadFailure: lastLoadFailure },
    );
  });
});

test("0.2.10 browser tool description documents the DSH Host isolation", () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  try {
    const description = harness.tools[0].description;
    for (const phrase of ["desktop shell", "DSH Host", "ERR_FAILED"]) {
      assert.ok(description.includes(phrase), `the browser tool description must mention "${phrase}"`);
    }
  } finally {
    harness.disposeAll();
  }
});
