import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { flushMicrotasks, loadClientBundle } from "./support/client-harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bundleDir = join(here, "..");
const clientFile = join(bundleDir, "client.js");
const pkg = JSON.parse(readFileSync(join(bundleDir, "package.json"), "utf8"));

/** Cross-realm VM objects have foreign prototypes; normalize before deepEqual. */
const plain = (value) => JSON.parse(JSON.stringify(value));

function makeWebviewMock(options = {}) {
  const calls = { executeJavaScript: [], sendInputEvent: [], insertText: [], loadURL: [], focus: 0, getURL: 0 };
  let scrollY = options.statefulScroll === true ? 0 : 120;
  // trackingScroll emulates a real scroll container for fullPage stitching:
  // window.scrollTo() moves the reported position (clamped to the page).
  let pageScroll = 120;
  // A classic scrollbar (15px) is subtracted from contentWidth until the page
  // hides it with the scrollbarVisibility script (viewport scrollbars:"hidden").
  let pageScrollHeight = options.pageScrollHeight ?? 900;
  let scrollbarsHiddenQ = false;
  const scrollbarWidthQ = options.scrollbarWidth ?? 15;
  const webview = {
    style: {},
    ...(options.capturePage !== undefined ? { capturePage: options.capturePage } : {}),
    executeJavaScript: async (code) => {
      calls.executeJavaScript.push(code);
      if (options.evaluateResult !== undefined && !code.includes("__dshAgent")) return options.evaluateResult;
      if (code.includes("__dshAgentSettle")) return { settled: true, mutations: 2, waitedMs: 120, quietMs: 100 };
      if (code.includes("__dshAgentSubmitForm")) return { submitted: true, method: "requestSubmit" };
      if (code.includes("__dshAgentEditable")) {
        if (options.editable === false) return { editable: false, tag: "body", value: "" };
        return { editable: true, tag: "input", value: "deepseek harness" };
      }
      if (code.includes("__dshAgentCursorVisibility")) return { found: true, hidden: true, previous: "" };
      if (code.includes("__dshAgentScrollbarVisibility")) {
        const hiding = code.includes("if (true)");
        if (hiding) scrollbarsHiddenQ = true;
        else scrollbarsHiddenQ = false;
        return { hidden: hiding, created: true };
      }
      if (code.includes("__dshAgentCursorMove")) return { moved: true };
      if (code.includes("__dshAgentClickTarget")) {
        if (options.clickTargetError !== undefined) return { ok: false, error: options.clickTargetError };
        return { ok: true, x: 120, y: 240, label: "Learn more" };
      }
      if (code.includes("__dshAgentSnapshot")) {
        return {
          title: "Example Domain",
          url: "https://example.com/",
          viewport: { w: 575, h: 742, scrollY: 0 },
          elements: [{ ref: "e0", role: "link", tag: "a", text: "Learn more", x: 120, y: 240, depth: 1 }],
          omitted: 2,
          scroll: { scrollHeight: 1800, pagesBelow: 1 },
        };
      }
      if (code.includes("__dshAgentViewportInfo")) {
        // A fixed viewport is expressed as px on the element; "100%" means auto.
        const widthText = String(webview.style.width ?? "");
        const heightText = String(webview.style.height ?? "");
        const styleWidth = options.ignoreViewportStyle === true ? Number.NaN : widthText.endsWith("px") ? Number.parseFloat(widthText) : Number.NaN;
        const styleHeight = options.ignoreViewportStyle === true ? Number.NaN : heightText.endsWith("px") ? Number.parseFloat(heightText) : Number.NaN;
        const innerWidth = Number.isFinite(styleWidth) ? Math.round(styleWidth) : options.viewportWidth ?? 1280;
        const innerHeight = Number.isFinite(styleHeight) ? Math.round(styleHeight) : options.viewportHeight ?? 800;
        return {
          innerWidth,
          innerHeight,
          devicePixelRatio: options.devicePixelRatio ?? 1,
          contentWidth: innerWidth - (scrollbarsHiddenQ ? 0 : scrollbarWidthQ),
          scrollWidth: options.viewportWidth ?? 1280,
          scrollHeight: 2400,
        };
      }
      if (code.includes("__dshAgentMetrics")) {
        return {
          title: "Metrics Domain",
          url: "https://example.com/",
          viewport: { width: 1280, height: 800, devicePixelRatio: 1, scrollY: 0 },
          document: { scrollWidth: 1280, scrollHeight: 2400, contentWidth: 1280 },
          overflow: [{ selector: "div#wide", tag: "div", right: 1500, overshoot: 220 }],
          overflowCount: 1,
          images: { total: 3, loaded: 3, failed: 0, failedSrc: [] },
          fonts: { status: "loaded", size: 2 },
          selectors: [{ selector: ".hero", found: true, rect: { x: 10, y: 20, width: 300, height: 200 } }],
        };
      }
      if (code.includes("__dshAgentWait")) {
        if (options.waitMet === false) return { met: false, waitedMs: 8000, conditions: { selector: false } };
        return { met: true, waitedMs: 320, conditions: { selector: true, text: true, networkIdle: true, images: true, fonts: true } };
      }
      if (code.includes("__dshAgentScrollIntoView")) {
        if (options.scrollIntoViewError !== undefined) return { ok: false, error: options.scrollIntoViewError };
        return {
          ok: true,
          tag: "h2",
          label: "Section Two",
          scrollY: 640,
          scrollHeight: 2400,
          innerHeight: 800,
          inViewport: true,
          rect: { x: 10, y: 20, width: 300, height: 40 },
          target: { selector: "#section-2" },
        };
      }
      if (code.includes("__dshAgentLogsProbe")) {
        return {
          imageCount: 4,
          failedImages: [{ src: "https://example.com/broken.png" }],
          resourceCount: 7,
          resources: [{ name: "https://example.com/slow.js", initiatorType: "script", duration: 1200, transferSize: 0 }],
        };
      }
      if (code.includes("__dshAgentScreenshotTarget")) {
        if (options.screenshotTargetError !== undefined) return { ok: false, error: options.screenshotTargetError };
        if (options.screenshotTarget !== undefined) return { ok: true, ...options.screenshotTarget };
        return {
          ok: true,
          viewport: { width: 575, height: 742, devicePixelRatio: 1 },
          rect: { x: 10, y: 20, width: 120, height: 40 },
          clipped: false,
          // Fully visible at the measured scroll position: the default target
          // must keep the legacy clip-to-viewport behaviour (no stitching).
          full: { x: 10, y: 140, width: 120, height: 40 },
          scrollX: 0,
          scrollY: 120,
          target: { tag: "button", label: "Save" },
        };
      }
      if (code.includes("__dshAgentEmulate")) {
        return {
          scheme: options.emulateScheme ?? "dark",
          matchMediaOverridden: true,
          colorScheme: "dark",
          sheets: { scanned: 2, patched: 1, crossOrigin: 0, unreadable: 0 },
          mediaRules: { patched: 1, restored: 0 },
          verified: { darkMatches: true, lightMatches: false },
        };
      }
      if (code.includes("__dshAgentSetContent")) {
        return {
          title: "Local Content",
          url: options.contentUrl ?? "about:blank",
          readyState: "complete",
          viewport: { width: 575, height: 742, devicePixelRatio: 1 },
          scrollHeight: 900,
        };
      }
      if (code.includes("__dshAgentScrollFallback")) {
        const match = /scrollBy\(0,\s*(-?\d+(?:\.\d+)?)\)/.exec(code);
        if (match) scrollY += Number(match[1]);
        return { scrolled: true };
      }
      if (options.trackingScroll === true && code.includes("window.scrollTo({")) {
        const match = /window\.scrollTo\(\{\s*top:\s*(-?\d+(?:\.\d+)?)/.exec(code);
        if (match) pageScroll = Math.max(0, Math.min(Number(match[1]), pageScrollHeight - 742));
        return 1;
      }
      if (code.includes("__dshAgentScrollState")) {
        return options.trackingScroll === true
          ? { scrollY: pageScroll, scrollHeight: pageScrollHeight, innerHeight: 742 }
          : { scrollY: options.statefulScroll === true ? scrollY : 120, scrollHeight: pageScrollHeight, innerHeight: 742 };
      }
      if (code.includes("__dshAgentFocusedValue")) return { value: "deepseek harness" };
      if (code.includes("__dshAgentFocus")) return { ok: true };
      return null;
    },
    insertText: (text) => {
      calls.insertText.push(text);
    },
    sendInputEvent: (event) => {
      calls.sendInputEvent.push(event);
      if (event.type === "mouseDown" && options.clickNavigates === true) calls.clicked = true;
    },
    loadURL: async (url) => {
      calls.loadURL.push(url);
      if (options.denyBlank !== true || !String(url).startsWith("about:blank")) calls.currentUrl = url;
    },
    getURL: () => {
      calls.getURL += 1;
      if (options.statefulUrl === true) return calls.currentUrl ?? "https://example.com/";
      if (options.clickNavigates === true) return calls.clicked === true ? "https://www.iana.org/help/example-domains" : "https://example.com/";
      return "https://example.com/";
    },
    focus: () => {
      calls.focus += 1;
    },
    insertCSS: async () => {},
  };
  return { webview, calls };
}

function makeDshDesktop(acquireError) {
  const released = [];
  return {
    released,
    desktop: {
      protocolVersion: 1,
      browser: {
        async acquire(workspace) {
          if (acquireError !== undefined) throw acquireError;
          return { lease: "lease-test", partition: `partition-${workspace}` };
        },
        async release(lease) {
          released.push(lease);
        },
        onOpenRequested() {
          return () => {};
        },
      },
    },
  };
}

function makeController(options = {}) {
  const loaded = loadClientBundle(clientFile, {
    webview: options.webview,
    dshDesktop: options.desktop,
    transport: options.transport,
    ...(options.imageDecodeHangs === true ? { imageDecodeHangs: true } : {}),
    ...(options.imageOnload === true ? { imageOnload: true } : {}),
  });
  const internals = loaded.plugin.__test;
  assert.ok(internals && typeof internals.createPanelController === "function", "plugin must expose __test.createPanelController");
  let ensurePanelCalls = 0;
  const controller = internals.createPanelController({
    document: loaded.context.document,
    dshDesktop: loaded.context.dshDesktop,
    sleep: async () => {},
    diag: async () => {},
    navigationWaitMs: options.navigationWaitMs ?? 0,
    ...(options.consoleLimit !== undefined ? { consoleLimit: options.consoleLimit } : {}),
    ...(options.evaluateResultLimit !== undefined ? { evaluateResultLimit: options.evaluateResultLimit } : {}),
    ...(options.fullPageMaxCssPx !== undefined ? { fullPageMaxCssPx: options.fullPageMaxCssPx } : {}),
    ...(options.captureTimeoutMs !== undefined ? { captureTimeoutMs: options.captureTimeoutMs } : {}),
    ...(options.decodeTimeoutMs !== undefined ? { decodeTimeoutMs: options.decodeTimeoutMs } : {}),
    ...(options.fullPageBudgetMs !== undefined ? { fullPageBudgetMs: options.fullPageBudgetMs } : {}),
    ...(options.viewportSettleMs !== undefined ? { viewportSettleMs: options.viewportSettleMs } : {}),
    ensurePanel: () => {
      ensurePanelCalls += 1;
      return undefined;
    },
  });
  return { loaded, controller, ensurePanelCalls: () => ensurePanelCalls };
}

/** Mount a mocked controller into a sized panel container and finish dom-ready. */
async function mountController(options = {}) {
  const mock = makeWebviewMock(options.webviewOptions ?? {});
  const { desktop, released } = makeDshDesktop();
  const built = makeController({
    webview: () => mock.webview,
    desktop,
    transport: options.transport,
    navigationWaitMs: options.navigationWaitMs ?? 0,
    ...(options.imageDecodeHangs === true ? { imageDecodeHangs: true } : {}),
    ...(options.imageOnload === true ? { imageOnload: true } : {}),
    ...(options.controllerOptions ?? {}),
  });
  const container = built.loaded.context.document.createElement("div");
  container.clientWidth = options.panelWidth ?? 480;
  container.clientHeight = options.panelHeight ?? 700;
  const mountPromise = built.controller.mount(container);
  await flushMicrotasks();
  const element = container.children.find((child) => child.tagName === "WEBVIEW");
  element.dispatch("dom-ready", {});
  await mountPromise;
  return { ...built, mock, container, desktop, released, element, calls: mock.calls };
}

test("bundle registers the package's client module id", () => {
  const { definition } = loadClientBundle(clientFile);
  assert.equal(definition.id, pkg.name);
});

test("factory returns a client plugin with the services it needs", () => {
  const { plugin } = loadClientBundle(clientFile);
  assert.equal(typeof plugin.apply, "function");
  for (const service of ["slots", "sidebarRight", "sidebarRightTabs"]) {
    assert.ok(plugin.inject.includes(service), `inject should include ${service}`);
  }
});

test("BOOT CONTRACT: apply() returns undefined", () => {
  const { plugin, makeContext } = loadClientBundle(clientFile);
  const harness = makeContext();
  const returned = plugin.apply(harness.ctx);
  assert.equal(returned, undefined, "apply must not return a thenable");
  harness.disposeAll();
});

test("registers the Agent Browser tab type and body slot", () => {
  const { plugin, makeContext } = loadClientBundle(clientFile);
  const harness = makeContext();
  plugin.apply(harness.ctx);
  assert.equal(harness.tabTypes.length, 1);
  assert.equal(harness.tabTypes[0].kind, "agent-browser", "the kind must be stable across reloads (one reusable tab)");
  assert.equal(harness.tabTypes[0].id, "@local/dsh-sidebar-browser-control", "the type id must be stable too");
  assert.equal(typeof harness.tabTypes[0].title, "function");
  assert.equal(harness.slotRegistrations.length, 1);
  assert.equal(harness.slotRegistrations[0].configuration.key, harness.tabTypes[0].id);
  harness.disposeAll();
});

test("legacy per-load tabs are identified for cleanup and current tabs are kept", () => {
  const { plugin } = loadClientBundle(clientFile);
  const staleTabIds = plugin.__test.staleTabIds;
  const tabs = [
    { id: "@local/dsh-sidebar-browser-control-abc123", kind: "agent-browser-abc123" },
    { id: "@local/dsh-sidebar-browser-control-def456", kind: "agent-browser-def456" },
    { id: "@local/dsh-sidebar-browser-control", kind: "agent-browser" },
    { id: "@deepseek-ai/dsh-client-ui-sidebar-browser", kind: "browser" },
    { id: "session-tab-1", kind: "temporary" },
  ];
  assert.deepEqual(
    [...staleTabIds(tabs)],
    ["@local/dsh-sidebar-browser-control-abc123", "@local/dsh-sidebar-browser-control-def456"],
    "only tabs minted by older builds are closed; the stable tab and other plugins stay",
  );
  assert.deepEqual([...staleTabIds(undefined)], []);
  assert.deepEqual([...staleTabIds([{ kind: "agent-browser-old" }])], [], "entries without an id are ignored");
});

test("apply closes legacy tabs left by older builds", () => {
  const { plugin, makeContext, flushTimers } = loadClientBundle(clientFile);
  const harness = makeContext({
    openTabs: [
      { id: "@local/dsh-sidebar-browser-control-abc123", kind: "agent-browser-abc123" },
      { id: "@local/dsh-sidebar-browser-control", kind: "agent-browser" },
    ],
  });
  plugin.apply(harness.ctx);
  flushTimers();
  assert.deepEqual([...harness.closedTabs], ["@local/dsh-sidebar-browser-control-abc123"]);
  harness.disposeAll();
});

test("controller replaces a wedged guest and retries attach when the first attempt never fires", async () => {
  const { webview } = makeWebviewMock();
  const { desktop } = makeDshDesktop();
  const built = makeController({ webview: () => webview, desktop });
  const container = built.loaded.context.document.createElement("div");
  const mountPromise = built.controller.mount(container);
  await flushMicrotasks();
  const first = container.children.find((child) => child.tagName === "WEBVIEW");
  assert.ok(first, "attempt 1 appends a guest");
  built.loaded.flushTimers(); // attempt 1 times out -> rebuild + re-select the tab
  await flushMicrotasks();
  const guests = container.children.filter((child) => child.tagName === "WEBVIEW");
  assert.equal(guests.length, 1, "only the current guest stays in the container");
  assert.notEqual(guests[0], first, "a wedged guest is replaced, not re-appended");
  assert.ok(built.ensurePanelCalls() >= 1, "a retry re-runs the panel ensure path to select the tab");
  guests[0].dispatch("dom-ready", {});
  await mountPromise;
  assert.equal(built.controller.status().ready, true);
  built.controller.unmount();
});

test("a command rebuilds the guest when the ready flag outlives a detached webview", async () => {
  const mounted = await mountController({ webviewOptions: {} });
  const stale = mounted.element;
  stale.isConnected = false; // e.g. a failed mount raced a remount
  const promise = mounted.controller.handle({ type: "evaluate", expression: "1+1" });
  let fresh;
  for (let attempt = 0; attempt < 8 && fresh === undefined; attempt += 1) {
    await flushMicrotasks();
    fresh = mounted.container.children.find((child) => child.tagName === "WEBVIEW" && child !== stale);
  }
  assert.ok(fresh, "the detached guest must be replaced before the command runs");
  fresh.dispatch("dom-ready", {});
  await flushMicrotasks();
  const result = await promise;
  assert.equal(result.ok, true);
  mounted.controller.unmount();
});

test("controller mounts a leased webview and resolves on dom-ready", async () => {
  const { webview } = makeWebviewMock();
  const { desktop, released } = makeDshDesktop();
  const { loaded, controller } = makeController({ webview: () => webview, desktop });
  const container = loaded.context.document.createElement("div");
  const mountPromise = controller.mount(container);
  await flushMicrotasks();
  const element = container.children.find((child) => child.tagName === "WEBVIEW");
  assert.ok(element, "a webview must be appended to the container");
  assert.equal(element.getAttribute("name"), "lease-test");
  element.dispatch("dom-ready", {});
  await mountPromise;
  assert.equal(controller.status().ready, true);
  controller.unmount();
  assert.deepEqual(released, ["lease-test"]);
});

test("status exposes the guest/container geometry used to diagnose black panes", async () => {
  const mounted = await mountController({ webviewOptions: {} });
  const status = mounted.controller.status();
  assert.equal(status.panel.hasWebview, true);
  assert.equal(status.panel.container.connected, true);
  assert.equal(status.panel.element.connected, true);
  assert.equal(status.panel.element.parentIsContainer, true, "the guest must live in the mounted container");
  assert.ok(status.panel.container.width > 0 && status.panel.container.height > 0);
  mounted.controller.unmount();
});

test("ensureMounted reattaches an existing guest into a new tab-body container", async () => {
  const mounted = await mountController({ webviewOptions: {} });
  const second = mounted.loaded.context.document.createElement("div");
  second.clientWidth = 520;
  second.clientHeight = 720;
  await mounted.controller.ensureMounted(second);
  const moved = second.children.filter((child) => child.tagName === "WEBVIEW");
  assert.equal(moved.length, 1, "the existing guest moves into the new container");
  assert.equal(
    mounted.container.children.filter((child) => child.tagName === "WEBVIEW").length,
    0,
    "it must not stay in the stale container",
  );
  const status = mounted.controller.status();
  assert.equal(status.panel.element.parentIsContainer, true);
  assert.equal(status.panel.container.width, 520);
  mounted.controller.unmount();
});

test("navigate rejects non-http(s) and loads allowed URLs", async () => {
  const { webview, calls } = makeWebviewMock();
  const { desktop } = makeDshDesktop();
  const { loaded, controller } = makeController({ webview: () => webview, desktop });
  const container = loaded.context.document.createElement("div");
  const mountPromise = controller.mount(container);
  await flushMicrotasks();
  container.children.find((child) => child.tagName === "WEBVIEW").dispatch("dom-ready", {});
  await mountPromise;
  await assert.rejects(() => controller.handle({ type: "navigate", url: "file:///etc/passwd" }));
  await assert.rejects(() => controller.handle({ type: "navigate", url: "dsh-app://app/" }));
  const result = await controller.handle({ type: "navigate", url: "https://example.com/" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.loadURL, ["https://example.com/"]);
  controller.unmount();
});

test("snapshot delegates to the page snapshot script", async () => {
  const { webview } = makeWebviewMock();
  const { desktop } = makeDshDesktop();
  const { loaded, controller } = makeController({ webview: () => webview, desktop });
  const container = loaded.context.document.createElement("div");
  const mountPromise = controller.mount(container);
  await flushMicrotasks();
  container.children.find((child) => child.tagName === "WEBVIEW").dispatch("dom-ready", {});
  await mountPromise;
  const result = await controller.handle({ type: "snapshot" });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.title, "Example Domain");
  assert.equal(result.snapshot.elements[0].ref, "e0");
  controller.unmount();
});

test("click by ref moves the agent cursor, hit-tests, then sends real mouse input", async () => {
  const { webview, calls } = makeWebviewMock();
  const { desktop } = makeDshDesktop();
  const { loaded, controller } = makeController({ webview: () => webview, desktop });
  const container = loaded.context.document.createElement("div");
  const mountPromise = controller.mount(container);
  await flushMicrotasks();
  container.children.find((child) => child.tagName === "WEBVIEW").dispatch("dom-ready", {});
  await mountPromise;
  const result = await controller.handle({ type: "click", ref: "e0" });
  assert.equal(result.ok, true);
  assert.equal(result.settle?.mutations, 2, "the click must settle before the next observation");
  assert.ok(
    calls.executeJavaScript.some((code) => code.includes("__dshAgentSettle")),
    "the client must wait for DOM quiescence after a click",
  );
  const downs = calls.sendInputEvent.filter((event) => event.type === "mouseDown");
  const ups = calls.sendInputEvent.filter((event) => event.type === "mouseUp");
  assert.equal(downs.length, 1);
  assert.equal(ups.length, 1);
  assert.deepEqual({ x: downs[0].x, y: downs[0].y }, { x: 120, y: 240 });
  assert.ok(
    calls.executeJavaScript.some((code) => code.includes("__dshAgentCursorMove")),
    "the cursor overlay must move to the target before clicking",
  );
  const targetCode = calls.executeJavaScript.filter((code) => code.includes("__dshAgentClickTarget")).at(-1);
  assert.match(targetCode, /requestAnimationFrame/, "the click must wait for scrollIntoView to settle before measuring");
  assert.match(targetCode, /behavior: 'instant'/);
  controller.unmount();
});

test("click by coordinates works without a prior snapshot", async () => {
  const { webview, calls } = makeWebviewMock();
  const { desktop } = makeDshDesktop();
  const { loaded, controller } = makeController({ webview: () => webview, desktop });
  const container = loaded.context.document.createElement("div");
  const mountPromise = controller.mount(container);
  await flushMicrotasks();
  container.children.find((child) => child.tagName === "WEBVIEW").dispatch("dom-ready", {});
  await mountPromise;
  const result = await controller.handle({ type: "click", x: 33, y: 44 });
  assert.equal(result.ok, true);
  const down = calls.sendInputEvent.find((event) => event.type === "mouseDown");
  assert.deepEqual({ x: down.x, y: down.y }, { x: 33, y: 44 });
  controller.unmount();
});

test("click reports navigation from the URL even when no did-navigate event arrives", async () => {
  const { webview } = makeWebviewMock({ clickNavigates: true });
  const { desktop } = makeDshDesktop();
  const { loaded, controller } = makeController({ webview: () => webview, desktop, navigationWaitMs: 0 });
  const container = loaded.context.document.createElement("div");
  const mountPromise = controller.mount(container);
  await flushMicrotasks();
  container.children.find((child) => child.tagName === "WEBVIEW").dispatch("dom-ready", {});
  await mountPromise;
  const result = await controller.handle({ type: "click", ref: "e0" });
  assert.equal(result.ok, true);
  assert.equal(result.navigated, true);
  assert.match(result.url, /iana\.org/);
  controller.unmount();
});

test("scroll falls back to window.scrollBy when the wheel does not move the page", async () => {
  const { webview, calls } = makeWebviewMock({ statefulScroll: true });
  const { desktop } = makeDshDesktop();
  const { loaded, controller } = makeController({ webview: () => webview, desktop });
  const container = loaded.context.document.createElement("div");
  const mountPromise = controller.mount(container);
  await flushMicrotasks();
  container.children.find((child) => child.tagName === "WEBVIEW").dispatch("dom-ready", {});
  await mountPromise;
  const result = await controller.handle({ type: "scroll", deltaY: 400 });
  assert.equal(result.ok, true);
  assert.equal(result.method, "script", "the wheel did not scroll, so the script fallback must run");
  assert.equal(result.scrollY, 400);
  assert.ok(calls.executeJavaScript.some((code) => code.includes("__dshAgentScrollFallback")));
  controller.unmount();
});

test("screenshot returns the capturePage data URL", async () => {
  const { webview } = makeWebviewMock({
    capturePage: async () => ({ toDataURL: () => "data:image/png;base64,AAAA" }),
  });
  const { desktop } = makeDshDesktop();
  const { loaded, controller } = makeController({ webview: () => webview, desktop });
  const container = loaded.context.document.createElement("div");
  const mountPromise = controller.mount(container);
  await flushMicrotasks();
  container.children.find((child) => child.tagName === "WEBVIEW").dispatch("dom-ready", {});
  await mountPromise;
  const result = await controller.handle({ type: "screenshot" });
  assert.equal(result.ok, true);
  assert.match(result.dataUrl, /^data:image\/png;base64,/);
  controller.unmount();
});

test("screenshot fails cleanly when the guest cannot capture", async () => {
  const { webview } = makeWebviewMock();
  const { desktop } = makeDshDesktop();
  const { loaded, controller } = makeController({ webview: () => webview, desktop });
  const container = loaded.context.document.createElement("div");
  const mountPromise = controller.mount(container);
  await flushMicrotasks();
  container.children.find((child) => child.tagName === "WEBVIEW").dispatch("dom-ready", {});
  await mountPromise;
  await assert.rejects(() => controller.handle({ type: "screenshot" }), /capturePage/);
  controller.unmount();
});

test("type focuses the referenced element and commits text through insertText", async () => {
  const { webview, calls } = makeWebviewMock();
  const { desktop } = makeDshDesktop();
  const { loaded, controller } = makeController({ webview: () => webview, desktop });
  const container = loaded.context.document.createElement("div");
  const mountPromise = controller.mount(container);
  await flushMicrotasks();
  container.children.find((child) => child.tagName === "WEBVIEW").dispatch("dom-ready", {});
  await mountPromise;
  const result = await controller.handle({ type: "type", ref: "e1", text: "abc" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.insertText, ["abc"], "type must use the editing pipeline instead of raw char events");
  assert.equal(result.method, "insertText");
  assert.ok(
    calls.executeJavaScript.some((code) => code.includes("__dshAgentFocus")),
    "typing by ref must focus the element first",
  );
  controller.unmount();
});

test("key and scroll dispatch the expected input events", async () => {
  const { webview, calls } = makeWebviewMock();
  const { desktop } = makeDshDesktop();
  const { loaded, controller } = makeController({ webview: () => webview, desktop });
  const container = loaded.context.document.createElement("div");
  const mountPromise = controller.mount(container);
  await flushMicrotasks();
  container.children.find((child) => child.tagName === "WEBVIEW").dispatch("dom-ready", {});
  await mountPromise;
  await controller.handle({ type: "key", key: "Enter" });
  await controller.handle({ type: "scroll", deltaY: 420 });
  const types = calls.sendInputEvent.map((event) => event.type);
  assert.deepEqual(types.slice(0, 3), ["keyDown", "char", "keyUp"], "Enter needs a keypress event for implicit submission");
  assert.ok(
    calls.executeJavaScript.some((code) => code.includes("__dshAgentSubmitForm")),
    "Enter must fall back to form.requestSubmit when no navigation happened",
  );
  const wheel = calls.sendInputEvent.find((event) => event.type === "mouseWheel");
  // Electron's wheel event is inverted relative to the DOM WheelEvent convention:
  // a downward scroll must be sent as a negative deltaY.
  assert.equal(wheel.deltaY, -420, "positive action deltaY must be negated on the Electron wheel event");
  controller.unmount();
});

test("open ensures the panel exists, then navigates once the guest is ready", async () => {
  const { webview, calls } = makeWebviewMock();
  const { desktop } = makeDshDesktop();
  const { loaded, controller, ensurePanelCalls } = makeController({ webview: () => webview, desktop });
  const openPromise = controller.handle({ type: "open", url: "https://example.com/" });
  await flushMicrotasks();
  assert.equal(ensurePanelCalls(), 1, "open must ask the sidebar to show the tab");
  const container = loaded.context.document.createElement("div");
  const mountPromise = controller.mount(container);
  await flushMicrotasks();
  container.children.find((child) => child.tagName === "WEBVIEW").dispatch("dom-ready", {});
  await mountPromise;
  const result = await openPromise;
  assert.equal(result.ok, true);
  assert.deepEqual(calls.loadURL, ["https://example.com/"]);
  controller.unmount();
});

test("commands fail cleanly when the panel is not mounted", async () => {
  const { webview } = makeWebviewMock();
  const { desktop } = makeDshDesktop();
  const { controller } = makeController({ webview: () => webview, desktop });
  const result = await controller.handle({ type: "snapshot" }).catch((error) => ({ error }));
  assert.ok(result.error !== undefined || result.ok === false, "must not silently succeed without a panel");
});

test("unknown commands return an explicit error result", async () => {
  const { webview } = makeWebviewMock();
  const { desktop } = makeDshDesktop();
  const { loaded, controller } = makeController({ webview: () => webview, desktop });
  const container = loaded.context.document.createElement("div");
  const mountPromise = controller.mount(container);
  await flushMicrotasks();
  container.children.find((child) => child.tagName === "WEBVIEW").dispatch("dom-ready", {});
  await mountPromise;
  const result = await controller.handle({ type: "explode" });
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown command/);
  controller.unmount();
});

test("scroll returns the resulting scroll position", async () => {
  const { webview } = makeWebviewMock();
  const { desktop } = makeDshDesktop();
  const { loaded, controller } = makeController({ webview: () => webview, desktop });
  const container = loaded.context.document.createElement("div");
  const mountPromise = controller.mount(container);
  await flushMicrotasks();
  container.children.find((child) => child.tagName === "WEBVIEW").dispatch("dom-ready", {});
  await mountPromise;
  const result = await controller.handle({ type: "scroll", deltaY: 300 });
  assert.equal(result.ok, true);
  assert.equal(result.scrollY, 120);
  assert.equal(result.scrollHeight, 900);
  assert.equal(result.innerHeight, 742);
  controller.unmount();
});

test("type returns the focused element's value after typing", async () => {
  const { webview } = makeWebviewMock();
  const { desktop } = makeDshDesktop();
  const { loaded, controller } = makeController({ webview: () => webview, desktop });
  const container = loaded.context.document.createElement("div");
  const mountPromise = controller.mount(container);
  await flushMicrotasks();
  container.children.find((child) => child.tagName === "WEBVIEW").dispatch("dom-ready", {});
  await mountPromise;
  const result = await controller.handle({ type: "type", ref: "e0", text: "hi" });
  assert.equal(result.ok, true);
  assert.equal(result.value, "deepseek harness");
  controller.unmount();
});

test("click reports navigation when did-navigate fires within the wait window", async () => {
  const { webview } = makeWebviewMock();
  const { desktop } = makeDshDesktop();
  const { loaded, controller } = makeController({ webview: () => webview, desktop, navigationWaitMs: 1000 });
  const container = loaded.context.document.createElement("div");
  const mountPromise = controller.mount(container);
  await flushMicrotasks();
  const element = container.children.find((child) => child.tagName === "WEBVIEW");
  element.dispatch("dom-ready", {});
  await mountPromise;
  const clickPromise = controller.handle({ type: "click", ref: "e0" });
  await flushMicrotasks(24);
  element.dispatch("did-navigate", { url: "https://www.iana.org/help/example-domains" });
  const result = await clickPromise;
  assert.equal(result.ok, true);
  assert.equal(result.navigated, true);
  controller.unmount();
});

test("bridge loop stops polling when the plugin is disposed", async () => {
  const respond = (call) => {
    if (call.url.includes("/hello")) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const loaded = loadClientBundle(clientFile, { respond });
  const harness = loaded.makeContext();
  loaded.plugin.apply(harness.ctx);
  await flushMicrotasks(16);
  const callsBeforeDispose = loaded.fetchCalls.length;
  assert.ok(callsBeforeDispose > 2, "the loop should have started polling");
  harness.disposeAll();
  await flushMicrotasks(24);
  await new Promise((resolve) => setImmediate(resolve));
  const pollsAfterDispose = loaded.fetchCalls
    .slice(callsBeforeDispose)
    .filter((call) => call.url.includes("/poll") || call.url.includes("/hello"));
  assert.equal(pollsAfterDispose.length, 0, "no poll may start after disposal (a final diag is allowed)");
});

test("click surfaces a stale/missing ref as an actionable error", async () => {
  const mock = makeWebviewMock({ clickTargetError: "element ref e9 is stale (the page changed); take a new snapshot" });
  const { desktop } = makeDshDesktop();
  const { loaded, controller } = makeController({ webview: () => mock.webview, desktop });
  const container = loaded.context.document.createElement("div");
  const mountPromise = controller.mount(container);
  await flushMicrotasks();
  container.children.find((child) => child.tagName === "WEBVIEW").dispatch("dom-ready", {});
  await mountPromise;
  await assert.rejects(
    () => controller.handle({ type: "click", ref: "e9" }),
    /stale .*take a new snapshot/i,
  );
  controller.unmount();
});

test("type refuses to report success when the focus is not editable", async () => {
  const mock = makeWebviewMock({ editable: false });
  const { desktop } = makeDshDesktop();
  const { loaded, controller } = makeController({ webview: () => mock.webview, desktop });
  const container = loaded.context.document.createElement("div");
  const mountPromise = controller.mount(container);
  await flushMicrotasks();
  container.children.find((child) => child.tagName === "WEBVIEW").dispatch("dom-ready", {});
  await mountPromise;
  await assert.rejects(
    () => controller.handle({ type: "type", text: "typo" }),
    /not editable/i,
  );
  controller.unmount();
});

// ---------------------------------------------------------------------------
// QA commands (0.2.0): viewport / evaluate / metrics / wait / scrollIntoView /
// logs / screenshot / emulate / setContent / close / status
// ---------------------------------------------------------------------------

test("viewport resizes the guest element to the requested CSS size, reports real numbers, and reset restores auto", async () => {
  const mounted = await mountController({
    panelWidth: 480,
    panelHeight: 700,
    controllerOptions: { viewportSettleMs: 200 },
    // Auto layout reports the panel size; a fixed viewport reports its own px.
    webviewOptions: { viewportWidth: 480, viewportHeight: 700 },
  });
  const { controller, mock } = mounted;
  const result = await controller.handle({ type: "viewport", width: 1280, height: 800 });
  assert.equal(result.ok, true);
  assert.equal(result.width, 1280);
  assert.equal(result.height, 800);
  assert.equal(result.actual.innerWidth, 1280, "the receipt reports the real guest innerWidth, not the request");
  assert.equal(result.actual.innerHeight, 800);
  assert.equal(result.actual.devicePixelRatio, 1);
  assert.equal(result.matched, true, "the command must wait until the guest reports the requested viewport");
  assert.equal(typeof result.settledMs, "number");
  assert.equal(mock.webview.style.width, "1280px");
  assert.equal(mock.webview.style.height, "800px");
  assert.equal(result.scale, 0.375, "480x700 panel shows a 1280x800 guest at 0.375 scale");
  assert.match(mock.webview.style.transform, /scale\(0\.375\)/);
  const status = controller.status();
  assert.deepEqual(plain(status.viewport), { width: 1280, height: 800, scale: 0.375, auto: false });

  const reset = await controller.handle({ type: "viewport", reset: true });
  assert.equal(reset.ok, true);
  assert.equal(reset.reset, true);
  assert.equal(reset.matched, true);
  assert.equal(mock.webview.style.width, "100%");
  assert.equal(mock.webview.style.height, "100%");
  assert.equal(mock.webview.style.transform, "");
  assert.deepEqual(plain(controller.status().viewport), { auto: true });
  controller.unmount();
});

test("viewport reports a warning instead of a fake size when the guest never settles", async () => {
  const mounted = await mountController({
    controllerOptions: { viewportSettleMs: 80 },
    webviewOptions: { viewportWidth: 999, viewportHeight: 888, ignoreViewportStyle: true },
  });
  const result = await mounted.controller.handle({ type: "viewport", width: 1280, height: 800 });
  assert.equal(result.matched, false);
  assert.equal(result.actual.innerWidth, 999, "the receipt reports what the guest actually says");
  assert.equal(result.actual.innerHeight, 888);
  mounted.controller.unmount();
});

test("evaluate returns the page JSON value and cap-truncates a huge result", async () => {
  const mounted = await mountController({ webviewOptions: { evaluateResult: { title: "Example", count: 3 } } });
  const result = await mounted.controller.handle({ type: "evaluate", expression: "({title: document.title, count: 3})" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { title: "Example", count: 3 });

  const big = await mountController({
    controllerOptions: { evaluateResultLimit: 16 },
    webviewOptions: { evaluateResult: "x".repeat(64) },
  });
  const truncated = await big.controller.handle({ type: "evaluate", expression: "'x'.repeat(64)" });
  assert.equal(truncated.ok, true);
  assert.equal(truncated.result.__truncated__, true);
  assert.ok(truncated.result.bytes > 16);
  assert.match(truncated.result.note, /smaller value/);
  big.controller.unmount();
  mounted.controller.unmount();
});

test("evaluate rejects an empty expression", async () => {
  const mounted = await mountController();
  await assert.rejects(() => mounted.controller.handle({ type: "evaluate", expression: "  " }), /non-empty expression/);
  mounted.controller.unmount();
});

test("metrics returns layout data plus console error/warning counts observed from webview events", async () => {
  const mounted = await mountController({ controllerOptions: { consoleLimit: 10 } });
  const { controller, element, calls } = mounted;
  element.dispatch("console-message", { level: 3, message: "boom", line: 12, sourceId: "app.js" });
  element.dispatch("console-message", { level: 2, message: "careful" });
  element.dispatch("console-message", { level: 1, message: "just info" });
  element.dispatch("console-message", { level: "error", message: "string-level error" });
  const result = await controller.handle({ type: "metrics", selectors: [".hero"], includeOverflow: true });
  assert.equal(result.ok, true);
  assert.equal(result.metrics.title, "Metrics Domain");
  assert.equal(result.metrics.document.scrollHeight, 2400);
  assert.equal(result.metrics.overflowCount, 1);
  assert.equal(result.metrics.selectors[0].found, true);
  assert.equal(result.metrics.console.errors, 2, "one numeric + one string error event");
  assert.equal(result.metrics.console.warnings, 1);
  assert.equal(result.metrics.console.total, 4);
  const code = calls.executeJavaScript.find((entry) => entry.includes("__dshAgentMetrics"));
  assert.match(code, /"\.hero"/);
  controller.unmount();
});

test("wait polls page conditions in one page-side script and returns what was met", async () => {
  const mounted = await mountController();
  const { controller, calls } = mounted;
  const result = await controller.handle({
    type: "wait",
    selector: "#ready",
    text: "ready now",
    networkIdle: true,
    idleMs: 250,
    images: true,
    fonts: true,
    ms: 1000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.waitedMs, 320);
  assert.deepEqual(result.conditions, { selector: true, text: true, networkIdle: true, images: true, fonts: true });
  const code = calls.executeJavaScript.find((entry) => entry.includes("__dshAgentWait"));
  assert.match(code, /MutationObserver/, "networkIdle needs in-page mutation observation");
  assert.match(code, /document\.fonts\.status/, "fonts waiting must read document.fonts");
  controller.unmount();
});

test("wait without conditions stays a plain sleep, and a timed-out condition throws with the page state", async () => {
  const mounted = await mountController({ webviewOptions: { waitMet: false } });
  const plain = await mounted.controller.handle({ type: "wait", ms: 25 });
  assert.equal(plain.mode, "sleep");
  assert.equal(plain.waitedMs, 25);
  await assert.rejects(
    () => mounted.controller.handle({ type: "wait", selector: "#never", ms: 800 }),
    /timed out after 8000ms.*selector.*false/,
  );
  mounted.controller.unmount();
});

test("scroll receipt reports requested/actual/clamped deltas and the wheel fallback method", async () => {
  const mounted = await mountController({ webviewOptions: { statefulScroll: true } });
  const result = await mounted.controller.handle({ type: "scroll", deltaY: 200 });
  assert.equal(result.ok, true);
  assert.equal(result.requestedDelta, 200);
  assert.equal(result.actualDelta, 200);
  assert.equal(result.clamped, false);
  assert.equal(result.method, "script");
  const clamped = await mountController();
  const stuck = await clamped.controller.handle({ type: "scroll", deltaY: 400 });
  assert.equal(stuck.actualDelta, 0);
  assert.equal(stuck.clamped, true, "a page that did not move must report clamped");
  clamped.controller.unmount();
  mounted.controller.unmount();
});

test("scrollIntoView scrolls a selector/ref target and reports the resulting position", async () => {
  const mounted = await mountController();
  const result = await mounted.controller.handle({ type: "scrollIntoView", selector: "#section-2", block: "start" });
  assert.equal(result.ok, true);
  assert.equal(result.scrollY, 640);
  assert.equal(result.scrollHeight, 2400);
  assert.equal(result.inViewport, true);
  assert.equal(result.target.selector, "#section-2");
  const code = mounted.calls.executeJavaScript.find((entry) => entry.includes("__dshAgentScrollIntoView"));
  assert.match(code, /behavior: 'instant'/);
  assert.match(code, /block: wanted\.block/);
  mounted.controller.unmount();
});

test("scrollIntoView surfaces a stale ref as an actionable error", async () => {
  const mounted = await mountController({ webviewOptions: { scrollIntoViewError: "element ref e9 is stale (the page changed); take a new snapshot" } });
  await assert.rejects(
    () => mounted.controller.handle({ type: "scrollIntoView", ref: "e9" }),
    /stale .*take a new snapshot/i,
  );
  mounted.controller.unmount();
});

test("logs buffers console messages, filters/limits, clears, and appends the failed-image probe", async () => {
  const mounted = await mountController({ controllerOptions: { consoleLimit: 10 } });
  const { controller, element } = mounted;
  element.dispatch("console-message", { level: 3, message: "Uncaught boom", line: 1, sourceId: "a.js" });
  element.dispatch("console-message", { level: 2, message: "deprecated thing" });
  element.dispatch("console-message", { level: 0, message: "verbose detail" });
  const all = await controller.handle({ type: "logs", limit: 50 });
  assert.equal(all.ok, true);
  assert.equal(all.entries.length, 3);
  assert.equal(all.bufferSize, 3);
  assert.equal(all.bufferLimit, 10);
  assert.equal(all.entries[0].level, "error");
  assert.equal(all.entries[1].level, "warning");
  assert.equal(all.entries[2].level, "verbose");
  assert.equal(all.probe.failedImages[0].src, "https://example.com/broken.png");
  assert.equal(all.probe.resourceCount, 7);

  const filtered = await controller.handle({ type: "logs", filter: "BOOM" });
  assert.equal(filtered.entries.length, 1, "the filter is case-insensitive over entry JSON");

  const limited = await controller.handle({ type: "logs", limit: 2 });
  assert.equal(limited.entries.length, 2);
  assert.equal(limited.matched, 3);

  const cleared = await controller.handle({ type: "logs", clear: true });
  assert.equal(cleared.clearedCount, 3);
  const after = await controller.handle({ type: "logs" });
  assert.equal(after.entries.length, 0);
  controller.unmount();
});

test("screenshot hides the agent cursor, honours element/clip rects, and restores state", async () => {
  const captured = [];
  let mounted;
  mounted = await mountController({
    webviewOptions: {
      capturePage: async (rect) => {
        captured.push({ rect, cursor: "hidden-during-capture", height: mounted.mock.webview.style.height });
        return { toDataURL: () => "data:image/png;base64,AAAA" };
      },
    },
  });
  const result = await mounted.controller.handle({ type: "screenshot" });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "viewport");
  assert.match(result.dataUrl, /^data:image\/png;base64,/);
  const cursorCalls = mounted.calls.executeJavaScript.filter((entry) => entry.includes("__dshAgentCursorVisibility"));
  assert.ok(cursorCalls.length >= 2, "the cursor must be hidden before and restored after capture");
  assert.match(cursorCalls[0], /host\.style\.display = true \? 'none'/);

  const elementShot = await mounted.controller.handle({ type: "screenshot", ref: "e0" });
  assert.equal(elementShot.mode, "element");
  assert.deepEqual(plain(captured.at(-1).rect), { x: 10, y: 20, width: 120, height: 40 });
  assert.equal(elementShot.element.target.label, "Save");

  const clipShot = await mounted.controller.handle({ type: "screenshot", clip: { x: 100, y: 100, width: 5000, height: 50 } });
  assert.equal(clipShot.mode, "clip");
  assert.deepEqual(plain(captured.at(-1).rect), { x: 100, y: 100, width: 1180, height: 50 }, "the clip is clamped to the real viewport");
  mounted.controller.unmount();
});

test("screenshot fullPage stitches viewport captures without resizing the guest", async () => {
  const captured = [];
  let mounted;
  mounted = await mountController({
    controllerOptions: { fullPageMaxCssPx: 1200 },
    webviewOptions: {
      trackingScroll: true,
      capturePage: async () => {
        captured.push({ height: mounted.mock.webview.style.height, flex: mounted.mock.webview.style.flex });
        return { toDataURL: () => "data:image/png;base64,AAAA" };
      },
    },
  });
  const result = await mounted.controller.handle({ type: "screenshot", fullPage: true });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "fullPage");
  assert.equal(result.fullPage.requestedHeight, 900, "scrollHeight comes from the page state script");
  assert.equal(result.fullPage.capturedHeight, 900);
  assert.equal(result.fullPage.capped, false);
  assert.equal(result.fullPage.stitched, true);
  assert.equal(result.fullPage.scrollbarsHidden, true, "fullPage should hide page scrollbars while stitching");
  assert.equal(result.fullPage.segments, 2, "900 CSS px at a 742 px viewport needs two slices");
  assert.equal(captured.length, 2, "one normal-size capturePage per viewport slice");
  assert.equal(captured[0].height, undefined, "the guest must not be resized for fullPage");
  const scrollbarCalls = mounted.calls.executeJavaScript.filter((code) => code.includes("__dshAgentScrollbarVisibility"));
  assert.equal(scrollbarCalls.length, 2, "hide before stitching, restore afterwards");
  assert.match(scrollbarCalls[0], /if \(true\)/);
  assert.match(scrollbarCalls[1], /if \(false\)/);
  const canvas = mounted.loaded.elements.find((element) => Array.isArray(element.__draws) && element.__draws.length > 0);
  assert.ok(canvas, "the stitched image must be drawn into a canvas");
  assert.equal(canvas.height, 900);
  assert.deepEqual(plain(canvas.__draws.map((draw) => draw.y)), [0, 158], "the last slice draws at the clamped bottom scroll");
  const scrollToCalls = mounted.calls.executeJavaScript.filter((code) => code.includes("window.scrollTo({"));
  assert.ok(scrollToCalls.length >= 3);
  assert.match(
    scrollToCalls.at(-1),
    /window\.scrollTo\(\{ top: 120, left: 0, behavior: 'instant' \}\)/,
    "the original scroll position must be restored, bypassing page smooth scrolling",
  );
  mounted.controller.unmount();

  const capped = await mountController({
    controllerOptions: { fullPageMaxCssPx: 500 },
    webviewOptions: {
      trackingScroll: true,
      capturePage: async () => ({ toDataURL: () => "data:image/png;base64,AAAA" }),
    },
  });
  const tallShot = await capped.controller.handle({ type: "screenshot", fullPage: true });
  assert.equal(tallShot.fullPage.capturedHeight, 500);
  assert.equal(tallShot.fullPage.capped, true);
  assert.equal(tallShot.fullPage.segments, 1);
  capped.controller.unmount();
});

test("a hanging capturePage times out instead of wedging the command loop", async () => {
  const mounted = await mountController({
    controllerOptions: { captureTimeoutMs: 40 },
    webviewOptions: { capturePage: () => new Promise(() => {}) },
  });
  const shot = mounted.controller.handle({ type: "screenshot" });
  await flushMicrotasks();
  mounted.loaded.flushTimers();
  await assert.rejects(() => shot, /capturePage timed out/);
  const snapshot = await mounted.controller.handle({ type: "snapshot" });
  assert.equal(snapshot.ok, true, "commands must still be served after a capture timeout");
  mounted.controller.unmount();
});

test("screenshot format=jpeg uses toJPEG quality and rejects a bad target", async () => {
  const jpegCalls = [];
  const mounted = await mountController({
    webviewOptions: {
      capturePage: async () => ({
        toJPEG: (quality) => {
          jpegCalls.push(quality);
          return Uint8Array.from([1, 2, 3]);
        },
      }),
    },
  });
  const result = await mounted.controller.handle({ type: "screenshot", format: "jpeg", quality: 42 });
  assert.equal(result.ok, true);
  assert.match(result.dataUrl, /^data:image\/jpeg;base64,/);
  assert.deepEqual(jpegCalls, [42]);
  mounted.controller.unmount();

  const broken = await mountController({ webviewOptions: { screenshotTargetError: "selector not found: .nope" } });
  await assert.rejects(() => broken.controller.handle({ type: "screenshot", selector: ".nope" }), /selector not found/);
  broken.controller.unmount();
});

test("emulate applies the theme shim, records it in status, and replays it after navigation", async () => {
  const mounted = await mountController({ webviewOptions: { emulateScheme: "dark" } });
  const { controller, calls } = mounted;
  const result = await controller.handle({ type: "emulate", colorScheme: "dark" });
  assert.equal(result.ok, true);
  assert.equal(result.scheme, "dark");
  assert.equal(result.sheets.patched, 1);
  assert.equal(controller.status().theme, "dark");

  const before = calls.executeJavaScript.length;
  const navigated = await controller.handle({ type: "navigate", url: "https://example.com/next" });
  assert.equal(navigated.ok, true);
  const replays = calls.executeJavaScript.slice(before).filter((code) => code.includes("__dshAgentEmulate"));
  assert.equal(replays.length, 1, "the current theme is replayed after navigation");
  assert.match(replays[0], /"dark"/);

  await controller.handle({ type: "emulate", colorScheme: "auto" });
  assert.equal(controller.status().theme, "auto");
  await assert.rejects(() => controller.handle({ type: "emulate", colorScheme: "sepia" }), /colorScheme/);
  controller.unmount();
});

test("setContent renders self-contained HTML on about:blank, injects <base>, and falls back in place", async () => {
  const blank = await mountController({ webviewOptions: { statefulUrl: true } });
  const rendered = await blank.controller.handle({
    type: "setContent",
    html: "<html><head><title>Local</title></head><body><h1>hi</h1></body></html>",
    baseUrl: "https://example.com/app/",
  });
  assert.equal(rendered.ok, true);
  assert.equal(rendered.context, "about:blank");
  assert.equal(rendered.title, "Local Content");
  assert.equal(rendered.injectedBase, true);
  assert.deepEqual(blank.calls.loadURL, ["about:blank"]);
  const contentCode = blank.calls.executeJavaScript.find((entry) => entry.includes("__dshAgentSetContent"));
  assert.match(contentCode, /document\.open\(\)/);
  assert.match(contentCode, /document\.write\(HTML\)/);
  assert.match(contentCode, /<base href=\\"https:\/\/example\.com\/app\/\\">/);
  blank.controller.unmount();

  const inPlace = await mountController({ webviewOptions: { statefulUrl: true, denyBlank: true } });
  const fallback = await inPlace.controller.handle({ type: "setContent", html: "<title>Fallback</title>" });
  assert.equal(fallback.context, "in-place");
  assert.equal(fallback.injectedBase, false);
  inPlace.controller.unmount();
});

test("close releases the lease and action=open can remount a fresh webview", async () => {
  const mounted = await mountController({ webviewOptions: { statefulUrl: true } });
  const { controller, container, released } = mounted;
  const closed = await controller.handle({ type: "close" });
  assert.equal(closed.ok, true);
  assert.equal(closed.closed, true);
  assert.deepEqual(released, ["lease-test"]);
  assert.equal(controller.status().hasWebview, false);
  assert.equal(controller.status().ready, false);

  const openPromise = controller.handle({ type: "open", url: "https://example.com/reopened" });
  await flushMicrotasks(16);
  const webviews = container.children.filter((child) => child.tagName === "WEBVIEW");
  assert.equal(webviews.length, 2, "a fresh webview must be appended to the existing container");
  const replacement = webviews.at(-1);
  assert.notEqual(replacement, mounted.element);
  replacement.dispatch("dom-ready", {});
  const reopened = await openPromise;
  assert.equal(reopened.ok, true);
  assert.equal(reopened.url, "https://example.com/reopened");
  assert.equal(controller.status().ready, true);
  controller.unmount();
});

test("close reports closed:false when no panel was ever mounted", async () => {
  const mock = makeWebviewMock();
  const { desktop } = makeDshDesktop();
  const { controller } = makeController({ webview: () => mock.webview, desktop });
  const result = await controller.handle({ type: "close" });
  assert.deepEqual(plain(result), { ok: true, closed: false });
});

test("status merges viewport/theme/console counters/last url and keeps the original fields", async () => {
  const mounted = await mountController({ webviewOptions: { statefulUrl: true, emulateScheme: "light" } });
  const { controller, element } = mounted;
  await controller.handle({ type: "viewport", width: 375, height: 700 });
  await controller.handle({ type: "emulate", colorScheme: "light" });
  element.dispatch("console-message", { level: 3, message: "one error" });
  await controller.handle({ type: "navigate", url: "https://example.com/next" });
  const status = controller.status();
  assert.equal(status.ready, true);
  assert.equal(status.hasWebview, true);
  assert.equal(status.theme, "light");
  assert.equal(status.viewport.width, 375);
  assert.equal(status.viewport.auto, false);
  assert.equal(status.console.errors, 1);
  assert.equal(status.console.buffer, 1);
  assert.equal(status.lastUrl, "https://example.com/next");
  assert.equal(typeof status.title, "string");
  mounted.controller.unmount();
});

test("navigate opens the panel when called before it is mounted", async () => {
  const mock = makeWebviewMock();
  const { desktop } = makeDshDesktop();
  const { loaded, controller, ensurePanelCalls } = makeController({ webview: () => mock.webview, desktop });
  const navPromise = controller.handle({ type: "navigate", url: "https://example.com/first" });
  await flushMicrotasks();
  assert.equal(ensurePanelCalls(), 1, "navigate must ask the sidebar to show the tab like open does");
  const container = loaded.context.document.createElement("div");
  const mountPromise = controller.mount(container);
  await flushMicrotasks();
  container.children.find((child) => child.tagName === "WEBVIEW").dispatch("dom-ready", {});
  await mountPromise;
  const result = await navPromise;
  assert.equal(result.ok, true);
  assert.deepEqual(mock.calls.loadURL, ["https://example.com/first"]);
  controller.unmount();
});

test("click navigation replays the current theme emulation on the new document", async () => {
  const mounted = await mountController({ webviewOptions: { clickNavigates: true } });
  const { controller, calls } = mounted;
  await controller.handle({ type: "emulate", colorScheme: "dark" });
  const countEmulates = () => calls.executeJavaScript.filter((code) => code.includes("__dshAgentEmulate")).length;
  assert.equal(countEmulates(), 1, "the explicit emulate call installs the shim once");
  const clicked = await controller.handle({ type: "click", ref: "e0" });
  assert.equal(clicked.navigated, true);
  assert.equal(countEmulates(), 2, "a click that navigates must replay the theme shim on the new document");
  controller.unmount();
});

// ---------------------------------------------------------------------------
// 0.2.4 round 2: stale open recovery, fullPage hardening, viewport scrollbars
// + contentWidth, tall-element scroll stitching.
// ---------------------------------------------------------------------------

function makeCountingDesktop() {
  const state = { released: [], acquireCalls: 0 };
  const desktop = {
    protocolVersion: 1,
    browser: {
      async acquire() {
        state.acquireCalls += 1;
        return { lease: `lease-${state.acquireCalls}`, partition: `partition-${state.acquireCalls}` };
      },
      async release(lease) {
        state.released.push(lease);
      },
      onOpenRequested() {
        return () => {};
      },
    },
  };
  return { desktop, state };
}

test("open recovers once from a stale panel whose webview never becomes ready", async () => {
  const mock = makeWebviewMock();
  const { desktop, state } = makeCountingDesktop();
  const { loaded, controller } = makeController({ webview: () => mock.webview, desktop });
  const openPromise = controller.handle({ type: "open", url: "https://example.com/" });
  await flushMicrotasks();
  const container = loaded.context.document.createElement("div");
  controller.mount(container).catch(() => {});
  await flushMicrotasks();
  // The first webview never fires dom-ready: run its three attach attempts and
  // the 2.5s ready wait until the stale recovery remounts a fresh guest.
  for (let i = 0; i < 12; i += 1) {
    loaded.flushTimers();
    await flushMicrotasks();
    if (container.children.filter((child) => child.tagName === "WEBVIEW").length >= 2) break;
  }
  const webviews = container.children.filter((child) => child.tagName === "WEBVIEW");
  assert.equal(webviews.length, 2, "the stale guest must be unmounted and a fresh one mounted into the same container");
  assert.equal(state.acquireCalls, 2, "exactly one remount: two leases in total");
  assert.deepEqual(state.released, ["lease-1"], "the stale lease was released before remounting");
  webviews.at(-1).dispatch("dom-ready", {});
  await flushMicrotasks();
  const result = await openPromise;
  assert.equal(result.ok, true);
  assert.match(result.url, /example\.com/);
  const remountDiags = loaded.fetchCalls
    .filter((call) => call.url.includes("/diag"))
    .map((call) => JSON.parse(String(call.init?.body ?? "{}")))
    .filter((body) => body?.value?.phase === "stale-remounted");
  assert.ok(remountDiags.length >= 1, "the recovery should record a stale-remounted diagnostic");
  const attachDiags = loaded.fetchCalls
    .filter((call) => call.url.includes("/diag"))
    .map((call) => JSON.parse(String(call.init?.body ?? "{}")))
    .filter((body) => body?.value?.phase === "attach-attempt");
  assert.ok(attachDiags.length >= 2, "the mount should retry the guest attach and record each attempt");
  controller.unmount();
});

test("open surfaces a close/open recovery hint after one remount and the floating fallback fail", async () => {
  const mock = makeWebviewMock();
  const { desktop } = makeCountingDesktop();
  const { loaded, controller } = makeController({ webview: () => mock.webview, desktop });
  const openPromise = controller.handle({ type: "open", url: "https://example.com/" });
  await flushMicrotasks();
  const container = loaded.context.document.createElement("div");
  controller.mount(container).catch(() => {});
  await flushMicrotasks();
  // Neither mount ever attaches: drain the attach retries and both ready waits.
  for (let i = 0; i < 20; i += 1) {
    loaded.flushTimers();
    await flushMicrotasks();
  }
  // 0.2.11: open/navigate report failures as a {ok:false} receipt instead of
  // throwing, so the actionable close/open hint must ride the resolved error.
  const result = await openPromise;
  assert.equal(result?.ok, false, "an open that never becomes ready must be reported as a failure, not a hang");
  assert.match(
    result.error,
    /close the Agent Browser tab and call action=open/,
    "the caller must get an actionable close/open hint, not a bare timeout",
  );
  controller.unmount();
});

test("fullPage stitches report stage diagnostics, per-step timings and finished inside the budget", async () => {  const mounted = await mountController({
    controllerOptions: { fullPageMaxCssPx: 1200, fullPageBudgetMs: 10000 },
    webviewOptions: {
      trackingScroll: true,
      pageScrollHeight: 3000,
      capturePage: async () => ({ toDataURL: () => "data:image/png;base64,AAAA" }),
    },
  });
  const result = await mounted.controller.handle({ type: "screenshot", fullPage: true });
  assert.equal(result.ok, true);
  const timings = result.fullPage.timings;
  assert.equal(timings.segments, result.fullPage.segments);
  assert.equal(Array.isArray(timings.captureMs), true);
  assert.equal(Array.isArray(timings.encodeMs), true);
  assert.equal(timings.captureMs.length, timings.segments, "one capture timing per stitched segment");
  assert.equal(timings.encodeMs.length, timings.segments, "one encode timing per stitched segment");
  assert.ok(Number.isFinite(timings.totalMs) && timings.totalMs >= 0, `totalMs must be reported, got ${timings.totalMs}`);
  const diagFases = new Set(
    mounted.loaded.fetchCalls
      .filter((call) => call.url.includes("/diag"))
      .map((call) => JSON.parse(String(call.init?.body ?? "{}")))
      .filter((body) => body?.tag === "fullpage")
      .map((body) => body.value?.phase),
  );
  for (const phase of ["begin", "hideScrollbars", "segment-start", "segment-capture", "segment-encode", "stitch", "restore"]) {
    assert.equal(diagFases.has(phase), true, `the fullPage capture must post the "${phase}" stage diagnostic`);
  }
  assert.equal(diagFases.has("error"), false, "a successful capture must not post an error stage");
  mounted.controller.unmount();
});

test("a hanging segment decode times out with a phase label instead of wedging the stitch", async () => {
  const mounted = await mountController({
    imageDecodeHangs: true,
    controllerOptions: { decodeTimeoutMs: 40 },
    webviewOptions: {
      trackingScroll: true,
      pageScrollHeight: 2000,
      capturePage: async () => ({ toDataURL: () => "data:image/png;base64,AAAA" }),
    },
  });
  const { controller, loaded } = mounted;
  const shot = controller.handle({ type: "screenshot", fullPage: true });
  // Drive the mocked capture loop: every mocked call settles inside
  // microtasks, so keep flushing until the only outstanding sandbox timer is
  // the decode deadline (flushing earlier would trip a capture race instead).
  for (let round = 0; round < 8; round += 1) await flushMicrotasks(30);
  const pendingTimers = loaded.timers.map((timer) => timer.ms);
  assert.deepEqual(
    JSON.parse(JSON.stringify(pendingTimers)),
    [40],
    `only the decode deadline may remain pending, got ${JSON.stringify(pendingTimers)}`,
  );
  loaded.flushTimers();
  await flushMicrotasks(30);
  await assert.rejects(() => shot, /image decode timed out after 40ms/, "the decode timeout must carry an explicit phase label");
  const errorDiags = loaded.fetchCalls
    .filter((call) => call.url.includes("/diag"))
    .map((call) => JSON.parse(String(call.init?.body ?? "{}")))
    .filter((body) => body?.tag === "fullpage" && body.value?.phase === "error");
  assert.ok(errorDiags.length >= 1, "the failed capture must post an error stage to the diagnostic channel");
  const after = await controller.handle({ type: "snapshot" });
  assert.equal(after.ok, true, "commands must still be served after the capture bailed out");
  controller.unmount();
});

test("fullPage stops at its total wall budget and reports how far it got", async () => {
  const mounted = await mountController({
    controllerOptions: { fullPageBudgetMs: 1 },
    webviewOptions: {
      trackingScroll: true,
      pageScrollHeight: 3000,
      // A real async capture makes the wall clock advance across segments even
      // with the instant sleep mock.
      capturePage: async () => {
        await new Promise((resolve) => setTimeout(resolve, 4));
        return { toDataURL: () => "data:image/png;base64,AAAA" };
      },
    },
  });
  const shot = mounted.controller.handle({ type: "screenshot", fullPage: true });
  await flushMicrotasks();
  await assert.rejects(() => shot, /exceeded its 1ms budget/, "the total budget must abort the capture instead of hanging");
  const after = await mounted.controller.handle({ type: "snapshot" });
  assert.equal(after.ok, true, "commands must still be served after a budget abort");
  mounted.controller.unmount();
});

test("viewport scrollbars:'hidden' hides page scrollbars persistently and reports contentWidth", async () => {
  const mounted = await mountController({
    webviewOptions: { viewportWidth: 575, viewportHeight: 742, scrollbarWidth: 15 },
  });
  const { controller, calls, mock } = mounted;
  const hidden = await controller.handle({ type: "viewport", width: 800, height: 600, scrollbars: "hidden" });
  assert.equal(hidden.ok, true);
  assert.equal(hidden.scrollbars, "hidden");
  assert.equal(hidden.contentWidth, 800, "with scrollbars hidden the content gets the full viewport width");
  assert.equal(hidden.actual.contentWidth, 800);
  assert.equal(mock.webview.style.width, "800px");
  const hideCalls = calls.executeJavaScript.filter((code) => code.includes("__dshAgentScrollbarVisibility"));
  assert.match(hideCalls.at(-1), /if \(true\)/, "viewport scrollbars:'hidden' must inject the same hide style fullPage uses");

  const auto = await controller.handle({ type: "viewport", width: 390, height: 844 });
  assert.equal(auto.scrollbars, "auto");
  assert.equal(auto.contentWidth, 375, "with classic scrollbars the content width is innerWidth minus the scrollbar");
  const restoreCalls = calls.executeJavaScript.filter((code) => code.includes("__dshAgentScrollbarVisibility"));
  assert.match(restoreCalls.at(-1), /if \(false\)/, "switching back to auto removes the persistent hide style");

  // The persistent hide style must be replayed on a fresh document.
  await controller.handle({ type: "viewport", width: 800, height: 600, scrollbars: "hidden" });
  const before = calls.executeJavaScript.length;
  await controller.handle({ type: "navigate", url: "https://example.com/next" });
  const after = calls.executeJavaScript.slice(before).filter((code) => code.includes("__dshAgentScrollbarVisibility"));
  assert.match(after.at(-1), /if \(true\)/, "navigation must replay the hidden-scrollbar style");

  const reset = await controller.handle({ type: "viewport", reset: true });
  assert.equal(reset.scrollbars, "auto");
  const finalCalls = calls.executeJavaScript.filter((code) => code.includes("__dshAgentScrollbarVisibility"));
  assert.match(finalCalls.at(-1), /if \(false\)/, "viewport reset must remove the persistent hide style");
  controller.unmount();
});

test("tall element screenshots scroll-stitch the element instead of clipping the first screen", async () => {
  const captured = [];
  const mounted = await mountController({
    webviewOptions: {
      trackingScroll: true,
      // The page must be tall enough to hold the whole element (400 + 2226).
      pageScrollHeight: 3000,
      capturePage: async (rect) => {
        captured.push({ ...rect });
        return { toDataURL: () => "data:image/png;base64,AAAA" };
      },
      screenshotTarget: {
        viewport: { width: 575, height: 742, devicePixelRatio: 1 },
        rect: { x: 0, y: 0, width: 500, height: 742 },
        clipped: true,
        full: { x: 0, y: 400, width: 500, height: 2226 },
        scrollX: 0,
        scrollY: 400,
        target: { tag: "section", label: "Very Tall" },
      },
    },
  });
  const { controller, calls } = mounted;
  const result = await controller.handle({ type: "screenshot", selector: ".very-tall" });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "element", "the receipt mode stays 'element' for a stitched tall element");
  const element = result.element;
  assert.equal(element.stitched, true);
  assert.equal(element.segments, 3, "2226 CSS px at a 742 px viewport needs three slices");
  assert.equal(element.fullHeight, 2226);
  assert.equal(element.fullWidth, 500);
  assert.equal(element.capped, false);
  assert.equal(element.croppedWidth, 0);
  assert.equal(captured.length, 3, "one capturePage(rect) per element slice");
  for (const rect of captured) {
    assert.deepEqual(
      { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      { x: 0, y: 0, width: 500, height: 742 },
      "each slice captures the element's visible band of the viewport",
    );
  }
  {
    const canvas = mounted.loaded.elements.find((el) => Array.isArray(el.__draws) && el.__draws.length > 0 && el.width === 500);
    assert.ok(canvas, "the slices must be stitched into one element-sized canvas");
    assert.equal(canvas.height, 2226);
    assert.deepEqual(plain(canvas.__draws.map((draw) => draw.y)), [0, 742, 1484], "slices line up at their clamped scroll offsets");
    assert.deepEqual(plain(canvas.__draws.map((draw) => draw.height)), [742, 742, 742]);
  }
  // Restore: scroll position and scrollbar style are put back after capture.
  const scrollToCalls = calls.executeJavaScript.filter((code) => code.includes("window.scrollTo({"));
  assert.match(
    scrollToCalls.at(-1),
    /window\.scrollTo\(\{ top: 120, left: 0, behavior: 'instant' \}\)/,
    "the original (pre-capture) scroll position must be restored",
  );
  const scrollbarCalls = calls.executeJavaScript.filter((code) => code.includes("__dshAgentScrollbarVisibility"));
  assert.match(scrollbarCalls.at(-1), /if \(false\)/, "the hide-scrollbar style must be removed after the capture");
  controller.unmount();
});

test("super-tall element captures stop at the 12000-cap and over-wide elements are cropped, not faked", async () => {
  const capped = await mountController({
    controllerOptions: { fullPageMaxCssPx: 1200 },
    webviewOptions: {
      trackingScroll: true,
      pageScrollHeight: 6000,
      capturePage: async () => ({ toDataURL: () => "data:image/png;base64,AAAA" }),
      screenshotTarget: {
        viewport: { width: 575, height: 742, devicePixelRatio: 1 },
        rect: { x: 0, y: 0, width: 500, height: 742 },
        clipped: true,
        full: { x: 0, y: 400, width: 500, height: 5000 },
        scrollX: 0,
        scrollY: 400,
        target: { tag: "section", label: "Extremely Tall" },
      },
    },
  });
  const cappedShot = await capped.controller.handle({ type: "screenshot", selector: ".extremely-tall" });
  assert.equal(cappedShot.element.capped, true, "the total element height is capped like fullPage");
  assert.equal(cappedShot.element.capturedHeight, 1200);
  assert.equal(cappedShot.element.segments, 2);
  assert.equal(cappedShot.element.fullHeight, 5000);
  assert.deepEqual(plain(cappedShot.element.fullRect), { x: 0, y: 400, width: 500, height: 5000 });
  capped.controller.unmount();

  const mounted = await mountController({
    webviewOptions: {
      trackingScroll: true,
      pageScrollHeight: 2400,
      capturePage: async () => ({ toDataURL: () => "data:image/png;base64,AAAA" }),
      screenshotTarget: {
        viewport: { width: 575, height: 742, devicePixelRatio: 1 },
        rect: { x: 500, y: 0, width: 75, height: 742 },
        clipped: true,
        full: { x: 500, y: 120, width: 600, height: 1000 },
        scrollX: 0,
        scrollY: 120,
        target: { tag: "section", label: "Wide And Tall" },
      },
    },
  });
  const wide = await mounted.controller.handle({ type: "screenshot", selector: ".wide-tall" });
  assert.equal(wide.element.segments, 2);
  assert.equal(wide.element.croppedWidth, 525, "the part beyond the viewport width is reported as cropped");
  mounted.controller.unmount();
});

// ---------------------------------------------------------------------------
// 0.2.10 desktop-shell DSH Host isolation guard + status.lastLoadFailure.
// The shell cancels every guest request to the Host's own origin (any loopback
// hostname on the Host port), which Chromium surfaces only as a bare
// ERR_FAILED; the client must refuse such open/navigate commands before the
// guest is mounted and expose the guest's last did-fail-load in status().
// ---------------------------------------------------------------------------

const DSH_HOST_ORIGIN = "http://127.0.0.1:55544";
/** Shape the desktop shell publishes on globalThis.__DSH_TRANSPORT__. */
const DSH_TRANSPORT = { ownsHost: true, streamBaseUrl: DSH_HOST_ORIGIN };

/** Unmounted controller that simulates the desktop shell's transport marker. */
function makeHostIsolationHarness(transport = DSH_TRANSPORT) {
  const mock = makeWebviewMock();
  const { desktop } = makeDshDesktop();
  const built = makeController({ webview: () => mock.webview, desktop, transport });
  return { ...built, calls: mock.calls };
}

/**
 * Await an open/navigate refusal without hanging the test when the guard is
 * missing: the legacy code path would wait for a panel that never becomes
 * ready. Fails with the contract expectation when the command throws instead
 * of resolving the refusal object.
 */
async function settleRefusal(promise) {
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout", value: undefined }), 400);
  });
  const settled = await Promise.race([
    promise.then(
      (value) => ({ kind: "value", value }),
      (error) => ({ kind: "error", value: undefined, error }),
    ),
    timedOut,
  ]);
  clearTimeout(timer);
  assert.notEqual(settled.kind, "timeout", "a refused load must settle immediately, not wait for a panel mount");
  assert.equal(
    settled.kind,
    "value",
    `a refused load must resolve {ok:false,error}, got a rejection: ${settled.error?.message ?? settled.error}`,
  );
  return settled.value;
}

/** Assert one desktop-shell refusal plus the no-load/no-mount guarantees. */
function assertHostRefusal(built, result, targetUrl) {
  assert.equal(result?.ok, false, `the refused load must resolve ok:false, got ${JSON.stringify(result)}`);
  assert.equal(typeof result.error, "string", "the refusal must carry a string error message");
  for (const part of ["desktop shell", DSH_HOST_ORIGIN, "ERR_FAILED", "setContent", "preview", targetUrl]) {
    assert.ok(result.error.includes(part), `the refusal must mention "${part}", got: ${result.error}`);
  }
  assert.deepEqual(built.calls.loadURL, [], "a refused load must never reach webview.loadURL");
  assert.equal(built.ensurePanelCalls(), 0, "a refused load must not open/mount the panel");
  assert.equal(
    built.loaded.elements.filter((element) => element.tagName === "WEBVIEW").length,
    0,
    "a refused load must not create the guest element either",
  );
}

test("open refuses the DSH Host origin before loading or mounting the panel", async () => {
  const built = makeHostIsolationHarness();
  const target = `${DSH_HOST_ORIGIN}/`;
  const result = await settleRefusal(built.controller.handle({ type: "open", url: target }));
  assertHostRefusal(built, result, target);
});

test("navigate refuses the DSH Host origin with the same actionable refusal", async () => {
  const built = makeHostIsolationHarness();
  const target = `${DSH_HOST_ORIGIN}/assets/x.js`;
  const result = await settleRefusal(built.controller.handle({ type: "navigate", url: target }));
  assertHostRefusal(built, result, target);
});

test("the host guard treats localhost as the same blocked loopback host", async () => {
  const built = makeHostIsolationHarness();
  const target = "http://localhost:55544/manifest.webmanifest";
  const result = await settleRefusal(built.controller.handle({ type: "open", url: target }));
  assertHostRefusal(built, result, target);
});

test("the host guard treats [::1] as the same blocked loopback host", async () => {
  const built = makeHostIsolationHarness();
  const target = "http://[::1]:55544/";
  const result = await settleRefusal(built.controller.handle({ type: "navigate", url: target }));
  assertHostRefusal(built, result, target);
});

test("a different loopback port is allowed and reaches loadURL", async () => {
  const mounted = await mountController({ transport: DSH_TRANSPORT });
  const result = await mounted.controller.handle({ type: "open", url: "http://127.0.0.1:47834/" });
  assert.equal(result.ok, true);
  assert.deepEqual(mounted.calls.loadURL, ["http://127.0.0.1:47834/"]);
  mounted.controller.unmount();
});

test("a non-loopback hostname on the host port is allowed", async () => {
  const mounted = await mountController({ transport: DSH_TRANSPORT });
  const result = await mounted.controller.handle({ type: "navigate", url: "http://example.com:55544/" });
  assert.equal(result.ok, true);
  assert.deepEqual(mounted.calls.loadURL, ["http://example.com:55544/"]);
  mounted.controller.unmount();
});

test("without the desktop transport marker a loopback host URL keeps the legacy behavior", async () => {
  // Standalone 'dsh web' (or an older shell) exposes no __DSH_TRANSPORT__: the
  // guard must stay out of the way and the load must go through as before.
  const mounted = await mountController();
  const target = `${DSH_HOST_ORIGIN}/`;
  const result = await mounted.controller.handle({ type: "open", url: target });
  assert.equal(result.ok, true);
  assert.deepEqual(mounted.calls.loadURL, [target]);
  mounted.controller.unmount();
});

test("a transport that does not own the Host leaves loopback host URLs loadable", async () => {
  const mounted = await mountController({ transport: { ownsHost: false, streamBaseUrl: DSH_HOST_ORIGIN } });
  const target = `${DSH_HOST_ORIGIN}/`;
  const result = await mounted.controller.handle({ type: "navigate", url: target });
  assert.equal(result.ok, true);
  assert.deepEqual(mounted.calls.loadURL, [target]);
  mounted.controller.unmount();
});

test("status records the guest's last did-fail-load failure", async () => {
  const mounted = await mountController();
  const target = `${DSH_HOST_ORIGIN}/`;
  mounted.element.dispatch("did-fail-load", {
    errorCode: -2,
    errorDescription: "ERR_FAILED",
    validatedURL: target,
    isMainFrame: true,
  });
  const status = mounted.controller.status();
  assert.ok(status.lastLoadFailure, "status must expose lastLoadFailure after a failed guest load");
  const failure = plain(status.lastLoadFailure);
  assert.equal(failure.errorCode, -2);
  assert.equal(failure.errorDescription, "ERR_FAILED");
  assert.equal(failure.validatedURL, target);
  assert.equal(failure.isMainFrame, true);
  assert.equal(typeof failure.at, "number");
  // Only an explicit isMainFrame:false counts as a subframe failure.
  mounted.element.dispatch("did-fail-load", { errorCode: -105, errorDescription: "NAME_NOT_RESOLVED", isMainFrame: false });
  assert.equal(mounted.controller.status().lastLoadFailure.isMainFrame, false);
  mounted.controller.unmount();
});

// ---------------------------------------------------------------------------
// 0.2.11 structured open/navigate failure receipts.
// A refused guest load surfaces in Electron as the raw IPC wrapper
// "Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ERR_... (-N)
// loading '<url>'"; the client must normalize it, keep the attempted URL, and
// never report a navigation that only reached Chromium's error page as loaded.
// ---------------------------------------------------------------------------

/** An unlistened loopback port: the shell does not block it, the load refuses. */
const UNAVAILABLE_URL = "http://127.0.0.1:55545/";

/** Exactly the wrapper the desktop shell surfaces for a failed guest load. */
function guestViewManagerFailure(url) {
  return new Error(
    `Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ERR_CONNECTION_REFUSED (-102) loading '${url}'`,
  );
}

/** main-frame did-fail-load payload for a refused connection. */
function refusedConnectionEvent(url) {
  return { errorCode: -102, errorDescription: "ERR_CONNECTION_REFUSED", validatedURL: url, isMainFrame: true };
}

/** The agent-facing error must be a clean Chromium failure, never the IPC wrapper. */
function assertNormalizedLoadError(result, url) {
  assert.equal(typeof result.error, "string", `a failed load must carry a string error, got ${JSON.stringify(result)}`);
  assert.ok(
    result.error.includes("ERR_CONNECTION_REFUSED (-102)"),
    `the normalized error must keep the Chromium code, got: ${result.error}`,
  );
  assert.ok(result.error.includes(url), `the normalized error must keep the attempted URL, got: ${result.error}`);
  assert.ok(
    !result.error.includes("Error invoking remote method"),
    `the raw Electron IPC wrapper must not reach the agent, got: ${result.error}`,
  );
  assert.ok(
    !result.error.includes("GUEST_VIEW_MANAGER_CALL"),
    `the raw GUEST_VIEW_MANAGER_CALL text must not reach the agent, got: ${result.error}`,
  );
}

/** The recorded did-fail-load shape attached to a failed load result. */
function assertRecordedFailure(failure, url) {
  assert.ok(failure !== undefined && failure !== null, "the result must carry the recorded loadFailure");
  const recorded = plain(failure);
  assert.equal(recorded.errorCode, -102);
  assert.equal(recorded.errorDescription, "ERR_CONNECTION_REFUSED");
  assert.equal(recorded.validatedURL, url);
  assert.equal(recorded.isMainFrame, true);
  assert.equal(typeof recorded.at, "number", "the failure must record when it happened");
}

test("0.2.11 client open: a rejected loadURL resolves ok:false with a normalized error and attemptedUrl", async () => {
  const mounted = await mountController({ transport: DSH_TRANSPORT });
  mounted.element.loadURL = async (url) => {
    mounted.calls.loadURL.push(url);
    throw guestViewManagerFailure(url);
  };
  const result = await mounted.controller.handle({ type: "open", url: UNAVAILABLE_URL });
  assert.equal(result.ok, false, `a failed load must resolve ok:false instead of throwing, got ${JSON.stringify(result)}`);
  assertNormalizedLoadError(result, UNAVAILABLE_URL);
  assert.equal(result.attemptedUrl, UNAVAILABLE_URL, "the receipt must name the URL the panel tried to load");
  mounted.controller.unmount();
});

test("0.2.11 client navigate: a rejected loadURL resolves the same normalized failure", async () => {
  const mounted = await mountController({ transport: DSH_TRANSPORT });
  mounted.element.loadURL = async (url) => {
    mounted.calls.loadURL.push(url);
    throw guestViewManagerFailure(url);
  };
  const result = await mounted.controller.handle({ type: "navigate", url: UNAVAILABLE_URL });
  assert.equal(result.ok, false, `a failed navigate must resolve ok:false, got ${JSON.stringify(result)}`);
  assertNormalizedLoadError(result, UNAVAILABLE_URL);
  assert.equal(result.attemptedUrl, UNAVAILABLE_URL);
  mounted.controller.unmount();
});

test("0.2.11 client: a rejection after a main-frame did-fail-load carries the recorded failure", async () => {
  const mounted = await mountController({ transport: DSH_TRANSPORT });
  mounted.element.loadURL = async (url) => {
    mounted.calls.loadURL.push(url);
    mounted.element.dispatch("did-fail-load", refusedConnectionEvent(url));
    throw guestViewManagerFailure(url);
  };
  const result = await mounted.controller.handle({ type: "open", url: UNAVAILABLE_URL });
  assert.equal(result.ok, false);
  assertNormalizedLoadError(result, UNAVAILABLE_URL);
  assert.equal(result.attemptedUrl, UNAVAILABLE_URL);
  assertRecordedFailure(result.loadFailure, UNAVAILABLE_URL);
  mounted.controller.unmount();
});

test("0.2.11 client open: a load that lands on Chromium's error page reports loaded:false and a warning", async () => {
  const mounted = await mountController({ transport: DSH_TRANSPORT });
  // loadURL resolves, but the guest only produced Chromium's error page.
  mounted.element.loadURL = async (url) => {
    mounted.calls.loadURL.push(url);
    mounted.element.dispatch("did-fail-load", refusedConnectionEvent(url));
  };
  const result = await mounted.controller.handle({ type: "open", url: UNAVAILABLE_URL });
  assert.equal(result.ok, true, `the command itself resolved, got ${JSON.stringify(result)}`);
  assert.equal(result.loaded, false, "a navigation that only reached Chromium's error page is not a loaded page");
  assert.equal(result.attemptedUrl, UNAVAILABLE_URL);
  assertRecordedFailure(result.loadFailure, UNAVAILABLE_URL);
  assert.match(String(result.warning), /ERR_CONNECTION_REFUSED|\(-102\)/u, "the warning must name the failure code");
  assert.match(String(result.warning), /error page|Chromium/iu, "the warning must explain that the panel shows the error page");
  mounted.controller.unmount();
});

test("0.2.11 client navigate: a load that lands on Chromium's error page reports loaded:false and a warning", async () => {
  const mounted = await mountController({ transport: DSH_TRANSPORT });
  mounted.element.loadURL = async (url) => {
    mounted.calls.loadURL.push(url);
    mounted.element.dispatch("did-fail-load", refusedConnectionEvent(url));
  };
  const result = await mounted.controller.handle({ type: "navigate", url: UNAVAILABLE_URL });
  assert.equal(result.ok, true);
  assert.equal(result.loaded, false);
  assert.equal(result.attemptedUrl, UNAVAILABLE_URL);
  assertRecordedFailure(result.loadFailure, UNAVAILABLE_URL);
  assert.match(String(result.warning), /ERR_CONNECTION_REFUSED|\(-102\)/u);
  assert.match(String(result.warning), /error page|Chromium/iu);
  mounted.controller.unmount();
});

test("0.2.11 client: a successful open reports loaded:true plus attemptedUrl, and status exposes attemptedUrl/hostOrigin", async () => {
  // A URL that differs from the mocked page's getURL() proves status() reports
  // the requested/attempted URL, not the page that ended up loaded.
  const requested = "https://example.org/attempted-path";
  const mounted = await mountController({ transport: DSH_TRANSPORT });
  const result = await mounted.controller.handle({ type: "open", url: requested });
  assert.equal(result.ok, true);
  assert.equal(result.loaded, true, "a clean load must be reported as loaded");
  assert.equal(result.attemptedUrl, requested);
  assert.deepEqual(mounted.calls.loadURL, [requested]);
  const status = mounted.controller.status();
  assert.equal(status.attemptedUrl, requested, "status must expose the last attempted open/navigate URL");
  assert.equal(status.hostOrigin, DSH_TRANSPORT.streamBaseUrl, "desktop shell status must expose the DSH Host origin");
  mounted.controller.unmount();

  // Standalone 'dsh web' knows no Host origin; the field must stay absent.
  const standalone = await mountController();
  const standaloneUrl = "https://example.org/standalone";
  const standaloneResult = await standalone.controller.handle({ type: "open", url: standaloneUrl });
  assert.equal(standaloneResult.ok, true);
  assert.equal(standaloneResult.loaded, true);
  assert.equal(standaloneResult.attemptedUrl, standaloneUrl);
  const standaloneStatus = standalone.controller.status();
  assert.equal(standaloneStatus.attemptedUrl, standaloneUrl);
  assert.equal(standaloneStatus.hostOrigin, undefined, "standalone 'dsh web' must not invent a Host origin");
  standalone.controller.unmount();
});

test("0.2.11 client: a load failure recorded before this attempt does not taint a later successful open", async () => {
  const mounted = await mountController({ transport: DSH_TRANSPORT });
  // A previous guest load failed (kept in status as a diagnostic)...
  mounted.element.dispatch("did-fail-load", {
    errorCode: -2,
    errorDescription: "ERR_FAILED",
    validatedURL: "http://127.0.0.1:55544/",
    isMainFrame: true,
  });
  // ...but this open starts strictly later, so its clean load must stay clean.
  await new Promise((resolve) => setTimeout(resolve, 5));
  mounted.element.loadURL = async (url) => {
    mounted.calls.loadURL.push(url);
  };
  const result = await mounted.controller.handle({ type: "open", url: "https://example.org/fresh" });
  assert.equal(result.ok, true);
  assert.equal(result.loaded, true, "a stale failure must not mark this attempt as an error-page load");
  assert.equal(result.loadFailure, undefined, "only failures recorded during this attempt are attached to the receipt");
  assert.equal(result.warning, undefined, "a clean load must not carry an error-page warning");
  mounted.controller.unmount();
});

// ---------------------------------------------------------------------------
// 0.2.12 command watchdog + desktop-safe setContent.
// Live bug: `browser setContent` on the desktop shell hung, the bridge loop
// awaited that command forever, and every later call reported "no connected
// client". The client now bounds every bridged command, and setContent never
// attempts an about:blank navigation on the desktop shell (the shell only
// admits http(s) main-frame navigation, so that load can hang).
// ---------------------------------------------------------------------------

/**
 * Await an attempted command against a real wall-clock deadline so a wedged
 * implementation fails the test instead of hanging the runner.
 */
async function settleWithin(promise, ms, label) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    const settled = await Promise.race([
      promise.then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
      deadline,
    ]);
    if (settled.timedOut === true) throw new Error(`${label} did not settle within ${ms}ms (the command is wedged)`);
    if (settled.error !== undefined) throw settled.error;
    return settled.value;
  } finally {
    clearTimeout(timer);
  }
}

test("0.2.12 client watchdog: withTimeout settles with its input and clears the deadline timer", async () => {
  const loaded = loadClientBundle(clientFile);
  const { withTimeout } = loaded.plugin.__test;
  assert.equal(typeof withTimeout, "function", "plugin.__test must export withTimeout");
  assert.equal(await withTimeout(Promise.resolve("payload"), 60, "deadline must not fire"), "payload");
  assert.equal(loaded.timers.length, 0, "a settled input must clear its deadline timer");
  await assert.rejects(
    () => withTimeout(Promise.reject(new Error("inner failure")), 60, "deadline must not fire"),
    /inner failure/u,
    "an input rejection must pass through unchanged",
  );
  assert.equal(loaded.timers.length, 0, "a rejected input must clear its deadline timer too");
});

test("0.2.12 client watchdog: withTimeout rejects with the given message after the deadline", async () => {
  const loaded = loadClientBundle(clientFile);
  const { withTimeout } = loaded.plugin.__test;
  const outcomePromise = withTimeout(new Promise(() => {}), 60, "the page did not answer").then(
    (value) => ({ kind: "value", value }),
    (error) => ({ kind: "error", error }),
  );
  await flushMicrotasks();
  assert.equal(loaded.timers.length, 1, "the watchdog must arm one deadline timer");
  loaded.flushTimers();
  const settled = await outcomePromise;
  assert.equal(settled.kind, "error", "the deadline must reject the wrapper");
  assert.equal(settled.error.message, "the page did not answer");
  assert.equal(loaded.timers.length, 0, "a fired deadline must not leave a timer behind");
});

test("0.2.12 client watchdog: runCommandGuarded returns results and converts handler rejections", async () => {
  const loaded = loadClientBundle(clientFile);
  const { runCommandGuarded } = loaded.plugin.__test;
  assert.equal(typeof runCommandGuarded, "function", "plugin.__test must export runCommandGuarded");
  const resolved = await runCommandGuarded(
    { handle: async (command) => ({ ok: true, echo: command.type }) },
    { type: "evaluate" },
    60,
  );
  assert.deepEqual(plain(resolved), { ok: true, echo: "evaluate" }, "a settled command must return the handler value");
  assert.equal(loaded.timers.length, 0, "a settled command must clear its deadline timer");
  const rejected = await runCommandGuarded(
    {
      handle: async () => {
        throw new Error("the handler exploded");
      },
    },
    { type: "evaluate" },
    60,
  );
  assert.equal(rejected.ok, false, "a handler rejection must become a receipt, not a rejection");
  assert.match(rejected.error, /the handler exploded/u);
  assert.equal(loaded.timers.length, 0, "a failed command must clear its deadline timer too");
});

test("0.2.12 client watchdog: runCommandGuarded turns a hung handler into a wedged-panel receipt", async () => {
  const loaded = loadClientBundle(clientFile);
  const { runCommandGuarded } = loaded.plugin.__test;
  // The live 0.2.11 shape: the controller accepts the command and never settles.
  const wedged = { handle: () => new Promise(() => {}) };
  const receiptPromise = runCommandGuarded(wedged, { type: "setContent", html: "<p>x</p>" }, 40);
  await flushMicrotasks();
  assert.equal(loaded.timers.length, 1, "the watchdog must arm exactly one command deadline");
  loaded.flushTimers();
  const receipt = await receiptPromise;
  assert.equal(receipt?.ok, false, "a hung command must resolve a failure receipt instead of hanging the loop");
  assert.match(String(receipt.error), /timed out after \d+ms/u, "the receipt must report the elapsed deadline");
  assert.match(String(receipt.error), /wedged/u, "the receipt must name the wedged panel");
  assert.match(String(receipt.error), /action=status/u, "the receipt must tell the agent how to recover");
});

test("0.2.12 client setContent: the desktop shell renders in place instead of navigating to about:blank", async () => {
  const mounted = await mountController({ transport: DSH_TRANSPORT, webviewOptions: { statefulUrl: true } });
  const result = await mounted.controller.handle({ type: "setContent", html: "<title>x</title>" });
  assert.equal(result.ok, true);
  assert.equal(result.context, "in-place", "the desktop shell must render in place: about:blank navigation is never admitted");
  assert.deepEqual(mounted.calls.loadURL, [], "setContent must not call loadURL at all on the desktop shell");
  mounted.controller.unmount();
});

test("0.2.12 client setContent: a never-settling content script still returns a bounded receipt", async () => {
  const mounted = await mountController({ transport: DSH_TRANSPORT, webviewOptions: { statefulUrl: true } });
  mounted.loaded.flushTimers(); // drain any mount-time leftovers so the first deadline timer is setContent's
  const originalExecuteJavaScript = mounted.mock.webview.executeJavaScript;
  mounted.element.executeJavaScript = (code) => {
    // Only the document-replacement script hangs; diagnostics probes still work.
    if (String(code).includes("__dshAgentSetContent")) return new Promise(() => {});
    return originalExecuteJavaScript(code);
  };
  const promise = mounted.controller.handle({ type: "setContent", html: "<title>x</title>" });
  let armed = false;
  for (let attempt = 0; attempt < 12 && !armed; attempt += 1) {
    await flushMicrotasks();
    if (mounted.loaded.timers.length > 0) {
      mounted.loaded.flushTimers();
      armed = true;
    }
  }
  assert.ok(armed, "the content render must be wrapped in a bounded deadline");
  const result = await settleWithin(promise, 15000, "setContent");
  if (result.ok === true) {
    assert.equal(result.context, "in-place");
    assert.match(String(result.warning), /completion signal/iu, "the warning must explain the lost completion signal");
  } else {
    assert.equal(result.ok, false);
    assert.match(String(result.error), /timed out/iu, "a failed receipt must report the timeout");
  }
  mounted.controller.unmount();
});

test("0.2.12 client setContent: without desktop transport the about:blank reset path is unchanged", async () => {
  const mounted = await mountController({ webviewOptions: { statefulUrl: true } });
  const result = await mounted.controller.handle({ type: "setContent", html: "<title>x</title>" });
  assert.equal(result.ok, true);
  assert.equal(result.context, "about:blank", "standalone 'dsh web' keeps resetting the page before rendering");
  assert.deepEqual(mounted.calls.loadURL, ["about:blank"]);
  mounted.controller.unmount();
});
