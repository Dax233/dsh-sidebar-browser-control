# dsh-sidebar-browser-control

DSH 侧边栏 Agent 浏览器：给模型一个真实的 `<webview>`，支持快照/点击/输入/滚动/截图，页面内虚拟光标不会移动用户的真实鼠标。

## 安装

```sh
dsh plugin --profile desktop add github:Dax233/dsh-sidebar-browser-control
```

安装后重启 DSH Desktop；调用 `browser open` 会自动打开 Agent Browser 面板。

---

# @local/dsh-sidebar-browser-control

Host + Client plugin that gives the agent a real browser in the DSH sidebar.

- **Host half** (`index.js`): registers the `browser` tool and a loopback bridge
  (`bridge.js`, bound to 127.0.0.1) that carries tool actions to the renderer.
  The bridge requires `Authorization: Bearer <token>` (never a query parameter),
  rejects a foreign `Host` header, and only admits the DSH renderer origin
  (`dsh-app://app` / `null`) so a random web page cannot drive it.
- **Client half** (`client.js`): registers the `Agent Browser` sidebar tab type,
  owns a leased Electron `<webview>` (through `window.dshDesktop.browser`),
  executes actions with `executeJavaScript` (snapshot/refs) and
  `sendInputEvent` (trusted clicks/typing/scroll), and injects a shadow-DOM
  virtual cursor so the user can watch the agent without the OS pointer moving.

## Tool surface

`browser(action)`:

| action | arguments | meaning |
|---|---|---|
| `open` | `url` | show the sidebar panel and navigate |
| `navigate` | `url` | navigate the open panel |
| `snapshot` | – | title/url/viewport + interactive elements with refs |
| `click` | `ref` or `x,y` | move the virtual cursor, hit-test, dispatch real mouse input |
| `type` | `text`, optional `ref` | focus the ref (optional) and type |
| `key` | `key` | Enter/Tab/Escape/Arrow* |
| `scroll` | `deltaY`, optional `ref` | wheel input |
| `wait` | `ms` or `selector` | wait for time or element |
| `status` | – | bridge/client state |

Only `http:` / `https:` navigation is allowed. The plugin never touches the
user's system pointer.

## Tests

Written test-first; run from the repo root:

```powershell
npm test
```

`tests/browser-control-client.test.mjs` executes this real `client.js` in a Node
VM with mocked `__ModuleLoader__` / `dshDesktop` / `<webview>` and checks the
boot contract (`apply()` must return `undefined`), tab registration and every
controller command. `tests/browser-control-host.test.mjs` checks the tool JSON
Schema (object-rooted; DS-compatible), argument validation, and a round-trip
through a fake client.

## Development rules

1. Client `apply()` must stay synchronous and return `undefined`; background
   loops are fire-and-forget.
2. Packaged desktop loads client bundles only at page boot: after changing
   `client.js`, restart the app (or reinstall as a new package id) before
   expecting the new code.
3. Never enable the bundle while `npm test` is red.
