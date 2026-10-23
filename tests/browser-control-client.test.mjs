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

function makeWebviewMock(options = {}) {
  const calls = { executeJavaScript: [], sendInputEvent: [], insertText: [], loadURL: [], focus: 0, getURL: 0 };
  let scrollY = options.statefulScroll === true ? 0 : 120;
  const webview = {
    ...(options.capturePage !== undefined ? { capturePage: options.capturePage } : {}),
    executeJavaScript: async (code) => {
      calls.executeJavaScript.push(code);
      if (code.includes("__dshAgentSettle")) return { settled: true, mutations: 2, waitedMs: 120, quietMs: 100 };
      if (code.includes("__dshAgentSubmitForm")) return { submitted: true, method: "requestSubmit" };
      if (code.includes("__dshAgentEditable")) {
        if (options.editable === false) return { editable: false, tag: "body", value: "" };
        return { editable: true, tag: "input", value: "deepseek harness" };
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
    loadURL: async (url) => calls.loadURL.push(url),
    getURL: () => {
      calls.getURL += 1;
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
    ensurePanel: () => {
      ensurePanelCalls += 1;
      return undefined;
    },
  });
  return { loaded, controller, ensurePanelCalls: () => ensurePanelCalls };
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
