/**
 * Test harness that executes the real browser bundle (client.js) inside a Node
 * VM with mocked browser globals. This is what lets us catch boot-breaking
 * regressions (e.g. apply() returning a never-settling promise) before the
 * bundle is ever installed into the desktop app.
 */
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

/** Minimal AbortSignal/Controller pair for the VM: no timers, so tests exit fast. */
function createFakeSignal() {
  const listeners = [];
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(type, callback) {
      if (type === "abort") listeners.push(callback);
    },
    removeEventListener(type, callback) {
      const index = listeners.indexOf(callback);
      if (index >= 0) listeners.splice(index, 1);
    },
    throwIfAborted() {
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
    },
    _abort(reason) {
      if (signal.aborted) return;
      signal.aborted = true;
      signal.reason = reason;
      for (const callback of [...listeners]) {
        try {
          callback();
        } catch {
          // Listeners must not break the abort path.
        }
      }
    },
  };
  return signal;
}

class FakeAbortController {
  constructor() {
    this.signal = createFakeSignal();
  }

  abort(reason) {
    this.signal._abort(reason);
  }
}

const FakeAbortSignal = {
  timeout() {
    // Deadlines are irrelevant inside unit tests; never create a timer.
    return createFakeSignal();
  },
  any(signals) {
    const controller = new FakeAbortController();
    for (const signal of signals) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", () => controller.abort(signal.reason));
    }
    return controller.signal;
  },
};

function makeElement(tag = "div") {
  const listeners = new Map();
  const element = {
    tagName: String(tag).toUpperCase(),
    style: {},
    children: [],
    dataset: {},
    attributes: {},
    listeners,
    // Fake DOM nodes count as connected; appendChild moves a node between
    // parents like the real DOM (the guest re-attach path relies on it).
    isConnected: true,
    __parent: null,
    get parentNode() {
      return this.__parent;
    },
    appendChild(child) {
      if (child !== null && typeof child === "object" && child.__parent !== undefined) {
        const previous = child.__parent;
        if (previous !== null && previous !== this) {
          const index = previous.children.indexOf(child);
          if (index >= 0) previous.children.splice(index, 1);
        }
        child.__parent = this;
      }
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index < 0) throw new Error("the node to be removed is not a child of this node");
      this.children.splice(index, 1);
      if (child !== null && typeof child === "object") child.__parent = null;
      return child;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getBoundingClientRect() {
      const width = Number(this.clientWidth ?? 0);
      const height = Number(this.clientHeight ?? 0);
      return { x: 0, y: 0, top: 0, left: 0, width, height, right: width, bottom: height };
    },
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
    addEventListener(type, callback) {
      const list = listeners.get(type) ?? [];
      list.push(callback);
      listeners.set(type, list);
    },
    removeEventListener(type, callback) {
      const list = listeners.get(type) ?? [];
      listeners.set(
        type,
        list.filter((entry) => entry !== callback),
      );
    },
    /** Deliver one event to every listener registered for the type (tests only). */
    dispatch(type, event = {}) {
      for (const callback of [...(listeners.get(type) ?? [])]) callback(event);
    },
    remove() {},
    attachShadow() {
      return makeElement("shadow");
    },
    focus() {},
    innerHTML: "",
    className: "",
  };
  return element;
}

/**
 * Load one bundle file and return its registered module definition plus mocks.
 *
 * @param {string} clientFile absolute path to client.js
 * @param {object} [options]
 * @param {(call: {url: string, init: object}) => object | Promise<object>} [options.respond]
 *        returns a fetch-like response; the default answers /hello and then holds /poll forever.
 */
export function loadClientBundle(clientFile, options = {}) {
  const registrations = [];
  const fetchCalls = [];
  const timers = [];
  const cleanups = [];
  const elements = [];
  let timerId = 1;

  const respond = options.respond ?? defaultResponder(fetchCalls);

  const fetchMock = (url, init = {}) => {
    const call = { url: String(url), init, at: Date.now() };
    fetchCalls.push(call);
    if (init.signal?.aborted === true) {
      return Promise.reject(Object.assign(new Error("fetch aborted"), { name: "AbortError" }));
    }
    try {
      return Promise.resolve(respond(call));
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const document = {
    createElement: (tag) => {
      const element = makeElement(tag);
      const name = String(tag).toLowerCase();
      if (name === "canvas") {
        // Full-page screenshot stitching draws the captured segments here.
        element.width = 0;
        element.height = 0;
        element.__draws = [];
        element.getContext = () => ({
          drawImage(image, x, y, width, height) {
            element.__draws.push({ x, y, width, height, naturalWidth: image?.naturalWidth, naturalHeight: image?.naturalHeight });
          },
        });
        element.toDataURL = (type = "image/png") => `data:${type};base64,AAAA`;
      }
      if (name === "webview" && options.webview !== undefined) {
        const supplied = typeof options.webview === "function" ? options.webview(tag) : options.webview;
        if (supplied !== undefined) Object.assign(element, supplied);
      }
      elements.push(element);
      return element;
    },
    getElementById: () => null,
    documentElement: makeElement("html"),
    body: makeElement("body"),
  };

  /** Decoded-image stand-in for canvas stitching; tests may override dimensions. */
  class FakeImage {
    constructor() {
      this.naturalWidth = options.imageNaturalWidth ?? 1280;
      this.naturalHeight = options.imageNaturalHeight ?? 800;
      this.onload = null;
      this.onerror = null;
      this._src = "";
    }
    set src(value) {
      this._src = String(value);
      if (options.imageOnload === true) {
        // No decode() to wait for: the load fallback must still complete.
        Promise.resolve().then(() => this.onload?.());
      }
    }
    get src() {
      return this._src;
    }
    decode() {
      if (options.imageDecodeHangs === true) return new Promise(() => {});
      return Promise.resolve();
    }
  }

  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => registrations.push(definition) } },
    document,
    location: { href: "dsh-app://app/", origin: "dsh-app://app" },
    navigator: { userAgent: "dsh-test-agent" },
    console: { log() {}, warn() {}, error() {} },
    fetch: fetchMock,
    AbortSignal: FakeAbortSignal,
    AbortController: FakeAbortController,
    Image: FakeImage,
    URL,
    URLSearchParams,
    setTimeout: (fn, ms) => {
      const id = timerId++;
      timers.push({ id, fn, ms });
      return id;
    },
    clearTimeout: (id) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    require: (id) => requireMock(id),
  };
  sandbox.globalThis = sandbox;
  if (options.dshDesktop !== undefined) sandbox.dshDesktop = options.dshDesktop;
  if (options.notification !== undefined) sandbox.Notification = options.notification;

  const context = createContext(sandbox);
  runInContext(readFileSync(clientFile, "utf8"), context, { filename: clientFile });
  if (registrations.length !== 1) {
    throw new Error(`expected exactly one __ModuleLoader__.load registration, got ${registrations.length}`);
  }
  const definition = registrations[0];
  const plugin = definition.factory((id) => requireMock(id));

  /** Run every pending setTimeout callback once (retry paths). */
  const flushTimers = () => {
    const pending = timers.splice(0);
    for (const timer of pending) timer.fn();
    return pending.length;
  };

  /** Minimal Cordis client context capturing registrations and disposers. */
  const makeContext = (overrides = {}) => {
    const tabTypes = [];
    const slotInjections = [];
    const slotRegistrations = [];
    const openTabCalls = [];
    const closedTabs = [];
    const effectDisposers = [];
    const ctx = {
      effect(execute) {
        const dispose = execute();
        if (typeof dispose === "function") effectDisposers.push(dispose);
        return dispose;
      },
      sidebarRightTabs: {
        register(configuration) {
          tabTypes.push(configuration);
          return () => {};
        },
      },
      sidebarRight: {
        openTab(...args) {
          openTabCalls.push(args);
          if (overrides.openTab) return overrides.openTab(...args);
          return undefined;
        },
        close(tabId) {
          closedTabs.push(tabId);
          if (overrides.close) return overrides.close(tabId);
          return undefined;
        },
        ...(overrides.openTabs === undefined
          ? {}
          : {
              openTabs: {
                getSnapshot: () => overrides.openTabs,
                subscribe: () => () => {},
              },
            }),
      },
      slots: {
        inject(name, callback) {
          const registration = callback();
          slotInjections.push({ name, registration });
          return () => {};
        },
        register(configuration, component) {
          slotRegistrations.push({ configuration, component });
          return () => {};
        },
      },
      locale: { bind: () => (key) => key, register: () => () => {} },
    };
    return {
      ctx,
      tabTypes,
      slotInjections,
      slotRegistrations,
      openTabCalls,
      closedTabs,
      effectDisposers,
      disposeAll() {
        for (const dispose of effectDisposers.splice(0).reverse()) dispose();
      },
    };
  };

  return {
    definition,
    plugin,
    context,
    fetchCalls,
    timers,
    elements,
    cleanups,
    flushTimers,
    makeContext,
  };
}

function requireMock(id) {
  if (id === "react") {
    return {
      createElement: () => null,
      useRef: () => ({ current: null }),
      useEffect: () => {},
      useState: () => [undefined, () => {}],
    };
  }
  throw new Error(`unexpected client require("${id}")`);
}

/** Answer /hello, then keep /poll pending so the bridge loop stays alive. */
function defaultResponder(fetchCalls) {
  return (call) => {
    if (call.url.includes("/hello")) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (call.url.includes("/poll")) {
      return new Promise(() => {});
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
}

/** Let queued promise chains (fetch/json/handle) settle. */
export function flushMicrotasks(rounds = 8) {
  let chain = Promise.resolve();
  for (let i = 0; i < rounds; i += 1) chain = chain.then(() => undefined);
  return chain;
}
