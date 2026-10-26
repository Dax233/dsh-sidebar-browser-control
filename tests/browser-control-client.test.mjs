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
        return {
          innerWidth: options.viewportWidth ?? 1280,
          innerHeight: options.viewportHeight ?? 800,
          devicePixelRatio: options.devicePixelRatio ?? 1,
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
        return {
          ok: true,
          viewport: { width: 575, height: 742, devicePixelRatio: 1 },
          rect: { x: 10, y: 20, width: 120, height: 40 },
          clipped: false,
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
      if (code.includes("__dshAgentScrollState")) {
        return { scrollY: options.statefulScroll === true ? scrollY : 120, scrollHeight: 900, innerHeight: 742 };
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

function makeController(options = {}) {  const loaded = loadClientBundle(clientFile, {
    webview: options.webview,
    dshDesktop: options.desktop,
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
    navigationWaitMs: options.navigationWaitMs ?? 0,
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
  assert.ok(harness.tabTypes[0].kind.startsWith("agent-browser-"), `kind must be unique per load, got ${harness.tabTypes[0].kind}`);
  assert.equal(typeof harness.tabTypes[0].title, "function");
  assert.equal(harness.slotRegistrations.length, 1);
  assert.equal(harness.slotRegistrations[0].configuration.key, harness.tabTypes[0].id);
  harness.disposeAll();
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
  assert.equal(wheel.deltaY, 420);
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
  const mounted = await mountController({ panelWidth: 480, panelHeight: 700 });
  const { controller, mock } = mounted;
  const result = await controller.handle({ type: "viewport", width: 1280, height: 800 });
  assert.equal(result.ok, true);
  assert.equal(result.width, 1280);
  assert.equal(result.height, 800);
  assert.equal(result.actual.innerWidth, 1280, "the receipt reports the real guest innerWidth, not the request");
  assert.equal(result.actual.innerHeight, 800);
  assert.equal(result.actual.devicePixelRatio, 1);
  assert.equal(mock.webview.style.width, "1280px");
  assert.equal(mock.webview.style.height, "800px");
  assert.equal(result.scale, 0.375, "480x700 panel shows a 1280x800 guest at 0.375 scale");
  assert.match(mock.webview.style.transform, /scale\(0\.375\)/);
  const status = controller.status();
  assert.deepEqual(plain(status.viewport), { width: 1280, height: 800, scale: 0.375, auto: false });

  const reset = await controller.handle({ type: "viewport", reset: true });
  assert.equal(reset.ok, true);
  assert.equal(reset.reset, true);
  assert.equal(mock.webview.style.width, "100%");
  assert.equal(mock.webview.style.height, "100%");
  assert.equal(mock.webview.style.transform, "");
  assert.deepEqual(plain(controller.status().viewport), { auto: true });
  controller.unmount();
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

test("screenshot fullPage grows the webview to scrollHeight (capped) then restores it", async () => {
  const captured = [];
  let mounted;
  mounted = await mountController({
    controllerOptions: { fullPageMaxCssPx: 1200 },
    webviewOptions: {
      capturePage: async () => {
        captured.push({ height: mounted.mock.webview.style.height, flex: mounted.mock.webview.style.flex });
        return { toDataURL: () => "data:image/png;base64,AAAA" };
      },
    },
  });
  const result = await mounted.controller.handle({ type: "screenshot", fullPage: true });
  assert.equal(result.ok, true);
  assert.equal(result.fullPage.requestedHeight, 900, "scrollHeight comes from the page state script");
  assert.equal(result.fullPage.capturedHeight, 900);
  assert.equal(result.fullPage.capped, false);
  assert.equal(captured[0].height, "900px", "the guest must be tall during the capture");
  assert.equal(mounted.mock.webview.style.height, "100%", "the original layout must be restored");
  mounted.controller.unmount();

  const capped = await mountController({
    controllerOptions: { fullPageMaxCssPx: 500 },
    webviewOptions: {
      capturePage: async () => ({ toDataURL: () => "data:image/png;base64,AAAA" }),
    },
  });
  const tallShot = await capped.controller.handle({ type: "screenshot", fullPage: true });
  assert.equal(tallShot.fullPage.capturedHeight, 500);
  assert.equal(tallShot.fullPage.capped, true);
  capped.controller.unmount();
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
