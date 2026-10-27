/**
 * Behavioural unit tests for the page-side QA scripts and pure helpers that
 * live in client.js. The bundle is loaded through the same VM harness as the
 * client tests, but these tests execute the generated page scripts against
 * fake page globals so the logic is verified, not just the marker comments.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { loadClientBundle } from "./support/client-harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bundleDir = join(here, "..");
const clientFile = join(bundleDir, "client.js");
const pkg = JSON.parse(readFileSync(join(bundleDir, "package.json"), "utf8"));

const { plugin, definition } = loadClientBundle(clientFile);
const helpers = plugin.__test;
assert.equal(definition.id, pkg.name);

/** Cross-realm VM objects have foreign prototypes; normalize before deepEqual. */
const plain = (value) => JSON.parse(JSON.stringify(value));

function makeContext(sandbox) {
  const context = createContext(sandbox);
  return context;
}

/** Native matchMedia evaluator for a fixed 800px-wide viewport. */
function nativeMatchMedia(width = 800) {
  return (query) => {
    const text = String(query);
    let body = text.trim();
    let negated = false;
    if (/^not\s+/iu.test(body)) {
      negated = true;
      body = body.replace(/^not\s+/iu, "");
    }
    body = body.replace(/^(all|screen|print)\s+and\s+/iu, "");
    let matches = false;
    const min = /\(min-width:\s*(\d+)px\)/iu.exec(body);
    const max = /\(max-width:\s*(\d+)px\)/iu.exec(body);
    if (min !== null) matches = width >= Number(min[1]);
    if (max !== null) matches = matches && width <= Number(max[1]);
    // The native engine always evaluates prefers-color-scheme as light by default.
    if (min === null && max === null) matches = false;
    return { media: text, matches: negated ? !matches : matches, addEventListener() {}, removeEventListener() {} };
  };
}

function makeMediaRule(mediaText, children = []) {
  const rule = { media: { mediaText }, cssRules: children };
  return rule;
}

function makeSheet(rules, options = {}) {
  if (options.throws === true) {
    return {
      get cssRules() {
        throw new Error("SecurityError: cross-origin stylesheet");
      },
    };
  }
  return { cssRules: rules };
}

/** Fake page globe for the emulate script. */
function makeEmulatePage(options = {}) {
  const darkRule = makeMediaRule("(prefers-color-scheme: dark)");
  const lightRule = makeMediaRule("(prefers-color-scheme: light)");
  const combinedRule = makeMediaRule("screen and (prefers-color-scheme: dark)");
  const nestedChild = makeMediaRule("(prefers-color-scheme: dark)");
  const nestedParent = makeMediaRule("(min-width: 600px)", [nestedChild]);
  const crossOrigin = makeSheet([], { throws: true });
  const sheets = options.sheets ?? [makeSheet([darkRule, lightRule, combinedRule, nestedParent]), crossOrigin];
  const documentElement = { style: { colorScheme: "" } };
  const document = {
    styleSheets: sheets,
    documentElement,
    title: "Emulate Page",
    fonts: { status: "loaded", size: 1 },
    images: [],
    body: { innerText: "" },
    querySelector: () => null,
    querySelectorAll: () => [],
    scrollingElement: { scrollWidth: 800, scrollHeight: 600, scrollTop: 0 },
  };
  const window = {
    matchMedia: nativeMatchMedia(800),
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 1,
    scrollY: 0,
  };
  const sandbox = {
    window,
    document,
    performance: { getEntriesByType: () => [], now: () => 0 },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout: () => 1,
    setInterval: () => 1,
    clearInterval: () => {},
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    console: { log() {}, warn() {}, error() {} },
  };
  sandbox.globalThis = sandbox;
  return { sandbox, darkRule, lightRule, combinedRule, nestedParent, nestedChild, documentElement, window };
}

function runInPage(code, sandbox) {
  sandbox.globalThis = sandbox;
  const context = makeContext(sandbox);
  return runInContext(code, context);
}

test("scripts: the bundle still boots and exposes the QA test helpers", () => {
  for (const name of [
    "createPanelController",
    "rewriteColorSchemeQuery",
    "injectBaseHref",
    "clampRect",
    "bytesToBase64",
    "imageToDataUrl",
    "isBlankUrl",
    "emulateJs",
    "setContentJs",
    "metricsJs",
    "waitConditionsJs",
  ]) {
    assert.equal(typeof helpers[name], "function", `__test.${name} must be exposed`);
  }
});

test("scripts: rewriteColorSchemeQuery replaces both schemes with width conditions", () => {
  assert.deepEqual(plain(helpers.rewriteColorSchemeQuery("(prefers-color-scheme: dark)", "dark")), {
    query: "(min-width: 0px)",
    changed: true,
  });
  assert.deepEqual(plain(helpers.rewriteColorSchemeQuery("(prefers-color-scheme: dark)", "light")), {
    query: "(min-width: 100000px)",
    changed: true,
  });
  assert.deepEqual(plain(helpers.rewriteColorSchemeQuery("(prefers-color-scheme: light)", "light")), {
    query: "(min-width: 0px)",
    changed: true,
  });
  assert.deepEqual(plain(helpers.rewriteColorSchemeQuery("(prefers-color-scheme: light)", "dark")), {
    query: "(min-width: 100000px)",
    changed: true,
  });
});

test("scripts: rewriteColorSchemeQuery keeps combinations and negation intact", () => {
  assert.equal(
    helpers.rewriteColorSchemeQuery("screen and (prefers-color-scheme: dark)", "light").query,
    "screen and (min-width: 100000px)",
  );
  assert.equal(
    helpers.rewriteColorSchemeQuery("not all and (prefers-color-scheme: light)", "light").query,
    "not all and (min-width: 0px)",
  );
  assert.equal(
    helpers.rewriteColorSchemeQuery("(min-width: 600px) and (prefers-color-scheme: dark), print", "dark").query,
    "(min-width: 600px) and (min-width: 0px), print",
  );
  const twice = helpers.rewriteColorSchemeQuery("(prefers-color-scheme: dark) and (prefers-color-scheme: light)", "light");
  assert.equal(twice.query, "(min-width: 100000px) and (min-width: 0px)");
  assert.deepEqual(plain(helpers.rewriteColorSchemeQuery("(min-width: 600px)", "dark")), {
    query: "(min-width: 600px)",
    changed: false,
  });
  assert.deepEqual(plain(helpers.rewriteColorSchemeQuery("(prefers-color-scheme: dark)", "auto")), {
    query: "(prefers-color-scheme: dark)",
    changed: false,
  });
});

test("scripts: emulateJs overrides matchMedia and forces media rules (dark)", () => {
  const page = makeEmulatePage();
  const result = runInPage(helpers.emulateJs("dark"), page.sandbox);
  assert.equal(result.scheme, "dark");
  assert.equal(result.matchMediaOverridden, true);
  assert.equal(result.sheets.crossOrigin, 1, "cross-origin stylesheets must be reported as unreadable");
  assert.equal(result.sheets.patched, 4, "dark+light+combined+nested rules patched");
  assert.equal(page.darkRule.media.mediaText, "all");
  assert.equal(page.lightRule.media.mediaText, "not all");
  assert.equal(page.combinedRule.media.mediaText, "all", "a satisfied combination applies");
  assert.equal(page.nestedChild.media.mediaText, "all", "nested group rules are scanned recursively");
  assert.equal(page.nestedParent.media.mediaText, "(min-width: 600px)", "unrelated media rules are untouched");
  assert.equal(page.documentElement.style.colorScheme, "dark");
  assert.equal(page.window.matchMedia("(prefers-color-scheme: dark)").matches, true);
  assert.equal(page.window.matchMedia("(prefers-color-scheme: light)").matches, false);
  assert.equal(page.window.matchMedia("(min-width: 600px)").matches, true, "non-color queries delegate to the native engine");
  assert.equal(result.verified.darkMatches, true);
  assert.equal(result.verified.lightMatches, false);
});

test("scripts: emulateJs switches schemes reversibly and auto restores everything", () => {
  const page = makeEmulatePage();
  runInPage(helpers.emulateJs("dark"), page.sandbox);
  const light = runInPage(helpers.emulateJs("light"), page.sandbox);
  assert.equal(page.darkRule.media.mediaText, "not all");
  assert.equal(page.lightRule.media.mediaText, "all");
  assert.equal(page.combinedRule.media.mediaText, "not all");
  assert.equal(light.mediaRules.restored, 4, "the previous patch set is restored before re-patching");
  assert.equal(page.documentElement.style.colorScheme, "light");

  const auto = runInPage(helpers.emulateJs("auto"), page.sandbox);
  assert.equal(page.darkRule.media.mediaText, "(prefers-color-scheme: dark)");
  assert.equal(page.lightRule.media.mediaText, "(prefers-color-scheme: light)");
  assert.equal(page.combinedRule.media.mediaText, "screen and (prefers-color-scheme: dark)");
  assert.equal(page.nestedChild.media.mediaText, "(prefers-color-scheme: dark)");
  assert.equal(auto.scheme, "auto");
  assert.equal(auto.matchMediaOverridden, false);
  assert.equal(page.documentElement.style.colorScheme, "");
  assert.equal(page.window.matchMedia("(prefers-color-scheme: dark)").matches, false, "native matchMedia is restored");
});

test("scripts: emulateJs leaves pages without matchMedia/documents safe", () => {
  const sandbox = {
    window: { innerWidth: 800, innerHeight: 600 },
    document: { styleSheets: [], documentElement: { style: {} } },
    performance: { getEntriesByType: () => [] },
    setTimeout: () => 1,
    setInterval: () => 1,
    clearInterval: () => {},
    console: { log() {}, warn() {}, error() {} },
  };
  const result = runInPage(helpers.emulateJs("dark"), sandbox);
  assert.equal(result.matchMediaOverridden, false);
  assert.equal(result.scheme, "dark");
});

test("scripts: setContentJs writes the document and returns real page state", async () => {
  const written = [];
  const document = {
    title: "",
    readyState: "complete",
    fonts: { ready: Promise.resolve(), status: "loaded", size: 0 },
    scrollingElement: { scrollHeight: 1234 },
    open() {
      written.push({ opened: true });
    },
    write(html) {
      written.push({ html });
      const title = /<title>([^<]*)<\/title>/iu.exec(html);
      if (title !== null) document.title = title[1];
    },
    close() {
      written.push({ closed: true });
    },
  };
  const sandbox = {
    window: { innerWidth: 575, innerHeight: 742, devicePixelRatio: 1 },
    document,
    location: { href: "about:blank" },
    setTimeout: (fn) => {
      fn();
      return 1;
    },
    requestAnimationFrame: (fn) => {
      fn();
      return 1;
    },
    console: { log() {}, warn() {}, error() {} },
  };
  const result = await runInPage(helpers.setContentJs("<title>Local</title><h1>hi</h1>"), sandbox);
  assert.equal(result.title, "Local");
  assert.equal(result.url, "about:blank");
  assert.equal(result.viewport.width, 575);
  assert.equal(result.scrollHeight, 1234);
  assert.equal(written[0].opened, true);
  assert.equal(written[1].html, "<title>Local</title><h1>hi</h1>");
  assert.equal(written.at(-1).closed, true);
});

test("scripts: metricsJs reports viewport/document/overflow/images/fonts/selectors", () => {
  const wide = {
    tagName: "DIV",
    id: "wide",
    className: "banner big",
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 120, right: 900, bottom: 120 }),
  };
  const hero = {
    tagName: "SECTION",
    id: "hero",
    className: "hero",
    getBoundingClientRect: () => ({ left: 20, top: 40, width: 300, height: 200, right: 320, bottom: 240 }),
  };
  const okImage = { complete: true, naturalWidth: 120, naturalHeight: 80, currentSrc: "https://example.com/ok.png", src: "" };
  const brokenImage = { complete: true, naturalWidth: 0, naturalHeight: 0, currentSrc: "", src: "https://example.com/broken.png" };
  const document = {
    title: "Metrics Page",
    fonts: { status: "loading", size: 3 },
    images: [okImage, brokenImage],
    body: { querySelectorAll: () => [wide], scrollWidth: 900, offsetWidth: 800, innerText: "hello world" },
    querySelector: (selector) => (selector === ".hero" ? hero : null),
    scrollingElement: { scrollWidth: 900, scrollHeight: 1600, scrollTop: 120 },
  };
  const sandbox = {
    window: { innerWidth: 800, innerHeight: 600, devicePixelRatio: 2, scrollY: 120 },
    document,
    location: { href: "https://example.com/metrics" },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    console: { log() {}, warn() {}, error() {} },
  };
  const result = runInPage(helpers.metricsJs([".hero", ".missing"], true), sandbox);
  assert.equal(result.title, "Metrics Page");
  assert.equal(result.url, "https://example.com/metrics");
  assert.deepEqual(plain(result.viewport), { width: 800, height: 600, devicePixelRatio: 2, scrollY: 120 });
  assert.equal(result.document.scrollWidth, 900);
  assert.equal(result.document.scrollHeight, 1600);
  assert.equal(result.overflowCount, 1);
  assert.equal(result.overflow[0].overshoot, 100);
  assert.equal(result.overflow[0].selector, "div#wide.banner.big");
  assert.equal(result.images.total, 2);
  assert.equal(result.images.loaded, 1);
  assert.equal(result.images.failed, 1);
  assert.deepEqual(plain(result.images.failedSrc), ["https://example.com/broken.png"]);
  assert.equal(result.fonts.status, "loading");
  assert.equal(result.fonts.size, 3);
  assert.equal(result.selectors[0].found, true);
  assert.deepEqual(plain(result.selectors[0].rect), { x: 20, y: 40, width: 300, height: 200 });
  assert.equal(result.selectors[1].found, false);
  const withoutOverflow = runInPage(helpers.metricsJs([], false), sandbox);
  assert.equal(withoutOverflow.overflowCount, 0, "includeOverflow=false skips the scan");
});

test("scripts: waitConditionsJs resolves met conditions and reports timeout state", async () => {
  const page = {
    images: [{ complete: true }],
    body: { innerText: "ready now" },
    querySelector: (selector) => (selector === "#ready" ? { id: "ready" } : null),
    fonts: { status: "loaded" },
  };
  const window = { innerWidth: 800, innerHeight: 600, scrollY: 0 };
  let clock = 0;
  const sandbox = {
    window,
    document: { ...page, documentElement: { style: {} }, styleSheets: [] },
    performance: {
      now: () => clock,
      getEntriesByType: () => [],
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout: (fn) => {
      clock += 100;
      fn();
      return 1;
    },
    console: { log() {}, warn() {}, error() {} },
  };
  const met = await runInPage(
    helpers.waitConditionsJs({ selector: "#ready", text: "ready now", images: true, fonts: true }, 1000),
    sandbox,
  );
  assert.equal(met.met, true);
  assert.deepEqual(plain(met.conditions), { selector: true, text: true, images: true, fonts: true });

  clock = 0;
  const timeout = await runInPage(helpers.waitConditionsJs({ selector: "#missing" }, 800), sandbox);
  assert.equal(timeout.met, false);
  assert.equal(timeout.conditions.selector, false);
  assert.ok(timeout.waitedMs >= 800, `waitedMs must reflect the real wait, got ${timeout.waitedMs}`);
});

test("scripts: injectBaseHref injects once, escapes, and leaves an existing base alone", () => {
  const withHead = helpers.injectBaseHref("<html><head><meta charset='utf-8'></head><body>x</body></html>", "https://example.com/a/");
  assert.equal(withHead.injected, true);
  assert.match(withHead.html, /<head><base href="https:\/\/example\.com\/a\/"><meta/);
  const withoutHead = helpers.injectBaseHref("<p>hello</p>", "https://example.com/");
  assert.equal(withoutHead.injected, true);
  assert.match(withoutHead.html, /^<base href="https:\/\/example\.com\/"><p>hello<\/p>$/);
  const existing = helpers.injectBaseHref('<base href="https://other.test/">x', "https://example.com/");
  assert.equal(existing.injected, false);
  assert.match(existing.warning, /<base>/);
  assert.equal(existing.html, '<base href="https://other.test/">x');
  const escaped = helpers.injectBaseHref("<head></head>", 'https://example.com/?q="x"&y=1');
  assert.match(escaped.html, /&quot;x&quot;&amp;y=1/);
  assert.equal(helpers.injectBaseHref("<p>x</p>", undefined).injected, false);
});

test("scripts: bytesToBase64 matches Buffer, and imageToDataUrl prefers context-safe capture paths", async () => {
  const bytes = Uint8Array.from([0, 1, 2, 3, 250, 251, 252, 42]);
  assert.equal(helpers.bytesToBase64(bytes), Buffer.from(bytes).toString("base64"));
  assert.equal(helpers.bytesToBase64(Uint8Array.from([])), "");
  assert.equal(
    await helpers.imageToDataUrl({ toPNG: () => Uint8Array.from([1, 2, 3]) }, "png", 80),
    `data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`,
  );
  assert.equal(
    await helpers.imageToDataUrl({ toJPEG: () => Uint8Array.from([9, 8, 7]) }, "jpeg", 90),
    `data:image/jpeg;base64,${Buffer.from([9, 8, 7]).toString("base64")}`,
  );
  assert.equal(
    await helpers.imageToDataUrl({ toDataURL: () => "data:image/png;base64,AAAA" }, "png", 80),
    "data:image/png;base64,AAAA",
  );
  await assert.rejects(() => helpers.imageToDataUrl({}, "png", 80), /did not return an image/);

  // Real DSH Desktop renderer: nativeImage.toPNG/toJPEG throw "Buffer is not
  // available for the current Context", toDataURL works. Captures must still work.
  const sandboxedPng = await helpers.imageToDataUrl(
    {
      toDataURL: () => "data:image/png;base64,AAAA",
      toPNG: () => {
        throw new Error("Buffer is not available for the current Context");
      },
    },
    "png",
    80,
  );
  assert.equal(sandboxedPng, "data:image/png;base64,AAAA");
  const sandboxedJpeg = await helpers.imageToDataUrl(
    {
      toDataURL: () => "data:image/png;base64,AAAA",
      toJPEG: () => {
        throw new Error("Buffer is not available for the current Context");
      },
    },
    "jpeg",
    60,
  );
  assert.match(sandboxedJpeg, /^data:image\/jpeg;base64,/, "JPEG must fall back to a canvas re-encode");
});

test("scripts: clampRect clamps into the viewport and isBlankUrl recognises about:blank", () => {  assert.deepEqual(plain(helpers.clampRect({ x: 10, y: 20, width: 100, height: 50 }, { width: 575, height: 742 })), {
    x: 10,
    y: 20,
    width: 100,
    height: 50,
  });
  assert.deepEqual(plain(helpers.clampRect({ x: 500, y: 700, width: 300, height: 300 }, { width: 575, height: 742 })), {
    x: 500,
    y: 700,
    width: 75,
    height: 42,
  });
  assert.deepEqual(plain(helpers.clampRect({ x: -50, y: -10, width: 100, height: 50 }, { width: 575, height: 742 })), {
    x: 0,
    y: 0,
    width: 50,
    height: 40,
  });
  assert.equal(helpers.clampRect(undefined, { width: 1, height: 1 }), undefined);
  assert.equal(helpers.isBlankUrl("about:blank"), true);
  assert.equal(helpers.isBlankUrl("about:blank#lease-1"), true);
  assert.equal(helpers.isBlankUrl("https://example.com/"), false);
  assert.equal(helpers.isBlankUrl(""), false);
});

// ---------------------------------------------------------------------------
// 0.2.4: emulate DOM fallback for native <picture>/<source media> and
// <link rel=stylesheet media>, including open shadow roots.
// ---------------------------------------------------------------------------

/** Minimal fake element with an attribute map (mirrors real DOM semantics used by the shim). */
function makeFakeEl(tag, attrs = {}) {
  const attributes = { ...attrs };
  return {
    tagName: String(tag).toUpperCase(),
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null),
    setAttribute: (name, value) => {
      attributes[name] = String(value);
    },
    removeAttribute: (name) => {
      delete attributes[name];
    },
    shadowRoot: undefined,
  };
}

function makePicturePage({ sources = [], imgAttrs = {}, shadowPictures = [] } = {}) {
  const img = makeFakeEl("img", { ...imgAttrs });
  const picture = {
    tagName: "PICTURE",
    querySelector: (selector) => (selector === "img" ? img : null),
    querySelectorAll: (selector) => (selector === "source" ? sources : []),
  };
  // An open shadow root can only be reached through element.shadowRoot.
  const hosts = shadowPictures.map((shadowPage) => {
    const host = makeFakeEl("div");
    host.shadowRoot = {
      querySelectorAll: (selector) => (selector === "picture" ? [shadowPage.picture] : []),
    };
    return host;
  });
  const darkLink = makeFakeEl("link", { rel: "stylesheet", media: "(prefers-color-scheme: dark)" });
  const document = {
    styleSheets: [],
    documentElement: { style: { colorScheme: "" } },
    title: "Dom Page",
    fonts: { status: "loaded", size: 1 },
    images: [],
    body: { innerText: "" },
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector === "picture") return [picture];
      if (selector === "link[media]") return [darkLink];
      if (selector === "*") return hosts;
      return [];
    },
    scrollingElement: { scrollWidth: 800, scrollHeight: 600, scrollTop: 0 },
  };
  const window = { matchMedia: nativeMatchMedia(800), innerWidth: 800, innerHeight: 600, devicePixelRatio: 1, scrollY: 0 };
  const sandbox = {
    window,
    document,
    performance: { getEntriesByType: () => [], now: () => 0 },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout: () => 1,
    setInterval: () => 1,
    clearInterval: () => {},
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    console: { log() {}, warn() {}, error() {} },
  };
  sandbox.globalThis = sandbox;
  return { sandbox, img, picture, darkLink, hosts };
}

test("scripts: emulate re-picks <picture> sources per scheme and fully restores on auto", () => {
  const page = makePicturePage({
    sources: [
      makeFakeEl("source", { media: "(prefers-color-scheme: dark)", srcset: "dark.png 1x" }),
      makeFakeEl("source", { srcset: "light.png 1x" }),
    ],
    imgAttrs: { src: "base.png" },
  });
  const dark = runInPage(helpers.emulateJs("dark"), page.sandbox);
  assert.equal(page.img.getAttribute("srcset"), "dark.png 1x", "dark re-picks the dark source");
  assert.equal(page.img.getAttribute("src"), "base.png", "theme-unrelated src attributes are left alone");
  assert.equal(dark.dom.picturesPatched, 1);

  const light = runInPage(helpers.emulateJs("light"), page.sandbox);
  assert.equal(page.img.getAttribute("srcset"), "light.png 1x", "switching schemes re-picks the matching source");
  assert.ok(light.dom.restored >= 1, "the previous picture patch is counted as restored");

  const auto = runInPage(helpers.emulateJs("auto"), page.sandbox);
  assert.equal(page.img.getAttribute("srcset"), null, "auto removes the patched srcset attribute");
  assert.equal(page.img.getAttribute("src"), "base.png", "auto keeps the original src");
  assert.ok(auto.dom.restored >= 1);
});

test("scripts: a <picture> with no matching source falls back to the img src and re-arms the source on auto", () => {
  const darkSource = makeFakeEl("source", { media: "(prefers-color-scheme: dark)", srcset: "dark.png" });
  const page = makePicturePage({
    sources: [darkSource],
    imgAttrs: { src: "base.png" },
  });
  const result = runInPage(helpers.emulateJs("light"), page.sandbox);
  // While the dark <source> matches the REAL browser preference it overrides
  // the img; neutralising it lets the light fallback show (a real dark-OS bug).
  assert.equal(darkSource.getAttribute("media"), "not all", "the source is neutralised so the img fallback can win");
  assert.equal(page.img.getAttribute("srcset"), null, "srcset stays as-is");
  assert.equal(page.img.getAttribute("src"), "base.png", "img keeps its own source (the real browser fallback)");
  assert.equal(result.dom.picturesPatched, 1);
  runInPage(helpers.emulateJs("auto"), page.sandbox);
  assert.equal(darkSource.getAttribute("media"), "(prefers-color-scheme: dark)", "auto re-arms the source media");
  assert.equal(page.img.getAttribute("src"), "base.png");
});

test("scripts: <picture> inside an open shadow root is reached through element.shadowRoot", () => {
  const shadowImg = makeFakeEl("img", { src: "base.png" });
  const shadowPicture = {
    tagName: "PICTURE",
    querySelector: (selector) => (selector === "img" ? shadowImg : null),
    querySelectorAll: (selector) => (selector === "source" ? [makeFakeEl("source", { media: "(prefers-color-scheme: dark)", srcset: "dark.png" })] : []),
  };
  const page = makePicturePage({ shadowPictures: [{ picture: shadowPicture }] });
  const result = runInPage(helpers.emulateJs("dark"), page.sandbox);
  assert.equal(shadowImg.getAttribute("srcset"), "dark.png", "the shadow-DOM themed picture gets the same DOM fallback");
  assert.equal(result.dom.picturesPatched, 1);

  runInPage(helpers.emulateJs("auto"), page.sandbox);
  assert.equal(shadowImg.getAttribute("srcset"), null, "auto also restores shadow-DOM patches");
});

test("scripts: <link rel=stylesheet media=prefers-color-scheme> is normalized and restored", () => {
  const page = makePicturePage({});
  const dark = runInPage(helpers.emulateJs("dark"), page.sandbox);
  assert.equal(page.darkLink.getAttribute("media"), "all", "a matching link media becomes 'all'");
  assert.equal(dark.dom.linkMediaPatched, 1);
  const light = runInPage(helpers.emulateJs("light"), page.sandbox);
  assert.equal(page.darkLink.getAttribute("media"), "not all", "a non-matching link media becomes 'not all'");
  const auto = runInPage(helpers.emulateJs("auto"), page.sandbox);
  assert.equal(page.darkLink.getAttribute("media"), "(prefers-color-scheme: dark)", "auto restores the original media attribute");
  assert.ok(auto.dom.restored >= 1);
});
