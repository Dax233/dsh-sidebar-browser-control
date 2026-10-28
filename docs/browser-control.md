# 浏览器控制插件：设计与落地顺序

> 状态：Phase 0 进行中 —— S2（Host↔Client 桥）**已验证通过**（2026-10-22）；
> S1（侧边栏 webview 控制）代码完成、等待重启验证；测试先行流程已建立（§10）。
> 事故复盘见 §0。
> 最后更新：2026-10-27（§34.8 第二轮迭代，0.2.4）。

## 0. 事故复盘：重启后无限加载（2026-10-22）

- **现象**：spike 插件启用时重启 DSH 桌面版，启动停在加载页；从 UI 禁用两个插件后恢复正常。
- **根因**：Client 半 `apply()` 末尾 `return loop;`，而 `loop` 是永不 resolve 的 bridge 轮询 Promise。
  Cordis 把 apply 返回的 thenable 视为"仍在加载"，client 启动审计会等待每个 entry 就绪 → 永远等不到 → 无限加载。
- **为什么之前没暴露**：首版 client 是通过运行期 HMR 加载的，不走启动审计；只有重启后按 boot graph 加载才会等 apply 完成。
- **修复**：`apply()` 同步返回 `undefined`；bridge 轮询改为 fire-and-forget（`loop.catch(...)` 兜住异常）；
  整个 apply 包 try/catch；侧边栏 tab 打开改为重试（启动早期会报 `no session surface is mounted`）。
- **防护**：新增 `tests/browser-control-client.test.mjs` 的 **BOOT CONTRACT** 回归测试
  （`apply()` 必须返回 `undefined`），并做过变异验证：把 `void loop` 改回 `return loop` 时测试必红。
- **另一条环境事实**：打包版桌面 App 的 client 模块只在**页面启动时**从 boot graph 加载；
  运行中新增/替换 client 插件不会生效（graph/rebuilt 帧不落地）。因此 **client 代码每次改动都必须重启 App 验证**，
  不要指望 HMR。

目标（用户 2026-10-22 提出）：

- **A. 侧边栏内置浏览器 + Agent 操控 + 独立虚拟光标**
  Agent 能打开/点击/输入/滚动；用户能看到 Agent 的“鼠标”与点击反馈；这个鼠标不抢占用户真实系统指针。
- **B. Chrome 扩展 + 配套控制插件**
  Agent 连接用户真实 Chrome，控制指定标签页；标签页切到后台后仍可继续操作。

原则：不依赖 Playwright/Puppeteer/额外 Chromium 下载（宿主机 F: 仅剩约 11.8 GB），
优先复用 DSH 自身与 Electron 已带的能力；每一步都可安装、可实测、可回滚。

## 1. 外部参考（OpenAI Codex / ChatGPT 桌面版）

已验证（来源）：

- Codex CLI 与 IDE 扩展**没有**内置浏览器；内置浏览器位于 ChatGPT/Codex 桌面 App 中，
  作为对话旁的浏览器标签页（分栏/全屏）。来源：<https://learn.chatgpt.com/docs/browser.md>、
  相关 issue <https://github.com/openai/codex/issues/53521>。
- 桌面 App 中由 **Computer Use** 驱动内置浏览器（打开页面、点击、输入、读取渲染状态、截图、验证结果）；
  Windows 上 Computer Use 会接管真实桌面指针、不能后台运行。来源：
  <https://learn.chatgpt.com/docs/browser.md>、<https://learn.chatgpt.com/docs/computer-use.md>。
- CDP 是**需要显式开启**的开发/检查通道（Settings → Browser → Developer mode → Enable full CDP access，
  且可由管理员策略关闭）。来源同上。
- Agent 光标的实现线索：注入到页面里的 shadow-DOM 覆盖层 + 自定义光标元素，
  原生光标被隐藏（`cursor: none !important`）。证据：
  <https://github.com/openai/codex/issues/36222>、<https://github.com/openai/codex/issues/52941>；
  另有“光标形状的控制标记”在停止后残留的报告 <https://github.com/openai/codex/issues/55540>。
- 已知难点：坐标映射（DPI/缩放下点击位置与可见光标错位）<https://github.com/openai/codex/issues/48505>；
  因此实现时必须做点击前命中测试（`elementFromPoint` + 可见/可用/未被遮挡检查）。

可对比的开源实现：

- **Nanobrowser**（Apache-2.0，Chrome 侧边栏）：只通过 `chrome.debugger` 操作页面，
  Puppeteer 仅用于 frame 管理；点击/输入是真实浏览器输入；一个任务一个标签组；
  操作前检查元素可见、未移动、可用、未被遮挡。无视觉光标。来源：<https://github.com/nanobrowser/nanobrowser>。
- **Stagehand / browser-use / Chrome DevTools MCP / Playwright MCP**：均无公开的“页面内 Agent 光标”实现；
  Playwright MCP 通过浏览器扩展接管用户已打开的标签页。来源：
  <https://github.com/browserbase/stagehand>、<https://github.com/browser-use/browser-use>、
  <https://github.com/ChromeDevTools/chrome-devtools-mcp>、
  <https://github.com/microsoft/playwright/tree/main/packages/extension>。

关于 Chrom 扩展的关键结论（来自调研）：

- OpenAI 的扩展权限里同时出现 “Access the page debugger” 与 “Communicate with cooperating native applications”，
  推断其生产实现是 **`chrome.debugger` + native messaging**，而不是 `--remote-debugging-port`。
  来源：<https://learn.chatgpt.com/docs/chrome-extension>（权限文案见该页）。
- Chrome 144+ 起，普通 `--remote-debugging-port` 需要用户在 `chrome://inspect` 里手动勾选并允许，
  端口动态；因此“直接开调试端口”不再是零摩擦方案（Nanobrowser 因此只走扩展内 `chrome.debugger`）。
- `chrome.debugger` 能操作**后台标签页**（按标签页 attach，不要求前台），这是 Goal B 的核心机制；
  代价是 Chrome 会显示“正在调试此浏览器”的提示条（不可屏蔽），权限范围按标签页、可随时撤销。

## 2. 本机 DSH 可行性（已验证，来自当前安装的 0.2.1-rc.2）

- DSH 已自带侧边栏浏览器：`@deepseek-ai/dsh-client-ui-sidebar-browser`。
  Desktop 使用 Electron `<webview>`；主进程 `DesktopBrowserGuests` 用 **lease** 管控每个 guest：
  渲染进程通过 preload 暴露的 `window.dshDesktop.browser.acquire(workspace)` 拿到 `{ lease, partition }`，
  然后创建 `<webview name=lease partition=partition src="about:blank#<lease>">`；
  主进程在 `will-attach-webview` 校验 lease/partition 并固定安全参数（sandbox、无 node、devTools 打包后关闭），
  `did-attach-webview` 后才允许页面存活。参考实现位置（app.asar 内）：
  `lib/main.js` 的 `DesktopBrowserGuests`、`dsh-client-ui-sidebar-browser/lib/client.js`、
  `lib/preload-app.cjs` 的 `createProductApi().browser`。
- 该 webview 是**用户向**的：DSH 自身不提供 Agent 控制，也没有对外暴露“控制已有 guest”的 API。
- 侧边栏提供了**公开扩展点**，第三方插件可以注册自己的标签页类型与内容：
  `ctx.sidebarRightTabs.register({ id, kind, title, ... })` + 在 `sidebar.right.pane.tab` 槽位注册 body
  （`ctx.slots.register`）；参考 `@deepseek-ai/dsh-client-ui-sidebar-right/README.md`。
- Host 插件可以：
  - 注册 Agent 工具（`ctx.tools.register`）；
  - 监听普通 Node HTTP 服务（插件是普通 Node 进程内代码）；
  - 使用 `ctx.webServer.register/registerUpgrade`、`ctx.connection.admit` 等公开服务（备用通道方案）。
- 因此 Goal A 的合理做法：**新建我们自己的“Agent Browser”标签类型，拥有自己的 leased webview**，
  由我们自己的客户端插件驱动；不去接管 DSH 自带 Browser 标签的 guest（那是私有实现，跨版本会碎）。

## 3. 总体架构

```
                 ┌───────────────────────── DSH Host 进程 (Node) ─────────────────────────┐
                 │  plugin: sidebar-browser-control (Host half)                          │
  Agent tools ◄──┤  ctx.tools.register("browser", actions)                              │
  (模型调用)      │   ├─ per-session panel registry / command queue / timeout / policy    │
                 │   └─ bridge server: 127.0.0.1:<port> + token                          │
                 │        ├─ /panel  ←→ 侧边栏客户端插件（自定义 webview）                │
                 │        └─ /ext    ←→ Chrome 扩展（Goal B，Phase 3）                    │
                 └──────────────────────────────────────────────────────────────────────┘
                                        ▲ 长期轮询/WS（JSON 命令）
                                        │
                 ┌──────────────────────┴──────── DSH 客户端 (renderer) ─────────────────┐
                 │  plugin: sidebar-browser-control (Client half)                        │
                 │   侧边栏 tab type "Agent Browser" + body slot                         │
                 │   ├─ dshDesktop.browser.acquire → <webview>（我们自己的 guest）        │
                 │   ├─ webview.executeJavaScript：DOM/AX 快照、注入光标覆盖层            │
                 │   ├─ webview.sendInputEvent：真实鼠标/键盘输入（不移动系统指针）       │
                 │   └─ 操作状态 UI：Agent 控制中 / 用户接管 / 停止                      │
                 └──────────────────────────────────────────────────────────────────────┘
```

为什么桥使用**独立 loopback 服务**而不是 DSH 内部 RPC：

- Host→Client（工具给面板下命令）在 DSH 的公开插件 API 里没有直接的“调用客户端”入口；
  内部 Typert Remote/Client 适配器需要代码生成，本地纯 JS 插件用不了（详见 §7 风险）。
- 独立 127.0.0.1 服务 + 随机/固定 token 与 DSH 版本解耦，Host/Client 两边都是我们自己的代码，
  失败模式简单；不给 DSH 升级引入私有依赖。代价是需要处理 CORS/PNA 与端口发现（Phase 0 验证）。

## 4. Goal A 交互与实现要点

工具（首版，模型可一次传 action）：

| action | 参数 | 说明 |
|---|---|---|
| `open` | `url` | 在侧边栏打开/复用 Agent Browser 标签并导航 |
| `snapshot` | `maxChars?` | 返回可交互元素列表：`ref`、角色/标签、文本、坐标、是否可见；作为模型点击的依据 |
| `click` | `ref` 或 `x,y` | 先 `elementFromPoint` 校验，再在元素中心派发真实鼠标事件 |
| `type` | `ref`/`text` | 先聚焦元素再逐键输入（或 `input` 事件） |
| `key` | `key` | Enter/Tab/Escape/方向键等 |
| `scroll` | `deltaY` / `ref` | 滚轮事件 |
| `navigate` | `url` | 地址导航 |
| `wait` | `ms` / `selector` | 等待加载/选择器 |
| `screenshot` | — | 若 webview 可截屏则返回图片，否则暂不提供（Phase 2 决定） |

前端光标（对齐 Codex 的做法，但更克制）：

- 注入一个 `position:fixed; inset:0; pointer-events:none; z-index:max` 的覆盖层（open shadow root），
  内部一个“Agent 光标”元素与点击涟漪；用 CSS transition/transform 移动到目标点，不移动系统指针。
- 覆盖层只在 Agent 操作时出现，`pointer-events:none` 保证用户仍可直接操作页面；
  用户一旦直接操作（面板获得焦点/真实输入）即视为“接管”，暂停 Agent 操作并提示。
- 页面 CSP 可能拦截注入 `<style>`：使用 `adoptedStyleSheets` 注入样式（调研中发现的实际坑）。
- 点击坐标换算统一用 `getBoundingClientRect` + devicePixelRatio 校准；点击前做命中测试，避免 Codex 的坐标错位问题。

安全边界（首版）：

- 只操作我们自己的 webview；不触碰 DSH 自带 Browser guest。
- 导航限 http(s)，拒绝 DSH 自身 origin 与 file:（主进程已有部分限制，插件再校验一次）。
- 面板内提供显眼的“Agent 控制 / 停止 / 用户接管”状态与开关。
- Tool 默认超时与“面板未打开”明确报错，不静默失败。

## 5. Goal B（Chrome 扩展）实现要点

- **扩展（MV3）**：`extensions/chrome-bridge/`
  - service worker：连接 `ws://127.0.0.1:<port>/ext?token=…`（或 HTTP 长轮询回退）；
  - `chrome.debugger.attach({tabId}, "1.3")` 按标签页 attach；`chrome.tabs.query` 列表；
  - CDP 动作：`Page.navigate`、`Input.dispatchMouseEvent`、`Input.insertText`、`Runtime.evaluate`、
    `Page.captureScreenshot`、`DOM.getDocument`/`Accessibility.getFullAXTree`；
  - 配对：扩展 popup 里输入/自动发现端口+token；标签组标识“Agent 正在控制的标签”；
  - 用户可随时关闭调试（Chrome 自带提示条与“取消”），插件检测断连。
- **Host 侧**：与 Goal A 共用一个 bridge，增加 `channel=chrome`；工具面统一为 `browser`，
  以 `target: "sidebar" | "chrome"` 区分（或按需拆成两个工具，Phase 3 定）。
- **后台标签页**：`chrome.debugger` 按标签页 attach，不要求标签在前台；
  截图/点击在后台标签的表现需 Phase 3 实测（其中“后台截图是否空白”是主要不确定点，
  若不支持则以 DOM/AX 文本操作为主）。
- **安装方式（待定）**：开发期 `chrome://extensions` → 开发者模式 → 加载已解压扩展；
  正式分发可选自签名 CRX / 商店上架（需要用户决定）。

## 6. 分阶段计划与验收

| 阶段 | 内容 | 验收（都必须在运行中的 DSH 实测） |
|---|---|---|
| **Phase 0 spike**（1 个插件骨架，失败即删） | S1：客户端插件在自己注册的 tab 里创建 leased webview，`executeJavaScript`/`sendInputEvent` 生效、覆盖层可见；S2：Host 工具 ↔ loopback 面板桥往返；S3：webview 截屏是否可用 | `example.com` 上：snapshot 有元素、click 链接跳转、type 进输入框；无系统鼠标移动；桥往返 < 100ms |
| **Phase 1 Goal A MVP** | 上面 §4 的工具与光标、状态 UI、错误处理 | 打开站点→snapshot→点击/输入/滚动→验证页面状态；用户可直接接管；停止按钮立即生效 |
| **Phase 2 Goal A 硬化** | 多标签、iframe、等待策略、locale/icon、设置页、安全策略、文档 | 在 3 个真实站点（含中文站点）完成一次端到端任务；插件页显示正常 |
| **Phase 3 Goal B MVP** | 扩展 + WS + `chrome.debugger` + 前台/后台标签操作 + 配对 | 用户 Chrome 中一个新标签：导航/点击/输入；切到后台后仍能 snapshot/点击；可随时断开 |
| **Phase 4 收尾** | 统一工具体验、可选 native messaging、dist 打包、版本 1.0.0 | 两个 goal 的用户流程走通，文档与 dist 更新 |

每个阶段：`plugin_manager install_bundle` → 实测 → `git commit` → 更新 dist（需要时）。

## 7. 主要风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| DSH 无公开 Host→Client 调用入口 | 桥不通 | 采用 loopback 服务桥（不依赖内部 RPC）；Phase 0 先验证 |
| 客户端页面（dsh-app://）到 127.0.0.1 的 CORS/PNA 限制 | 面板连不上 Host | 服务端返回 CORS/PNA 头 + token；备选：走 DSH `webServer` 升级路由 |
| webview 主进程策略（lease、导航限制）与版本升级 | 插件失效 | 用公开能力（`dshDesktop.browser`、公开 tab 扩展点）；产品升级后用 `scripts/verify.ps1` 思路加浏览器专项自检 |
| `webview.sendInputEvent` 在后台/失焦时的行为 | 点击无效 | Phase 0 实测；备选注入 DOM 事件（isTrusted=false）或让面板先聚焦 webview |
| 后台标签页截图空白（Chrome 渲染节流） | Vision 能力受限 | 以 DOM/AX 文本为第一等公民；截图作为增强 |
| `chrome.debugger` 的“正在调试”提示与权限 | 用户观感 | 明示状态；按标签页 attach；可一键断开 |
| 依赖体积/磁盘 | 宿主磁盘紧张 | 零第三方依赖（不装 Playwright/Puppeteer/Chromium）；必要时 pnpm store 迁到 K: |
| 安全：Agent 自动操作登录态页面 | 误操作风险 | 默认“面板内显式授权/站点白名单”，操作日志 + 停止（待用户决策，见 §8） |

## 8. 已决策（用户，2026-10-22）

1. **授权模型：B — 完全自动**。Agent 打开面板后可操作任何站点，无需逐站批准；
   保留显眼的「停止 / 用户接管」与操作日志作为安全阀。
2. **Chrome 扩展分发：B — 同时做自签名 CRX**。开发期用开发者模式加载未打包目录迭代，
   Phase 4 产出自签名 `.crx` 便于固定安装（仍需开发者模式/策略允许）。

## 10. 开发流程与测试（强制，2026-10-22 起）

用户要求：**先构建测试用例，对着测试用例开发，测试通过确认无误后再应用**。
仓库根目录提供测试入口：

```powershell
cd <repo>
npm test
```

现有测试覆盖（见 `npm test`）：

| 文件 | 覆盖 |
|---|---|
| `tests/support/client-harness.mjs` | 在 Node VM 里用 mock 的 `window.__ModuleLoader__` / `require` / `fetch` / `document` / `AbortSignal` 执行**真实 client.js** |
| `tests/browser-control-client.test.mjs` | 模块 id、plugin 形状、**BOOT CONTRACT（apply 不得返回 thenable）**、tab/body 注册、openTab 重试、ping 往返、**卸载后停止轮询**、mount/命令分发/光标/点击/输入/滚动/导航等待 |
| `tests/bridge.test.mjs` | 桥的 HTTP 契约：token 鉴权、poll 投递、result 结算、diag、关闭时结算 pending、**只投递给最新 client 实例**、**关闭时结束挂起 long-poll**（端口 0，不占用真实端口） |
| `tests/browser-control-host.test.mjs` | Host apply 同步完成、工具注册、**DS 兼容 schema 回归**、参数校验、fake client 端到端往返（open/snapshot/click/type/scroll）、监听启动、dispose 安全 |
| `tests/browser-control-*.test.mjs` / `tests/bridge.test.mjs` | Agent 浏览器 client/host 与桥的回归测试 |

**两条硬规则**（违反其一就会重现 2026-10-22 的启动事故）：

1. client 插件 `apply()` **必须同步返回 `undefined`**，后台循环一律 fire-and-forget；
   client 代码禁止顶层 await / 阻塞式初始化。
2. 打包桌面端 **client 代码改动必须重启 App 验证**；不要依赖运行期 HMR。

开发顺序（每个变更都必须遵守）：

1. 先在 `tests/` 写/改测试并让它失败（红）；
2. 改实现直到 `npm test` 全绿；
3. `plugin_manager remove_bundle` → `install_bundle` 重新安装 Host 半；
4. 需要 client 半变更时，请用户重启 App，再按 `%TEMP%\dsh-browser-control-state.json` 的诊断验证；
5. 验证通过才提交；**测试未绿不允许启用 bundle**。

## 11. Phase 0 进展（早期 spike 代码已在公开前移除，历史提交可查）

- **S2 桥已验证**（2026-10-22）：
  - Host 插件零依赖注册工具 + 起站 `127.0.0.1:47833`（`node:http`），写诊断状态到 `%TEMP%\dsh-browser-spike-state.json`；
  - 客户端半（`dsh.client.immediately: true`）**热加载即生效，无需重启/刷新**，从 `dsh-app://app`
    页面直接 `fetch` 该端口（CORS `*` + PNA 允许头即可），证明 CORS/PNA 不拦；
  - Host→Client→Host 全链路自动 ping：往返 **3–6ms**，客户端回报
    `origin: dsh-app://app`、Electron 44.7.0 / Chrome 152 / DSH 0.2.1-rc.2。
- **工具 schema 的坑（已修复）**：profile 插件用裸对象注册工具时不会经过
  `defineTool` 的 `parameterSchemaSpecToJsonSchema` 转换，DSH 方言
  （属性内 `required: true`）原样上 wire，DS 上游 400：`schema must be a JSON Schema of type:"object", got type:null`。
  修法：**手写等价 JSON Schema** —— 顶层 `{ type:"object", properties, required:[...] }`，
  属性内不带 `required` 标志（与 `defineTool` 输出逐字段同形）。正式插件沿用此约定，
  （若事实证明 profile 插件可 `import "@deepseek-ai/dsh-tools"`，可改回 `defineTool`，待验证）。
- **S1 侧边栏 webview 控制已验证**（2026-10-22，自检 7/7 全过）：
  - `dshDesktop.browser.acquire()` 拿到 lease/partition；`<webview src="about:blank#lease">` 成功挂载
    （`dom-ready`，webContentsId=2），导航 `https://example.com/` 正常；
  - `snapshot`：`executeJavaScript` 返回可交互元素（ref/文本/坐标/可见性），example.com 上正确列出
    “Learn more” 链接（x=280,y=731）；
  - `overlay`：shadow-DOM 光标覆盖层注入成功（`translate(48px,64px)`），`pointer-events:none`，
    不影响系统鼠标；
  - `click`：在链接中心派发 `sendInputEvent`（mouseDown/mouseUp）→ **真实跳转**到
    `https://www.iana.org/help/example-domains`（`navigated: true`）；
  - `type`：`sendInputEvent({type:'char'})` 逐字符输入，注入的输入框得到 `"abc"`；
  - `capabilities`：`loadURL / executeJavaScript / sendInputEvent / insertCSS / **capturePage** /
    getWebContentsId / focus / reload / getURL` 全部可用 → 截图能力具备（Phase 2 接）；
  - 桥在整套自检期间保持 **3–7ms** 往返。
- 经验修正：在**新启动**的 App 实例里，运行期启用 bundle 仍可热加载 client 模块（graph 通道存活）；
  但**替换已加载的同一模块**不会生效。所以 client 代码迭代仍需重启，新 id 的首次加载可以不重启。
- 待办：`scroll` 用例在 google.com 上测到 `scrollHeight == innerHeight`（页面未撑开/加载未完成），
  Phase 1 用更稳的等待策略重测。

## 12. Phase 1 进展（`sidebar-browser-control/` → `@local/dsh-sidebar-browser-control`）

**MVP 已落地并完成端到端验证**（2026-10-22）：

- **工具面**：`browser`（`open / navigate / snapshot / click / type / key / scroll / wait / status`），
  参数为 wire-ready JSON Schema（object root + required 数组），坐标/ref 两种寻址；
  只允许 http(s) 导航。
- **Client**：注册 `Agent Browser` 侧边栏标签类型；`dshDesktop.browser.acquire()` 拿 lease 建 webview；
  snapshot 用页面内 `window.__dshAgentRefs` 保存元素引用；点击前先 `elementFromPoint` 命中测试、
  再移动 shadow-DOM 虚拟光标（180ms 过渡），然后 `sendInputEvent` 派发真实 mouseDown/mouseUp；
  `type` 支持 ref 聚焦 + 逐字符 char 事件；`wait` 支持时间或选择器轮询。
- **测试先行**：`tests/browser-control-client.test.mjs`（12 项，VM 执行真实 client.js）+
  `tests/browser-control-host.test.mjs`（7 项，含 fake client 端到端往返）；整套 **36 项全绿**。
- **端到端实测**（子 agent 只调 `browser` 工具）：
  - `status` → 桥 47834、client 在线；
  - `open https://example.com/` → `opened ... (Example Domain)`；
  - `snapshot` → `ref=0 <a> "Learn more" @280,731`；
  - `click ref=0` → 真实跳转到 `https://www.iana.org/help/example-domains`；
  - 再次 `snapshot` → 31 个可交互元素；`scroll deltaY=300` → ok。
- 已知体验缺口（下一批改进，需一次重启验证）：scroll 结果没有回显 `scrollY`；type 后没有回显输入框值；
  click 后对“是否发生导航”只是事后比对 URL（可改为等待导航事件）；截图（`capturePage` 可用）尚未接入工具。

**Phase 1 修复与增强（2026-10-22 第二轮，已测试但待重启验证）**：

- **生命周期 bug**：client 桥循环在插件卸载后不会停止（重装后出现多个重复 client 轮询）；
  修复为 `AbortController` 生命周期 + 循环内检查，卸载即中止。
- **多实例路由**：bridge 只把命令投递给**最新注册**的 client 实例（`firstSeenAt`），
  旧实例的 poll 立即返回空——重装后不会把命令发给已销毁的旧面板。
- **关闭挂起**：`bridge.close()` 先结束所有挂起的长轮询再关闭监听，Host 卸载/测试不再挂起。
- **体验增强**：click 等待 `did-navigate` 并回报 `navigated`；scroll 回显 `scrollY/scrollHeight/innerHeight`；
  type 回显聚焦元素当前值；snapshot 过滤不可见元素并回报 `skipped` 数量；工具文本提示“refs 仅对最近一次 snapshot 有效”。
- 测试从 36 → **42 项全绿**（新增卸载停止轮询、最新实例路由、关闭长轮询、导航等待、scroll/type 回显等用例）。
- 验证状态：以上 client 改动需**重启 App** 后生效；当前页面里残留的是修复前的旧 client 实例（会造成 47834 端口轮询争用），
  重启即清空。重启后按 `%TEMP%\dsh-browser-control-state.json` 的 `activeClient` 与 `diags` 验证。

**Phase 1 重启后验证（2026-10-22，已通过）**：

- 干净状态：重启后仅一个 client（`activeClient` 正确）；旧标签页自动恢复面板并拿到新 lease。
- 子 agent 实测（仅用 `browser` 工具）：open/snapshot/click 导航到 iana.org 且 click 文本回报
  `page changed to …`；`type` 回显 `focused value`；snapshot 过滤隐藏元素（DuckDuckGo 175 可见 + 9 hidden skipped）；
  `scroll` 现在**真实滚动**（example.com 35px、Wikipedia 600px），并标记 `[script fallback]`——
  合成 wheel 事件在 guest 中不稳定，脚本 fallback 兜底。
- 已知小问题：ref-click 回显的坐标是"滚动到视口后"的坐标，与 snapshot 里的 @坐标不一定相同（仅观感差异，点击本身正确）。
- **截图能力已验证**（2026-10-22 第三轮）：`browser action=screenshot` → `capturePage()` 生成 PNG
  落盘到 `%TEMP%\dsh-browser-shots\`（实测 46,534 字节、575×742），返回路径；用 `read_image` 打开确认
  是真实页面渲染（不是空白/黑图）。工具描述里已提示模型用 `read_image` 查看。

## 13. Goal B 进展（`chrome-bridge/` + `extensions/chrome-extension/`）

**MVP 代码完成、测试通过，等待在 Chrome 中加载扩展后做真实端到端验证**（2026-10-22）：

- 传输：`chrome-bridge/ws.js` —— 零依赖 RFC6455 服务端（握手、64 位帧、ping/pong、close、
  token 鉴权、新连接替换旧扩展实例），监听 `127.0.0.1:47835`。
- Host 工具：`chrome`（status/tabs/newTab/closeTab/attach/detach/navigate/snapshot/click/type/key/scroll/screenshot），
  schema 为 DS 兼容的 object-rooted JSON Schema；无扩展时返回加载扩展的操作提示；
  `newTab` 默认在**后台**新建（不抢用户当前标签），`screenshot` 经 CDP 截 PNG 后返回文件路径（`read_image` 查看）。
- 扩展：MV3（`debugger/tabs/storage/alarms` 权限，无 content_scripts、无远程代码）；
  service worker 维持到 Host 的 WebSocket（Chrome 116+ 的 WebSocket keepalive）+ 1 分钟 alarm 兜底重连；
  `controller.js` 按标签页 `chrome.debugger.attach(…, "1.3")`，用 `Runtime.evaluate` 做 snapshot/refs、
  `Input.dispatchMouseEvent/insertText/dispatchKeyEvent` 做真实输入；操作时不要求标签页在前台。
- 测试：`tests/ws-bridge.test.mjs`（6）、`tests/chrome-bridge-host.test.mjs`（6）、
  `tests/chrome-extension-controller.test.mjs`（9）、`tests/chrome-extension-manifest.test.mjs`（4）；
  全套 **69 项全绿**。
- 待验证（需人工加载扩展）：`chrome://extensions` → 开发者模式 → 加载已解压扩展
  （`extensions/chrome-extension/`）→ 选项页确认端口/token → `chrome action=tabs` 应列出真实标签页，
  `attach/navigate/snapshot/click` 生效，且标签页切后台后仍可操作。

**Goal B 真机联调结果（2026-10-22，最终通过）**：

- 用户加载扩展后，`chrome` 工具 13/13 步全部一次通过（0 重试、0 超时）：
  `status → newTab(后台) → attach → snapshot → click(ref) → snapshot → navigate → snapshot →
  type(ref) → key Enter → wait → snapshot → screenshot → closeTab`。
  - 后台新建标签 `1221655429`，点击 "Learn more" **真实跳转**到 iana.org（无脚本兜底）；
  - 在 DuckDuckGo 输入 `deepseek harness` + Enter，快照 URL 带 `q=deepseek+harness`；
  - 后台标签截图成功（1662×1355 PNG，240KB），`read_image` 确认是真实搜索结果页；
  - 用户原有的视频标签与后台标签**全程未触碰**，测试标签最后已关闭。
- 心跳保活验证：同一连接 `connectedAt` 稳定超过 2.5 分钟（修复前每 45–75 秒重连一次）。
- 结论：Goal B（真实 Chrome、后台标签、截图）MVP 完成并验证。
- **标签组**（用户建议）：Agent 新建/接管的标签自动进入橙色的 “DSH Agent” 标签组
  （`chrome.tabs.group` + `chrome.tabGroups.update`，manifest 增加 `tabGroups` 权限），
  用户可一眼区分 Agent 工作标签与自己的标签，避免误关；分组失败只报告不阻塞操作。
  改动已通过单测；用户在 `chrome://extensions` 刷新扩展后实测：`newTab` 返回
  `created tab … in the background [tab group: DSH Agent]`，分组生效（空组在标签关闭后自动消失）。

## 14. 打包与分发（2026-10-22）

- **Chrome 扩展自签名 CRX3**（用户决策 B）：`npm run pack:crx`
  → 本地构建产物（不入库）：`npm run pack:crx` 生成 `dist/dsh-chrome-bridge.crx`、同名 `.zip`
  与签名私钥 `dist/*.pem`。私钥永不提交；换私钥 = 换扩展 ID。
- CRX3 格式与签名由零依赖实现（`scripts/crx.mjs`：store-method ZIP + protobuf + RSA-2048
  PKCS#1 v1.5 over `CRX3 SignedData\0 | len | signed_header_data | zip`），
  `tests/crx-pack.test.mjs` 6 项覆盖：结构、签名可验证、篡改必失败、crx_id 稳定性、真实扩展打包。
- 安装方式：
  - `chrome://extensions` → 开发者模式 → **加载已解压**（`extensions/chrome-extension/`，最稳）；
  - 或把 `.crx` 拖入扩展页（部分 Chrome 版本会拒绝非商店 CRX；被拒时用上面的解压目录方式，代码相同）。
- 本机日常使用建议：扩展保持“加载已解压”指向本仓库目录（改代码后点刷新即可），
  CRX/zip 作为备份与其它设备分发。


**Goal B 首次真机联调（2026-10-22）发现的缺陷与修复**：

- **MV3 连接抖动**：service worker 被挂起后重连，`status` 仍报“已连接”，实际命令分发失败
  （实测约 45–75 秒重连一次；WS 协议层 ping 不算 JS 活动）。修复：Host 每 15s 发**应用层
  `{type:"ping"}`**，扩展回 `pong`（JS 消息保活）；45s 无响应判定 stale 并断开；
  工具侧遇到瞬时断连先等 2.5–3s 重连再重试一次，而不是立刻返回“未连接”。
- **后台标签输入不生效**：chrome.debugger attach 后，隐藏标签没有焦点，合成鼠标事件被丢弃。
  修复：attach 时调用 `Emulation.setFocusEmulationEnabled {enabled:true}`；
  鼠标事件补 `buttons` 位掩码（按下 1 / 抬起 0）；若 700ms 内没有导航，ref 点击再走
  `element.click()` 脚本兜底（返回 `method: "input+script"`）。
- 首次联调已验证：`status`/`tabs`（列出用户真实标签）、`newTab`（后台 1221655422）、
  `attach`、`snapshot`（Example Domain）、`screenshot`（PNG 45,731 字节落盘）、`closeTab` 均可用；
  点击导航与后台输入待扩展重新加载后用新代码复验。

## 15. 本机桥安全加固（2026-10-23）

侧栏浏览器插件的 Host↔Client 桥曾使用**固定默认 token + query 参数**，且不校验
`Host`/`Origin`。对照 BrowserTools MCP 1.x 的 WS RCE 事故后按最小成本加固：

- 仍只绑定 `127.0.0.1`；新增 **Host 校验**（必须是 `127.0.0.1:<port>` / `localhost:<port>`，
  防 DNS rebinding）。
- Token 从 query 移到 **`Authorization: Bearer`**（URL 会进日志/进程列表）；
  比较改为 `timingSafeEqual`。
- **Origin 白名单**：只放行 DSH renderer 的 `dsh-app://app` 与 `null`；网页 Origin 一律 403。
  CORS 不再返回 `*`，只回显允许的 Origin，并声明 `Vary: Origin`。
- OPTIONS 预检在 Origin/Host 校验之后处理；允许 `authorization` 请求头。
- 诊断状态新增 `lastRejectedOrigin` / `lastRejectedHost`，联调时可直接看被拒来源。

测试：`tests/bridge.test.mjs` 新增 6 项（拒绝 query token、foreign Host、foreign Origin、
允许 dsh-app origin + CORS 回显、允许/拒绝预检），全套 **129 项全绿**；真机重装后
新 client（`bc-…`）正常连上，`browser status/open/snapshot/screenshot` 全通。


### chrome 桥（2026-10-23）

- 升级握手：token 从 `ws://…/ext?token=…` 移到连接后的 `hello` 消息字段；URL 不再携带密钥。
- 升级请求校验 **Host**（`127.0.0.1:<port>` / `localhost:<port>`）与 **Origin**
  （只允许 `chrome-extension://…`；网页 Origin 一律 403）；`/hello` 的 CORS 同样只回显扩展 Origin。
- token 比较改为 `timingSafeEqual`；诊断状态记录 `lastRejectedToken/Origin/Host`。
- 扩展 background 改为无 query 连接 + hello 带 token；版本 0.1.2。
- 测试：`tests/ws-bridge.test.mjs` 新增 5 项（错误 hello token、query token 无效、foreign Host/Origin、
  chrome-extension Origin 放行），`tests/chrome-bridge-host.test.mjs` 更新握手；全套 **133 项全绿**。
- 真机：Host 重装后旧扩展被正确拒绝（`lastRejectedToken`），扩展刷新后复验。

后续（未做）：随机配对 token（避免固定默认值）。
chrome 桥同样的 Origin/Host 加固与
token 移出 WS query。

## 9. 与仓库其他部分的关系

- 本仓库每个插件一个顶层目录；本插件的 Host/Client 代码放 `sidebar-browser-control/`，
  Chrome 扩展放 `extensions/chrome-bridge/`，测试放 `tests/`，设计与记录放 `docs/`。
- 通用更新复检沿用根 README 的流程：DSH 更新后跑 `scripts/verify.ps1`（后续扩展为同时检查本插件）。


## 16. 快照 v2：缩进树 + 稳定 refs（2026-10-23）

- 快照从 400 元素平铺改为**深度受限缩进树**（interactive 元素 + h1–h3/landmark），每行 `[ref] role "name" @x,y -> href`。
- ref 改为基于 tag/role/text/href/name/type 的 FNV **稳定 id**（如 `e52c4ns`），跨快照复用；缺失/过期返回明确提示（`take a new snapshot`）。
- 虚拟光标/波纹带 `data-dsh-agent-ui`，快照时排除，避免 ref 漂移或点到自身 overlay。
- 截断可操作：返回 `omitted`/`skipped`/`pagesBelow` 并提示 `action=scroll`；Host 最多输出 80 行。
- click 回执带 `hitTrusted`；目标被遮挡时输出 warning，提示改用坐标点击。
- 真机验证：example.com = 1 个 link（`e52c4ns`）；Wikipedia DeepSeek = 150 元素 / 1217 over limit / 23 页提示；refs 稳定。
- 测试：全套 **134 项全绿**（快照树、稳定 ref、overlay 排除、stale 报错、截断提示断言）。

## 17. 动作 settle 与回执、ref 点击坐标修复（2026-10-23）

- 动作后执行页面内 **settle**：MutationObserver 统计 DOM 突变，约 100ms 静默或 3s 上限；导航销毁上下文时降级为 `navigatedAway`。
- `click`/`type`/`key`/`scroll` 返回 `settle` 与 `changed`；click 还带 `hitTrusted`，无 URL/滚动/DOM 变化时提示 `no observable change`（可能被遮挡或 inert）。
- 修复 ref 点击坐标偏移：`scrollIntoView` 可能是异步/平滑滚动，旧代码立即取 rect 导致点到滚动前位置。现在等待两帧并循环确认 `scrollY` 稳定后再测 rect。
- 真机验证：Wikipedia "Liang Wenfeng" ref 点击在滚动稳定后命中并正确导航（快照 y=707 → 实际派发 y=334，导航证明 resol 正确）。
- 待复验：type 测试时 Agent Browser 面板被关闭/客户端断连（bridge 返回 no client result），需要重开面板后继续验证。
- 测试：全套 **135 项全绿**（settle 调用、回执警告、滚动稳定脚本断言）。

## 18. 输入 / 引用稳定性 / chrome settle（2026-10-23）

- **type 改用 `webContents.insertText`**（走真实编辑管线，React/Vue 受控输入能收到）；无 insertText 时回退逐字符 char 事件。真机 Bing：输入后 `focused value` 与下一次快照 `= "deepseek harness"` 均确认落地。
- 快照元素新增 `value`（input/textarea/select）与 `checked`（checkbox/radio），Host 输出 `= "…"` / `[checked]`，便于验证输入结果。
- **control ref 稳定**：stableId 对 input/textarea/select 排除其当前 value 派生的可访问名，输入前后 ref 不变（真机 evjx1pi 保持）。
- key Enter 增加 char keypress 事件（隐式提交所需）；真机测试中 Enter 触发后 Agent Browser 面板被关闭（两次复现），提交结果未确认，面板需重开。疑似导航/面板 teardown 关联，待改用 form.requestSubmit 或显式提交控件再验证。
- chrome 侧同步加入同样的 settle（MutationObserver 100ms/3s）、click `changed` 警告与回执；扩展需刷新后真机验证。
- 测试：全套 **135 项全绿**。

## 19. chrome Host 侧 refs、console/network 回执（2026-10-23）

- `snapshot` 优先调用 `Accessibility.getFullAXTree`；refs 为 `n<backendDOMNodeId>`（如 `n123`），只保存在扩展 Host 侧，页面 JS 无法伪造/覆盖，节点重现时可复用；旧页面 JS 快照保留为 fallback。
- `click` 通过 `DOM.pushNodesByBackendIdsToFrontend` → `scrollIntoViewIfNeeded` → `getBoxModel` 实时取坐标，并用 `DOM.getNodeForLocation` 给出 `hitTrusted`；`type` 用 `DOM.resolveNode` + `Runtime.callFunctionOn` 聚焦后 `Input.insertText`。
- 快照输出与侧栏一致：缩进树、`[n123] role "name"`、value/checked、omitted/truncated 提示。
- 新增 `logs {tabId,limit?}`：收集 `Runtime.consoleAPICalled`、`Log.entryAdded`、`Network.loadingFailed`、HTTP>=400 响应，每 tab 120 条环形缓冲。
- key Enter 在未导航时回退 `form.requestSubmit()`（与侧栏相同策略）。
- 扩展升到 0.1.5；测试 138 项全绿。真机验证需刷新扩展（AX refs/logs 生效）。

## 20. chrome AX refs 真机修复（2026-10-23）

- 真机发现 `click` 报 `Document needs to be requested first`：AX ref 解析前必须先 `DOM.enable` + `DOM.getDocument`（已加）。
- `Accessibility.getFullAXTree` 会混入浏览器 UI（翻译气泡/右键菜单等）；快照现在批量 `DOM.pushNodesByBackendIdsToFrontend`，只保留能解析到本页 document 的节点，同时提前校验 ref。
- `type` 在不可编辑页面会假成功（把 body 文本当 focused value）；现在要求 activeElement 是 input/textarea/select/contenteditable，否则明确报错。
- 版本 0.1.6；测试 139 绿；待扩展刷新后复验 click/type/过滤效果。

## 21. chrome upload 与侧栏输入校验（2026-10-23）

- chrome 新增 `upload {tabId, ref, paths[]}`：对快照中的 file input（AX ref）调用 `DOM.setFileInputFiles`，返回 settle/回执。
- 侧栏 `type` 与 chrome 一致：要求 activeElement 是 input/textarea/select/contenteditable，否则明确报错（避免把 body 文本当输入成功）。
- 扩展/宿主升到 0.1.7；测试 **141 项全绿**；需刷新扩展与重开侧栏面板复验。

## 22. chrome execute 分派修复、evaluate、帧过滤（2026-10-23）

- 修复 `logs`/`upload` 在 Host schema 中存在但扩展 `execute` 未分派的问题（真机曾报 `unknown action`）。
- 新增 `evaluate {tabId, expression}`：Runtime.evaluate（returnByValue + awaitPromise），用于调试/读取页面状态。
- AX 快照增加帧过滤：`Page.getFrameTree` 取主 frameId，`DOM.describeNode` 校验节点 frameId，剔除浏览器 UI（翻译气泡/右键菜单等）节点。
- 版本 0.1.8；测试 **142 项全绿**；需刷新扩展后复验 logs/upload/快照过滤。

## 23. chrome AX 浏览器 UI 过滤与 Host 分派修复（2026-10-23）

- 真机发现 `logs/upload/evaluate` 在 Host schema 中存在但 `toCommand` 无分支 → Host 直接报 unknown action；已补 `toCommand` + `formatResult`，并加 host dispatch 单测（143 绿）。
- AX 树混入的浏览器 UI 节点（图片翻译/语音翻译/添加到收藏夹/快捷设置）不在页面 DOM（`document.querySelectorAll` 与 textContent 扫描为空），帧过滤无效；现对每个候选 `DOM.resolveNode` + `Runtime.callFunctionOn` 校验 `getRootNode() === document`，不属于页面文档的节点全部剔除。
- 版本 0.1.9；需刷新扩展后复验：快照只含页面节点、`logs`/`evaluate`/`upload` 可调用。

## 24. 侧栏浮动兜底面板、Enter 提交与 chrome wait（2026-10-23）

- 多次插件重载后 DSH 右侧栏会保留陈旧 tab 且不再挂载 body（UIA/OCR 确认右侧空白）；新增**浮动 Agent Browser 兜底面板**（fixed 右侧、可关闭），侧栏 `waitReady` 2.5s 失败后自动创建并挂载 webview，工具恢复可用。
- tab type 改为每次模块加载唯一 id/kind（旧 tab 不再复用），并记录 mount-start/acquired/ready/failed 诊断。
- 真机验证：浮动面板下 `open/snapshot/screenshot` 通过；Bing 输入 + Enter 后**成功跳转搜索结果**（title `deepseek harness - 搜索`，URL `/search?q=...`），Enter `requestSubmit` 兜底生效。
- chrome 新增 `wait {tabId, selector|text|ms}`（轮询文档选择器/文本）；顺带修复 Host `toCommand` 未分派 `wait` 的问题。版本 0.1.12，测试 **145 项全绿**。

## 25. iframe 支持（2026-10-23）

- `buildFrameOffsets`：`Page.getFrameTree` 递归 + `DOM.getFrameOwner` + `DOM.getBoxModel` 计算每个子 frame 相对主 frame 视口的偏移表（嵌套累加）。
- AX 快照保留解析得到的子 frame 节点（`element.frame = frameId`，Host 输出附加 `(iframe)`）；主 frame 继续做浏览器 UI 过滤。
- `click` 对子 frame ref 使用 `getBoxModel` 本 frame 坐标 + frame 偏移换算成主视口坐标后 `Input.dispatchMouseEvent`；子 frame 不做主 frame 命中判断（`hitTrusted` 留空）。
- 限制：跨进程 OOPIF 若 `DOM.pushNodesByBackendIdsToFrontend` 失败会被丢弃（占位不可见），当前优先同进程 iframe；`type` 在子 frame 内暂不保证聚焦。
- 测试：controller 的 frame tree/frame owner/box model mock 回归（子 frame 元素保留、点击坐标 120,230 正确）；版本 0.1.14。

## 26. iframe 真机迭代（2026-10-23）

- 真机发现主 AX 树为空：新 `axSnapshot` 漏了 `Accessibility.enable`，导致只剩子 frame 结果（所有元素被标 `(iframe)`）。已补 enable。
- iframe 内容预留配额：主 frame 最多 120 个元素，子 frame 最多 30 个（无子 frame 时主 frame 仍可用满 150）。
- 子 frame 点击：优先 `DOM.resolveNode({backendNodeId})` + `Runtime.callFunctionOn(this.click())`；失败再回退 frame 偏移坐标点击，并标注方法。
- 真机验证被并发桌面占用打断（另一个对话使用 computer-use/chrome、COMPUTER_USE_BUSY、用户 Esc）；0.1.18 扩展尚未刷新，iframe 标记/点击需下一轮安静环境复验。
- 测试 **149 项全绿**。

## 27. iframe 状态收口（2026-10-23）

- 0.1.19 真机（纯 chrome）：`snapshot` 恢复主 frame 内容，并打印全部 150 行；其中 **30 行带 `(iframe)` 标记**（主 frame 120 + 子 frame 30 配额）。
- 仍存在限制：子 frame 内元素点击尝试 script-click/坐标回退，W3Schools 页面点击后无可观察变化（未触发 `iframe element click` 路径）；iframe 内容目前**可读、可定位，但点击可靠性未验证**。
- 结论：iframe 观测支持已交付；点击支持标记为实验性，后续可选通过逐 frame target session（Target.attachToTarget）实现，列入 backlog。
- Host 打印上限从 80 提到 150，避免预留的 iframe 行被截断（commit `66f20b7`）。

## 28. tab group ACL（2026-10-23）

- 一旦存在 “DSH Agent” 组，`snapshot/click/type/key/scroll/logs/upload/evaluate/wait/navigate/screenshot` 只允许组内 tab；`tabs.get(tabId).groupId` 不匹配时返回 `tab N is not in the DSH Agent group; call attach first to opt it in`。
- `newTab` 自动入组；`attach` 是显式 opt-in（把用户 tab 移入 DSH Agent 组，用户拖出组即撤销）。尚无组时不拦截。
- 测试：mock `tabs.get`/`tabGroups.query`，拒绝组外 tab、attach 后放行；全套 **150 项全绿**。
- 真机验证待扩展刷新到 0.1.20（用户手动刷新，未使用 desktop 自动化）。

## 29. tab group ACL 真机部分验证（2026-10-23）

- 0.1.20 真机：`newTab` 自动入组、`attach` 后 snapshot 正常；组外 `chrome://extensions` tab 被**更早的 scheme 守卫**拒绝（`Cannot access a chrome:// URL`），未走到 ACL 分支。
- 待验证：普通 http(s) 且不在 DSH Agent 组的 tab → snapshot 应返回 `not in the DSH Agent group; call attach first`。需要用户手动开一个普通标签页（不要 attach）。
- 单元测试已覆盖 ACL 拒绝与 attach 放行；全套 150 项全绿。

## 30. tab group ACL 入组修复（2026-10-23）

- 真机 ACL 拒绝路径通过：普通 example.com tab（非组内）snapshot 返回 `tab N is not in the DSH Agent group; call attach first to opt it in`。
- 但暴露入组 bug：扩展缓存了已不存在的 DSH Agent group id（991255573），`tabs.group` 报 `No group with id`，attach 仍显示 attached、newTab 无组后缀。
- 修复（0.1.21）：`ensureAgentGroup` 捕获失效 group id 后清空缓存并用无 groupId 重新建组；入组后用 `tabs.get` 轮询确认 membership（最长 600ms）；attach/newTab 暴露 `grouping failed: ...`。`assertAgentTab` 同样短轮询后再拒绝。
- 测试 150 全绿；待用户刷新 0.1.21 后复验 newTab/attach/snapshot 与 ACL 拒绝。

## 31. logs 过滤/清空（2026-10-23）

- `logs {tabId, limit?, filter?, clear?}`：`filter` 对条目 JSON 做大小写不敏感匹配；`clear:true` 清空该 tab 的环形缓冲并返回 clearedCount。
- Host 输出：清空提示、空结果带 filter 提示；schema 增加 `filter`/`clear`。
- 测试 **151 项全绿**；版本 0.1.22，等扩展刷新后真机验证。

## 32. logs 真机验证通过（2026-10-24）

- 0.1.22 真机（纯 chrome）：`newTab` 入组、`attach` 入组、`evaluate` 注入 console error/info、`logs filter=boom` 只返回 boom 条目、`logs clear` 返回 clearedCount=2、之后 `logs` 为 0 条。
- 当前 chrome 侧交付：Host 侧 backendNodeId refs、settle/动作回执、logs（console/network + filter/clear）、upload、evaluate、wait、tab group ACL、iframe 观测（标记 + 内容）；iframe 内点击为实验性（坐标回退）。
- 全套测试 **151 项全绿**；扩展/Host 版本 0.1.22。

## 33. iframe 内点击：frame 隔离世界脚本点击（2026-10-24）

- 参考实现确实解决了 iframe 点击：Playwright MCP 用 frame 前缀 refs（`f1e5`）+ frame 内 locator；chrome-devtools-mcp / browser-use 也通过 Puppeteer/CDP 的 frame 上下文操作。
- 本插件实现：快照时记录子 frame 的 `frameId` 与可访问名；点击子 frame ref 时 `Page.createIsolatedWorld({frameId})` 取得 executionContextId，再 `Runtime.evaluate({contextId})` 在 frame 内按文本定位元素并 `.click()`，返回 `method: iframe-script`；失败再依次回退 `ax-script`、frame 偏移坐标点击。
- 不需要新增扩展权限；Host 对 `iframe-script` 输出 `(iframe script click)`。
- 测试：mock `Page.createIsolatedWorld`/`Runtime.evaluate(contextId)`，断言点击在 frame 上下文执行且无坐标派发；全套 **151 项全绿**。
- 版本 0.1.23；待用户刷新扩展后真机验证 W3Schools iframe 内链接点击。

### iframe 点击受控验证（2026-10-24）

- 本地受控页面（outer + iframe inner.html）验证通过：点击 iframe 内 `GO TO INNER TWO` 后，`contentDocument.location.href` = `http://127.0.0.1:47999/inner2.html`，title/h1 = `Inner Two`；证明点击在 frame 上下文真实执行并触发 within-frame 导航。
- 注意：`iframe.src` 属性不会随内部导航更新，验证应读 `contentDocument.location`。
- W3Schools 的 "CSS" iframe ref 实际是 `target=_blank` 推广卡（campus.w3schools.com），所以此前测试无可观察变化——不是工具失效。
- 0.1.24：iframe 点击成功后 `changed` 记为 true，不再输出误导性的 "no observable change inside the frame"。

0.1.24 受控复验（2026-10-24）：点击 iframe 内 `GO TO INNER TWO` 输出 `(iframe script click)` 且无 no-observable-change 提示；`contentDocument.location.href` = `/inner2.html`，title/h1 = `Inner Two`。

## 34. QA 能力（2026-10-26，0.1.0 → 0.2.3）

背景见 `dsh-plugins/research/feedback-triage-2026-10-26.md` §1/§3/§5：真实工程验收（改 GitHub 主页后
明/暗 × 桌面/手机 4 组验收）暴露了侧栏浏览器缺 viewport / evaluate / 资源等待 / 证据截图 / 批量回归，
这些可以在「页面 JS + webview DOM API」内完成；DPR、媒体仿真、网络状态码与离屏/CI 需要 CDP 或
Electron 主进程，**不在插件能力内，不做伪造**。0.2.1 / 0.2.2 / 0.2.3 是 0.2.0 真机首验后的修补（见 34.5–34.7）。

### 34.1 新增工具面

| action | 实现位置 | 关键事实 |
|---|---|---|
| `viewport {width,height=800,reset}` | Client 设 webview 元素 CSS 尺寸 + 面板内 `transform: scale()` | guest 视口 = 元素尺寸（真实布局）；面板缩放不改变 guest 布局；**轮询等待 guest 报告目标尺寸**（真实 Electron 会滞后一帧以上），回执真实 `innerWidth/innerHeight/devicePixelRatio` + `matched/settledMs`；未收敛时回执 warning 而不是假成功 |
| `evaluate {expression}` | `executeJavaScript` 包装 | 返回 JSON；Client 侧 200KB 保护桥 1MB body 上限，Host 回执再按 16KB 截断并标注 |
| `metrics {selectors?,includeOverflow?}` | 页面脚本 `__dshAgentMetrics` + console 计数合并 | viewport/document/内容宽/横向溢出 top20/图片/`document.fonts`/console 错误警告/选择器 rect |
| `wait` 扩展 | 页面脚本 `__dshAgentWait` 内轮询 | selector/text/networkIdle(idleMs)/images/fonts；`ms` 既是超时也是纯等待；networkIdle 是「资源计数 + DOM 突变静默」近似 |
| `scroll` 扩展 + `scrollIntoView` | Client 轮询滚动状态 + 页面脚本 | 回执 requested/actualDelta/scrollY/scrollHeight/innerHeight/clamped/method（wheel 失效时脚本兜底）；**sendInputEvent 的 wheel deltaY 符号与 DOM 相反，内部取负**；scrollIntoView 支持 ref/selector + block |
| `logs {clear,filter,limit}` | mount 时监听 webview `console-message` 环形缓冲（≤200） + 页面脚本 `__dshAgentLogsProbe` | 附带失败图片/可疑资源条目；**HTTP 状态码不可见**（见 34.4） |
| `screenshot` 扩展 | Client 逐屏 capturePage + canvas 拼接（fullPage）/ `capturePage(rect)`（元素、clip）+ Host 落盘 | fullPage **不再拉高 webview**（真机会卡死 capturePage），改为滚动逐屏截图后 canvas 拼接（≤12000 CSS px，capped；fixed/sticky 可能重复）；每次 capturePage 都有超时上限，挂起不会锁死命令循环；hideCursor 默认隐藏虚拟光标；Host 解析 PNG/JPEG 头得到实际像素尺寸；不伪造 2x |
| `emulate {colorScheme}` | 页面脚本 `__dshAgentEmulate` | matchMedia 覆盖（`prefers-color-scheme` 条件替换为 width 条件求值，支持组合/not）+ 同源 @media 规则归一化 all/not all（可恢复、递归 group rule、MutationObserver/短轮询补扫）；跨域样式表不可读；导航后自动重放（open/navigate，以及会替换文档的 click/key） |
| `setContent {html,baseUrl}` | 页面脚本 `__dshAgentSetContent` | `document.open/write/close` 渲染自包含 HTML；baseUrl 只收 http(s) 并注入 `<base>`；≤2MB；优先 about:blank（若壳/会话拒绝则如实报 in-place） |
| `preview {dir,file?,port?}` | Host 新文件 `lib/preview.js` | `dir` 必须是绝对路径（Host 相对路径会解析到 DSH 安装目录）；127.0.0.1 + 随机 token 路径前缀、GET/HEAD、realpath 防穿越、MIME 表、无目录列表、单文件 >64MiB 拒绝(413)、dispose 关闭；action 起/复用服务后让 client `open` 该 URL |
| `qa {...}` | Host 编排多条 client 命令 | width×theme 矩阵一次跑完（≤6 variants）；每 width 导航一次（`navigate` 会在面板未开时先打开它）、每 theme 应用 emulate→短等待→metrics→screenshot；Host 保存 `qa-<width>x<height>-<theme>.png`；结束恢复 viewport/theme 为 auto |
| `close` | Client `unmount()` | 释放 webview/lease；`open` 用保留的 panel 容器重新 mount 新的 leased webview |
| `status` 扩展 | Client status + Host 合并 | 保留 bridge 字段，新增 viewport/theme/console 计数/last url/title |

桥的改动：`pushCommand(cmd, timeoutMs?)` 支持**单命令超时覆盖**（qa 的 navigate/screenshot 用
`DSH_BROWSER_CONTROL_QA_TIMEOUT_MS`，默认 120s），队列过期过滤也用命令自己的超时，避免长命令被
全局 25s 误丢。

### 34.2 设计取舍

- **qa 在 Host 编排而不是塞进一个 client 命令**：每条子命令都有独立超时/错误定位，截图 data URL
  逐张落盘，不把多张 base64 塞进一个 HTTP 响应；配合单命令超时覆盖既简单又可单测。
- **viewport 用「元素尺寸 + 面板缩放」**：Electron `<webview>` 的 guest 视口跟随元素 CSS 尺寸，
  这是真实布局；面板用 `transform: scale` 只影响显示，所以 `sendInputEvent` 的 guest 坐标不受影响。
- **主题用 width 条件替换**：`(prefers-color-scheme: dark)` → `(min-width: 0px)`（真）、
  `(min-width: 100000px)`（假），其它条件（and/not/媒体类型）原样保留后交给真实 matchMedia 求值；
  再用同样的重写结果决定同源 `@media` 规则置 `all`/`not all`，全部可恢复。
- **页面脚本集中生成**：`__dshAgent*` 标记注释 + `__test` 暴露纯函数/脚本生成器
  （`rewriteColorSchemeQuery`、`emulateJs`、`metricsJs`、`waitConditionsJs`、`setContentJs`、
  `injectBaseHref`、`clampRect`、`bytesToBase64`），在 Node VM 里用假页面对象做行为单测。
- **navigate 也会开面板**：与 `open` 共用同一段「确保客户端/面板/lease 就绪」逻辑，这样 `qa`、
  agent 的直连路径不必先显式 `open`；`close` 后仍保留 React body 容器，下一次 open/navigate 重挂新 lease。
- **主题重放覆盖所有会换文档的动作**：open/navigate 之后、以及 click/key 产生导航时重放 emulate，
  否则新 document 上的 `window.matchMedia` 覆盖会消失（反馈里最容易漏的一条）。
- **preview 的安全边界**：`dir` 必须是绝对路径，单文件 >64 MiB 直接 413（避免 Host 把大文件整个读进内存）；
  这些是「请求来自无人值守的 agent」时的硬约束，不是可调参数。
- **fullPage 改为滚动拼接（0.2.1）**：0.2.0 用「把 webview 元素拉高到 scrollHeight 再 capturePage」，
  真机上 capturePage 永不 resolve、client 命令循环被锁死（只能重启恢复）。0.2.1 改为正常视口尺寸下
  逐屏滚动截图、在 renderer canvas 拼接；不再有 vh 重排，代价是 `position:fixed/sticky` 可能在拼接图里重复。
  每次 `capturePage()` 另加超时 race，挂起时返回错误而不是卡死面板。
- **viewport 回执要等 guest 收敛（0.2.1）**：真机首验发现元素 resize 传到 guest `innerWidth/innerHeight`
  比一个命令周期更慢，立刻读会拿到**上一个**尺寸。改为 50ms 轮询直到匹配（约 2s 上限），
  未收敛时回执带 warning 与真实值，不把旧尺寸当成功。
- **wheel 符号（0.2.1）**：Electron `sendInputEvent` 的 `mouseWheel.deltaY` 用 Chromium 约定
  （正值向上），与 DOM 相反；真机首验 `/` 位置大 deltaY 会跳到页顶。内部取负后 `action=scroll`
  的 `deltaY>0` 才是向下。

### 34.3 验证（单测层面）

- `tests/browser-control-scripts.test.mjs`：emulate shim 在假 document 上真实改写/恢复媒体规则、
  matchMedia 覆盖与 auto 还原；metrics/wait/setContent 用假页面对象断言输出结构；纯函数行为断言。
- `tests/browser-control-client.test.mjs`：新增命令的 controller 分派、回执、状态串联
  （viewport 尺寸/缩放/settle 与未收敛 warning、console 计数、fullPage 逐屏拼接/恢复滚动、
  capturePage 超时后仍能继续服务、close 后 open 重挂载、navigate 自动开面板、click 导航重放主题等）。
- `tests/browser-control-host.test.mjs`：新 action 的 JSON Schema/参数校验/回执文本/fake client
  往返、qa 矩阵与文件落盘、preview 服务启动/复用、status 合并、PNG/JPEG 尺寸解析与 16KB 截断。
- `tests/preview.test.mjs`：token、穿越（含编码/反斜杠）、MIME、HEAD/405、无目录列表、file 选项、
  超大文件 413、dispose 关闭。
- 全套 **101 项全绿**（基线 44 + 新增 57）。

### 34.4 边界（如实记录，不做假能力）

- **真 DPR / deviceScaleFactor**：renderer `<webview>` 无 `webContents.debugger`，打包版还关闭 devTools，
  `Emulation.setDeviceMetricsOverride` 调不到；截图的物理分辨率由宿主显示器缩放决定。回执只报真实
  `devicePixelRatio` 与真实像素尺寸；需要真 DPR 的验收走 chrome-bridge（真 CDP）。
- **file://**：桌面壳 `will-frame-navigate` 只放行 http(s)，session `webRequest` 取消 `file:`；
  插件不做绕过。用 `setContent`（自包含 HTML）或 `preview`（本地静态预览）替代。
- **离屏 / CI**：插件架构是「侧栏里用户能看的 webview + Host 子进程」，没有 Electron 主进程权限；
  `qa`+`close` 覆盖批量回归的常用需求，不承诺 CI/无头。远端子 agent 操作时 sidebar 面板必须处于
  打开状态（本插件不是独立浏览器进程）。
- **HTTP 状态码**：renderer 侧不可观测（无 network 事件）；`logs` 只能给 console、失败图片、
  零 transfer 资源条目，文档不写「network status」。
- **fullPage 的拼接 caveat**：逐屏拼接不再有 vh 重排，但 `position:fixed/sticky` 元素可能在每屏重复出现；
  需要精确证据时用 viewport+scroll+clip 逐段截图。超大页面 cap 在 12000 CSS px。
- **主题 best-effort**：跨域样式表不可读；与其他条件组合的媒体规则在应用时点求值（之后 resize
  不会重算）；页面内联脚本用 `matchMedia` 能拿到模拟值，但 `forced-colors`/系统级主题不受影响。
- **真机验证依赖重启**：client bundle 只在页面启动时从 boot graph 加载，上述 QA 能力需重启 DSH
  Desktop 后才能在侧栏真实 webview 里复验（Host 半可单独卸载/安装）。单测不覆盖真实 Electron
  `<webview>` 的 capturePage/缩放行为，留给重启后的人工/agent 复验。

### 34.5 真机首验记录（2026-10-26，0.2.0 → 0.2.1）

profile 重装 + 重启 DSH 后，用真实侧栏 webview 跑首轮冒烟（example.com + setContent 主题样例），
发现并修复三个只有真机才暴露的问题：

1. **viewport 回执滞后**：`viewport {width:390,height:844}` 首次回执仍报 575x742（面板原尺寸），
   下一次命令才看到 390x844 —— 元素 resize 传播到 guest 比一个命令周期慢。改为轮询 settle + warning。
2. **fullPage 卡死**：0.2.0 的「拉高 webview 再 capturePage」让 capturePage 永不 resolve，bridge
   25s 超时后 client 命令循环仍卡在 await，后续命令全部超时。0.2.1 改为逐屏拼接 + capturePage 超时。
3. **wheel 方向反了**：`action=scroll deltaY:1000` 从 scrollY 200 直接跳到 0；Electron wheel 的
   deltaY 正值向上，与 DOM 相反。内部取负修复。

同轮已真机确认正常的能力：`open`/`navigate`、`setContent`（about:blank 上下文 + 主题重放）、
`emulate`（computed style 与 matchMedia 都翻转，样式表 media rule 被改写/恢复）、`evaluate`、
`metrics`、`logs`（console error 被缓冲读出）、`scroll` 脚本兜底、`scrollIntoView`、
`viewport` 的真实布局（metrics 显示 300x600、body 宽 285 = 滚动条扣除）、`close`。
仍待下一轮重启后复验：fullPage 拼接截图、元素/clip 截图、`qa` 矩阵、`preview` 本地目录、
以及 client 循环在 capturePage 超时后继续服务的真机行为。

### 34.6 第二轮真机（2026-10-26，0.2.1 → 0.2.2）

0.2.1 重启后，`viewport` 首次回执即 390x844（`settled 87ms`），确认 34.5 #1 的修复有效。
`metrics`（375x962，滚动条已扣除）、`emulate`/`setContent`/`evaluate`/`logs` 继续通过。
**截图仍然失败**，报错来自 renderer：

```
browser screenshot failed: Buffer is not available for the current Context
```

根因：DSH renderer 是 sandbox（无 Node integration），`nativeImage.toPNG()/toJPEG()` 在页面世界
无法分配 Node Buffer，Electron 抛上述错误；0.1.0 的旧实现直接用 `toDataURL()` 所以能截。0.2.2 把
`toDataURL()` 设为首选路径，`toPNG` 只在 try/catch 里做兼容；JPEG 若 `toJPEG()` 失败则用 canvas
把 PNG 转 JPEG（质量参数保留）。回归测试覆盖「toPNG/toJPEG 抛 Buffer 错误但 toDataURL 正常」的
sandbox 场景。截图相关的 fullPage/元素/clip/qa 待 0.2.2 重启后再验。

### 34.7 第三轮真机（2026-10-27，0.2.2 → 0.2.3）

0.2.2 重启后截图链路全部通过（真机 + 读图确认）：

- `screenshot` viewport：390x844 PNG；
- 元素截图（`#sec2 .badge`）：163x78 PNG；
- clip 截图：300x300 PNG；
- **fullPage：390x3500 PNG，逐屏拼接 5 段**，5 个 section/颜色/badge 全部对齐无接缝；
- **`qa` 4 组矩阵全部成功**：375/1280 × light/dark，viewport 与 doc 宽度正确（360/1265 = 扣滚动条），
  截图 375x3500 / 1280x3500，light/dark 配色正确，console/图片/字体指标齐全；
- `preview` 本地目录 + token URL + 404 安全边界（上轮已验）。

0.2.3 只做一个小改进：fullPage 拼接前**隐藏页面滚动条**（注入 `scrollbar-width:none` /
`::-webkit-scrollbar{display:none}`，截完移除），这样每段不再带滚动条残影，内容宽度也不再有 15px
偏差；回执 `fullPage.scrollbarsHidden` 如实标注。已知边界仍是 `position:fixed/sticky` 会重复。
真机复验需再重启一次。

### 34.8 第二轮迭代（2026-10-27，0.2.3 → 0.2.4）

数据来源：`dsh-plugins/research/feedback-round2-2026-10-27.md`（Lead 真机复现与诊断）。
本轮五项交付 A–E，全部只动本仓库（Host/Client/测试/文档），无新依赖；改动**未重启复验**，
需下一轮重启后按下面的真机清单逐项验证。

#### A. 重启后首次 open 超时自动恢复（0.2.4）

- 现象：DSH 重启后第一次 `browser open` 报 `panel did not become ready in time`，
  status `hasWebview:true` 但 `client.ready:false`——webview 存在但 `dom-ready` 永不到来；
  手动 close→open 恢复。
- 实现：`ensurePanelReady()`（open/navigate 共用）在首次 `waitReady(2.5s)` 失败后判定 stale：
  `unmount()`（释放 lease，但保留 `lastMountContainer`）→ 重挂一次 → 再 `waitReady(2.5s)`；
  仍失败则回退浮动面板（§24 的既有路径），最终失败抛出的错误**包含 close/open 恢复指引**。
  全程 postDiag（`ready-stale` / `stale-remount-failed` / `stale-remounted`）。
- 测试：首次 mount 永不 dom-ready → 只重挂一次（两次 acquire、释放旧 lease）→ open 成功；
  重挂 + 浮动面板都失败时错误信息含 `close the Agent Browser tab and call action=open`。

#### B. fullPage 外网页面超时（0.2.4，最高优先）

- Lead 复现事实：本地 127.0.0.1 页（1280×900、3500px、4 段）**秒级成功**；
  `github.com/Dax233`（3484px）与 `en.wikipedia.org/wiki/GitHub`（21879px，cap 12000）
  稳定 **25s 超时**（Host 默认命令超时）。同页普通截图 0.53s，手动 hide+scroll+capture 正常
  → 挂点不在 capturePage 本身，在拼接/恢复路径。
- **根因结论：未最终确定（真机诊断待证）**，但静态审计找到一类与症状完全吻合的挂点：
  0.2.3 拼接路径里存在多处**无超时 await**——段 `Image.decode()`（stitch 内）、
  hide/滚动/量测/恢复的 `executeJavaScript`（恢复步骤在 finally 里，若页面被卡住会让错误路径也挂死）
  ——任何一个在某些页面永不 resolve，都会精确复现「到 Host 25s 超时」的症状。
  代码里没有能区分是哪一步的证据能力（这正是 25s 只见超时不见错误的原因）。
- 0.2.4 的处理（双保险）：
  1. **所有 await 全部加超时**：capturePage 降到 8s（可配置 `captureTimeoutMs`）、段图
     `Image.decode()` race 1.5s（decode + onload/onerror 双兜底 + 超时抛带 phase 的错误）、
     hide/scrollTo/scrollState/恢复步骤全部限 8s / 恢复 2.5s；
  2. **总预算**：整个 fullPage 默认 60s（可配置），超时抛错并带段数/已用时间，绝不无限挂；
  3. **阶段诊断**：每步 `void postDiag("fullpage", {phase, ms, index})`
     （begin/hideScrollbars/segment-start/segment-capture/segment-encode/stitch/restore/error），
     写进 bridge diags 环形缓冲（无需面板即可在 `%TEMP%\dsh-browser-control-state.json` 查看）；
     成功回执带 `fullPage.timings`（totalMs + 每段 capture/encode 耗时 + 段数）；
  4. **Host 侧长超时**：`screenshot fullPage:true` 用 120s 单命令超时
     （`DSH_BROWSER_CONTROL_FULLPAGE_TIMEOUT_MS` 可配），普通截图保持默认；qa 全身已用 120s。
     行为级测试：fake client 3s 后才应答（超过 2s 默认超时），fullPage 成功返回
     → 证明长超时生效；非 fullPage 不受影响。
- 下一轮真机按 postDiag 阶段数据定位最终根因（哪个 phase 在外网页面不 resolve）。
  **→ 已在 2026-10-27 真机定位并修复，见 §34.9：根因不在这些 await，而在 bridge 的
  `/result` 请求体 1MB 上限。**

#### C. emulate 的原生 `<picture>`/`<link media>` DOM 兜底（0.2.4）

- 原理：资源选择不受 matchMedia shim/CSSOM 影响；GitHub themed-picture 在 open shadow DOM 内。
  `emulateJs` 扩展为：restore → 深度遍历 `document` + 所有 open `shadowRoot`
  （`element.shadowRoot` 递归，**节点预算 6000**，超限 `limitReached` 如实报告）→
  对每个 `<picture>` 按模拟 scheme 选第一个「无 media 或 media 匹配」的 source
  （用 `rewriteColorSchemeQuery` + 原生 matchMedia 求值；无匹配不动，保留浏览器自己的回退），
  把 `img.srcset`（或 `src`）设为该 source；每个 patch 保存原始值；`<link rel=stylesheet media>`
  含 prefers-color-scheme 的置 `all` / `not all`，保存原值。
- `auto` 完整恢复（picture 的 src/srcset、link 的 media）；重放/定时重扫也会先 restore 再 patch。
- 回执新增 `dom: { picturesPatched, linkMediaPatched, restored, visited, limitReached }`，
  Host 文本如实转述。
- 边界（README 同步）：JS 运行时驱动选图的页面、closed shadow DOM、CSS image-set 不覆盖。
- 测试：dark/light 选择、light 下无匹配 source 不动、shadowRoot 内 picture、link media 归一化与 auto 还原。

#### D. viewport 滚动条与 contentWidth（0.2.4）

- `viewport {scrollbars:"auto"|"hidden"}`（默认 auto）：hidden 注入与 fullPage 相同的隐藏
  滚动条 CSS 并**持久**（导航后重放，`viewport reset` / `close` 移除并回到 auto）。
- 回执与 `actual` 增加 `contentWidth`（`documentElement.clientWidth`）；Host 文本在
  innerWidth > contentWidth 时说明「经典滚动条差 N px」，hidden 时说明
  「content width == 视口宽 + 由 reset/close 恢复」。
- `qa {scrollbars:"auto"|"hidden"}` 透传到每个 variant 的 viewport 命令；
  QA 结果表新增 content 列。
- 测试：hidden 后 contentWidth == width、切回 auto 移除样式并按 mock 报
  （innerWidth−15）、导航重放、reset 移除；Host：viewport/qa 校验与透传、回执文本。

#### E. 超长元素截图逐屏拼接（0.2.4）

- 元素截图（ref/selector）先由 `__dshAgentScreenshotTarget` 量出元素**页面坐标** full rect
  （新增 `full`/`scrollX`/`scrollY`；兼容字段保持不变）。
- 当元素高于视口或部分在视口外时，不再裁到第一屏：`captureTallElement` 逐屏
  （hide scrollbar → scrollTo(behavior instant) → `capturePage(rect)` 截元素可见带 →
  canvas 拼接），与 fullPage **共享拼接基建**（同一个 `stitchSegments`：canvas/decode 超时/
  encode/回执），但回执字段独立：
  `element: { stitched, segments, fullRect, fullHeight, fullWidth, capturedHeight, capped, croppedWidth, scrollbarsHidden, timings }`；
  mode 保持 `element`；总高 cap 12000（capped 标注）；宽超视口部分裁剪并报 `croppedWidth`，
  不伪造；截完恢复滚动位置与滚动条。
- 测试：三段拼接逐段 rect/画布 y 对齐 + 恢复滚动/滚动条、cap 与 capped、超宽裁剪。

#### 单测与状态

- 0.2.4 完成时：**117 项全绿**（基线 101 + 新增 16：client +8、scripts +4、host +4）。
  `npm test` 全绿；BOOT CONTRACT 保持（apply 同步返回 undefined）。
- 未做（如实）：DPR/file:// 依旧不做（平台事实）；不重启 DSH 无法真机复验。

#### 真机待验清单（重启 DSH 后）

1. 重启后第一次 `browser open` 直接成功（stale 恢复：或自动重挂成功，或报错带 close/open 指引）。
2. `github.com/Dax233` / Wikipedia 长页 `screenshot {fullPage:true}`：
   看 `%TEMP%\dsh-browser-control-state.json` 的 `diags` 里 fullpage 各 phase 的 ms，
   确定卡点 phase；若 60s 预算内完成则看回执 timings（总耗时、每段 capture/encode）。
3. GitHub profile 页 `emulate {colorScheme:"dark"}`：themed-picture（shadow DOM）切图正确，
   回执 `dom.picturesPatched > 0`；`auto` 完全还原。
4. `viewport {width:1280, scrollbars:"hidden"}` → metrics 的 doc 宽 == 视口宽（1265→1280），
   回执 contentWidth；导航（open/navigate）后仍隐藏；reset 后恢复。
5. `.markdown-body`（1833px 高）`screenshot {selector:"css-0"}`：完整高度拼接图
   （mode=element + stitched/segments=3），fixed/sticky 重复为已知外观边界。
6. `qa {scrollbars:"hidden"}`：表 content 列全等于视口宽。

#### 风险

- capturePage/decode 超时若在外网页面普遍触发（而非停在单点），会把「25s 超时」变成
  「阶段错误」——结论相同但路径不同，预算与段数信息会帮助定位。
- picture DOM 兜底对 JS 框架强管理的 img（React 重置 src）只保证 apply 时点正确；
  框架后续渲染由 MutationObserver/定时重扫补丁（restore→re-patch）。
- 元素拼接与 fullPage 复用 `stitchSegments`，若 canvas 尺寸超限（>12000 或超宽）报错而非降级。

### 34.9 真机复验与 fullPage 根因（2026-10-27，0.2.4 → 0.2.5）

0.2.4 重启后真机（sidebar 0.2.4 / 扩展 0.1.30）：

- **首次 `browser open` 一次成功**（本次未复现 34.8 A 的 stale 超时；恢复逻辑仍在，作为兜底）。
- `viewport {1280×900}`：回执 `content width 1265 (innerWidth is larger by 15px: classic scrollbar)`，
  即 34.8 D 的 `contentWidth` 已生效。
- **fullPage 仍然失败（25–120s 超时），但阶段诊断直接给出了真相**：
  `%TEMP%\dsh-browser-control-state.json` 的 `diags.fullpage` 显示
  `begin(3ms) → hideScrollbars(74ms) → 4 段 segment-capture 33–66ms/段 → stitch(654ms) → restore(799ms)`，
  也就是说 **client 799ms 就完成了整张拼接图并回传**，没有任何一步卡住。
- 继续验证：同一页 `screenshot {fullPage:true, format:"jpeg", quality:70}` → **669ms 成功**，
  1280×3496、211 KB。两张图只差格式 → 一定是 **结果回传被 bridge 丢掉**。
- **最终根因**：`bridge.js` 的 `readBody` 把所有 POST body 限制在 **1,000,000 字符**；
  外网长页的 fullPage **PNG** base64 有数 MB，`/result` 请求被 400 拒绝且无任何状态记录，
  Host 端只能等到命令超时（本地预览页是纯色，PNG 极小所以一直"秒过"）。
  JPEG 压缩后 211KB 没触限，所以"只有 PNG 的 fullPage 失败"。
- **0.2.5 修复**：
  1. bridge `/result` body 上限提高到 **64MB**（`maxResultBodyBytes` 可配；`/diag` 单独 2MB）；
  2. 超限时返回 **413** 并在 diag state 记录 `sticky.lastRejectedBody`
     （path / limitBytes / receivedBytes / at），不再静默丢弃；
  3. client 在 POST 前预检 JSON 长度（**48MB**），超限直接返回可操作的错误
     （"use format jpeg / smaller clip"），并对非 2xx 回执补 `postDiag("result-rejected")`；
  4. 测试新增 2 项：3MB 结果 body 正常送达（回归 fullPage PNG）、超限 body 413 + 
     `lastRejectedBody` + 命令按超时失败（不会挂死）。
- 仍待真机复验（下一轮重启后）：C（picture 兜底）、E（高元素拼接）、`qa {scrollbars:"hidden"}`，
  以及 chrome 0.1.30 的 networkIdle best-effort（独立扩展 reload）。

### 34.10 真机复验第二轮（2026-10-27，0.2.5 → 0.2.6）

0.2.5 重启后（bridge 64MB 修复已生效）：

- **fullPage PNG 修复确认**：`github.com/Dax233` → 1280×3496 PNG **1.45MB / 798ms / 4 段**成功
  （1.45MB 文件 ≈1.9MB base64，正好是旧 1MB 上限丢掉的量）；`en.wikipedia.org/wiki/GitHub`
  → 1280×12000 PNG **9.5MB / 2929ms / 14 段**成功，capped 标注正确。
- `viewport` 回执 `contentWidth 1265（innerWidth 大 15px：经典滚动条）`；首次 open 一次成功。
- **`<picture>` 兜底真机复验发现新 bug（0.2.4 实现不完整）**：探针页（base64 data URI 的
  light/dark `<source media>`，含 open shadowRoot 版本）在 **light 模拟下图片仍是 dark 版**、
  auto 也回不去；DOM 属性检查显示 img 的 `src` 已是 light、`srcset` 已移除，但
  `img.currentSrc`/`naturalWidth` 仍是 dark 图。
  根因：**这台机器的真实浏览器偏好是 dark**，`<picture>` 里 media 匹配的 dark `<source>`
  永远胜出，img 自己的 `src`/`srcset` 被忽略——0.2.4 只改 img 属性，既无法让 light 版生效，
  restore 重挂时也会被真实偏好再次覆盖（dark 模拟"看起来生效"只是因为本来就已经是 dark）。
  修复（0.2.6）：patch 时把该 picture 内**所有 `<source>` 的 `media` 临时改成 `not all`**
  （让 img 的 src/srcset 决定），再设置目标变体；若模拟 scheme 没有任何匹配 source，
  回退到 img 自己的 src；`auto` 时先还原每个 source 的 original media，再还原 img 的 src/srcset，
  浏览器随即按真实偏好重新选择。测试同步更新（原"无匹配 source 不动"改为"neutralise + 回退 + auto 还原"）。
- 真机复验结论（0.2.6 重启后补）：light 模拟 → LIGHT IMAGE / SHADOW LIGHT；dark → DARK /
  SHADOW DARK；auto → 回到真实偏好（dark）。



### 34.11 侧栏挂载失败与黑标签（2026-10-27 第三轮反馈，0.2.6 → 0.2.7）

第三轮真机验收（用户侧）报告：`browser open` 连续失败 22–25s，
`Agent Browser panel did not become ready in time` / `no client result before timeout`；
diag 事件链为 `mount-acquired → webview did not attach within 10s（mount-failed）
→ reopen-mount-failed → ready-stale → unmount → mount-start → mount-acquired
→ webview did not attach within 10s（stale-remount-failed）`；侧栏里还有大量黑色空标签。

分析（结合 0.2.7 修复前的真机 diag）：

1. **黑标签的来源**：旧实现每次模块加载 mint 随机 `TAB_SUFFIX`（`agent-browser-xxxxxx`），
   DSH 把 tab 存进 `dsh.sidebar-right.v1.<sessionId>`，重启后旧 tab 仍在布局里、其类型
   已不再注册 → 渲染成黑色空面板；每次重启又多一个，于是"标签页越积越多、都是黑的"。
2. **挂载失败的来源**：`<webview>` 的 attach 依赖该 tab 真正被选中/可见；旧 `ensurePanel`
   调 `openTab(kind)` 不带 `revealIfOpened`，一旦布局里选中了别的（黑）标签，body 虽然挂载、
   guest 却一直不 attach，10s 后 mount 失败；社区证据：同一容器后来一次重挂（tab 被选中时）
   2ms 就 dom-ready。
3. 0.2.4 的 unmount/remount 只换 guest、不换 tab，所以两次都救不回来。

0.2.7 修复：

- **稳定 tab 身份**：`TAB_ID = @local/dsh-sidebar-browser-control`，`TAB_KIND = agent-browser`；
  重载后在同一 slot key 上重新注册 body，DSH 直接复用原 tab。
- **启动清理旧标签**：`staleTabIds()`（纯函数，可测）从 `ctx.sidebarRight.openTabs` 快照里
  挑出旧随机 id/kind 的 tab，`ctx.sidebarRight.close(id)` 关闭；1.5s 与 6s 各跑一次
  （布局恢复时序），已关闭的 id 去重。用户现有的黑标签会在重启后自动清掉。
- **挂载重试**：`appendAndWaitAttach()` 最多 3 次、每次 3.2s；每次重试 re-append guest
  （强制 Electron attach）并重跑 `ensurePanel()`（`openTab(kind, { revealIfOpened: true })`
  重新选中 tab）。三次都失败才抛错。
- **最后兜底**：`ensurePanelReady` 在 remount 仍失败后调用 `resetPanel()`（关闭我们的 tab +
  重开）再等 4s，最后才回退浮动面板；错误文案仍带 close/open 指引。
- 全过程 diag：`attach-attempt`（每次 attempt/attached）、`stale-tabs-closed`（closed/total）、
  `panel-tab-reset` / `panel-tab-reset-ready` / `panel-tab-reset-failed`。
- 测试：`staleTabIds` 过滤（只关旧随机 tab，不碰稳定 tab 与其它插件）、apply 清理（去重）、
  attach 重试（同一元素 re-append、ensurePanel 再跑、ready 后成功）、既有 stale 恢复与最终错误文案；
  共 **122 项全绿**。
- 真机复验（重启后）：黑标签被清理、`browser open` 一次成功、随后重跑 fullPage/picture/scrollbars/高元素。

### 34.12 黑面板与 status.panel 几何诊断（2026-10-27，0.2.7 → 0.2.8）

0.2.7 修好挂载后，真机（本会话）出现「tab 在、面板全黑，但所有 browser 命令都正常」
（open/evaluate/screenshot/qa 都返回真实数据）。用真实屏幕捕获（Graphics.CopyFromScreen，
非 PrintWindow）确认黑面板不是截图伪影；点击 tab、UIA 树都改变不了。

推断与实际一致的机制：React 在 tab body 重渲染时把我们的 body 挂到**新的容器**，而
`ensureMounted()` 旧实现只要 `webview !== undefined` 就直接 return → guest 留在已被替换的
（detached）旧容器里，命令仍能执行，但不参与合成 → 面板全黑。

0.2.8 修复：

- `ensureMounted(container)` 检测容器变化：把现有 guest `appendChild` 到新容器（真 DOM 的
  append 会从旧父节点移除），更新 `mountContainer/lastMountContainer`，并写
  `guest-reattached` 诊断（附几何）。容器未变时仍走原来的 ready 判断。
- `status` 新增 `panel` 字段：container/element 的 rect + `connected` + `element.parentIsContainer`
  + element 的 display/visibility/transform，用来一眼区分「detached / 零尺寸 / 隐藏 / 正常」。
- 测试：status 几何形状（正常挂载时 parentIsContainer/connected/尺寸）、以及重新挂到新容器后
  旧容器不再持有 guest；harness 的 fake DOM 增加 parentNode/append 移动语义与
  getBoundingClientRect。共 **124 项全绿**。
- 真机复验（重启后）：用 CopyFromScreen 抓 DSH 窗口，确认右侧面板是否显示页面；
  同时用 `browser status` 的 `panel` 字段核对容器/元素几何。

### 34.13 重启后首次 open 失败与「换元素」重试（2026-10-27，0.2.8 → 0.2.9）

0.2.8 重启后第一次 `browser open` 失败，报 Electron 的
`The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called`。
diag：`attach-attempt 1/2/3 attached:false` → `mount-failed` → `stale-remount-failed` →
`panel-tab-reset` → 之后 React 又自己挂了一次（2ms 成功）。

结论：**同一元素 re-append 救不回 wedged guest**；真机证据是"重建元素"（新 webview）
立刻 attach（2ms）。所以：

- `mountGuest()` 把重试改成**每次新建 webview 元素**（旧元素移除并 `remove()`），
  仍保留 3 次 × 3.2s，并在重试时重跑 `ensurePanel()` 选中 tab；
- 抽了 `createGuestElement()`（元素 + 全部事件监听），mount 只负责 acquire/loop/主题重放；
- `requireReady()` 增加 `guestAttached()` 探针（isConnected + getWebContentsId）；
  若 ready 标志还在但 guest 已 detached，会 `unmount()` 后立刻重建再等 ready；
- `loadUrlWithRecovery()`：open/navigate 命中 `must be attached` 时重建一次再 loadURL，
  不再把 Electron 原始错误抛给调用方；
- 测试：换元素重试（新元素 ≠ 旧元素、容器只留一个）、ready-but-detached 时命令前自动重建；
  共 **125 项全绿**。
- 真机待验（重启后）：首次 open 一次成功；若 attach 首次失败应看到 attach-attempt 后自动恢复。

### 34.14 DSH Host 自身端口被桌面壳隔离（2026-10-28，0.2.9 → 0.2.10）

0.2.9 真机复验通过后，试用内置浏览器自检 DSH 自己的 GUI：`browser open http://127.0.0.1:55544/`
（当前桌面 Host 地址）失败，只返回裸 IPC 错误
`Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ERR_FAILED (-2)`；
`browser status` 只有旧的 `lastUrl`，`logs` 0 条，没有任何策略原因。对照实验：同是 loopback 的
桥端口 `127.0.0.1:47834` 正常打开，`127.0.0.1:55545`（无监听）也返回 "opened"（错误页也算打开），
说明 `-2` 不是网络不可达，而是被主动 cancel。

根因（桌面壳有意隔离，不是插件缺陷）：`app.asar/lib/main.js` 的 `DesktopBrowserGuests.configureSession`
在 `webRequest.onBeforeRequest` 里 cancel 所有「loopback hostname + 当前 DSH Host 端口」的请求，
判定函数：

```js
isApplicationHost(url) {
  const value = this.hostUrl();
  if (value === void 0) return false;
  const host = new URL(value);
  return url.port === host.port && (
    url.hostname === host.hostname ||
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
}
```

隔离本身合理（guest 若能请求已认证的 Host，Agent 控制的页面就能拿到带 cookie 的 GUI/RPC 权限），
但 `webRequest` cancel 在 Chromium 侧只表现为 `net::ERR_FAILED (-2)`，没有策略标识；插件 `status`
也只记录成功导航后的 `lastUrl`，失败时没有任何可诊断线索——只能解包 `app.asar` 才知道是壳的策略。

0.2.10 修复（插件侧，不绕过隔离）：

- client 读 `globalThis.__DSH_TRANSPORT__.streamBaseUrl`（仅桌面壳存在）取 DSH Host origin，
  镜像壳的判定（loopback hostname + Host 端口）；`open` / `navigate` 在 mount webview **之前**
  命中即拒绝，不再等 Electron 抛裸 `GUEST_VIEW_MANAGER_CALL` 错误。
- 错误文案以 `blocked by the desktop shell's isolation policy` 开头，含 DSH Host origin、
  被拦目标（`(target: …)`）、`ERR_FAILED (-2)`，以及替代做法（`action=setContent` /
  `action=preview` / 另起独立 `dsh web` 实例）。
- 其它被壳 cancel 的 guest 请求（URL 带凭证；页面内导航到非 http(s) 目标等）仍会抛 `ERR_FAILED`，
  此类错误会追加指引并提示查看 `action=status` 的 `lastLoadFailure`（`open`/`navigate` 本身在
  `toHttpUrl` 已先拒绝非 http(s)）。
- 非桌面壳环境（`__DSH_TRANSPORT__` 不存在或 `ownsHost !== true`）不拦截，行为与 0.2.9 相同（兼容路径）。
- `status` 新增 `lastLoadFailure`：从 guest 的 `did-fail-load` 事件取 `errorCode` /
  `errorDescription` / `validatedURL` / `isMainFrame` / `at`；Host 半边把它并入工具返回的
  JSON status 文本，所以失败时也能看到原始 `-2` 原因。
- `browser` 工具描述的 Boundaries 句补上「不能打开 DSH Host 自身 origin」这条边界。
- 测试：新增 11 项回归测试（125 → **136 项全绿**）覆盖隔离判定/放行/兼容路径与 lastLoadFailure
  回传；独立验收另做了「新测试跑旧代码」变异检查（恰好 7 项失败，放行/兼容用例仍通过）与
  「壳源码逐字截取 vs 插件镜像」44 组 URL 等价比较（0 分歧，含 WHATWG 规范化与 IPv6 形态）。
- DSH 升级后需重核壳的 `isApplicationHost` 策略与 `__DSH_TRANSPORT__` 契约：若漂移，guard 会
  fail-open（退回裸 `ERR_FAILED`）而不会误拦，此时要同步镜像再发版。
- 未修复（上游壳侧）：DSH Host 端口上的公开静态路径（如 `/manifest.webmanifest`、`/assets/*`）
  同样被拦；壳侧修复（IPC 错误里带 typed 失败原因、可选的只读代理、按路径区分的策略）仍是
  DSH Desktop 上游 TODO，本插件不尝试绕过。
- 真机待验：profile 是 `file:` 副本安装，需要 `dsh plugin --profile desktop remove/add` 刷新
  （见索引 README「本机 profile 更换本地插件版本」）+ 重启 DSH Desktop 后才能真机复验
  （当前会话未重启，未做真机验证）。

### 34.15 open/navigate 失败回执与 status 预判字段（2026-10-28，0.2.10 → 0.2.11）

0.2.10 的显式隔离错误在下一次重启后做了真机验收（desktop profile，已刷新到 0.2.10 并重启；
GUI origin `http://127.0.0.1:62109`）：

| 调用 | 0.2.10 真机结果 |
|---|---|
| `browser open http://127.0.0.1:62109/` | `browser open failed: blocked by the desktop shell's isolation policy: the Agent Browser cannot load the DSH Host itself (http://127.0.0.1:62109); the shell cancels guest requests to the Host's own port, which Chromium reports as a bare ERR_FAILED (-2). Use action=setContent or action=preview for local content, or a separate standalone 'dsh web' instance to inspect the GUI. (target: http://127.0.0.1:62109/)` —— 端口取自 `__DSH_TRANSPORT__`，不是硬编码 |
| `browser open http://localhost:62109/manifest.webmanifest` | 同一策略拒绝，`localhost` 目标被回显到 `(target: …)`（loopback 别名 + Host 端口判定都生效） |
| `browser open http://127.0.0.1:55545/`（无监听） | 0.2.10 仍返回 Electron 裸 IPC 包装：`browser open failed: Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ERR_CONNECTION_REFUSED (-102) loading 'http://127.0.0.1:55545/'`（0.2.11 的清理对象） |
| `browser status`（紧接着上一行） | `lastLoadFailure = {errorCode:-102, errorDescription:"ERR_CONNECTION_REFUSED", validatedURL:"http://127.0.0.1:55545/", isMainFrame:true, at:…}` —— Host 半边 pass-through 真机确认 |
| `browser open https://example.com/` | 正常 `opened https://example.com/ (Example Domain)`，守卫不误拦 |

结论：0.2.10 的「挂载前拒绝 + `status.lastLoadFailure`」真机 PASS；剩余两处体验缺口来自
dsh-sidebar-ux 会话的反馈，由 0.2.11 修复：

1. `open`/`navigate` 失败仍把 Electron 的 IPC 包装原样交给 agent（上面 55545 的例子），
   且导航落到 Chromium 错误页时仍报 `opened`，agent 会误以为内容已加载。
2. `status` 应暴露本次尝试的 URL 与 DSH Host origin，让 agent 预判壳隔离，而不是撞上后
   只看裸错误。

0.2.11 实现契约（client.js + index.js；不绕过壳隔离）：

- client 在 `open`/`navigate` 通过隔离守卫后记录 `lastAttempt = {url, at}`；`loadFailureSince(at)`
  只认本次尝试之后发生的 `did-fail-load`，上一次失败不会污染本次回执。
- `describeLoadError()` 把 Electron 的
  `Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ERR_CONNECTION_REFUSED (-102) loading '<url>'`
  规范化为 `<CODE> (<numeric>) loading '<url>'`（丢弃 IPC 包装；没有错误码时原样返回）；
  `loadFailureLine()` 用 `errorDescription (errorCode) loading 'validatedURL'` 组装回执行。
- 加载抛错不再直接 throw：resolve `{ ok:false, error, attemptedUrl, loadFailure? }`；`error` 末尾附
  `— see action=status lastLoadFailure …`，`ERR_FAILED` 时附「桌面壳会 cancel 部分 guest 请求」说明。
  隔离守卫命中的拒绝保持原样（仍不 mount/load）。
- 成功路径同样检查本次 `did-fail-load`：主 frame 失败（导航落在 Chromium 错误页）时返回
  `{ ok:true, loaded:false, url, title, attemptedUrl, loadFailure, warning }`，不再报裸 `opened`；
  正常加载返回 `{ ok:true, loaded:true, url, title, attemptedUrl }`。
- `status()` 增加 `attemptedUrl`（最近一次 open/navigate 请求的 URL）与 `hostOrigin`
  （`desktopTransport()?.streamBaseUrl`；standalone `dsh web` 无 transport → undefined，JSON 丢弃）。
- Host 半边 `formatResult("open"/"navigate")` 追加 `requested <attemptedUrl>`（请求与实际落点不同时）
  与错误页 warning（含 `ERR_…` 错误码 + `see action=status lastLoadFailure`）；`executeStatus()`
  pass-through `attemptedUrl`/`hostOrigin`；工具 DESCRIPTION 的 status 句补三条字段。
- 兼容：0.2.10 的隔离守卫与 `loadUrlWithRecovery()` 的 must-be-attached 重建重试都不变；
  非桌面环境没有 `hostOrigin`，行为与 0.2.10 相同。
- 测试：新增 11 项（136 → **147 项全绿**），覆盖 IPC 包装规范化（结果不含 `Error invoking remote
  method`/`GUEST_VIEW_MANAGER_CALL`，含 `ERR_CONNECTION_REFUSED (-102)` 与 URL）、loadURL reject +
  本次 `did-fail-load` 的 `loadFailure`、错误页 `loaded:false` + warning、正常 `loaded:true`、
  `status.attemptedUrl`/`hostOrigin` 及无 transport 时的缺省、Host 回执 `requested`/warning 与
  `executeStatus()` pass-through、工具 DESCRIPTION 措辞。
- 真机待验（下次重启生效）：profile 是 `file:` 副本安装，本轮由维护会话直接把 0.2.11 文件同步进
  安装副本（内容等价于 remove/add 后的结果，下次重启加载；也可按索引 README 的 remove/add 流程刷新）；
  复验 `browser open http://127.0.0.1:55545/` 应返回 `{ok:false}` + `attemptedUrl` +
  `ERR_CONNECTION_REFUSED (-102)`（无 IPC 包装文本），`browser status` 应含
  `attemptedUrl`/`hostOrigin`/`lastLoadFailure`，且 0.2.10 已真机验证的隔离拒绝与 example.com
  正常路径不回归。真机证据与剩余 backlog 见本地
  `dsh-plugins/research/browser-host-block-followup-2026-10-28.md`（gitignored）。

### 34.16 setContent 死锁与命令看门狗（2026-10-28，0.2.11 → 0.2.12）

0.2.11 真机试用由 dsh-sidebar-ux 会话报告：`browser setContent` 在桌面壳真机上连续两次失败，
工具返回：

```text
browser setContent failed: browser bridge: no client result before timeout
```

之后 client 完全停止轮询：`browser status` 里只剩一个 stale client id，`open` / `close` / `preview`
都返回：

```text
browser <action>: no connected client — the Agent Browser sidebar panel is not open. Call action=open with a URL first (or ask the user to reopen the panel).
```

面板只能手动重开恢复。约 16:55:39（本地）会话触发一次 plugin dispose/remount 后出现新的 client id
`bc-yb2vxgkl`，`browser status` 恢复健康——说明 Host / 桥本身没死，是 guest/client 端命令卡住导致
轮询停摆。

根因分析（三处叠加）：

1. **桌面壳主 frame 导航只放行 http(s)**：`setContent` 旧实现先 `await webview.loadURL("about:blank")`；
   桌面壳的 `webRequest` / `allowedNavigation` 会 cancel 非 http(s) 主 frame 导航，但在 Electron
   侧该 `loadURL` 可能既不 resolve 也不 reject → 命令永久挂起。
2. **client bridge poll 循环没有看门狗**：旧 `createBridgeLoop` 直接 `await controller.handle(cmd)`，
   一个卡死命令让整个轮询停止；Host 侧保留旧 client id，后续命令只能等到 bridge timeout，
   表现为 `no client result before timeout`，随后新命令因 client 不再登记而报 `no connected client`。
3. **页面脚本的双重 rAF 可能被节流**：`setContentJs()` 用
   `requestAnimationFrame(() => requestAnimationFrame(finish))` 等文档稳定；隐藏/被遮挡的 webview
   不保证触发 rAF，脚本可能永远不返回完成信号，即使文档已经替换成功。

另外 0.2.10 / 0.2.11 的隔离错误文案推荐用 `setContent` 替代本地内容，这条建议在桌面壳上不可靠
（上述第 1 条），本轮一并修正。

0.2.12 修复契约（client.js + bridge.js + index.js；不改变 0.2.11 已有行为）：

- 新增模块级 `withTimeout(promise, ms, message)`：带上限地等待任意 promise，输入 settle 时清除
  定时器，竞速失败分支挂 noop catch，不会产生 unhandled rejection；`__test` 导出。
- **`setContent` 在桌面壳原地渲染**：`desktopTransport() !== undefined` 时完全不尝试 `about:blank`
  导航（`context = "in-place"`），直接 `document.open/write/close` 渲染；非桌面环境保留 about:blank
  路径但包 `withTimeout(…, 2000)`，失败/拒绝时同样回退 in-place 并如实回执。
- `executeJavaScript(setContentJs(...))` 包 `withTimeout(…, 8000)`；超时后用 2s 预算探测
  `pageInfo()`：页面可读 → `{ok:true, context, warning:"setContent completion signal was lost
  (the document was replaced); the page is readable"}`；探测也失败 →
  `{ok:false, error:"setContent timed out after 8000ms — the guest document may be stuck; call
  action=status, then action=setContent again or action=close and action=open"}`。命令不再可能无限挂起。
- `setContentJs()` 的双重 rAF 改为与 `setTimeout(finish, 100)` 竞速，被节流的 webview 也能返回完成信号。
- **bridge poll 命令看门狗**：`runCommandGuarded(controller, cmd, timeoutMs)` 有界执行
  `controller.handle(cmd)`；超时 resolve
  `{ok:false, error:"client command timed out after <ms>ms — the Agent Browser panel may be wedged;
  the bridge loop stays alive, retry action=status, or action=close then action=open"}`；handler 抛错
  也转成失败回执；该函数从不 reject，poll 循环超时后继续轮询。deadline 取 bridge 随命令下发的
  `timeoutMs`（+3s grace，默认 45s），慢命令仍由 Host 的 bridge timeout 先报，真卡死才由看门狗切断。
- `bridge.js` 即时派发也携带 `timeoutMs: effectiveTimeoutMs`（排队路径原本已带）。
- `index.js` push 捕获 `no client result before timeout` 时追加
  `— the sidebar client did not answer in time (the panel may be wedged); the bridge stays alive,
  retry action=status, or action=close then action=open.`，不再让 agent 猜插件是否整体死掉。
- 测试：新增 9 项（147 → **156 项全绿**）：`withTimeout` 正常/超时/清定时器、`runCommandGuarded`
  正常/拒绝/挂死回 wedged receipt、桌面 `setContent` 不调用 `loadURL("about:blank")` 且
  `context:"in-place"`、never-settling 内容脚本有界返回（warning 或 timeout error 均算通过）、
  非桌面环境 about:blank 路径不变、bridge 即时派发携带 `timeoutMs`、Host 对不回应 client 的
  wedged 提示。
- 真机待验（下次重启生效）：profile 仍是 0.2.11 安装副本，0.2.12 需同步/remove+add 后重启
  DSH Desktop。复验清单：
  1) `browser setContent {html:"<h1>hi</h1>"}` 秒级返回，回执 `ok:true` 且 `context:"in-place"`，
     不再出现 bridge timeout；
  2) 连续两次 setContent 后 `browser status` 仍为 connected，`open`/`close`/`preview` 不再报
     `no connected client`；
  3) 人为让一个命令挂死时回执 `client command timed out after <ms>ms … panel may be wedged`，
     且随后 `status` 仍 connected（轮询继续）；
  4) 0.2.11 的隔离错误/结构化失败回执不回归。
  本轮未重启、未做 0.2.12 真机验证。报告与 backlog 见本地
  `dsh-plugins/research/browser-host-block-followup-2026-10-28.md` 的「0.2.12：setContent 死锁与命令看门狗」一节。

### 34.17 0.2.11 + 0.2.12 真机验收（2026-10-28 17:19，重启后；两项 PASS）

环境：desktop profile 安装副本已同步到 0.2.12（直接文件同步，未走 remove/add），重启后 GUI origin
`http://127.0.0.1:65254`；`browser status` 只有 1 个 client `bc-s9bn4rf8`（无累积）。

0.2.11 验收（`attemptedUrl` / `hostOrigin` / 结构化失败回执）：

| 调用 | 真机结果 |
|---|---|
| `browser status`（首次） | `hostOrigin: "http://127.0.0.1:65254"`（0.2.10 无此字段，证明 0.2.11 已加载） |
| `browser open http://127.0.0.1:55545/`（无监听） | `browser open failed: ERR_CONNECTION_REFUSED (-102) loading 'http://127.0.0.1:55545/' — see action=status lastLoadFailure for the guest's last load failure.` —— 干净错误码，**无 `Error invoking remote method` / `GUEST_VIEW_MANAGER_CALL` 包装** |
| 紧接 `browser status` | `lastLoadFailure: {errorCode:-102, errorDescription:"ERR_CONNECTION_REFUSED", validatedURL:"http://127.0.0.1:55545/", isMainFrame:true, at:…}`；`attemptedUrl: "http://127.0.0.1:55545/"` —— 失败后 `lastUrl` 仍停在旧页时也能关联本次尝试 |
| `browser open http://127.0.0.1:65254/` | 0.2.10 隔离拒绝不回归：`blocked by the desktop shell's isolation policy … (http://127.0.0.1:65254) … ERR_FAILED (-2) … (target: …)`，端口动态 |
| `browser open https://example.com/` | 正常 opened（不误拦） |

0.2.12 验收（setContent 桌面安全 + 命令看门狗）：

| 调用 | 真机结果 |
|---|---|
| `setContent`（完整 doctype/inline 样式，两次） | 两次均秒级返回：`setContent: "<title>" in the current context — viewport 575x742 (rendered in place of the current page (about:blank navigation was unavailable))` —— `context:"in-place"`，**无 bridge timeout** |
| 两次 setContent 后 `browser status` | 仍 `client.ready:true / hasWebview:true / freshClients:["bc-s9bn4rf8"]`，无 stale client / no connected client |
| 之后 `open`（example.org / example.com）、`close` + `open` 重挂载、`preview`（随机 loopback 端口 61065 的 tokenized URL，snapshot 可读） | 全部正常，面板不再需要手动重开 |
| **看门狗真机验证**：`evaluate {expression:"new Promise(() => {})"}` 人为挂死 | Host 25s 后返回 `browser evaluate failed: browser bridge: no client result before timeout — the sidebar client did not answer in time (the panel may be wedged); the bridge stays alive, retry action=status, or action=close then action=open.`；随后 `browser status` 仍 fresh/connected，`browser open https://example.com/` 成功 —— **不再出现 stale client / no-connected-client 死锁**（这正是 dsh-sidebar-ux 会话在 0.2.10 上遇到的故障形态） |

结论：0.2.11 与 0.2.12 真机 PASS，二者不再标注「真机待验」；残余风险只剩壳侧上游 TODO（typed
`did-fail-load`、只读代理、静态路径策略）。
