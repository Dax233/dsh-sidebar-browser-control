window.__ModuleLoader__.load({
  id: "@local/dsh-sidebar-browser-control",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const PORT = 47834;
    const TOKEN = "dsh-browser-control-local";
    const BASE = `http://127.0.0.1:${PORT}`;
    // A plugin reload disposes the old body but DSH keeps its tab entry; opening
    // the same kind would only focus that stale, bodiless tab. A per-module-load
    // identity guarantees openTab places a fresh tab whose body mounts.
    const TAB_SUFFIX = Math.random().toString(36).slice(2, 8);
    const TAB_ID = `@local/dsh-sidebar-browser-control-${TAB_SUFFIX}`;
    const TAB_KIND = `agent-browser-${TAB_SUFFIX}`;
    const WORKSPACE_KEY = "agent-browser";
    const DEFAULT_WAIT_MS = 10000;

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // ---------------------------------------------------------------------
    // Page scripts. Each runs inside the guest page through executeJavaScript;
    // the marker comments are also what the unit tests assert to prove the
    // right path was taken.
    // ---------------------------------------------------------------------

    const CURSOR_HOST_ID = "__dshAgentCursor";

    function cursorMoveJs(x, y) {
      return `(() => {
        // __dshAgentCursorMove
        const ID = ${JSON.stringify(CURSOR_HOST_ID)};
        let host = document.getElementById(ID);
        if (!host) {
          host = document.createElement('div');
          host.id = ID;
          host.setAttribute('data-dsh-agent-ui', '1');
          host.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:2147483647;will-change:transform';
          const shadow = host.attachShadow({ mode: 'open' });
          const style = document.createElement('style');
          style.textContent = '.cursor{position:absolute;left:0;top:0;width:20px;height:20px;transform:translate(-6px,-4px);filter:drop-shadow(0 1px 2px rgba(0,0,0,.55));} .ring{position:absolute;left:0;top:0;width:30px;height:30px;margin:-15px 0 0 -15px;border:2px solid #fbbf24;border-radius:50%;opacity:0;transition:opacity .15s}';
          shadow.appendChild(style);
          const cursor = document.createElement('div');
          cursor.className = 'cursor';
          cursor.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M2 2l8 19 2.5-7.5L20 11 2 2z" fill="#fbbf24" stroke="#111" stroke-width="1.2"/></svg>';
          shadow.appendChild(cursor);
          const ring = document.createElement('div');
          ring.className = 'ring';
          shadow.appendChild(ring);
          document.documentElement.appendChild(host);
          host.__ring = ring;
        }
        host.style.transform = 'translate(' + ${x} + 'px,' + ${y} + 'px)';
        return { moved: true, x: ${x}, y: ${y} };
      })()`;
    }

    function cursorRippleJs(x, y) {
      return `(() => {
        // __dshAgentCursorRipple
        const host = document.getElementById(${JSON.stringify(CURSOR_HOST_ID)});
        if (!host || !host.__ring) return { rippled: false };
        host.__ring.style.opacity = '1';
        setTimeout(() => { if (host.__ring) host.__ring.style.opacity = '0'; }, 320);
        return { rippled: true, x: ${x}, y: ${y} };
      })()`;
    }

    /** Snapshot: depth-limited tree; refs are stable ids kept in window.__dshAgentRefs. */
    function snapshotJs(maxElements = 150) {
      return `(() => {
        // __dshAgentSnapshot
        const MAX = ${Number(maxElements)};
        const AGENT_UI = '[data-dsh-agent-ui]';
        const interactiveSelector = 'a[href], button, input, textarea, select, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=menuitem], [role=tab], [role=switch], [contenteditable=""], [contenteditable=true]';
        const headingSelector = 'h1, h2, h3, [role=heading], [role=main], [role=navigation], [role=search]';
        const all = [...document.querySelectorAll(interactiveSelector + ', ' + headingSelector)];
        const interactiveMatches = (el) => typeof el.matches === 'function' && el.matches(interactiveSelector);
        const included = new Set();
        const usedIds = new Set();
        const refs = new Map();
        const elements = [];
        let skipped = 0;
        let omitted = 0;
        const clean = (value) => String(value ?? '').trim().replace(/\\s+/g, ' ');
        const stableId = (el) => {
          const tag = el.tagName.toLowerCase();
          const isControl = tag === 'input' || tag === 'textarea' || tag === 'select';
          // A control's visible text is its current value, which changes while
          // the agent types; exclude it so the ref stays stable across snapshots.
          const display = isControl
            ? ''
            : clean(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title')).slice(0, 80);
          const key = [
            tag,
            el.getAttribute('role') || '',
            display,
            clean(el.getAttribute('href')),
            clean(el.getAttribute('name') || el.getAttribute('id') || el.getAttribute('placeholder') || el.getAttribute('aria-label')),
            clean(el.getAttribute('type')),
          ].join('|');
          let hash = 2166136261;
          for (let i = 0; i < key.length; i += 1) {
            hash ^= key.charCodeAt(i);
            hash = Math.imul(hash, 16777619) >>> 0;
          }
          let id = 'e' + hash.toString(36);
          let suffix = 2;
          while (usedIds.has(id)) { id = 'e' + hash.toString(36) + '-' + suffix; suffix += 1; }
          usedIds.add(id);
          return id;
        };
        for (const el of all) {
          if (typeof el.closest === 'function' && el.closest(AGENT_UI)) { skipped += 1; continue; }
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
          if (!visible) { skipped += 1; continue; }
          if (elements.length >= MAX) { omitted += 1; continue; }
          const interactive = interactiveMatches(el);
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role') || (interactive
            ? ({ a: 'link', button: 'button', input: 'textbox', textarea: 'textbox', select: 'combobox', summary: 'button' }[tag] || 'control')
            : (tag === 'h1' || tag === 'h2' || tag === 'h3' ? 'heading' : tag));
          const text = clean(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title')).slice(0, 100);
          const ref = interactive ? stableId(el) : undefined;
          if (ref !== undefined) refs.set(ref, el);
          included.add(el);
          let depth = 0;
          for (let node = el.parentElement; node !== null && node !== document.body; node = node.parentElement) {
            if (included.has(node)) depth += 1;
          }
          const value = tag === "input" || tag === "textarea" || tag === "select" ? String(el.value ?? "").slice(0, 80) : undefined;
          const checked = tag === "input" && (el.type === "checkbox" || el.type === "radio") ? el.checked === true : undefined;
          elements.push({
            ...(ref === undefined ? {} : { ref }),
            role,
            tag,
            text,
            ...(value === undefined ? {} : { value }),
            ...(checked === undefined ? {} : { checked }),
            href: el.getAttribute("href") || undefined,
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            depth,
          });
        }
        window.__dshAgentRefs = refs;
        const doc = document.scrollingElement || document.documentElement;
        const scrollHeight = Math.round(doc.scrollHeight || 0);
        const innerHeight = Math.round(window.innerHeight || 0);
        const scrollY = Math.round(window.scrollY || doc.scrollTop || 0);
        const pagesBelow = innerHeight > 0 ? Math.max(0, Math.ceil((scrollHeight - scrollY - innerHeight) / innerHeight)) : 0;
        return {
          title: document.title,
          url: location.href,
          viewport: { w: innerWidth, h: innerHeight, scrollY },
          count: elements.length,
          total: all.length,
          omitted,
          skipped,
          scroll: { scrollHeight, pagesBelow },
          elements,
        };
      })()`;
    }

    function clickTargetJs(ref) {
      return `(async () => {
        // __dshAgentClickTarget
        const refs = window.__dshAgentRefs;
        const wanted = ${JSON.stringify(String(ref))};
        const el = refs ? refs.get(wanted) : undefined;
        if (!el) return { ok: false, error: 'element ref ' + wanted + ' is not in the current snapshot; take a new snapshot' };
        if (!el.isConnected) return { ok: false, error: 'element ref ' + wanted + ' is stale (the page changed); take a new snapshot' };
        // scrollIntoView can scroll asynchronously (smooth CSS); measuring the
        // rect immediately would dispatch the click at the pre-scroll position.
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        let lastScrollY = -1;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await nextFrame();
          const now = Math.round(window.scrollY || 0);
          if (now === lastScrollY) break;
          lastScrollY = now;
        }
        const rect = el.getBoundingClientRect();
        const clamp = (value, max) => Math.max(0, Math.min(Math.round(value), Math.max(0, max - 1)));
        const x = clamp(rect.left + rect.width / 2, innerWidth);
        const y = clamp(rect.top + rect.height / 2, innerHeight);
        const hit = document.elementFromPoint(x, y);
        const hitTrusted = hit === el || el.contains(hit) || (hit !== null && hit.contains(el));
        return {
          ok: true,
          x,
          y,
          label: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
          hitTrusted
        };
      })()`;
    }

    function focusJs(ref) {
      return `(() => {
        // __dshAgentFocus
        const refs = window.__dshAgentRefs;
        const wanted = ${JSON.stringify(String(ref))};
        const el = refs ? refs.get(wanted) : undefined;
        if (!el) return { ok: false, error: 'element ref ' + wanted + ' is not in the current snapshot; take a new snapshot' };
        if (!el.isConnected) return { ok: false, error: 'element ref ' + wanted + ' is stale (the page changed); take a new snapshot' };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus();
        if (typeof el.select === 'function') { try { el.select(); } catch (error) {} }
        return { ok: true, tag: el.tagName.toLowerCase() };
      })()`;
    }

    function submitFormJs() {
      return `(() => {
        // __dshAgentSubmitForm
        const el = document.activeElement;
        const form = el && el.form;
        if (!form) return { submitted: false, reason: 'no form for the focused element' };
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit();
          return { submitted: true, method: 'requestSubmit' };
        }
        if (typeof form.submit === 'function') {
          form.submit();
          return { submitted: true, method: 'submit' };
        }
        return { submitted: false, reason: 'form has no submit method' };
      })()`;
    }

    function waitSelectorJs(selector) {
      return `(() => {
        // __dshAgentWaitSelector
        const el = document.querySelector(${JSON.stringify(selector)});
        return { found: el !== null };
      })()`;
    }

    function pageTitleJs() {
      return `(() => ({ title: document.title, url: location.href }))()`;
    }

    function scrollStateJs() {
      return `(() => {
        // __dshAgentScrollState
        const doc = document.scrollingElement || document.documentElement;
        return {
          scrollY: Math.round(window.scrollY || doc.scrollTop || 0),
          scrollHeight: Math.round(doc.scrollHeight || 0),
          innerHeight: Math.round(window.innerHeight || 0)
        };
      })()`;
    }

    function scrollFallbackJs(deltaY) {
      return `(() => {
        // __dshAgentScrollFallback
        window.scrollBy(0, ${Number(deltaY)});
        return { scrolled: true };
      })()`;
    }

    /**
     * Wait until mutations quiet down (or a cap is reached) before the next
     * observation. Runs in the page because only the page can see its own DOM.
     */
    function settleJs(maxQuietMs = 100, maxWaitMs = 3000) {
      return `(async () => {
        // __dshAgentSettle
        const maxQuiet = ${Number(maxQuietMs)};
        const maxWait = ${Number(maxWaitMs)};
        const started = performance.now();
        let lastMutation = Date.now();
        let mutations = 0;
        let observer;
        try {
          observer = new MutationObserver((records) => {
            mutations += records.length;
            lastMutation = Date.now();
          });
          observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        } catch (error) {
          return { settled: false, mutations: 0, waitedMs: 0, quietMs: 0, error: String(error && error.message ? error.message : error) };
        }
        while (true) {
          const elapsed = performance.now() - started;
          const idle = Date.now() - lastMutation;
          if ((mutations > 0 && idle >= maxQuiet) || elapsed >= maxWait) {
            observer.disconnect();
            return { settled: true, mutations, waitedMs: Math.round(elapsed), quietMs: Math.round(idle) };
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      })()`;
    }

    function focusedValueJs() {
      return `(() => {
        // __dshAgentFocusedValue
        const el = document.activeElement;
        if (!el) return { value: "" };
        if ('value' in el && typeof el.value === 'string') return { value: el.value, tag: el.tagName.toLowerCase() };
        return { value: (el.innerText || '').trim().slice(0, 200), tag: el.tagName.toLowerCase() };
      })()`;
    }

    function editableJs() {
      return `(() => {
        // __dshAgentEditable
        const el = document.activeElement;
        const tag = el ? el.tagName.toLowerCase() : '';
        const editable = !!el && (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true);
        return { editable, tag, value: editable ? String(el.value !== undefined ? el.value : (el.innerText || '')) : '' };
      })()`;
    }

    // ---------------------------------------------------------------------
    // Panel controller: owns the leased webview and executes commands.
    // Exported through plugin.__test so unit tests drive it with mocks.
    // ---------------------------------------------------------------------

    function toHttpUrl(raw) {
      if (typeof raw !== "string" || raw.trim() === "") throw new Error("url is required");
      let url;
      try {
        url = new URL(raw.trim());
      } catch {
        throw new Error(`url is not valid: ${String(raw)}`);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`only http:// and https:// pages are allowed, got ${url.protocol}//`);
      }
      return url.href;
    }

    function createPanelController(options = {}) {
      const documentRef = options.document ?? globalThis.document;
      const desktop = options.dshDesktop ?? globalThis.dshDesktop;
      const sleepImpl = options.sleep ?? sleep;
      const ensureFallback = options.ensureFallback;
      let fallbackContainer;
      const diag = options.diag ?? (() => Promise.resolve());
      const ensurePanel = options.ensurePanel ?? (() => {});
      const navigationWaitMs = options.navigationWaitMs ?? 1200;

      let webview;
      let lease;
      let ready = false;
      let mountPromise;
      let lastSnapshot;
      let navigationCount = 0;
      const readyWaiters = [];
      const navigationWaiters = [];

      function settleNavigation() {
        navigationCount += 1;
        for (const waiter of navigationWaiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.resolve(true);
        }
      }

      function waitForNavigation(timeoutMs) {
        if (timeoutMs <= 0) return Promise.resolve(false);
        return new Promise((resolve) => {
          const waiter = {
            resolve,
            timer: setTimeout(() => {
              const index = navigationWaiters.indexOf(waiter);
              if (index >= 0) navigationWaiters.splice(index, 1);
              resolve(false);
            }, timeoutMs),
          };
          navigationWaiters.push(waiter);
        });
      }

      function settleReady() {
        ready = true;
        for (const waiter of readyWaiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.resolve();
        }
      }

      function waitReady(timeoutMs = DEFAULT_WAIT_MS) {
        if (ready) return Promise.resolve();
        return new Promise((resolve, reject) => {
          const waiter = {
            resolve,
            reject,
            timer: setTimeout(() => {
              const index = readyWaiters.indexOf(waiter);
              if (index >= 0) readyWaiters.splice(index, 1);
              reject(new Error("Agent Browser panel did not become ready in time"));
            }, timeoutMs),
          };
          readyWaiters.push(waiter);
        });
      }

      async function mount(container) {
        if (ready) return;
        if (mountPromise !== undefined) return mountPromise;
        mountPromise = (async () => {
          void postDiag("panel", { phase: "mount-start" });
          const desktopBridge = desktop?.browser;
          if (desktopBridge === undefined) {
            throw new Error("the desktop browser bridge is missing (window.dshDesktop.browser); the Agent Browser needs the desktop app");
          }
          const reservation = await desktopBridge.acquire(WORKSPACE_KEY);
          void postDiag("panel", { phase: "mount-acquired", lease: reservation.lease });
          lease = reservation.lease;
          const element = documentRef.createElement("webview");
          webview = element;
          element.setAttribute("name", reservation.lease);
          element.setAttribute("partition", reservation.partition);
          element.setAttribute("src", `about:blank#${reservation.lease}`);
          element.style.cssText = "width:100%;height:100%;display:flex;background:#0b0d12";
          element.addEventListener("did-navigate", () => {
            settleNavigation();
          });
          // Lifecycle diagnostics: a panel can stop polling without an error
          // (guest crash, lease teardown, host unmount). Record why it happened.
          for (const eventName of ["crashed", "destroyed", "render-process-gone", "unresponsive"]) {
            element.addEventListener(eventName, () => {
              void postDiag("panel", { phase: "webview-event", event: eventName, lease: lease ?? null });
            });
          }
          element.addEventListener("did-fail-load", (event) => {
            void postDiag("panel", {
              phase: "did-fail-load",
              errorCode: event?.errorCode,
              errorDescription: event?.errorDescription,
              validatedURL: event?.validatedURL,
            });
          });
          element.addEventListener("dom-ready", () => {
            void postDiag("panel", { phase: "dom-ready", url: safePageUrl(element) });
          });
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Agent Browser webview did not attach within 10s")), 10000);
            element.addEventListener(
              "dom-ready",
              () => {
                clearTimeout(timer);
                settleReady();
                resolve();
              },
              { once: true },
            );
            container.appendChild(element);
          });
          void postDiag("panel", { phase: "ready", lease: reservation.lease });
        })().catch((error) => {
          mountPromise = undefined;
          void postDiag("panel", { phase: "mount-failed", error: String(error && error.message ? error.message : error) });
          throw error;
        });
        return mountPromise;
      }

      function ensureMounted(container) {
        if (webview !== undefined) return Promise.resolve();
        return mount(container);
      }

      function unmount() {
        const currentLease = lease;
        const element = webview;
        void postDiag("panel", { phase: "unmount", lease: currentLease ?? null, url: safePageUrl(element) });
        webview = undefined;
        lease = undefined;
        ready = false;
        mountPromise = undefined;
        lastSnapshot = undefined;
        try {
          element?.remove?.();
        } catch {
          // The guest may already be gone.
        }
        if (currentLease !== undefined && desktop?.browser !== undefined) {
          desktop.browser.release(currentLease).catch(() => {});
        }
        for (const waiter of readyWaiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error("Agent Browser panel was closed"));
        }
      }

      /** Current URL without evaluating page script (used for navigation checks). */
      function safePageUrl(element) {
        try {
          return element !== undefined && typeof element.getURL === "function" ? element.getURL() : "";
        } catch {
          return "";
        }
      }

      function readUrl() {
        const current = webview;
        if (current === undefined) return "";
        try {
          return typeof current.getURL === "function" ? current.getURL() : "";
        } catch {
          return "";
        }
      }

      async function pageInfo() {
        const current = webview;
        if (current === undefined) return { url: "", title: "" };
        const url = readUrl();
        let title = "";
        try {
          const info = await current.executeJavaScript(pageTitleJs());
          title = info?.title ?? "";
        } catch {
          title = "";
        }
        return { url, title };
      }

      async function ensureFallbackMounted() {
        if (ready || webview !== undefined) return;
        let container;
        try {
          container = fallbackContainer ?? options.ensureFallback?.();
        } catch (error) {
          void postDiag("panel", { phase: "fallback-failed", error: String(error && error.message ? error.message : error) });
          return;
        }
        if (container === undefined || container === null) return;
        fallbackContainer = container;
        void postDiag("panel", { phase: "fallback-mounted" });
        await ensureMounted(container);
      }

      async function requireReady() {
        if (ready && webview !== undefined) return webview;
        if (webview === undefined) throw new Error("Agent Browser panel is not open; call action=open first");
        await waitReady();
        if (webview === undefined) throw new Error("Agent Browser panel was closed");
        return webview;
      }

      /** Observations settle after an action; navigation can destroy the page context. */
      async function settlePage(current) {
        try {
          const result = await current.executeJavaScript(settleJs());
          return result !== null && typeof result === "object" ? result : { settled: false };
        } catch {
          // The action navigated and the old page context is gone.
          return { settled: false, navigatedAway: true };
        }
      }

      async function handle(command) {
        const type = String(command?.type ?? "");
        switch (type) {
          case "status":
            return { ok: true, ...status() };
          case "open": {
            const url = toHttpUrl(command.url);
            if (!ready) {
              if (webview === undefined) ensurePanel();
              try {
                await waitReady(2500);
              } catch {
                // The DSH right sidebar can keep a stale tab entry that never
                // mounts its body after plugin reloads; fall back to a floating
                // panel so the tool stays usable.
                await ensureFallbackMounted();
                await waitReady();
              }
            }
            const current = await requireReady();
            await current.loadURL(url);
            await sleepImpl(Number(command.waitMs ?? 350));
            const info = await pageInfo();
            return { ok: true, url: info.url || url, title: info.title };
          }
          case "navigate": {
            const url = toHttpUrl(command.url);
            const current = await requireReady();
            await current.loadURL(url);
            await sleepImpl(Number(command.waitMs ?? 350));
            const info = await pageInfo();
            return { ok: true, url: info.url || url, title: info.title };
          }
          case "snapshot": {
            const current = await requireReady();
            const snapshot = await current.executeJavaScript(snapshotJs());
            if (snapshot === undefined || snapshot === null) throw new Error("the page returned no snapshot");
            lastSnapshot = snapshot;
            return { ok: true, snapshot };
          }
          case "click": {
            const current = await requireReady();
            let x;
            let y;
            let label;
            let hitTrusted;
            if (command.ref !== undefined && command.ref !== null) {
              const target = await current.executeJavaScript(clickTargetJs(String(command.ref)));
              if (!target || target.ok !== true) throw new Error(target?.error ?? "element ref not found; take a new snapshot");
              x = target.x;
              y = target.y;
              label = target.label;
              hitTrusted = target.hitTrusted;
            } else {
              x = Number(command.x);
              y = Number(command.y);
              if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("click requires ref or x/y coordinates");
            }
            await current.executeJavaScript(cursorMoveJs(Math.round(x), Math.round(y)));
            await sleepImpl(180);
            current.focus();
            const navigationBaseline = navigationCount;
            const beforeUrl = readUrl();
            current.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
            current.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
            await current.executeJavaScript(cursorRippleJs(Math.round(x), Math.round(y)));
            const eventNavigated =
              navigationWaitMs > 0 ? await waitForNavigation(navigationWaitMs) : navigationCount > navigationBaseline;
            await sleepImpl(Number(command.waitMs ?? 120));
            const settle = await settlePage(current);
            const info = await pageInfo();
            const scroll = await current.executeJavaScript(scrollStateJs()).catch(() => undefined);
            const urlChanged = beforeUrl !== "" && info.url !== "" && beforeUrl !== info.url;
            const navigated = eventNavigated || urlChanged;
            return {
              ok: true,
              x,
              y,
              label,
              hitTrusted,
              url: info.url,
              title: info.title,
              navigated,
              scrollY: typeof scroll?.scrollY === "number" ? scroll.scrollY : undefined,
              settle,
              changed: navigated || Number(settle?.mutations ?? 0) > 0,
            };
          }
          case "type": {
            const current = await requireReady();
            const text = String(command.text ?? "");
            if (command.ref !== undefined && command.ref !== null) {
              const focus = await current.executeJavaScript(focusJs(String(command.ref)));
              if (!focus || focus.ok !== true) throw new Error(focus?.error ?? "element ref not found; take a new snapshot");
              await sleepImpl(60);
            }
            current.focus();
            let typeMethod;
            if (typeof current.insertText === "function") {
              // insertText commits through the real editing pipeline, which is
              // what controlled inputs (React/Vue) listen to; raw char events can
              // be dropped by them.
              current.insertText(text);
              typeMethod = "insertText";
            } else {
              for (const ch of text) {
                current.sendInputEvent({ type: "char", keyCode: ch });
                await sleepImpl(35);
              }
              typeMethod = "char-events";
            }
            await sleepImpl(80);
            const editable = await current.executeJavaScript(editableJs());
            if (editable?.editable !== true) {
              throw new Error("the focused element is not editable; take a snapshot and pass a textbox ref, or click the input first");
            }
            const settle = await settlePage(current);
            const info = await pageInfo();
            return {
              ok: true,
              typed: text,
              method: typeMethod,
              value: typeof editable.value === "string" ? editable.value : "",
              url: info.url,
              title: info.title,
              settle,
              changed: Number(settle?.mutations ?? 0) > 0,
            };
          }
          case "key": {
            const current = await requireReady();
            const key = String(command.key ?? "");
            if (key === "") throw new Error("key is required");
            const beforeUrl = readUrl();
            current.focus();
            current.sendInputEvent({ type: "keyDown", keyCode: key });
            if (key === "Enter") {
              // Enter's default action (implicit form submission) is a keypress;
              // a raw keyDown alone is not enough for some web apps.
              current.sendInputEvent({ type: "char", keyCode: key });
            }
            current.sendInputEvent({ type: "keyUp", keyCode: key });
            let submit;
            if (key === "Enter") {
              await sleepImpl(200);
              const info = await pageInfo();
              const urlChanged = beforeUrl !== "" && info.url !== "" && beforeUrl !== info.url;
              if (!urlChanged) {
                // Some controlled inputs swallow the synthesized Enter and never
                // submit their form; requestSubmit is the standards path.
                try {
                  submit = await current.executeJavaScript(submitFormJs());
                } catch {
                  submit = undefined;
                }
              }
            }
            const settle = await settlePage(current);
            const info = await pageInfo();
            return {
              ok: true,
              key,
              url: info.url,
              title: info.title,
              submit,
              settle,
              changed: Number(settle?.mutations ?? 0) > 0 || submit?.submitted === true,
            };
          }
          case "scroll": {
            const current = await requireReady();
            const deltaY = Number(command.deltaY ?? 400);
            if (!Number.isFinite(deltaY)) throw new Error("scroll requires a numeric deltaY");
            let x = 300;
            let y = 300;
            const viewport = lastSnapshot?.viewport;
            if (viewport) {
              x = Math.round(viewport.w / 2);
              y = Math.round(viewport.h / 2);
            }
            if (command.ref !== undefined && command.ref !== null) {
              const target = await current.executeJavaScript(clickTargetJs(String(command.ref)));
              if (target && target.ok === true) {
                x = target.x;
                y = target.y;
              }
            }
            current.sendInputEvent({ type: "mouseWheel", x, y, deltaX: 0, deltaY, canScroll: true });
            await sleepImpl(140);
            const before = await current.executeJavaScript(scrollStateJs());
            const beforeScrollY = typeof before?.scrollY === "number" ? before.scrollY : undefined;
            let state = before;
            let method = "wheel";
            if (
              deltaY !== 0 &&
              typeof beforeScrollY === "number" &&
              typeof state?.scrollY === "number" &&
              state.scrollY === beforeScrollY
            ) {
              // Synthetic wheel input is not always honored by the guest; fall
              // back to scripted scrolling so the page actually moves.
              await current.executeJavaScript(scrollFallbackJs(deltaY));
              await sleepImpl(120);
              state = await current.executeJavaScript(scrollStateJs());
              method = "script";
            }
            const settle = await settlePage(current);
            const finalScrollY = typeof state?.scrollY === "number" ? state.scrollY : undefined;
            return {
              ok: true,
              deltaY,
              method,
              scrollY: finalScrollY,
              scrollHeight: typeof state?.scrollHeight === "number" ? state.scrollHeight : undefined,
              innerHeight: typeof state?.innerHeight === "number" ? state.innerHeight : undefined,
              settle,
              changed: Number(settle?.mutations ?? 0) > 0 || (typeof beforeScrollY === "number" && typeof finalScrollY === "number" && finalScrollY !== beforeScrollY),
            };
          }
          case "wait": {
            const current = await requireReady();
            const selector = typeof command.selector === "string" && command.selector !== "" ? command.selector : undefined;
            if (selector !== undefined) {
              const timeoutMs = Number(command.ms ?? 8000);
              const started = Date.now();
              for (;;) {
                const state = await current.executeJavaScript(waitSelectorJs(selector));
                if (state && state.found === true) return { ok: true, waitedMs: Date.now() - started, selector };
                if (Date.now() - started > timeoutMs) throw new Error(`selector not found within ${timeoutMs}ms: ${selector}`);
                await sleepImpl(150);
              }
            }
            const ms = Math.max(0, Number(command.ms ?? 500));
            await sleepImpl(ms);
            return { ok: true, waitedMs: ms };
          }
          case "screenshot": {
            const current = await requireReady();
            if (typeof current.capturePage !== "function") throw new Error("capturePage is not available in this webview");
            const image = await current.capturePage();
            const dataUrl = typeof image?.toDataURL === "function" ? image.toDataURL() : undefined;
            if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
              throw new Error("capturePage did not return an image");
            }
            return { ok: true, dataUrl };
          }
          default:
            return { ok: false, error: `unknown command "${type}"` };
        }
      }

      function status() {
        let url = "";
        try {
          url = webview !== undefined && typeof webview.getURL === "function" ? webview.getURL() : "";
        } catch {
          url = "";
        }
        return { ready, hasWebview: webview !== undefined, url, title: lastSnapshot?.title ?? "" };
      }

      return { mount, ensureMounted, unmount, waitReady, handle, status, _internals: { get webview() { return webview; } } };
    }

    // ---------------------------------------------------------------------
    // Cordis client plugin
    // ---------------------------------------------------------------------

    let activeController;

    function AgentBrowserBody() {
      const containerRef = React.useRef(null);
      React.useEffect(() => {
        const controller = activeController;
        const container = containerRef.current;
        if (controller === undefined || container === null) return undefined;
        controller.ensureMounted(container).catch((error) => {
          void postDiag("panel", { phase: "body-mount-failed", error: String(error && error.message ? error.message : error) });
        });
        return () => controller.unmount();
      }, []);
      return h("div", {
        ref: containerRef,
        style: { width: "100%", height: "100%", display: "flex", background: "#0b0d12" },
      });
    }

    /** Bearer auth is deliberately a header, never a query parameter: URLs are
     * logged and shown in process listings. */
    function authHeaders(extra = {}) {
      return { authorization: `Bearer ${TOKEN}`, ...extra };
    }

    async function postDiag(tag, value) {
      try {
        await fetch(`${BASE}/diag`, {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ tag, value }),
          signal: AbortSignal.timeout(4000),
        });
      } catch {
        // Diagnostics are best-effort.
      }
    }

    /** Combine a request timeout with the plugin's lifetime signal. */
    function fetchSignal(lifetime, timeoutMs) {
      const timeout = AbortSignal.timeout(timeoutMs);
      if (lifetime === undefined) return timeout;
      return typeof AbortSignal.any === "function" ? AbortSignal.any([timeout, lifetime]) : lifetime;
    }

    function createBridgeLoop(controller, lifetime) {
      const clientId = `bc-${Math.random().toString(36).slice(2, 10)}`;
      return (async () => {
        let backoff = 500;
        while (!lifetime.aborted) {
          try {
            const response = await fetch(`${BASE}/hello`, { headers: authHeaders(), signal: fetchSignal(lifetime, 4000) });
            if (response.ok) break;
          } catch {
            if (lifetime.aborted) return;
          }
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 5000);
        }
        if (lifetime.aborted) return;
        void postDiag("panel", { phase: "bridge-ready", clientId });
        const heartbeat = setInterval(() => {
          if (!lifetime.aborted) void postDiag("panel", { phase: "heartbeat", clientId });
        }, 30_000);
        lifetime.addEventListener("abort", () => clearInterval(heartbeat), { once: true });
        backoff = 500;
        while (!lifetime.aborted) {
          try {
            const response = await fetch(`${BASE}/poll?client=${encodeURIComponent(clientId)}`, {
              headers: authHeaders(),
              signal: fetchSignal(lifetime, 25000),
            });
            if (!response.ok) throw new Error(`poll: HTTP ${response.status}`);
            const message = await response.json();
            backoff = 500;
            if (message && typeof message.id === "string" && message.cmd) {
              let result;
              try {
                result = await controller.handle(message.cmd);
              } catch (error) {
                result = { ok: false, error: String(error && error.message ? error.message : error) };
              }
              await fetch(`${BASE}/result?id=${encodeURIComponent(message.id)}`, {
                method: "POST",
                headers: authHeaders({ "content-type": "application/json" }),
                body: JSON.stringify(result),
                signal: fetchSignal(lifetime, 4000),
              });
            } else {
              // The Host answers immediately only for a stale client instance;
              // do not busy-loop on it.
              await sleep(200);
            }
          } catch (error) {
            if (lifetime.aborted) return;
            void postDiag("panel", { phase: "poll-error", error: String(error && error.message ? error.message : error) });
            await sleep(backoff);
            backoff = Math.min(backoff * 2, 5000);
          }
        }
      })();
    }

    return {
      inject: ["slots", "locale", "layout", "sidebarRight", "sidebarRightTabs"],
      apply(ctx) {
        try {
          let fallbackHost;
          const ensureFallback = () => {
            const doc = globalThis.document;
            if (doc === undefined) return undefined;
            if (fallbackHost !== undefined && fallbackHost.isConnected === true) return fallbackHost.querySelector("[data-agent-browser-body]");
            fallbackHost = doc.createElement("div");
            fallbackHost.id = "dsh-agent-browser-floating";
            fallbackHost.style.cssText =
              "position:fixed;right:24px;top:72px;width:min(480px,42vw);height:72vh;z-index:2147483000;display:flex;flex-direction:column;background:#0b0d12;border:1px solid #2a2f3a;border-radius:10px;box-shadow:0 18px 48px rgba(0,0,0,.55);overflow:hidden";
            const header = doc.createElement("div");
            header.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 10px;background:#11151d;color:#c9d1d9;font:12px system-ui;border-bottom:1px solid #222836";
            const title = doc.createElement("span");
            title.textContent = "Agent Browser (floating)";
            title.style.cssText = "flex:1";
            const hide = doc.createElement("button");
            hide.type = "button";
            hide.textContent = "×";
            hide.title = "Hide";
            hide.style.cssText = "background:transparent;border:0;color:#c9d1d9;font-size:16px;cursor:pointer;line-height:1";
            hide.addEventListener("click", () => {
              fallbackHost.style.display = "none";
            });
            header.append(title, hide);
            const body = doc.createElement("div");
            body.setAttribute("data-agent-browser-body", "1");
            body.style.cssText = "flex:1;display:flex;min-height:0";
            fallbackHost.append(header, body);
            doc.body.appendChild(fallbackHost);
            return body;
          };
          const controller = createPanelController({
            document: globalThis.document,
            dshDesktop: globalThis.dshDesktop,
            ensureFallback,
            ensurePanel: () => {
              // A collapsed right sidebar can accept openTab without mounting the
              // body; expand it first so the webview actually becomes ready.
              const info = { hasLayout: typeof ctx.layout?.openRightbar === "function", hasOpenTab: typeof ctx.sidebarRight?.openTab === "function" };
              try {
                ctx.layout?.openRightbar?.(true, false);
              } catch (error) {
                info.layoutError = String(error && error.message ? error.message : error);
              }
              try {
                ctx.sidebarRight.openTab(TAB_KIND);
                info.opened = TAB_KIND;
              } catch (error) {
                info.openError = String(error && error.message ? error.message : error);
              }
              void postDiag("panel", { phase: "ensure-panel", ...info });
            },
            diag: postDiag,
          });
          activeController = controller;
          const lifetime = new AbortController();
          ctx.effect(() => () => {
            void postDiag("panel", { phase: "plugin-dispose" });
            lifetime.abort();
            controller.unmount();
          }, "sidebar-browser-control.panel");
          ctx.effect(
            () =>
              ctx.sidebarRightTabs.register({
                id: TAB_ID,
                kind: TAB_KIND,
                multiple: false,
                priority: "extension",
                title: () => "Agent Browser",
              }),
            "sidebar-browser-control.tab-type",
          );
          ctx.effect(
            () =>
              ctx.slots.inject("sidebar.right.pane.tab", () =>
                ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, AgentBrowserBody),
              ),
            "sidebar-browser-control.tab-body",
          );
          // Fire-and-forget: never return this promise from apply (boot contract).
          const loop = createBridgeLoop(controller, lifetime.signal);
          loop.catch((error) => {
            void postDiag("panel", { phase: "loop-stopped", error: String(error && error.stack ? error.stack : error) });
          });
        } catch (error) {
          void postDiag("panel", { phase: "apply-failed", error: String(error && error.message ? error.message : error) });
        }
      },
      __test: { createPanelController },
    };
  },
});
