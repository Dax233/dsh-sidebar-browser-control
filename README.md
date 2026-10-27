# dsh-sidebar-browser-control

DSH 侧边栏 Agent 浏览器：给模型一个真实的 `<webview>`，支持快照/点击/输入/滚动/截图，以及一整套
QA 验收动作（viewport / evaluate / metrics / wait / logs / 主题模拟 / fullPage 截图 / 本地预览 /
批量 qa）；页面内虚拟光标不会移动用户的真实鼠标。

## 安装

```sh
dsh plugin --profile desktop add github:Dax233/dsh-sidebar-browser-control
```

安装后重启 DSH Desktop；调用 `browser open` 会自动打开 Agent Browser 面板。当面板存在但一直
不 ready（如 DSH 重启后的 stale webview），`open`/`navigate` 会自动 unmount 并重挂一次；仍失败时
给出 close/open 的恢复指引。

---

# @local/dsh-sidebar-browser-control

Host + Client plugin that gives the agent a real browser in the DSH sidebar.

- **Host half** (`index.js`): registers the `browser` tool and a loopback bridge
  (`bridge.js`, bound to 127.0.0.1) that carries tool actions to the renderer.
  The bridge requires `Authorization: Bearer <token>` (never a query parameter),
  rejects a foreign `Host` header, and only admits the DSH renderer origin
  (`dsh-app://app` / `null`) so a random web page cannot drive it.
- **Preview server** (`lib/preview.js`): read-only static server for local QA
  (see [Local preview](#local-preview-preview)).
- **Client half** (`client.js`): registers the `Agent Browser` sidebar tab type,
  owns a leased Electron `<webview>` (through `window.dshDesktop.browser`),
  executes actions with `executeJavaScript` (snapshot/refs, page measurement,
  theme shim) and `sendInputEvent` (trusted clicks/typing/scroll), and injects a
  shadow-DOM virtual cursor so the user can watch the agent without the OS
  pointer moving.

## Tool surface

`browser(action)` — every action returns `{ text }`; coordinates are CSS pixels
inside the page viewport.

### Interaction

| action | arguments | meaning |
|---|---|---|
| `open` | `url` | show the sidebar panel and navigate (also reopens after `close`); recovers once from a stale never-ready panel by remounting |
| `navigate` | `url` | navigate the panel, opening it first when it is closed |
| `snapshot` | – | title/url/viewport + interactive elements with refs |
| `click` | `ref` or `x,y` | move the virtual cursor, hit-test, dispatch real mouse input |
| `type` | `text`, optional `ref` | focus the ref (optional) and type |
| `key` | `key` | Enter/Tab/Escape/Arrow* |
| `scroll` | `deltaY`, optional `ref` | wheel input + script fallback; receipt has `requested/actualDelta/scrollY/scrollHeight/innerHeight/clamped/method` |
| `scrollIntoView` | `ref` or `selector`, `block` | scroll a target into view and report the resulting position |
| `wait` | `ms` / `selector` / `text` / `networkIdle`+`idleMs` / `images` / `fonts` | in-page polling; `ms` is the timeout when conditions are given |
| `status` | – | bridge state merged with the panel's viewport/theme/console counters/last url |

### QA and evidence

| action | arguments | meaning |
|---|---|---|
| `viewport` | `width`, `height` (default 800), `reset`, `scrollbars` (`auto` default / `hidden`) | set the real guest CSS viewport (the panel scales to fit); `scrollbars:"hidden"` persistently hides the page scrollbars (content width == viewport width; replayed after navigation, removed by `reset`/`close`); receipt reports actual `innerWidth/innerHeight/devicePixelRatio/contentWidth` and explains the classic-scrollbar difference |
| `evaluate` | `expression` | `executeJavaScript` wrapper; JSON result, Host receipt capped at 16KB |
| `metrics` | `selectors[]`, `includeOverflow` | viewport/document sizes, content width, top-20 horizontal overflow, images (total/loaded/failed + src), `document.fonts.status`, console error/warning counts, per-selector rect/natural size |
| `logs` | `clear`, `filter`, `limit` | console-message ring buffer (≤200) + page-side failed-image/resource probe |
| `screenshot` | `fullPage`, `clip{x,y,width,height}`, `ref`, `selector`, `format` (`png`/`jpeg`), `quality`, `path`, `hideCursor` | saves PNG/JPEG evidence and reports the real pixel size parsed from the file; `fullPage` scroll-stitches viewport captures (≤12000 CSS px; fixed/sticky elements may repeat) and reports stage diagnostics, per-step `timings` and the segment count; an element taller than the viewport (or outside it) is scroll-stitched instead of clipped (≤12000, `capped`/`croppedWidth` annotated); every stitch step has a timeout; fullPage rides a longer bridge command timeout (default 120s, `DSH_BROWSER_CONTROL_FULLPAGE_TIMEOUT_MS`) |
| `emulate` | `colorScheme` (`light`/`dark`/`auto`) | best-effort light/dark preference: matchMedia shim, same-origin `@media (prefers-color-scheme)` rewrite, plus a DOM fallback that re-picks native `<picture><source media>` and normalizes `<link rel=stylesheet media>` (including open shadow roots, capped at 6000 nodes); counters in the receipt; fully restored by `auto`; replayed on navigation (open/navigate/click/key) |
| `setContent` | `html`, optional `baseUrl` | render self-contained HTML (inline CSS / `data:` URLs; max 2MB) |
| `preview` | `dir` (absolute), optional `file`, `port` | serve a local directory over a tokenized 127.0.0.1 URL and open it |
| `qa` | `url`, `widths`, `themes`, `height`, `fullPage`, `scrollbars`, `maxVariants`, `outDir`, `selectors` | one call runs the width × theme matrix (≤6 variants); `scrollbars` is passed to every variant's viewport command; the result table reports viewport + content width; saves one screenshot per variant |
| `close` | – | release the leased webview; `open` reopens |

Only `http:` / `https:` navigation is allowed. The plugin never touches the
user's system pointer.

### QA workflow example

```text
browser open https://example.com/
browser viewport {width:390, height:844}
browser emulate {colorScheme:"dark"}
browser metrics {selectors:[".hero","#cta"]}
browser wait {images:true, fonts:true, networkIdle:true, idleMs:600, ms:5000}
browser screenshot {fullPage:true, path:"C:\\evidence\\mobile-dark.png"}
browser qa {url:"https://example.com/", widths:[1280,768,375], themes:["light","dark"], outDir:"C:\\evidence\\qa"}
browser close
```

## Limits (honest boundaries)

- **DPR / deviceScaleFactor is not emulated.** A renderer-side `<webview>` only
  exposes DOM APIs, not `webContents.debugger`, so `Emulation.setDeviceMetricsOverride`
  is unreachable. The plugin never fakes a 2x image: receipts report the real
  `devicePixelRatio` and the screenshot's real pixel size. Real DPR QA should use
  the separate chrome-bridge plugin (real CDP) or external CDP.
- **`file://` is unavailable.** The DSH desktop shell only admits `http(s)` frame
  navigation and cancels `file:` requests, so a plugin cannot legally open local
  files. Use `setContent` for self-contained HTML, or `preview` for a local
  directory (see below).
- **No offscreen / CI mode.** `qa` runs inside the visible sidebar panel; the
  plugin has no Electron main-process access and cannot render headless.
- **`fullPage` screenshot is scroll-stitched, not a guest resize.** On the first
  real-device run (2026-10-26) the earlier "grow the webview element then
  `capturePage()`" approach hung `capturePage()` forever and wedged the command
  loop until DSH restarted. The current implementation hides the page scrollbars,
  scrolls one viewport at a time, captures normal-size frames, and stitches them
  in a canvas (cap 12000 CSS px, reported as `capped`). `vh` layouts are no longer
  distorted, but `position:fixed/sticky` elements can repeat in the stitched image.
  Since round 2 (0.2.4): **every step is bounded** — each `capturePage`/decode/
  scroll call races its own timeout (capture 8s, decode 1.5s), the whole capture
  carries a 60s total budget (never hangs forever), every stage posts a
  `fullpage` diagnostic to the bridge diag ring (`postDiag`), and the receipt
  reports `timings` (total wall ms + per-segment capture/encode ms). The bridge
  timeout for a fullPage command is 120s (`DSH_BROWSER_CONTROL_FULLPAGE_TIMEOUT_MS`)
  so slow-but-healthy stitches survive the 25s default.
  **Root cause found on the 2026-10-27 device run (fixed in 0.2.5):** the client
  finished a github.com fullPage in 799ms (4 segments, per-segment capture 33–66ms),
  but the bridge's `/result` handler rejected request bodies over 1 MB, and a real
  site's full-page PNG base64 is several MB — the result was silently dropped and
  the Host could only report a command timeout. A JPEG capture of the same page
  (211 KB) succeeded in 669ms, which confirmed it. The bridge now accepts result
  bodies up to 64 MB (`maxResultBodyBytes`), answers 413 and records
  `lastRejectedBody` in the diag state when a body is too large, and the client
  pre-checks the JSON payload (48 MB) so an oversized capture fails with an
  actionable error ("use format jpeg / smaller clip") instead of a bare timeout.
  For very long real pages prefer `format:"jpeg"` (much smaller) or a smaller
  viewport width.
- **Tall element screenshots are scroll-stitched too (0.2.4).** An element
  taller than the viewport (or lying outside it) used to be clipped to the first
  screen; it is now stitched from scroll captures into one image (cap 12000 CSS
  px, `capped` annotated). Content wider than the viewport is cropped and the
  receipt reports `croppedWidth` instead of faking it. `position:fixed/sticky`
  repeats apply here as well.
- **`viewport scrollbars:"hidden"` removes the classic scrollbar (0.2.4).**
  The same hide-scrollbar CSS used by fullPage is injected persistently
  (replayed after navigation; removed by `viewport reset` or `close`) so the
  content width equals the viewport width. The receipt reports
  `contentWidth` (`documentElement.clientWidth`) and explains the difference
  when the guest uses a classic (non-overlay) scrollbar.
- **Screenshots use the sandbox-safe image path.** The DSH renderer has no Node
  integration, so Electron's `nativeImage.toPNG()/toJPEG()` throw "Buffer is not
  available for the current Context". Capture conversion therefore prefers
  `toDataURL()`; JPEG falls back to re-encoding the PNG in a canvas when `toJPEG`
  is unavailable (0.2.2, found on a real tab).
- **Theme `emulate` is best-effort, not CDP emulation.** It overrides
  `matchMedia('(prefers-color-scheme: …)')` in the page, rewrites same-origin
  media rules to `all`/`not all`, and since 0.2.4 re-picks native
  `<picture><source media="…prefers-color-scheme…">` and normalizes
  `<link rel=stylesheet media="…">` in the DOM (including open shadow roots, up
  to a 6000-node budget; counters in the receipt, full restore on `auto`).
  Since 0.2.6 the picture patch also **neutralises every `<source media>` to
  `not all`** while patched (restored on `auto`): the browser resolves
  `<picture>` with the REAL preference, so on a dark-OS machine a dark
  `<source>` would always override the img and a light emulation could never
  win (found on a real probe page, where img attrs were correct but
  `img.currentSrc` stayed dark). When no source matches the emulated scheme the
  patch falls back to the img's own `src`.
  Honest boundaries of that DOM fallback: pages that pick their image via
  **JS runtime logic** (framework conditionals) still win over the patch,
  **closed shadow DOM** is unreachable (`element.shadowRoot` is `null`), and
  CSS `image-set()` variants are not rewritten. Cross-origin stylesheets remain
  unreadable by design (reported as `crossOrigin`); media rules that combine
  `prefers-color-scheme` with other conditions are resolved at apply time, so
  resizing afterwards does not re-evaluate them; it is replayed on navigation
  (open/navigate, and click/key actions that replace the document).
- **No HTTP status codes for network logs.** `logs` can only see
  `console-message` events and page-side image/resource probes; a renderer
  `<webview>` has no network instrumentation, so failed requests are inferred
  (failed images, zero-transfer resource entries) rather than reported with a
  status code.
- **`wait networkIdle` is an approximation**: quiet resource-entry count + DOM
  mutations for `idleMs`, not real network idle.
- **`viewport` is a real CSS viewport, displayed scaled** down inside the panel;
  the panel scale never changes the guest's layout size. A real Electron `<webview>`
  can take more than one frame to propagate the element resize into the guest's
  `innerWidth/innerHeight`, so the action polls until the guest reports the
  requested size (or warns after ~2s) instead of reporting the previous size.
- **`scroll` sends a negated wheel delta internally.** Electron's synthesized
  `mouseWheel` `deltaY` follows the Chromium convention (positive scrolls up),
  opposite to the DOM: the action negates it so `deltaY` positive scrolls down;
  if the synthetic wheel is ignored the scripted fallback runs and the receipt
  says `[script fallback]`.

## Local preview (`preview`)

`preview {dir, file?, port?}` starts a static server and navigates the panel to
it, so a local directory can be QA'd without asking the user to run their own
server. Security posture:

- binds to **127.0.0.1 only**;
- every URL has a **random token path prefix** (`/…32 hex…/`); a request without
  the token gets a plain 404;
- **GET/HEAD only**; `POST`/others get `405`;
- **path traversal is rejected**: the decoded path is resolved, `realpath`ed,
  and required to stay inside the served directory (`..`, encoded `..`,
  backslashes and symlinks pointing outside all fail);
- **no directory listings**: a directory serves its `index.html`, otherwise 404;
- **only source-sized files**: a single file larger than 64 MiB is refused with
  `413`, so the Host never reads a huge media file into memory;
- `dir` must be an **absolute path** (a Host-process relative path would resolve
  against the DSH install directory, not the session workspace);
- one server per plugin instance; a different `dir`/`file`/`port` replaces it,
  and the plugin **closes it on dispose**.

`setContent` is the file-free alternative: it renders the given HTML through
`document.open/write/close` on the current document context (about:blank right
after mount) and injects `<base href>` when `baseUrl` is given. Inline CSS and
`data:` URLs work; relative links need `baseUrl`; `file://` never works.

## Tests

Written test-first; run from the repo root:

```powershell
npm test
```

`tests/browser-control-client.test.mjs` executes this real `client.js` in a Node
VM with mocked `__ModuleLoader__` / `dshDesktop` / `<webview>` and checks the
boot contract (`apply()` must return `undefined`), tab registration and every
controller command (including the 0.2.x QA commands).
`tests/browser-control-scripts.test.mjs` executes the generated page scripts
(theme shim, metrics, wait, setContent) against fake page globals, so the logic
is asserted behaviourally, not just by string. `tests/browser-control-host.test.mjs`
checks the tool JSON Schema (object-rooted; DS-compatible), per-action argument
validation, receipts, and a round-trip through a fake client (including
`qa`/`preview`/`screenshot` file output). `tests/bridge.test.mjs` covers the
bridge HTTP contract and per-command timeout overrides. `tests/preview.test.mjs`
covers the preview server's token/path-traversal/dispose boundaries.

## Development rules

1. Client `apply()` must stay synchronous and return `undefined`; background
   loops are fire-and-forget.
2. Packaged desktop loads client bundles only at page boot: after changing
   `client.js`, restart the app (or reinstall as a new package id) before
   expecting the new code.
3. Never enable the bundle while `npm test` is red.
