window.__ModuleLoader__.load({
  id: "@local/dsh-sidebar-browser-control",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const PORT = 47834;
    const TOKEN = "dsh-browser-control-local";
    const BASE = `http://127.0.0.1:${PORT}`;
    // Keep well under the bridge's 64MB /result body limit; a full-page PNG of a
    // real site can reach several MB base64, so fail with guidance instead of
    // letting the bridge reject the body and the Host report a bare timeout.
    const MAX_RESULT_CHARS = 48 * 1024 * 1024;
    // Stable tab identity. An earlier build minted a random suffix per module
    // load to dodge "stale bodiless tab" reuse, but that leaves one dead tab per
    // restart in the persisted right-sidebar layout (the black tabs users see)
    // and made every open create yet another tab. A stable id/kind lets DSH
    // reuse the same tab and remount its body after a reload; legacy suffixed
    // tabs are closed on startup (see staleTabIds/closeStaleTabs).
    const TAB_ID = "@local/dsh-sidebar-browser-control";
    const TAB_KIND = "agent-browser";
    const LEGACY_TAB_ID_PREFIX = "@local/dsh-sidebar-browser-control-";
    const LEGACY_TAB_KIND_PREFIX = "agent-browser-";
    const WORKSPACE_KEY = "agent-browser";
    const DEFAULT_WAIT_MS = 10000;

    /**
     * Tab ids that belong to older builds of this plugin and should be closed.
     * Kept pure so the persisted-layout cleanup is unit-testable.
     */
    function staleTabIds(tabs, current = { id: TAB_ID, kind: TAB_KIND }) {
      const list = Array.isArray(tabs) ? tabs : [];
      const ids = [];
      for (const tab of list) {
        const id = typeof tab?.id === "string" ? tab.id : typeof tab?.tabId === "string" ? tab.tabId : undefined;
        const kind = typeof tab?.kind === "string" ? tab.kind : undefined;
        if (id === undefined) continue;
        const legacyId = id !== current.id && id.startsWith(LEGACY_TAB_ID_PREFIX);
        const legacyKind = kind !== undefined && kind !== current.kind && kind.startsWith(LEGACY_TAB_KIND_PREFIX);
        if (legacyId || legacyKind) ids.push(id);
      }
      return ids;
    }

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
    // QA page scripts (2026-10-26). Same convention: the marker comment is
    // what the unit tests assert, and every script returns plain JSON.
    // ---------------------------------------------------------------------

    /** Actual guest viewport numbers after a resize (the real sizes, not fakes). */
    function viewportInfoJs() {
      return `(() => {
        // __dshAgentViewportInfo
        const doc = document.scrollingElement || document.documentElement;
        return {
          innerWidth: Math.round(window.innerWidth || 0),
          innerHeight: Math.round(window.innerHeight || 0),
          devicePixelRatio: window.devicePixelRatio || 1,
          // The layout width the content actually gets: with the classic
          // (non-overlay) scrollbar this is smaller than innerWidth by the
          // scrollbar width.
          contentWidth: Math.round((document.documentElement ? document.documentElement.clientWidth : 0) || (doc ? doc.clientWidth : 0) || 0),
          scrollWidth: Math.round(doc.scrollWidth || 0),
          scrollHeight: Math.round(doc.scrollHeight || 0)
        };
      })()`;
    }

    /** Structured layout/image/font/selector measurements for action=metrics. */
    function metricsJs(selectors = [], includeOverflow = true) {
      return `(() => {
        // __dshAgentMetrics
        const wanted = ${JSON.stringify(Array.isArray(selectors) ? selectors.map(String) : [])};
        const includeOverflow = ${includeOverflow === true};
        const doc = document.scrollingElement || document.documentElement;
        const describe = (el) => {
          if (!el || !el.tagName) return '?';
          const tag = el.tagName.toLowerCase();
          const id = el.id ? '#' + el.id : '';
          const cls = typeof el.className === 'string' && el.className.trim() !== ''
            ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
            : '';
          return tag + id + cls;
        };
        const overflow = [];
        if (includeOverflow && document.body) {
          for (const el of document.body.querySelectorAll('*')) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.right > window.innerWidth + 1) {
              overflow.push({
                selector: describe(el),
                tag: el.tagName.toLowerCase(),
                left: Math.round(rect.left),
                right: Math.round(rect.right),
                width: Math.round(rect.width),
                overshoot: Math.round(rect.right - window.innerWidth)
              });
            }
          }
          overflow.sort((left, right) => right.overshoot - left.overshoot);
        }
        const images = [...document.images];
        const failedSrc = [];
        let loaded = 0;
        let failed = 0;
        for (const img of images) {
          if (img.complete && img.naturalWidth > 0) loaded += 1;
          else if (img.complete && img.naturalWidth === 0) {
            failed += 1;
            failedSrc.push(String(img.currentSrc || img.src || '').slice(0, 500));
          }
        }
        const fonts = document.fonts
          ? { status: String(document.fonts.status || 'unknown'), size: Number(document.fonts.size || 0) }
          : { status: 'unsupported', size: 0 };
        const measured = [];
        for (const selector of wanted) {
          try {
            const el = document.querySelector(selector);
            if (!el) {
              measured.push({ selector, found: false });
              continue;
            }
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            const tag = el.tagName.toLowerCase();
            measured.push({
              selector,
              found: true,
              tag,
              rect: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
              natural: tag === 'img' ? { width: Number(el.naturalWidth || 0), height: Number(el.naturalHeight || 0) } : undefined,
              display: style ? style.display : undefined,
              visibility: style ? style.visibility : undefined
            });
          } catch (error) {
            measured.push({ selector, found: false, error: String(error && error.message ? error.message : error) });
          }
        }
        return {
          title: document.title,
          url: location.href,
          viewport: {
            width: Math.round(window.innerWidth || 0),
            height: Math.round(window.innerHeight || 0),
            devicePixelRatio: window.devicePixelRatio || 1,
            scrollY: Math.round(window.scrollY || doc.scrollTop || 0)
          },
          document: {
            scrollWidth: Math.round(doc.scrollWidth || 0),
            scrollHeight: Math.round(doc.scrollHeight || 0),
            contentWidth: Math.round(document.body ? Math.max(document.body.scrollWidth || 0, document.body.offsetWidth || 0) : 0)
          },
          overflow: overflow.slice(0, 20),
          overflowCount: overflow.length,
          images: { total: images.length, loaded, failed, failedSrc: failedSrc.slice(0, 10) },
          fonts,
          selectors: measured
        };
      })()`;
    }

    /**
     * In-page polling wait: selector / text / images / fonts / networkIdle.
     * networkIdle is an approximation (resource-entry count + DOM mutations
     * quiet for idleMs) because a renderer webview has no network events.
     */
    function waitConditionsJs(conditions = {}, timeoutMs = 8000) {
      return `(async () => {
        // __dshAgentWait
        const conditions = ${JSON.stringify(conditions)};
        const timeoutMs = ${Number(timeoutMs)};
        const started = performance.now();
        const idleMs = Math.max(0, Number(conditions.idleMs ?? 500));
        let lastActivity = Date.now();
        let resourceCount = 0;
        try {
          resourceCount = performance.getEntriesByType ? performance.getEntriesByType('resource').length : 0;
        } catch (error) {
          resourceCount = 0;
        }
        let observer;
        try {
          if (typeof MutationObserver === 'function' && document.documentElement) {
            observer = new MutationObserver(() => { lastActivity = Date.now(); });
            observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
          }
        } catch (error) {
          observer = undefined;
        }
        const inspect = () => {
          const result = {};
          if (conditions.selector) {
            try { result.selector = document.querySelector(conditions.selector) !== null; }
            catch (error) { result.selector = false; result.selectorError = String(error && error.message ? error.message : error); }
          }
          if (conditions.text) {
            const bodyText = document.body ? String(document.body.innerText || '') : '';
            result.text = bodyText.includes(conditions.text);
          }
          if (conditions.images) {
            result.images = [...document.images].every((img) => img.complete === true);
          }
          if (conditions.fonts) {
            result.fonts = !!(document.fonts && document.fonts.status === 'loaded');
          }
          if (conditions.networkIdle) {
            let count = resourceCount;
            try { count = performance.getEntriesByType ? performance.getEntriesByType('resource').length : resourceCount; } catch (error) { count = resourceCount; }
            if (count !== resourceCount) {
              resourceCount = count;
              lastActivity = Date.now();
            }
            result.networkIdle = Date.now() - lastActivity >= idleMs;
          }
          return result;
        };
        const met = (state) => {
          for (const [key, value] of Object.entries(state)) {
            if (key === 'selectorError') continue;
            if (value !== true) return false;
          }
          return true;
        };
        let state = inspect();
        while (!met(state) && performance.now() - started < timeoutMs) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          state = inspect();
        }
        if (observer) observer.disconnect();
        return { met: met(state), waitedMs: Math.round(performance.now() - started), conditions: state };
      })()`;
    }

    /** Scroll an element (ref or selector) into view, then report real positions. */
    function scrollIntoViewJs(target = {}) {
      return `(async () => {
        // __dshAgentScrollIntoView
        const wanted = ${JSON.stringify(target)};
        let el;
        if (wanted.ref) {
          const refs = window.__dshAgentRefs;
          el = refs ? refs.get(wanted.ref) : undefined;
          if (!el) return { ok: false, error: 'element ref ' + wanted.ref + ' is not in the current snapshot; take a new snapshot' };
        } else {
          try { el = document.querySelector(wanted.selector); }
          catch (error) { return { ok: false, error: 'invalid selector: ' + String(error && error.message ? error.message : error) }; }
          if (!el) return { ok: false, error: 'selector not found: ' + String(wanted.selector) };
        }
        if (!el.isConnected) return { ok: false, error: 'the target left the document; take a new snapshot' };
        el.scrollIntoView({ block: wanted.block || 'center', inline: 'nearest', behavior: 'instant' });
        const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        let lastScrollY = -1;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await nextFrame();
          const now = Math.round(window.scrollY || 0);
          if (now === lastScrollY) break;
          lastScrollY = now;
        }
        const doc = document.scrollingElement || document.documentElement;
        const rect = el.getBoundingClientRect();
        const innerWidth = Math.round(window.innerWidth || 0);
        const innerHeight = Math.round(window.innerHeight || 0);
        return {
          ok: true,
          tag: el.tagName.toLowerCase(),
          label: String(el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
          scrollY: Math.round(window.scrollY || doc.scrollTop || 0),
          scrollHeight: Math.round(doc.scrollHeight || 0),
          innerHeight,
          inViewport: rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth,
          rect: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
          target: { ref: wanted.ref || undefined, selector: wanted.selector || undefined }
        };
      })()`;
    }

    /** Page-side probe for action=logs: failed images + suspicious resources. */
    function logsProbeJs() {
      return `(() => {
        // __dshAgentLogsProbe
        const failedImages = [];
        let imageCount = 0;
        for (const img of document.images) {
          imageCount += 1;
          if (img.complete && img.naturalWidth === 0) {
            failedImages.push({ src: String(img.currentSrc || img.src || '').slice(0, 500), alt: String(img.alt || '').slice(0, 120) });
          }
        }
        let entries = [];
        try { entries = performance.getEntriesByType ? performance.getEntriesByType('resource') : []; } catch (error) { entries = []; }
        // A zero transferSize with non-zero duration usually means a failed or
        // cross-origin-restricted resource; HTTP status codes are not exposed.
        const suspicious = entries.filter((entry) => entry && entry.transferSize === 0 && entry.duration > 0);
        const resources = suspicious.slice(-20).map((entry) => ({
          name: String(entry.name || '').slice(0, 500),
          initiatorType: entry.initiatorType || '?',
          duration: Math.round(entry.duration || 0),
          transferSize: entry.transferSize,
          decodedBodySize: entry.decodedBodySize
        }));
        return { imageCount, failedImages: failedImages.slice(0, 20), resourceCount: entries.length, resources };
      })()`;
    }

    /** Hide/show the injected virtual cursor so screenshots have no overlay. */
    function cursorVisibilityJs(hide) {
      return `(() => {
        // __dshAgentCursorVisibility
        const host = document.getElementById(${JSON.stringify(CURSOR_HOST_ID)});
        if (!host) return { found: false, hidden: ${hide === true} };
        const previous = host.style.display;
        host.style.display = ${hide === true} ? 'none' : (previous === 'none' ? '' : previous);
        return { found: true, hidden: ${hide === true}, previous };
      })()`;
    }

    /**
     * Hide/show the page scrollbars while a full-page capture is stitched.
     * Without this every viewport slice carries a scrollbar strip, and the
     * stitched image is exactly viewportWidth wide only because of it.
     */
    function scrollbarVisibilityJs(hide) {
      return `(() => {
        // __dshAgentScrollbarVisibility
        const ID = '__dshAgentHideScrollbars';
        const existing = document.getElementById(ID);
        if (${hide === true}) {
          if (existing) return { hidden: true, created: false };
          const style = document.createElement('style');
          style.id = ID;
          style.textContent = 'html{scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important}';
          (document.head || document.documentElement).appendChild(style);
          return { hidden: true, created: true };
        }
        if (existing) { existing.remove(); return { hidden: false, removed: true }; }
        return { hidden: false, removed: false };
      })()`;
    }

    /** Measure an element for a capturePage(rect) element screenshot. */
    function screenshotTargetJs(target = {}) {
      return `(async () => {
        // __dshAgentScreenshotTarget
        const wanted = ${JSON.stringify(target)};
        let el;
        if (wanted.ref) {
          const refs = window.__dshAgentRefs;
          el = refs ? refs.get(wanted.ref) : undefined;
          if (!el) return { ok: false, error: 'element ref ' + wanted.ref + ' is not in the current snapshot; take a new snapshot' };
        } else {
          try { el = document.querySelector(wanted.selector); }
          catch (error) { return { ok: false, error: 'invalid selector: ' + String(error && error.message ? error.message : error) }; }
          if (!el) return { ok: false, error: 'selector not found: ' + String(wanted.selector) };
        }
        if (!el.isConnected) return { ok: false, error: 'the target left the document; take a new snapshot' };
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        let lastScrollY = -1;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await nextFrame();
          const now = Math.round(window.scrollY || 0);
          if (now === lastScrollY) break;
          lastScrollY = now;
        }
        const doc = document.scrollingElement || document.documentElement;
        const rect = el.getBoundingClientRect();
        const viewport = {
          width: Math.round(window.innerWidth || 0),
          height: Math.round(window.innerHeight || 0),
          devicePixelRatio: window.devicePixelRatio || 1
        };
        const scrollX = Math.round(window.scrollX || 0);
        const scrollY = Math.round(window.scrollY || doc.scrollTop || 0);
        const clamp = (value, max) => Math.max(0, Math.min(Math.round(value), Math.max(0, max)));
        const x = clamp(rect.left, viewport.width);
        const y = clamp(rect.top, viewport.height);
        const width = clamp(rect.right, viewport.width) - x;
        const height = clamp(rect.bottom, viewport.height) - y;
        if (width <= 0 || height <= 0) {
          return {
            ok: false,
            error: 'the target is outside the visible viewport; scroll it into view first',
            viewport,
            rect: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
          };
        }
        return {
          ok: true,
          viewport,
          rect: { x, y, width, height },
          clipped: width < Math.round(rect.width) || height < Math.round(rect.height),
          // Page-space box of the whole element (used by the tall-element
          // scroll-stitch): viewport coordinates shift when scrollbars hide or
          // the page scrolls, page coordinates do not.
          full: {
            x: Math.round(rect.left + scrollX),
            y: Math.round(rect.top + scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          scrollX,
          scrollY,
          target: {
            tag: el.tagName.toLowerCase(),
            label: String(el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 80)
          }
        };
      })()`;
    }

    /**
     * Rewrite one media query so a width condition stands in for
     * `(prefers-color-scheme: …)`:
     * - true  → `(min-width: 0px)`      (always matches, even at width 0)
     * - false → `(min-width: 100000px)` (never matches)
     * Other conditions (media types, and/not/only, commas) are left intact, so
     * combinations evaluate with the real matchMedia engine.
     *
     * Pure function: also used inside the generated page script below, so its
     * behaviour is unit-testable without a browser.
     */
    function rewriteColorSchemeQuery(query, scheme) {
      const text = String(query ?? "");
      if (scheme !== "light" && scheme !== "dark") return { query: text, changed: false };
      let changed = false;
      const rewritten = text.replace(/\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/giu, (_match, wanted) => {
        changed = true;
        const target = String(wanted).toLowerCase() === "dark" ? "dark" : "light";
        return target === scheme ? "(min-width: 0px)" : "(min-width: 100000px)";
      });
      return { query: changed ? rewritten : text, changed };
    }

    /**
     * Best-effort prefers-color-scheme emulation for the guest page:
     * 1. wrap window.matchMedia for color-scheme queries (width-condition stand-in);
     * 2. rewrite same-origin @media rules containing prefers-color-scheme to
     *    `all` / `not all` (reversible; nested group rules included);
     * 3. re-scan late-loading stylesheets via MutationObserver + a short poll;
     * 4. `auto` restores native matchMedia and the original media texts.
     * Cross-origin stylesheets are unreadable and reported as such.
     */
    function emulateJs(scheme) {
      const rewriteSource = rewriteColorSchemeQuery.toString();
      return `(() => {
        // __dshAgentEmulate
        const SCHEME = ${JSON.stringify(scheme)};
        const rewrite = ${rewriteSource};
        const COLOR_SCHEME = /prefers-color-scheme/i;
        const state = (window.__dshAgentEmulation = window.__dshAgentEmulation || {});
        if (!Array.isArray(state.patched)) state.patched = [];
        if (!Array.isArray(state.lists)) state.lists = [];
        if (state.installed !== true) {
          state.installed = true;
          state.nativeMatchMedia = typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : null;
          if (state.nativeMatchMedia) {
            window.matchMedia = function (query) {
              const text = String(query);
              if (!COLOR_SCHEME.test(text)) return state.nativeMatchMedia(text);
              const wrapper = {
                media: text,
                matches: false,
                onchange: null,
                __listeners: [],
                addEventListener(type, listener) {
                  if (type === 'change' && typeof listener === 'function') this.__listeners.push(listener);
                },
                removeEventListener(type, listener) {
                  const index = this.__listeners.indexOf(listener);
                  if (index >= 0) this.__listeners.splice(index, 1);
                },
                addListener(listener) { this.addEventListener('change', listener); },
                removeListener(listener) { this.removeEventListener('change', listener); },
                __recompute() {
                  const forced = window.__dshAgentEmulation && window.__dshAgentEmulation.scheme;
                  const next = forced === 'light' || forced === 'dark'
                    ? !!state.nativeMatchMedia(rewrite(text, forced).query).matches
                    : !!state.nativeMatchMedia(text).matches;
                  if (next !== this.matches) {
                    this.matches = next;
                    const event = { matches: next, media: text, target: this };
                    for (const listener of [...this.__listeners]) {
                      try { listener(event); } catch (error) {}
                    }
                  }
                  return next;
                }
              };
              wrapper.__recompute();
              state.lists.push(wrapper);
              return wrapper;
            };
          }
        }
        // -----------------------------------------------------------------
        // DOM fallback (0.2.4): <picture><source media="…prefers-color-scheme…">
        // and <link rel=stylesheet media="…"> are resolved by the resource
        // loader, not by CSSOM or the matchMedia shim; a rewritten stylesheet
        // cannot reroute them (GitHub's themed-picture lives inside an open
        // shadow root). Re-pick the source in the DOM itself, walking the
        // document and every open shadowRoot under a node budget so a huge
        // page cannot wedge the call. Every patch stores its original value
        // for full restore on scheme=? or auto.
        // -----------------------------------------------------------------
        const DOM_NODE_LIMIT = 6000;
        if (!Array.isArray(state.pictures)) state.pictures = [];
        if (!Array.isArray(state.links)) state.links = [];
        const setOrRemove = (el, name, value) => {
          if (value === undefined || value === null) { try { el.removeAttribute(name); } catch (error) {} }
          else { try { el.setAttribute(name, value); } catch (error) {} }
        };
        const evaluateMedia = (text) => {
          if (!state.nativeMatchMedia) return null;
          try { return !!state.nativeMatchMedia(rewrite(text, SCHEME).query).matches; } catch (error) { return null; }
        };
        const restoreDomPatches = () => {
          let restored = 0;
          for (const entry of state.pictures) {
            try {
              // Restore the <source> media first: re-arming them makes the
              // browser re-run picture selection with the restored img attrs.
              if (Array.isArray(entry.sources)) {
                for (const source of entry.sources) {
                  if (source && source.el) setOrRemove(source.el, 'media', source.media);
                }
              }
              setOrRemove(entry.img, 'srcset', entry.srcset);
              setOrRemove(entry.img, 'src', entry.src);
              restored += 1;
            } catch (error) {}
          }
          state.pictures = [];
          for (const entry of state.links) {
            try { setOrRemove(entry.link, 'media', entry.media); restored += 1; } catch (error) {}
          }
          state.links = [];
          return restored;
        };
        const chooseSource = (sources) => {
          for (const source of sources) {
            if (!source || typeof source.getAttribute !== 'function') continue;
            let media;
            try { media = source.getAttribute('media'); } catch (error) { media = null; }
            const text = String(media ?? '').trim();
            if (text === '') return source;
            if (COLOR_SCHEME.test(text)) {
              if (evaluateMedia(text) === true) return source;
            } else if (state.nativeMatchMedia) {
              try { if (state.nativeMatchMedia(text).matches) return source; } catch (error) {}
            }
          }
          return undefined;
        };
        const patchDom = () => {
          const dom = { picturesPatched: 0, linkMediaPatched: 0, visited: 0, limitReached: false };
          const pictures = [];
          const links = [];
          const scanRoot = (root) => {
            if (dom.visited >= DOM_NODE_LIMIT) return;
            try { for (const picture of root.querySelectorAll('picture')) pictures.push(picture); } catch (error) {}
            try {
              for (const link of root.querySelectorAll('link[media]')) {
                dom.visited += 1;
                if (dom.visited >= DOM_NODE_LIMIT) { dom.limitReached = true; return; }
                links.push(link);
              }
            } catch (error) {}
          };
          const walk = (root) => {
            scanRoot(root);
            if (dom.visited >= DOM_NODE_LIMIT) return;
            let elements;
            try { elements = root.querySelectorAll('*'); } catch (error) { return; }
            for (const el of elements) {
              dom.visited += 1;
              if (dom.visited >= DOM_NODE_LIMIT) { dom.limitReached = true; return; }
              if (el && el.shadowRoot) walk(el.shadowRoot);
            }
          };
          try { walk(document); } catch (error) {}
          for (const picture of pictures) {
            const img = (() => { try { return picture.querySelector('img'); } catch (error) { return undefined; } })();
            if (!img || typeof img.getAttribute !== 'function' || typeof img.setAttribute !== 'function') continue;
            const sources = [];
            try { for (const source of picture.querySelectorAll('source')) sources.push(source); } catch (error) {}
            const chosen = chooseSource(sources);
            let nextSrcset;
            let nextSrc;
            if (chosen !== undefined) {
              try {
                const sourceSrcset = chosen.getAttribute('srcset');
                const sourceSrc = chosen.getAttribute('src');
                nextSrcset = typeof sourceSrcset === 'string' && sourceSrcset.trim() !== '' ? sourceSrcset : undefined;
                nextSrc = nextSrcset === undefined && typeof sourceSrc === 'string' && sourceSrc.trim() !== '' ? sourceSrc : undefined;
              } catch (error) { continue; }
              if (nextSrcset === undefined && nextSrc === undefined) continue;
            } else {
              // No <source> matches the emulated scheme (e.g. only a dark
              // source on a dark-OS machine): fall back to the img's own src,
              // which is how a light-preferring browser would render it.
              try {
                const fallback = img.getAttribute('src');
                if (typeof fallback !== 'string' || fallback.trim() === '') continue;
                nextSrc = fallback;
              } catch (error) { continue; }
            }
            let saved;
            try {
              saved = { img, srcset: img.getAttribute('srcset'), src: img.getAttribute('src'), sources: [] };
            } catch (error) { continue; }
            // Neutralise every <source>: while a source's media matches the
            // REAL browser preference it overrides the img's own src/srcset,
            // so the emulated variant could never win (the exact bug seen on a
            // dark-OS machine). Restoring the media values re-arms them.
            for (const source of sources) {
              let media = null;
              try { media = source.getAttribute('media'); } catch (error) { media = null; }
              saved.sources.push({ el: source, media });
              try { source.setAttribute('media', 'not all'); } catch (error) {}
            }
            if (nextSrcset !== undefined) {
              setOrRemove(img, 'srcset', nextSrcset);
              setOrRemove(img, 'src', saved.src);
            } else {
              setOrRemove(img, 'srcset', undefined);
              setOrRemove(img, 'src', nextSrc);
            }
            state.pictures.push(saved);
            dom.picturesPatched += 1;
          }
          for (const link of links) {
            let media = null;
            try { media = link.getAttribute('media'); } catch (error) { continue; }
            const text = String(media ?? '');
            if (!COLOR_SCHEME.test(text)) continue;
            if (typeof link.setAttribute !== 'function') continue;
            const verdict = evaluateMedia(text);
            setOrRemove(link, 'media', verdict === true ? 'all' : 'not all');
            state.links.push({ link, media: text });
            dom.linkMediaPatched += 1;
          }
          return dom;
        };
        const restoredDomCount = restoreDomPatches();
        const restoredCount = state.patched.length;
        for (const entry of state.patched) {
          try { entry.rule.media.mediaText = entry.original; } catch (error) {}
        }
        state.patched = [];
        const sheets = { scanned: 0, patched: 0, crossOrigin: 0, unreadable: 0 };
        const match = (query) => {
          try { return !!(state.nativeMatchMedia && state.nativeMatchMedia(query).matches); } catch (error) { return false; }
        };
        const normalizeRule = (rule) => {
          try {
            if (!rule || typeof rule !== 'object') return;
            const media = rule.media;
            if (media && typeof media.mediaText === 'string' && COLOR_SCHEME.test(media.mediaText)) {
              const original = media.mediaText;
              const shouldApply = match(rewrite(original, SCHEME).query);
              media.mediaText = shouldApply ? 'all' : 'not all';
              state.patched.push({ rule, original });
              sheets.patched += 1;
            }
            const nested = rule.cssRules;
            if (nested && nested.length) {
              for (const child of nested) normalizeRule(child);
            }
          } catch (error) {
            sheets.unreadable += 1;
          }
        };
        const scan = () => {
          let list;
          try { list = document.styleSheets; } catch (error) { return; }
          for (const sheet of Array.from(list || [])) {
            sheets.scanned += 1;
            let rules;
            try { rules = sheet.cssRules; }
            catch (error) { sheets.crossOrigin += 1; continue; }
            if (!rules) continue;
            for (const rule of Array.from(rules)) normalizeRule(rule);
          }
        };
        let domResult;
        const rescan = () => {
          scan();
          if (SCHEME === 'light' || SCHEME === 'dark') {
            // Restore then re-patch: late-added pictures/links get picked and
            // the counters stay per-call.
            restoreDomPatches();
            domResult = patchDom();
          }
        };
        if (SCHEME === 'light' || SCHEME === 'dark') {
          state.scheme = SCHEME;
          if (document.documentElement && document.documentElement.style) document.documentElement.style.colorScheme = SCHEME;
          rescan();
          if (typeof MutationObserver === 'function' && document.documentElement) {
            if (!state.observer) {
              state.observer = new MutationObserver(() => {
                if (state.scanTimer) return;
                state.scanTimer = setTimeout(() => { state.scanTimer = undefined; rescan(); }, 120);
              });
              state.observer.observe(document.documentElement, { subtree: true, childList: true });
            }
          }
          if (!state.poll) {
            let remaining = 20;
            state.poll = setInterval(() => {
              rescan();
              remaining -= 1;
              if (remaining <= 0) { clearInterval(state.poll); state.poll = undefined; }
            }, 500);
          }
        } else {
          state.scheme = 'auto';
          if (state.nativeMatchMedia) window.matchMedia = state.nativeMatchMedia;
          if (state.observer) { state.observer.disconnect(); state.observer = undefined; }
          if (state.poll) { clearInterval(state.poll); state.poll = undefined; }
          if (document.documentElement && document.documentElement.style) document.documentElement.style.colorScheme = '';
        }
        for (const wrapper of state.lists) {
          try { wrapper.__recompute(); } catch (error) {}
        }
        const verify = (query) => {
          try { return window.matchMedia ? !!window.matchMedia(query).matches : undefined; } catch (error) { return undefined; }
        };
        return {
          scheme: SCHEME,
          matchMediaOverridden: !!(state.nativeMatchMedia && state.installed && (SCHEME === 'light' || SCHEME === 'dark')),
          colorScheme: document.documentElement && document.documentElement.style ? String(document.documentElement.style.colorScheme || '') : null,
          sheets,
          mediaRules: { patched: sheets.patched, restored: restoredCount },
          dom: {
            picturesPatched: domResult?.picturesPatched ?? 0,
            linkMediaPatched: domResult?.linkMediaPatched ?? 0,
            restored: restoredDomCount,
            visited: domResult?.visited ?? 0,
            limitReached: domResult?.limitReached === true,
          },
          verified: {
            darkMatches: verify('(prefers-color-scheme: dark)'),
            lightMatches: verify('(prefers-color-scheme: light)')
          }
        };
      })()`;
    }

    /** Render self-contained HTML over the current document context. */
    function setContentJs(html) {
      return `(async () => {
        // __dshAgentSetContent
        const HTML = ${JSON.stringify(String(html ?? ""))};
        document.open();
        document.write(HTML);
        document.close();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (document.fonts && document.fonts.ready) {
          try { await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 500))]); } catch (error) {}
        }
        const doc = document.scrollingElement || document.documentElement;
        return {
          title: document.title,
          url: location.href,
          readyState: document.readyState,
          viewport: {
            width: Math.round(window.innerWidth || 0),
            height: Math.round(window.innerHeight || 0),
            devicePixelRatio: window.devicePixelRatio || 1
          },
          scrollHeight: Math.round(doc.scrollHeight || 0)
        };
      })()`;
    }

    // ---------------------------------------------------------------------
    // Plain helpers shared by the controller and the unit tests.
    // ---------------------------------------------------------------------

    /** Base64-encode bytes without Buffer (the renderer may not expose it). */
    function bytesToBase64(bytes) {
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      let output = "";
      for (let index = 0; index < bytes.length; index += 3) {
        const first = bytes[index];
        const second = index + 1 < bytes.length ? bytes[index + 1] : undefined;
        const third = index + 2 < bytes.length ? bytes[index + 2] : undefined;
        output += alphabet[first >> 2];
        output += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)];
        output += second === undefined ? "=" : alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)];
        output += third === undefined ? "=" : alphabet[third & 63];
      }
      return output;
    }

    /**
     * Extract a PNG data URL from an Electron NativeImage.
     *
     * The DSH renderer is sandboxed (no Node integration): `nativeImage.toPNG()`
     * throws "Buffer is not available for the current Context" there because
     * Electron cannot allocate a Node Buffer in the page world (observed on a
     * real session, 2026-10-26). `toDataURL()` is context-safe and must be
     * preferred; toPNG() stays as a fallback for contexts that do have Node.
     */
    function nativeImageToPngDataUrl(image) {
      if (image === undefined || image === null) throw new Error("capturePage did not return an image");
      if (typeof image.toDataURL === "function") {
        try {
          const dataUrl = image.toDataURL();
          if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) return dataUrl;
        } catch {
          // Fall through to the Buffer-based paths.
        }
      }
      if (typeof image.toPNG === "function") {
        try {
          const bytes = image.toPNG();
          if (bytes && bytes.length > 0) return `data:image/png;base64,${bytesToBase64(bytes)}`;
        } catch {
          // Sandboxed renderer without Buffer.
        }
      }
      throw new Error("capturePage did not return an image");
    }

    /** Convert a PNG data URL to JPEG with a canvas (toJPEG is also unsafe in the sandbox). */
    async function pngDataUrlToJpeg(dataUrl, quality) {
      const documentRef = globalThis.document;
      const ImageCtor = globalThis.Image;
      if (documentRef === undefined || typeof documentRef.createElement !== "function" || typeof ImageCtor !== "function") {
        throw new Error("JPEG screenshots need the renderer canvas/Image APIs");
      }
      const image = new ImageCtor();
      image.src = dataUrl;
      if (typeof image.decode === "function") await image.decode();
      else {
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = () => reject(new Error("the captured image could not be decoded"));
        });
      }
      const canvas = documentRef.createElement("canvas");
      canvas.width = Math.max(1, Math.round(Number(image.naturalWidth || image.width || 1)));
      canvas.height = Math.max(1, Math.round(Number(image.naturalHeight || image.height || 1)));
      const context = typeof canvas.getContext === "function" ? canvas.getContext("2d") : undefined;
      if (!context || typeof context.drawImage !== "function") throw new Error("JPEG screenshots need a 2D canvas");
      context.drawImage(image, 0, 0);
      const converted = canvas.toDataURL("image/jpeg", Math.max(1, Math.min(100, Number(quality ?? 80))) / 100);
      if (typeof converted !== "string" || !converted.startsWith("data:image/jpeg")) {
        throw new Error("JPEG conversion produced no image");
      }
      return converted;
    }

    /**
     * Convert a captured image to a data URL, preferring the context-safe paths.
     * JPEG first tries toJPEG() (fast, quality honoured) and falls back to a
     * canvas re-encode when the sandboxed renderer cannot use Node Buffers.
     */
    async function imageToDataUrl(image, format, quality) {
      const requested = format === "jpeg" ? "jpeg" : "png";
      if (requested === "jpeg" && image !== undefined && image !== null && typeof image.toJPEG === "function") {
        try {
          const bytes = image.toJPEG(Math.max(1, Math.min(100, Number(quality ?? 80))));
          if (bytes && bytes.length > 0) return `data:image/jpeg;base64,${bytesToBase64(bytes)}`;
        } catch {
          // Sandboxed renderer: fall back to canvas conversion.
        }
      }
      const png = nativeImageToPngDataUrl(image);
      if (requested === "png") return png;
      return pngDataUrlToJpeg(png, quality);
    }

    /** Clamp a requested clip rectangle to the real viewport (visible intersection). */
    function clampRect(rect, viewport) {
      if (rect === undefined || rect === null) return undefined;
      const boundsWidth = Math.max(1, Math.round(Number(viewport?.width ?? viewport?.innerWidth ?? 0)));
      const boundsHeight = Math.max(1, Math.round(Number(viewport?.height ?? viewport?.innerHeight ?? 0)));
      const rawX = Number(rect.x ?? 0);
      const rawY = Number(rect.y ?? 0);
      const rawWidth = Number(rect.width ?? 0);
      const rawHeight = Number(rect.height ?? 0);
      if (![rawX, rawY, rawWidth, rawHeight].every((value) => Number.isFinite(value))) return undefined;
      const left = Math.max(0, Math.round(rawX));
      const top = Math.max(0, Math.round(rawY));
      const right = Math.min(boundsWidth, Math.round(rawX + rawWidth));
      const bottom = Math.min(boundsHeight, Math.round(rawY + rawHeight));
      if (right - left < 1 || bottom - top < 1) return undefined;
      return { x: left, y: top, width: right - left, height: bottom - top };
    }

    /** Inject a validated http(s) base URL as <base> unless the HTML has one. */
    function injectBaseHref(html, baseUrl) {
      const text = String(html ?? "");
      if (typeof baseUrl !== "string" || baseUrl === "") return { html: text, injected: false };
      if (/<base[\s>]/iu.test(text)) {
        return { html: text, injected: false, warning: "html already contains a <base> tag; it was left untouched" };
      }
      const escaped = baseUrl.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;");
      const tag = `<base href="${escaped}">`;
      const head = /<head[^>]*>/iu.exec(text);
      if (head !== null) {
        const index = head.index + head[0].length;
        return { html: text.slice(0, index) + tag + text.slice(index), injected: true };
      }
      return { html: tag + text, injected: true };
    }

    /** about:blank (with or without the lease fragment) needs no navigation. */
    function isBlankUrl(url) {
      return typeof url === "string" && url.startsWith("about:blank");
    }

    /** UTF-8 byte length where TextEncoder exists, else UTF-16 units (clamped). */
    function utf8Length(text) {
      const value = String(text ?? "");
      if (typeof TextEncoder === "function") {
        try {
          return new TextEncoder().encode(value).length;
        } catch {
          return value.length;
        }
      }
      return value.length;
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

    /**
     * DSH desktop boot facts. The shell's web frontend publishes the live Host
     * origin on globalThis.__DSH_TRANSPORT__ ({ ownsHost, streamBaseUrl });
     * standalone 'dsh web' does not. Read at call time (never cached): the
     * value is installed during desktop boot, possibly after this module runs.
     */
    function desktopTransport() {
      try {
        const transport = globalThis.__DSH_TRANSPORT__;
        if (transport === null || typeof transport !== "object") return undefined;
        if (transport.ownsHost !== true) return undefined;
        const streamBaseUrl = transport.streamBaseUrl;
        if (typeof streamBaseUrl !== "string" || streamBaseUrl === "") return undefined;
        new URL(streamBaseUrl);
        return { ownsHost: true, streamBaseUrl };
      } catch {
        return undefined;
      }
    }

    /** Hostnames the desktop shell resolves to the DSH Host itself. */
    const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

    /**
     * Mirror the desktop shell's guest isolation policy exactly
     * (DesktopBrowserGuests.configureSession in app.asar lib/main.js): every
     * guest request whose port equals the Host port and whose hostname is the
     * Host's own or a loopback alias is cancelled before it leaves the guest,
     * so a webview load there can only fail with a bare ERR_FAILED (-2).
     * Returns the policy block (Host origin + target) or undefined.
     */
    function applicationHostBlock(url) {
      const transport = desktopTransport();
      if (transport === undefined) return undefined;
      let host;
      try {
        host = new URL(transport.streamBaseUrl);
      } catch {
        return undefined;
      }
      if (url.port !== host.port) return undefined;
      if (url.hostname !== host.hostname && !LOOPBACK_HOSTNAMES.includes(url.hostname)) return undefined;
      return { origin: host.origin, target: url.href };
    }

    /**
     * Refuse an application-host URL with an actionable policy error before the
     * panel mounts: Electron would only surface GUEST_VIEW_MANAGER_CALL:
     * ERR_FAILED (-2) after the shell already cancelled the request.
     */
    function assertLoadable(url) {
      const block = applicationHostBlock(url);
      if (block === undefined) return;
      throw new Error(
        `blocked by the desktop shell's isolation policy: the Agent Browser cannot load the DSH Host itself (${block.origin}); ` +
          "the shell cancels guest requests to the Host's own port, which Chromium reports as a bare ERR_FAILED (-2). " +
          "Use action=setContent or action=preview for local content, or a separate standalone 'dsh web' instance to inspect the GUI. " +
          `(target: ${block.target})`,
      );
    }

    /**
     * One did-fail-load event as "<description> (<code>) loading '<url>'" — the
     * receipt line open/navigate failures and status.lastLoadFailure report.
     */
    function loadFailureLine(failure, fallbackUrl) {
      return `${failure.errorDescription ?? failure.errorCode}${
        failure.errorCode !== undefined ? ` (${failure.errorCode})` : ""
      } loading '${failure.validatedURL ?? fallbackUrl}'`;
    }

    /**
     * Normalize an Electron guest load error into a load-receipt line: Electron
     * rejects webview.loadURL() with the raw IPC wrapper
     * "Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error:
     * ERR_CONNECTION_REFUSED (-102) loading 'http://…/'", which is noise for the
     * agent. When a Chromium code is present, keep only code (+ numeric) and the
     * loading URL; otherwise return the original message unchanged.
     */
    function describeLoadError(error) {
      const message = String(error?.message ?? error);
      const code = /ERR_[A-Z0-9_]+/u.exec(message)?.[0];
      if (code === undefined) return message;
      const numeric = /\((-?\d+)\)/u.exec(message)?.[1];
      const loadingUrl = /loading '([^']+)'/u.exec(message)?.[1];
      let text = code;
      if (numeric !== undefined) text += ` (${numeric})`;
      if (loadingUrl !== undefined) text += ` loading '${loadingUrl}'`;
      return text;
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
      const consoleLimit = options.consoleLimit ?? 200;
      const evaluateResultLimit = options.evaluateResultLimit ?? 200 * 1024;
      const fullPageMaxCssPx = options.fullPageMaxCssPx ?? 12000;
      const captureTimeoutMs = options.captureTimeoutMs ?? 8000;
      const decodeTimeoutMs = options.decodeTimeoutMs ?? 1500;
      const fullPageBudgetMs = options.fullPageBudgetMs ?? 60000;
      const viewportSettleMs = options.viewportSettleMs ?? 2000;
      /** Closes our right-sidebar tab (if any) and re-opens it; last-resort reset. */
      const resetPanel = typeof options.resetPanel === "function" ? options.resetPanel : undefined;

      let webview;
      let lease;
      let ready = false;
      let mountPromise;
      let lastSnapshot;
      let navigationCount = 0;
      let mountContainer;
      /** Last container a webview was mounted into; lets action=open reopen after close. */
      let lastMountContainer;
      /** Requested fixed CSS viewport {width,height,scale}; undefined = auto. */
      let viewportState;
      /** Current best-effort prefers-color-scheme emulation: light/dark/auto. */
      let themeState = "auto";
      /** Page-scrollbar preference for viewport captures: "auto" (default) or "hidden". */
      let scrollbarState = "auto";
      let lastNavigation = { url: "", title: "" };
      /** Last open/navigate attempt ({url, at}); did-fail-load events before it are stale. */
      let lastAttempt;
      /** Last did-fail-load observed on the guest (diagnoses cancelled loads). */
      let lastLoadFailure;
      /** Ring buffer of webview console-message events (≤ consoleLimit). */
      const consoleLog = [];
      const consoleCounts = { error: 0, warning: 0 };
      let consoleTotal = 0;
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

      /** Build one leased guest element with all listeners; the caller appends it. */
      function createGuestElement(reservation) {
        const element = documentRef.createElement("webview");
        webview = element;
        element.setAttribute("name", reservation.lease);
        element.setAttribute("partition", reservation.partition);
        element.setAttribute("src", `about:blank#${reservation.lease}`);
        element.style.cssText = "width:100%;height:100%;display:flex;background:#0b0d12";
        if (viewportState !== undefined) applyViewportStyle(viewportState);
        element.addEventListener("did-navigate", () => {
          // A new document means the previous snapshot refs are gone.
          lastSnapshot = undefined;
          settleNavigation();
          lastNavigation = { url: safePageUrl(element), title: "" };
        });
        element.addEventListener("console-message", (event) => {
          recordConsoleMessage(event);
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
          // A load cancelled by the desktop shell only surfaces as a bare
          // ERR_FAILED here, so expose the guest's last failure in status().
          lastLoadFailure = {
            errorCode: event?.errorCode,
            errorDescription: event?.errorDescription,
            validatedURL: event?.validatedURL,
            isMainFrame: event?.isMainFrame !== false,
            at: Date.now(),
          };
        });
        element.addEventListener("dom-ready", () => {
          void postDiag("panel", { phase: "dom-ready", url: safePageUrl(element) });
        });
        return element;
      }

      /** Resolve true when the guest emits dom-ready before the timeout. */
      function waitForGuestReady(element, timeoutMs) {
        return new Promise((resolve) => {
          let done = false;
          const onReady = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            if (done) return;
            done = true;
            try {
              element.removeEventListener("dom-ready", onReady);
            } catch {
              // Fake guests in tests may not implement removeEventListener.
            }
            resolve(false);
          }, timeoutMs);
          element.addEventListener("dom-ready", onReady, { once: true });
        });
      }

      /**
       * Append a leased guest and wait for `dom-ready`, REPLACING the element on
       * every retry.
       *
       * A real restart (2026-10-27) showed three attach attempts on the same
       * element fail while the next fresh mount attached in 2ms: a wedged guest
       * is repaired by rebuilding it, not by re-appending it. Each retry also
       * re-runs the panel-ensure path so the right-sidebar tab stays selected.
       */
      async function mountGuest(container, reservation) {
        const attemptMs = 3200;
        const maxAttempts = 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          const element = createGuestElement(reservation);
          try {
            container.appendChild(element);
          } catch {
            // A vanished container fails the wait below.
          }
          const attached = await waitForGuestReady(element, attemptMs);
          void postDiag("panel", { phase: "attach-attempt", attempt, attached });
          if (attached) {
            settleReady();
            return element;
          }
          try {
            if (typeof container.removeChild === "function") container.removeChild(element);
          } catch {
            // Already detached.
          }
          try {
            element.remove?.();
          } catch {
            // Already removed.
          }
          if (webview === element) webview = undefined;
          try {
            ensurePanel();
          } catch {
            // Best effort: the tab may already be selected.
          }
        }
        throw new Error(
          `Agent Browser webview did not attach after ${maxAttempts} attempts (the right-sidebar tab may be stale); ` +
            "close the Agent Browser tab and call action=open again",
        );
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
          mountContainer = container;
          lastMountContainer = container;
          try {
            // A fixed viewport is displayed scaled-down inside the panel; the
            // panel clips the over-sized guest instead of scrolling the page.
            container.style.overflow = "hidden";
            container.style.position = "relative";
          } catch {
            // Mock containers in tests use plain objects.
          }
          const element = await mountGuest(container, reservation);
          if (themeState !== "auto") {
            // A fresh about:blank context must carry the current emulation.
            try {
              await element.executeJavaScript(emulateJs(themeState));
            } catch {
              // Best effort: the panel may still be blank.
            }
          }
          void postDiag("panel", { phase: "ready", lease: reservation.lease });
        })().catch((error) => {
          mountPromise = undefined;
          void postDiag("panel", { phase: "mount-failed", error: String(error && error.message ? error.message : error) });
          throw error;
        });
        return mountPromise;
      }

      function ensureMounted(container) {
        if (webview !== undefined) {
          // React can remount a tab body into a NEW container while our guest
          // element stays in the old (now detached) one: the guest keeps
          // working for CDP-like calls but is no longer composited, so the pane
          // renders black. Move the guest into the live container.
          try {
            if (container !== undefined && webview.parentNode !== container) {
              container.appendChild(webview);
              mountContainer = container;
              lastMountContainer = container;
              void postDiag("panel", { phase: "guest-reattached", geometry: panelGeometry() });
            }
          } catch (error) {
            void postDiag("panel", { phase: "guest-reattach-failed", error: String(error && error.message ? error.message : error) });
          }
          return ready ? Promise.resolve() : waitReady();
        }
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
        mountContainer = undefined;
        viewportState = undefined;
        themeState = "auto";
        scrollbarState = "auto";
        lastNavigation = { url: "", title: "" };
        consoleLog.length = 0;
        consoleCounts.error = 0;
        consoleCounts.warning = 0;
        consoleTotal = 0;
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

      /** Normalize Electron console-message levels (number or string events). */
      function normalizeConsoleLevel(level) {
        if (typeof level === "number") return ["verbose", "info", "warning", "error"][level] ?? "info";
        const text = String(level ?? "info").toLowerCase();
        if (text === "warning" || text === "warn") return "warning";
        if (text === "error") return "error";
        if (text === "info" || text === "verbose" || text === "log" || text === "debug") return "info";
        return text;
      }

      /** Append one console-message event to the ring buffer (≤ consoleLimit). */
      function recordConsoleMessage(event) {
        const level = normalizeConsoleLevel(event?.level);
        const entry = {
          level,
          message: String(event?.message ?? "").slice(0, 2000),
          line: Number(event?.line ?? 0) || 0,
          source: String(event?.sourceId ?? event?.source ?? "").slice(0, 500),
          at: Date.now(),
        };
        consoleTotal += 1;
        if (level === "error") consoleCounts.error += 1;
        else if (level === "warning") consoleCounts.warning += 1;
        consoleLog.push(entry);
        if (consoleLog.length > consoleLimit) consoleLog.splice(0, consoleLog.length - consoleLimit);
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

      /**
       * Whether the guest element is really attached. Electron throws
       * "The WebView must be attached to the DOM and the dom-ready event
       * emitted before this method can be called" when a method is used on a
       * guest that failed to attach, so probe it before issuing commands.
       */
      function guestAttached(element) {
        if (element === undefined || element === null) return false;
        try {
          if (element.isConnected === false) return false;
          if (typeof element.getWebContentsId === "function") element.getWebContentsId();
          return true;
        } catch {
          return false;
        }
      }

      async function requireReady() {
        if (ready && webview !== undefined && guestAttached(webview)) return webview;
        if (webview === undefined) throw new Error("Agent Browser panel is not open; call action=open first");
        if (ready && !guestAttached(webview)) {
          // A ready flag can outlive its guest (failed mount racing a remount):
          // rebuild the guest instead of issuing commands on a detached one.
          void postDiag("panel", { phase: "ready-guest-detached", geometry: panelGeometry() });
          const container = lastMountContainer;
          unmount();
          if (container !== undefined) await ensureMounted(container);
        }
        await waitReady();
        if (webview === undefined) throw new Error("Agent Browser panel was closed");
        if (!guestAttached(webview)) throw new Error("Agent Browser webview is not attached; call action=open again");
        return webview;
      }

      /**
       * Navigate with one recovery pass: a guest that lost its attach raises
       * Electron's "must be attached ... dom-ready" error, so rebuild it once
       * instead of surfacing that raw error to the caller.
       */
      async function loadUrlWithRecovery(url) {
        const current = await requireReady();
        try {
          await current.loadURL(url);
          return current;
        } catch (error) {
          const message = String(error && error.message ? error.message : error);
          if (!/must be attached/iu.test(message)) throw error;
          void postDiag("panel", { phase: "loadurl-detached-retry", error: message });
          const container = lastMountContainer;
          unmount();
          if (container !== undefined) await ensureMounted(container);
          const retried = await requireReady();
          await retried.loadURL(url);
          return retried;
        }
      }

      /**
       * Ensure the panel is ready, then navigate. loadUrlWithRecovery keeps the
       * "must be attached" rebuild retry; guest load failures (including the
       * shell's cancelled requests, which Electron only reports as a bare
       * ERR_FAILED) are normalized into the structured receipt by handle().
       */
      async function loadUrlWithGuidance(url) {
        await ensurePanelReady();
        return loadUrlWithRecovery(url);
      }

      /**
       * The lastLoadFailure that belongs to the current open/navigate attempt.
       * A failure observed before the attempt started belongs to an earlier
       * navigation and must not be attributed to it.
       */
      function loadFailureSince(sinceMs) {
        if (lastLoadFailure === undefined) return undefined;
        if (typeof sinceMs === "number" && lastLoadFailure.at < sinceMs) return undefined;
        return lastLoadFailure;
      }

      /**
       * Resolve an application-host URL to the explicit {ok:false, error}
       * result the bridge/tool expects (the same shape unknown commands use),
       * or undefined when the URL is loadable.
       */
      function loadRefusal(url) {
        try {
          assertLoadable(url);
          return undefined;
        } catch (error) {
          return { ok: false, error: String(error && error.message ? error.message : error) };
        }
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

      /** Panel size in CSS px (undefined when the host cannot measure it). */
      function panelSize() {
        const container = mountContainer;
        if (container === undefined || container === null) return undefined;
        let width = Number(container.clientWidth);
        let height = Number(container.clientHeight);
        if ((!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) && typeof container.getBoundingClientRect === "function") {
          try {
            const rect = container.getBoundingClientRect();
            width = Number(rect?.width);
            height = Number(rect?.height);
          } catch {
            return undefined;
          }
        }
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
        return { width: Math.round(width), height: Math.round(height) };
      }

      /**
       * Geometry of the mounted guest and its container. A black pane with a
       * working guest means the element is detached, zero-sized or hidden, so
       * status exposes exactly those facts.
       */
      function panelGeometry() {
        const rectOf = (node) => {
          if (node === undefined || node === null) return undefined;
          try {
            const rect = node.getBoundingClientRect();
            return {
              x: Math.round(Number(rect.x ?? 0)),
              y: Math.round(Number(rect.y ?? 0)),
              width: Math.round(Number(rect.width ?? 0)),
              height: Math.round(Number(rect.height ?? 0)),
            };
          } catch {
            return undefined;
          }
        };
        const element = webview;
        const container = mountContainer;
        let style;
        if (element !== undefined) {
          try {
            const computed = globalThis.getComputedStyle?.(element);
            style = computed === undefined ? undefined : { display: computed.display, visibility: computed.visibility, transform: computed.transform };
          } catch {
            style = undefined;
          }
        }
        return {
          hasWebview: element !== undefined,
          container: container === undefined ? undefined : { ...rectOf(container), connected: container.isConnected === true },
          element:
            element === undefined
              ? undefined
              : {
                  ...rectOf(element),
                  connected: element.isConnected === true,
                  parentIsContainer: container !== undefined && element.parentNode === container,
                  ...(style === undefined ? {} : { style }),
                },
        };
      }

      /** Scale that fits the requested guest viewport into the visible panel. */
      function computeScale(width, height) {
        const panel = panelSize();
        if (panel === undefined) return 1;
        const scale = Math.min(panel.width / width, panel.height / height, 1);
        return Math.round(scale * 1000) / 1000;
      }

      /** Apply the requested fixed viewport to the webview element. */
      function applyViewportStyle(state) {
        const element = webview;
        if (element === undefined) return;
        try {
          if (state === undefined) {
            element.style.width = "100%";
            element.style.height = "100%";
            element.style.flex = "";
            element.style.transform = "";
            element.style.transformOrigin = "";
            return;
          }
          element.style.width = `${state.width}px`;
          element.style.height = `${state.height}px`;
          element.style.flex = "0 0 auto";
          element.style.transformOrigin = "0 0";
          element.style.transform = state.scale === 1 ? "" : `scale(${state.scale})`;
        } catch {
          // A detached guest may reject style writes; the receipt reports actual.
        }
      }

      /** Read the guest's real viewport numbers after a resize. */
      async function readViewportInfo(current) {
        let info;
        try {
          info = await current.executeJavaScript(viewportInfoJs());
        } catch {
          info = undefined;
        }
        return {
          innerWidth: Math.round(Number(info?.innerWidth ?? 0)),
          innerHeight: Math.round(Number(info?.innerHeight ?? 0)),
          devicePixelRatio: Number(info?.devicePixelRatio ?? 1),
          contentWidth: Math.round(Number(info?.contentWidth ?? 0)),
          scrollWidth: Math.round(Number(info?.scrollWidth ?? 0)),
          scrollHeight: Math.round(Number(info?.scrollHeight ?? 0)),
        };
      }

      /**
       * Wait until the guest reports the expected viewport. A real Electron
       * <webview> can take more than one command turn to propagate an element
       * resize into the guest's innerWidth/innerHeight, so reading once right
       * after the style write would report the *previous* size (observed on a
       * real DSH Desktop; see docs §34.5).
       *
       * @returns {{actual: object, matched: boolean, settledMs: number}}
       */
      async function settleViewport(current, expected, timeoutMs = viewportSettleMs) {
        const started = Date.now();
        for (;;) {
          const actual = await readViewportInfo(current);
          const matched =
            expected === undefined ||
            (Math.abs(actual.innerWidth - expected.width) <= 2 && Math.abs(actual.innerHeight - expected.height) <= 2);
          const settledMs = Date.now() - started;
          if (matched === true || settledMs >= timeoutMs) return { actual, matched, settledMs };
          await sleepImpl(50);
        }
      }

      /** Reject a hanging Electron API after timeoutMs so the command loop survives. */
      function withCaptureTimeout(promise, timeoutMs, label) {
        let timer;
        const timeout = new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
      }

      /**
       * Decode one captured image with a hard bound. In the real renderer both
       * `Image.decode()` and the load/error events can stall (huge data URLs,
       * memory pressure), and an unbounded decode wedges the whole capture:
       * race decode() against the load event and a timeout that throws with
       * the phase label so the stage diagnostics show where it hung.
       */
      function decodeSegmentImage(image, label, timeoutMs) {
        const loadEvent = new Promise((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error(`${label}: the captured image could not be decoded`));
        });
        const decodeCall =
          typeof image.decode === "function"
            ? Promise.resolve(image.decode()).catch((error) => {
                throw error;
              })
            : loadEvent;
        let timer;
        const timeout = new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${label}: image decode timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        return Promise.race([decodeCall, loadEvent, timeout]).finally(() => clearTimeout(timer));
      }

      /**
       * Draw stitched viewport captures into one canvas and encode it.
       * Segments may override draw geometry (dx/dy/dw/dh) so the tall-element
       * path reuses this same canvas + decode + encode base.
       */
      async function stitchSegments(segments, width, height, viewportHeight, format, quality) {
        const canvas = documentRef.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width));
        canvas.height = Math.max(1, Math.round(height));
        const context = typeof canvas.getContext === "function" ? canvas.getContext("2d") : undefined;
        if (!context || typeof context.drawImage !== "function") {
          throw new Error("fullPage screenshot needs a 2D canvas in the renderer");
        }
        const ImageCtor = globalThis.Image;
        if (typeof ImageCtor !== "function") throw new Error("fullPage screenshot needs the renderer Image constructor");
        for (let index = 0; index < segments.length; index += 1) {
          const segment = segments[index];
          const image = new ImageCtor();
          image.src = segment.dataUrl;
          await decodeSegmentImage(image, segment.decodeLabel ?? "fullPage stitch", decodeTimeoutMs);
          context.drawImage(
            image,
            Math.round(segment.dx ?? 0),
            Math.round(segment.dy ?? segment.actualY ?? 0),
            Math.round(segment.dw ?? width),
            Math.round(segment.dh ?? viewportHeight),
          );
        }
        const dataUrl =
          format === "jpeg"
            ? canvas.toDataURL("image/jpeg", Math.max(1, Math.min(100, Number(quality ?? 80))) / 100)
            : canvas.toDataURL("image/png");
        if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
          throw new Error("fullPage stitching produced no image (the page may be too large for a canvas)");
        }
        return dataUrl;
      }

      /**
       * Full-page evidence without resizing the guest.
       *
       * The earlier approach (grow the webview element to scrollHeight, then
       * capturePage) hung in a real DSH Desktop session: capturePage never
       * settled and the client command loop stayed stuck until restart. This
       * implementation scrolls viewport by viewport, captures normal-sized
       * frames, and stitches them in a canvas: no guest resize, no vh reflow.
       * Cost: position:fixed/sticky elements repeat in the output (documented).
       *
       * 0.2.4 hardening after a real-device finding (2026-10-27): local pages
       * finished in seconds but external pages (github.com, wikipedia.org)
       * reliably hit the 25s bridge timeout. Regular viewport screenshots on
       * the same pages were instant and manual hide+scroll+capture worked, so
       * the hang lives in the stitch/restore path, not capturePage. Every
       * await here is now bounded (capture, decode, every executeJavaScript,
       * the restore steps), the whole capture has a total budget, and every
       * stage posts a `fullpage` diagnostic so the next device run shows which
       * step stalled on which page.
       */
      async function captureFullPage(current, options = {}) {
        if (typeof current.capturePage !== "function") throw new Error("capturePage is not available in this webview");
        const format = options.format === "jpeg" ? "jpeg" : "png";
        const quality = options.quality;
        const startedAt = Date.now();
        const stage = (phase, extra) => {
          void postDiag("fullpage", {
            phase,
            ms: Date.now() - startedAt,
            ...(extra === undefined ? {} : extra),
          });
        };
        const budgetLeft = () => fullPageBudgetMs <= 0 || Date.now() - startedAt < fullPageBudgetMs;
        const budgetError = () =>
          new Error(
            `fullPage screenshot exceeded its ${fullPageBudgetMs}ms budget: ${timings.segments} segment(s) captured in ${Date.now() - startedAt}ms`,
          );
        let scrollbarsHidden = false;
        let originalScrollY = 0;
        const timings = { segments: 0, captureMs: [], encodeMs: [] };
        stage("begin");
        try {
          // Hide scrollbars first: the layout width grows by the scrollbar
          // width, so dimensions must be read after it is applied. Never run
          // unbounded: a stalled hide would wedge stitching a step later.
          try {
            const hidden = await withCaptureTimeout(
              Promise.resolve(current.executeJavaScript(scrollbarVisibilityJs(true))),
              captureTimeoutMs,
              "fullPage hideScrollbars",
            );
            scrollbarsHidden = hidden?.hidden === true;
          } catch (error) {
            scrollbarsHidden = false;
            void postDiag("fullpage", {
              phase: "hide-scrollbars-failed",
              ms: Date.now() - startedAt,
              error: String(error && error.message ? error.message : error),
            });
          }
          if (scrollbarsHidden) await sleepImpl(60);
          stage("hideScrollbars");
          const state = await current.executeJavaScript(scrollStateJs());
          const viewport = await current.executeJavaScript(viewportInfoJs());
          const requestedHeight = Math.max(1, Math.round(Number(state?.scrollHeight ?? 0)));
          const viewportHeight = Math.max(1, Math.round(Number(state?.innerHeight ?? viewport?.innerHeight ?? 0)));
          const viewportWidth = Math.max(1, Math.round(Number(viewport?.innerWidth ?? 0)));
          originalScrollY = Math.max(0, Math.round(Number(state?.scrollY ?? 0)));
          const capturedHeight = Math.max(1, Math.min(requestedHeight, fullPageMaxCssPx));
          const segments = [];
          let targetY = 0;
          while (targetY < capturedHeight) {
            if (!budgetLeft()) throw budgetError();
            stage("segment-start", { index: segments.length });
            // `behavior: 'instant'` bypasses a page's `scroll-behavior: smooth`,
            // which would otherwise animate and make the capture frame lag.
            await withCaptureTimeout(
              Promise.resolve(current.executeJavaScript(`(() => { window.scrollTo({ top: ${targetY}, left: 0, behavior: 'instant' }); return 1; })()`)),
              captureTimeoutMs,
              "fullPage scrollTo",
            );
            await sleepImpl(60);
            const captureStartedAt = Date.now();
            stage("segment-capture", { index: segments.length });
            const image = await withCaptureTimeout(Promise.resolve(current.capturePage()), captureTimeoutMs, "capturePage");
            timings.captureMs.push(Date.now() - captureStartedAt);
            // The browser clamps a scroll near the bottom; record where the
            // frame really starts so the stitched output stays aligned.
            const at = await withCaptureTimeout(
              Promise.resolve(current.executeJavaScript(scrollStateJs())),
              captureTimeoutMs,
              "fullPage scrollState",
            );
            const actualY = Math.max(0, Math.round(Number(at?.scrollY ?? targetY)));
            const encodeStartedAt = Date.now();
            const dataUrl = await imageToDataUrl(image, "png", 100);
            timings.encodeMs.push(Date.now() - encodeStartedAt);
            stage("segment-encode", { index: segments.length, stepMs: Date.now() - encodeStartedAt });
            segments.push({ actualY, dataUrl });
            if (actualY >= capturedHeight - viewportHeight) break;
            targetY += viewportHeight;
          }
          if (!budgetLeft()) throw budgetError();
          timings.segments = segments.length;
          stage("stitch", { index: segments.length });
          const dataUrl = await stitchSegments(
            segments.map((segment) => ({ ...segment, dy: segment.actualY, dh: Math.min(viewportHeight, capturedHeight - segment.actualY) })),
            viewportWidth,
            capturedHeight,
            viewportHeight,
            format,
            quality,
          );
          return {
            dataUrl,
            format,
            fullPage: {
              requestedHeight,
              capturedHeight,
              capped: requestedHeight > capturedHeight,
              segments: segments.length,
              stitched: true,
              viewportHeight,
              scrollbarsHidden,
              timings: {
                // Total wall time including capture, stitch and restore.
                totalMs: Date.now() - startedAt,
                segments: segments.length,
                captureMs: [...timings.captureMs],
                encodeMs: [...timings.encodeMs],
              },
            },
            viewportInfo: { innerWidth: viewportWidth, innerHeight: viewportHeight },
          };
        } catch (error) {
          void postDiag("fullpage", {
            phase: "error",
            ms: Date.now() - startedAt,
            error: String(error && error.message ? error.message : error),
          });
          throw error;
        } finally {
          // Bounded restore too: a wedged guest must not keep the command loop
          // waiting past the capture itself.
          try {
            await withCaptureTimeout(
              Promise.resolve(current.executeJavaScript(`(() => { window.scrollTo({ top: ${originalScrollY}, left: 0, behavior: 'instant' }); return 1; })()`)),
              Math.min(captureTimeoutMs, 2500),
              "fullPage scroll restore",
            );
          } catch {
            // The page may have navigated away mid-capture.
          }
          if (scrollbarsHidden) {
            try {
              await withCaptureTimeout(
                Promise.resolve(current.executeJavaScript(scrollbarVisibilityJs(false))),
                Math.min(captureTimeoutMs, 2500),
                "fullPage scrollbar restore",
              );
            } catch {
              // The page may have navigated away mid-capture.
            }
          }
          stage("restore");
        }
      }

      /**
       * Tall-element screenshot: scroll-stitch an element that is taller than
       * the viewport (or lies outside it) instead of clipping it to the first
       * screen. Shares the fullPage base (scrollbar hide/restore, per-segment
       * capture, canvas stitch) but crops to the element's box and reports its
       * own receipt fields; the total height keeps the same 12000 CSS px cap.
       */
      async function captureTallElement(current, target, options = {}) {
        const format = options.format === "jpeg" ? "jpeg" : "png";
        const quality = options.quality;
        const startedAt = Date.now();
        const stage = (phase, extra) => {
          void postDiag("fullpage", {
            phase: `element-${phase}`,
            ms: Date.now() - startedAt,
            ...(extra === undefined ? {} : extra),
          });
        };
        const budgetLeft = () => fullPageBudgetMs <= 0 || Date.now() - startedAt < fullPageBudgetMs;
        const viewport = target.viewport ?? {};
        const innerWidth = Math.max(1, Math.round(Number(viewport.width ?? target.innerWidth ?? 0)));
        const innerHeight = Math.max(1, Math.round(Number(viewport.height ?? target.innerHeight ?? 0)));
        const full = target.full ?? {};
        // Page-space coordinates: scrollbars are hidden (and page-wide
        // scrollTo uses left:0), so viewport coordinates taken at measure time
        // are not stable; page coordinates are.
        const fullX = Math.round(Number(full.x ?? target.rect?.x ?? 0));
        const fullY = Math.round(Number(full.y ?? target.rect?.y ?? 0));
        const fullWidth = Math.max(1, Math.round(Number(full.width ?? target.rect?.width ?? 1)));
        const fullHeight = Math.max(1, Math.round(Number(full.height ?? target.rect?.height ?? 1)));
        const capped = fullHeight > fullPageMaxCssPx;
        const captureHeight = Math.max(1, Math.min(fullHeight, fullPageMaxCssPx));
        // Crop to the visible horizontal band of the element; the over-wide
        // remainder is reported instead of faked.
        const cropLeft = Math.max(0, fullX);
        const cropWidth = Math.max(1, Math.min(fullX + fullWidth, innerWidth) - cropLeft);
        let scrollbarsHidden = false;
        /** Scroll position to restore in the finally block (measured pre-capture). */
        let originalScrollY = 0;
        const timings = { segments: 0, captureMs: [], encodeMs: [] };
        stage("begin");
        try {
          try {
            const hidden = await withCaptureTimeout(
              Promise.resolve(current.executeJavaScript(scrollbarVisibilityJs(true))),
              captureTimeoutMs,
              "tall element hideScrollbars",
            );
            scrollbarsHidden = hidden?.hidden === true;
          } catch (error) {
            scrollbarsHidden = false;
            void postDiag("fullpage", {
              phase: "element-hide-scrollbars-failed",
              ms: Date.now() - startedAt,
              error: String(error && error.message ? error.message : error),
            });
          }
          if (scrollbarsHidden) await sleepImpl(60);
          stage("hideScrollbars");
          let originalScrollAtCapture = 0;
          try {
            const initial = await current.executeJavaScript(scrollStateJs());
            originalScrollAtCapture = Math.max(0, Math.round(Number(initial?.scrollY ?? 0)));
          } catch {
            originalScrollAtCapture = 0;
          }
          originalScrollY = originalScrollAtCapture;
          const segments = [];
          let offset = 0;
          let covered = 0;
          let lastCovered = -1;
          while (covered < captureHeight) {
            if (!budgetLeft()) {
              throw new Error(
                `tall element screenshot exceeded its ${fullPageBudgetMs}ms budget: ${segments.length} segment(s) captured covering ${covered} of ${captureHeight} px`,
              );
            }
            stage("segment-start", { index: segments.length });
            await withCaptureTimeout(
              Promise.resolve(current.executeJavaScript(`(() => { window.scrollTo({ top: ${fullY + offset}, left: 0, behavior: 'instant' }); return 1; })()`)),
              captureTimeoutMs,
              "tall element scrollTo",
            );
            await sleepImpl(60);
            const captureStartedAt = Date.now();
            stage("segment-capture", { index: segments.length });
            const at = await withCaptureTimeout(
              Promise.resolve(current.executeJavaScript(scrollStateJs())),
              captureTimeoutMs,
              "tall element scrollState",
            );
            const actualY = Math.max(0, Math.round(Number(at?.scrollY ?? fullY + offset)));
            // Element top in viewport coordinates at this scroll position.
            const elementTop = fullY - actualY;
            const rectTop = Math.max(0, elementTop);
            const rectBottom = Math.min(elementTop + fullHeight, innerHeight);
            const rectHeight = rectBottom - rectTop;
            if (rectHeight <= 0) break;
            const image = await withCaptureTimeout(
              Promise.resolve(current.capturePage({ x: cropLeft, y: rectTop, width: cropWidth, height: rectHeight })),
              captureTimeoutMs,
              "capturePage",
            );
            timings.captureMs.push(Date.now() - captureStartedAt);
            const encodeStartedAt = Date.now();
            const dataUrl = await imageToDataUrl(image, "png", 100);
            timings.encodeMs.push(Date.now() - encodeStartedAt);
            stage("segment-encode", { index: segments.length, stepMs: Date.now() - encodeStartedAt });
            segments.push({ dx: cropLeft, dy: Math.max(0, rectTop - elementTop), dw: cropWidth, dh: rectHeight, dataUrl, decodeLabel: "tall element stitch" });
            covered = Math.max(covered, Math.max(0, rectTop - elementTop) + rectHeight);
            if (covered <= lastCovered || actualY >= fullY + captureHeight - innerHeight) break;
            lastCovered = covered;
            offset = covered;
          }
          if (!budgetLeft() && segments.length === 0) {
            throw new Error(
              `tall element screenshot exceeded its ${fullPageBudgetMs}ms budget: ${segments.length} segment(s) captured covering ${covered} of ${captureHeight} px`,
            );
          }
          if (segments.length === 0) {
            throw new Error("tall element screenshot produced no segment; the element is not visible at any scroll position");
          }
          timings.segments = segments.length;
          stage("stitch", { index: segments.length });
          const dataUrl = await stitchSegments(segments, cropWidth, captureHeight, innerHeight, format, quality);
          stage("restore");
          return {
            dataUrl,
            format,
            element: {
              target: target.target,
              clippedToViewport: false,
              stitched: true,
              segments: segments.length,
              fullRect: { x: fullX, y: fullY, width: fullWidth, height: fullHeight },
              fullHeight,
              fullWidth,
              capturedHeight: captureHeight,
              capped,
              croppedWidth: Math.max(0, fullWidth - cropWidth),
              viewportHeight: innerHeight,
              scrollbarsHidden,
              timings: {
                totalMs: Date.now() - startedAt,
                segments: segments.length,
                captureMs: [...timings.captureMs],
                encodeMs: [...timings.encodeMs],
              },
            },
            viewport: { width: innerWidth, height: innerHeight },
          };
        } catch (error) {
          void postDiag("fullpage", {
            phase: "element-error",
            ms: Date.now() - startedAt,
            error: String(error && error.message ? error.message : error),
          });
          throw error;
        } finally {
          try {
            await withCaptureTimeout(
              Promise.resolve(
                current.executeJavaScript(`(() => { window.scrollTo({ top: ${originalScrollY}, left: 0, behavior: 'instant' }); return 1; })()`),
              ),
              Math.min(captureTimeoutMs, 2500),
              "tall element scroll restore",
            );
          } catch {
            // The page may have navigated away mid-capture.
          }
          if (scrollbarsHidden) {
            try {
              await withCaptureTimeout(
                Promise.resolve(current.executeJavaScript(scrollbarVisibilityJs(false))),
                Math.min(captureTimeoutMs, 2500),
                "tall element scrollbar restore",
              );
            } catch {
              // The page may have navigated away mid-capture.
            }
          }
        }
      }

      /** Replay the best-effort theme shim after a page context was replaced. */
      async function replayTheme(current) {
        if (themeState === "auto") return false;
        try {
          await current.executeJavaScript(emulateJs(themeState));
          return true;
        } catch {
          // The new page may not be ready yet; the emulate action still works.
          return false;
        }
      }

      /** Replay the persistent scrollbar-hide style after the document changed. */
      async function replayScrollbars(current) {
        if (scrollbarState !== "hidden") return false;
        try {
          await current.executeJavaScript(scrollbarVisibilityJs(true));
          return true;
        } catch {
          return false;
        }
      }

      /** Navigation invalidates the in-page cursor/refs; replay emulation if set. */
      async function afterNavigation(current, info, fallbackUrl) {
        lastSnapshot = undefined;
        lastNavigation = { url: info.url || fallbackUrl || "", title: info.title || "" };
        await replayTheme(current);
        await replayScrollbars(current);
      }

      /**
       * Ensure the panel exists and its webview is ready, reopening a released
       * guest when needed. Shared by open/navigate so a navigate can be the
       * first call (qa, agent shortcuts) instead of failing on a closed panel.
       *
       * Stale-panel recovery (0.2.4): after a DSH restart the sidebar can keep
       * a webview that exists but never fires dom-ready (status showed
       * hasWebview:true / client.ready:false). close→open fixed it by hand, so
       * the first waitReady failure unmounts the stale guest and remounts once
       * (unmount keeps lastMountContainer for exactly this), then waits again.
       * If that still fails the floating-panel fallback runs; the final error
       * carries the original message plus a close/open recovery hint.
       */
      async function ensurePanelReady() {
        if (ready) return;
        if (webview === undefined) ensurePanel();
        if (webview === undefined && lastMountContainer !== undefined) {
          // action=close released the guest but the React body keeps its
          // container; mount a fresh leased webview into it on reopen.
          try {
            await ensureMounted(lastMountContainer);
          } catch (error) {
            void postDiag("panel", { phase: "reopen-mount-failed", error: String(error && error.message ? error.message : error) });
          }
        }
        let firstError;
        try {
          await waitReady(2500);
          return;
        } catch (error) {
          firstError = error;
        }
        void postDiag("panel", { phase: "ready-stale", error: String(firstError && firstError.message ? firstError.message : firstError) });
        // Stale guest: unmount the wedged webview and remount exactly one more
        // time into the kept container before giving up.
        let remounted = false;
        if (lastMountContainer !== undefined) {
          try {
            unmount();
            await ensureMounted(lastMountContainer);
            remounted = true;
          } catch (error) {
            void postDiag("panel", { phase: "stale-remount-failed", error: String(error && error.message ? error.message : error) });
          }
        }
        if (remounted) {
          try {
            await waitReady(2500);
            void postDiag("panel", { phase: "stale-remounted" });
            return;
          } catch (error) {
            firstError = error;
          }
        }
        if (resetPanel !== undefined) {
          // A wedged right-sidebar tab can keep a wedged body even after a
          // remount; dropping our tab and opening a fresh one is the last
          // in-app recovery before the floating fallback.
          try {
            const closed = resetPanel();
            void postDiag("panel", { phase: "panel-tab-reset", closed });
            await waitReady(4000);
            void postDiag("panel", { phase: "panel-tab-reset-ready" });
            return;
          } catch (error) {
            void postDiag("panel", { phase: "panel-tab-reset-failed", error: String(error && error.message ? error.message : error) });
          }
        }
        try {
          // The DSH right sidebar can keep a stale tab entry that never mounts
          // its body after plugin reloads; fall back to a floating panel so the
          // tool stays usable.
          await ensureFallbackMounted();
          await waitReady();
        } catch {
          throw new Error(
            `Agent Browser panel did not become ready in time (${String(firstError && firstError.message ? firstError.message : firstError)}); ` +
              "close the Agent Browser tab and call action=open again (or ask the user to reopen the panel)",
          );
        }
      }

      /**
       * Decide whether an element screenshot must scroll-stitch instead of
       * clipping to the viewport: the element is taller than the viewport or
       * extends outside the visible band measured by screenshotTargetJs.
       */
      function elementStitchPlan(target) {
        if (!target || target.ok !== true || !target.full || !target.viewport) return undefined;
        const viewportHeight = Math.max(1, Math.round(Number(target.viewport.height ?? 0)));
        const scrollY = Math.max(0, Math.round(Number(target.scrollY ?? 0)));
        const top = Math.round(Number(target.full.y ?? 0));
        const height = Math.round(Number(target.full.height ?? 0));
        if (!Number.isFinite(height) || height <= 0) return undefined;
        const visibleTop = top - scrollY;
        const runsOutside = height > viewportHeight || visibleTop < 0 || visibleTop + height > viewportHeight;
        return runsOutside ? { stitch: true } : undefined;
      }

      async function handle(command) {
        const type = String(command?.type ?? "");
        switch (type) {
          case "status":
            return { ok: true, ...status() };
          case "open": {
            const url = toHttpUrl(command.url);
            const refusal = loadRefusal(new URL(url));
            if (refusal !== undefined) return refusal;
            lastAttempt = { url, at: Date.now() };
            const attemptAt = lastAttempt.at;
            let current;
            try {
              current = await loadUrlWithGuidance(url);
            } catch (error) {
              // Resolve a structured failure receipt instead of throwing: the
              // Host tool text then carries the normalized reason, not
              // Electron's GUEST_VIEW_MANAGER_CALL IPC wrapper.
              const failure = loadFailureSince(attemptAt);
              const base = failure !== undefined ? loadFailureLine(failure, url) : describeLoadError(error);
              const hint = /ERR_FAILED/u.test(String(error?.message ?? error))
                ? " — the desktop shell cancels some guest requests (its own DSH Host port, URLs with credentials, non-http(s) schemes); see action=status lastLoadFailure for details."
                : " — see action=status lastLoadFailure for the guest's last load failure.";
              return { ok: false, error: base + hint, loadFailure: failure, attemptedUrl: url };
            }
            await sleepImpl(Number(command.waitMs ?? 350));
            const info = await pageInfo();
            await afterNavigation(current, info, url);
            const failure = loadFailureSince(attemptAt);
            if (failure !== undefined && failure.isMainFrame !== false) {
              // The navigation resolved onto Chromium's error page: report a
              // failed load instead of claiming the requested page opened.
              return {
                ok: true,
                loaded: false,
                url: info.url || url,
                title: info.title,
                attemptedUrl: url,
                loadFailure: failure,
                warning: `the guest did not load ${failure.validatedURL ?? url} (${failure.errorDescription ?? failure.errorCode}); the panel is showing Chromium's error page`,
              };
            }
            return { ok: true, loaded: true, url: info.url || url, title: info.title, attemptedUrl: url, themeReapplied: themeState !== "auto" };
          }
          case "navigate": {
            const url = toHttpUrl(command.url);
            const refusal = loadRefusal(new URL(url));
            if (refusal !== undefined) return refusal;
            lastAttempt = { url, at: Date.now() };
            const attemptAt = lastAttempt.at;
            let current;
            try {
              current = await loadUrlWithGuidance(url);
            } catch (error) {
              // Same structured receipt as open (see above).
              const failure = loadFailureSince(attemptAt);
              const base = failure !== undefined ? loadFailureLine(failure, url) : describeLoadError(error);
              const hint = /ERR_FAILED/u.test(String(error?.message ?? error))
                ? " — the desktop shell cancels some guest requests (its own DSH Host port, URLs with credentials, non-http(s) schemes); see action=status lastLoadFailure for details."
                : " — see action=status lastLoadFailure for the guest's last load failure.";
              return { ok: false, error: base + hint, loadFailure: failure, attemptedUrl: url };
            }
            await sleepImpl(Number(command.waitMs ?? 350));
            const info = await pageInfo();
            await afterNavigation(current, info, url);
            const failure = loadFailureSince(attemptAt);
            if (failure !== undefined && failure.isMainFrame !== false) {
              // Same error-page receipt as open (see above).
              return {
                ok: true,
                loaded: false,
                url: info.url || url,
                title: info.title,
                attemptedUrl: url,
                loadFailure: failure,
                warning: `the guest did not load ${failure.validatedURL ?? url} (${failure.errorDescription ?? failure.errorCode}); the panel is showing Chromium's error page`,
              };
            }
            return { ok: true, loaded: true, url: info.url || url, title: info.title, attemptedUrl: url, themeReapplied: themeState !== "auto" };
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
            if (navigated) {
              // A click can replace the document (link/form); the theme shim
              // lives on window and must be replayed on the new context.
              lastNavigation = { url: info.url, title: info.title };
              await replayTheme(current);
            }
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
            const navigatedAfterKey = beforeUrl !== "" && info.url !== "" && beforeUrl !== info.url;
            if (navigatedAfterKey) {
              lastNavigation = { url: info.url, title: info.title };
              await replayTheme(current);
            }
            return {
              ok: true,
              key,
              url: info.url,
              title: info.title,
              submit,
              settle,
              changed: Number(settle?.mutations ?? 0) > 0 || submit?.submitted === true || navigatedAfterKey,
            };
          }
          case "scroll": {
            const current = await requireReady();
            const requestedDelta = Number(command.deltaY ?? 400);
            if (!Number.isFinite(requestedDelta)) throw new Error("scroll requires a numeric deltaY");
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
            const before = await current.executeJavaScript(scrollStateJs());
            const beforeScrollY = typeof before?.scrollY === "number" ? before.scrollY : undefined;
            // Electron's synthesized wheel uses the Chromium WebMouseWheelEvent
            // sign convention (positive deltaY scrolls UP), the opposite of the
            // DOM WheelEvent convention used by our deltaY argument. Negating
            // here is what makes action=scroll deltaY positive scroll downward;
            // without it a large deltaY from a scrolled position jumps to the top.
            current.sendInputEvent({ type: "mouseWheel", x, y, deltaX: 0, deltaY: -requestedDelta, canScroll: true });
            await sleepImpl(140);
            let state = await current.executeJavaScript(scrollStateJs());
            let method = "wheel";
            if (requestedDelta !== 0 && typeof beforeScrollY === "number" && Number(state?.scrollY) === beforeScrollY) {
              // Synthetic wheel input is not always honored by the guest; fall
              // back to scripted scrolling so the page actually moves.
              await current.executeJavaScript(scrollFallbackJs(requestedDelta));
              await sleepImpl(120);
              state = await current.executeJavaScript(scrollStateJs());
              method = "script";
            }
            const settle = await settlePage(current);
            const finalScrollY = typeof state?.scrollY === "number" ? state.scrollY : undefined;
            const actualDelta =
              typeof beforeScrollY === "number" && typeof finalScrollY === "number" ? finalScrollY - beforeScrollY : undefined;
            const clamped =
              requestedDelta !== 0 && typeof actualDelta === "number" ? Math.abs(actualDelta) < Math.abs(requestedDelta) : false;
            return {
              ok: true,
              requestedDelta,
              deltaY: requestedDelta,
              actualDelta,
              method,
              scrollY: finalScrollY,
              scrollHeight: typeof state?.scrollHeight === "number" ? state.scrollHeight : undefined,
              innerHeight: typeof state?.innerHeight === "number" ? state.innerHeight : undefined,
              clamped,
              settle,
              changed: Number(settle?.mutations ?? 0) > 0 || (typeof actualDelta === "number" && actualDelta !== 0),
            };
          }
          case "scrollIntoView": {
            const current = await requireReady();
            const target = { block: command.block === undefined ? "center" : String(command.block) };
            if (command.ref !== undefined && command.ref !== null) target.ref = String(command.ref);
            if (typeof command.selector === "string" && command.selector !== "") target.selector = command.selector;
            if (target.ref === undefined && target.selector === undefined) throw new Error("scrollIntoView requires a ref or selector");
            const result = await current.executeJavaScript(scrollIntoViewJs(target));
            if (result === undefined || result === null || result.ok !== true) {
              throw new Error(result?.error ?? "scrollIntoView target not found; take a snapshot first");
            }
            const settle = await settlePage(current);
            return { ok: true, ...result, settle, changed: true };
          }
          case "wait": {
            const current = await requireReady();
            const conditions = {};
            if (typeof command.selector === "string" && command.selector !== "") conditions.selector = command.selector;
            if (typeof command.text === "string" && command.text !== "") conditions.text = command.text;
            if (command.networkIdle === true) conditions.networkIdle = true;
            if (command.images === true) conditions.images = true;
            if (command.fonts === true) conditions.fonts = true;
            if (command.idleMs !== undefined) conditions.idleMs = Math.max(0, Number(command.idleMs));
            const conditional = Object.keys(conditions).length > 0;
            const timeoutMs = Math.max(0, Number(command.ms ?? (conditional ? 8000 : 500)));
            if (!conditional) {
              await sleepImpl(timeoutMs);
              return { ok: true, waitedMs: timeoutMs, mode: "sleep" };
            }
            const result = await current.executeJavaScript(waitConditionsJs(conditions, timeoutMs));
            if (result === undefined || result === null || result.met !== true) {
              const state = result?.conditions === undefined ? "no page result" : JSON.stringify(result.conditions);
              throw new Error(`wait timed out after ${result?.waitedMs ?? timeoutMs}ms (${state})`);
            }
            return { ok: true, waitedMs: result.waitedMs, conditions: result.conditions, mode: "conditions" };
          }
          case "metrics": {
            const current = await requireReady();
            const selectors = Array.isArray(command.selectors) ? command.selectors.map(String).slice(0, 20) : [];
            const metrics = await current.executeJavaScript(metricsJs(selectors, command.includeOverflow !== false));
            if (metrics === undefined || metrics === null || typeof metrics !== "object") {
              throw new Error("the page returned no metrics");
            }
            return {
              ok: true,
              metrics: {
                ...metrics,
                console: {
                  errors: consoleCounts.error,
                  warnings: consoleCounts.warning,
                  total: consoleTotal,
                  entries: consoleLog.length,
                },
              },
            };
          }
          case "evaluate": {
            const current = await requireReady();
            const expression = typeof command.expression === "string" ? command.expression : "";
            if (expression.trim() === "") throw new Error("evaluate requires a non-empty expression");
            let result = await current.executeJavaScript(expression);
            if (result === undefined) result = null;
            let serialized;
            try {
              serialized = JSON.stringify(result);
            } catch {
              serialized = String(result);
            }
            if (typeof serialized === "string" && serialized.length > evaluateResultLimit) {
              // Protect the loopback result body (1MB cap) from a runaway
              // expression; the Host applies the 16KB receipt budget on top.
              return {
                ok: true,
                result: {
                  __truncated__: true,
                  bytes: serialized.length,
                  note: `result is ${serialized.length} chars; return a smaller value`,
                  preview: serialized.slice(0, 2000),
                },
              };
            }
            return { ok: true, result };
          }
          case "viewport": {
            const current = await requireReady();
            const scrollbars = command.scrollbars === "hidden" ? "hidden" : "auto";
            if (command.reset === true) {
              if (scrollbarState === "hidden") {
                // The persistent scrollbar-hide style must not outlive the
                // auto (reset) viewport choice.
                try {
                  await current.executeJavaScript(scrollbarVisibilityJs(false));
                } catch {
                  // Best effort; receipt reports the outcome of the size below.
                }
              }
              scrollbarState = "auto";
              viewportState = undefined;
              applyViewportStyle(undefined);
              const settled = await settleViewport(current, panelSize());
              return {
                ok: true,
                reset: true,
                width: settled.actual.innerWidth,
                height: settled.actual.innerHeight,
                actual: settled.actual,
                matched: settled.matched,
                settledMs: settled.settledMs,
                contentWidth: settled.actual.contentWidth,
                scrollbars: "auto",
              };
            }
            const width = Math.max(64, Math.min(10000, Math.round(Number(command.width))));
            const height = Math.max(64, Math.min(10000, Math.round(Number(command.height ?? 800))));
            if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error("viewport requires numeric width and height");
            if (scrollbars === "hidden") {
              // Same hide-scrollbar injection the fullPage stitch uses, but
              // persistent: replayed after navigation until reset/close.
              await current.executeJavaScript(scrollbarVisibilityJs(true));
              scrollbarState = "hidden";
            } else if (scrollbarState === "hidden") {
              await current.executeJavaScript(scrollbarVisibilityJs(false));
              scrollbarState = "auto";
            }
            const scale = computeScale(width, height);
            viewportState = { width, height, scale };
            applyViewportStyle(viewportState);
            const settled = await settleViewport(current, { width, height });
            return {
              ok: true,
              width,
              height,
              scale,
              actual: settled.actual,
              matched: settled.matched,
              settledMs: settled.settledMs,
              contentWidth: settled.actual.contentWidth,
              scrollbars,
              panel: panelSize(),
            };
          }
          case "logs": {
            const current = await requireReady();
            const limit = Math.max(1, Math.min(200, Math.round(Number(command.limit ?? 50))));
            const filter = typeof command.filter === "string" && command.filter !== "" ? command.filter.toLowerCase() : undefined;
            const bufferSize = consoleLog.length;
            let clearedCount = 0;
            if (command.clear === true) {
              clearedCount = consoleLog.length;
              consoleLog.length = 0;
              consoleCounts.error = 0;
              consoleCounts.warning = 0;
              consoleTotal = 0;
            }
            let entries = consoleLog.map((entry) => ({ ...entry }));
            if (filter !== undefined) entries = entries.filter((entry) => JSON.stringify(entry).toLowerCase().includes(filter));
            const matched = entries.length;
            entries = entries.slice(-limit);
            let probe;
            try {
              probe = await current.executeJavaScript(logsProbeJs());
            } catch {
              probe = undefined;
            }
            return {
              ok: true,
              entries,
              matched,
              bufferSize,
              bufferLimit: consoleLimit,
              totalSeen: consoleTotal,
              clearedCount,
              filter: command.filter,
              probe: probe !== null && typeof probe === "object" ? probe : {},
            };
          }
          case "emulate": {
            const current = await requireReady();
            const scheme = String(command.colorScheme ?? "auto");
            if (scheme !== "light" && scheme !== "dark" && scheme !== "auto") {
              throw new Error('emulate colorScheme must be "light", "dark" or "auto"');
            }
            const result = await current.executeJavaScript(emulateJs(scheme));
            themeState = scheme;
            return { ok: true, scheme, ...(result !== null && typeof result === "object" ? result : {}) };
          }
          case "setContent": {
            const current = await requireReady();
            const html = String(command.html ?? "");
            const baseUrl = typeof command.baseUrl === "string" && command.baseUrl !== "" ? command.baseUrl : undefined;
            const rendered = injectBaseHref(html, baseUrl);
            let context = "about:blank";
            if (!isBlankUrl(readUrl())) {
              // Get to a blank document so the HTML owns the whole page; if the
              // shell/session refuses about:blank, render in place and say so.
              context = "in-place";
              try {
                await current.loadURL("about:blank");
                for (let attempt = 0; attempt < 10; attempt += 1) {
                  await sleepImpl(150);
                  if (isBlankUrl(readUrl())) break;
                }
                if (isBlankUrl(readUrl())) context = "about:blank";
              } catch {
                context = "in-place";
              }
            }
            const result = await current.executeJavaScript(setContentJs(rendered.html));
            lastSnapshot = undefined;
            lastNavigation = { url: result?.url ?? "", title: result?.title ?? "" };
            if (themeState !== "auto") {
              try {
                await current.executeJavaScript(emulateJs(themeState));
              } catch {
                // Best effort: the new document may still be parsing.
              }
            }
            return {
              ok: true,
              context,
              title: result?.title ?? "",
              url: result?.url ?? "",
              viewport: result?.viewport,
              baseUrl: baseUrl ?? null,
              injectedBase: rendered.injected === true,
              warning: rendered.warning,
              bytes: utf8Length(html),
            };
          }
          case "close": {
            const wasOpen = webview !== undefined;
            unmount();
            return { ok: true, closed: wasOpen };
          }
          case "screenshot": {
            const current = await requireReady();
            const format = command.format === "jpeg" ? "jpeg" : "png";
            const quality = Math.max(1, Math.min(100, Number(command.quality ?? 80)));
            const hideCursor = command.hideCursor !== false;
            let rect;
            let mode = "viewport";
            let elementInfo;
            let clipInfo;
            let viewportInfo;
            let screenshotTargetResult;
            if (command.ref !== undefined || command.selector !== undefined) {
              screenshotTargetResult = await current.executeJavaScript(
                screenshotTargetJs({
                  ...(command.ref === undefined || command.ref === null ? {} : { ref: String(command.ref) }),
                  ...(typeof command.selector === "string" && command.selector !== "" ? { selector: command.selector } : {}),
                }),
              );
              if (screenshotTargetResult === undefined || screenshotTargetResult === null || screenshotTargetResult.ok !== true) {
                throw new Error(screenshotTargetResult?.error ?? "screenshot target not found; take a snapshot first");
              }
              rect = screenshotTargetResult.rect;
              viewportInfo = screenshotTargetResult.viewport;
              elementInfo = { target: screenshotTargetResult.target, clippedToViewport: screenshotTargetResult.clipped === true };
              mode = "element";
            } else if (command.clip !== undefined && command.clip !== null) {
              viewportInfo = await current.executeJavaScript(viewportInfoJs());
              rect = clampRect(command.clip, viewportInfo);
              if (rect === undefined) throw new Error("screenshot clip is outside the viewport");
              clipInfo = rect;
              mode = "clip";
            } else if (command.fullPage === true) {
              mode = "fullPage";
            }
            let cursorHidden = false;
            try {
              if (hideCursor) {
                try {
                  await current.executeJavaScript(cursorVisibilityJs(true));
                  cursorHidden = true;
                } catch {
                  cursorHidden = false;
                }
              }
              if (mode === "fullPage") {
                // Scroll-stitch instead of resizing the guest: growing a real
                // Electron <webview> element and then calling capturePage hung
                // in a real session (capturePage never settled and wedged the
                // command loop), so full-page evidence must not resize.
                const stitched = await captureFullPage(current, { format, quality });
                return {
                  ok: true,
                  dataUrl: stitched.dataUrl,
                  format,
                  mode,
                  fullPage: stitched.fullPage,
                  viewport: {
                    width: stitched.viewportInfo.innerWidth,
                    height: stitched.viewportInfo.innerHeight,
                  },
                  devicePixelRatio: undefined,
                  hideCursor,
                };
              }
              if (mode === "element" && elementStitchPlan(screenshotTargetResult) !== undefined) {
                // An element taller than the viewport (or lying outside it) is
                // scroll-stitched instead of clipped to the first screen;
                // shares the fullPage stitch base with its own receipt fields.
                if (typeof current.capturePage !== "function") throw new Error("capturePage is not available in this webview");
                const stitched = await captureTallElement(current, screenshotTargetResult, { format, quality });
                return {
                  ok: true,
                  dataUrl: stitched.dataUrl,
                  format,
                  mode,
                  element: stitched.element,
                  viewport: stitched.viewport,
                  devicePixelRatio: undefined,
                  hideCursor,
                };
              }
              if (typeof current.capturePage !== "function") throw new Error("capturePage is not available in this webview");
              const image = await withCaptureTimeout(
                rect === undefined ? Promise.resolve(current.capturePage()) : Promise.resolve(current.capturePage(rect)),
                captureTimeoutMs,
                "capturePage",
              );
              const dataUrl = await imageToDataUrl(image, format, quality);
              if (viewportInfo === undefined || viewportInfo === null) {
                try {
                  viewportInfo = await current.executeJavaScript(viewportInfoJs());
                } catch {
                  viewportInfo = undefined;
                }
              }
              if (viewportInfo === null) viewportInfo = undefined;
              return {
                ok: true,
                dataUrl,
                format,
                mode,
                width: rect?.width,
                height: rect?.height,
                clip: clipInfo,
                element: elementInfo,
                viewport:
                  viewportInfo === undefined
                    ? undefined
                    : { width: viewportInfo.innerWidth, height: viewportInfo.innerHeight },
                devicePixelRatio: viewportInfo?.devicePixelRatio,
                hideCursor,
              };
            } finally {
              if (cursorHidden) {
                try {
                  await current.executeJavaScript(cursorVisibilityJs(false));
                } catch {
                  // The page may have navigated away mid-capture.
                }
              }
            }
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
        return {
          ready,
          hasWebview: webview !== undefined,
          url,
          title: lastSnapshot?.title ?? lastNavigation.title ?? "",
          viewport:
            viewportState === undefined
              ? { auto: true }
              : { width: viewportState.width, height: viewportState.height, scale: viewportState.scale, auto: false },
          theme: themeState,
          // Where the guest actually lives: a pane renders black while the
          // element sits in a detached/zero-sized container even though every
          // command still works, so expose the geometry for diagnosis.
          panel: panelGeometry(),
          console: { errors: consoleCounts.error, warnings: consoleCounts.warning, total: consoleTotal, buffer: consoleLog.length },
          lastUrl: lastNavigation.url || url,
          lastTitle: lastNavigation.title || lastSnapshot?.title || "",
          // The URL of the last open/navigate attempt lets the agent compare
          // what it asked for with where the guest actually ended up.
          attemptedUrl: lastAttempt?.url,
          // In DSH Desktop the shell cancels guest requests to this origin;
          // standalone 'dsh web' exposes no transport, so this is undefined.
          hostOrigin: desktopTransport()?.streamBaseUrl,
          lastLoadFailure,
        };
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
              let payload = JSON.stringify(result);
              // The bridge rejects oversized result bodies (HTTP 413) and the
              // Host would only see a timeout. Fail loudly with guidance first.
              if (payload.length > MAX_RESULT_CHARS) {
                result = {
                  ok: false,
                  error: `result too large for the bridge (${payload.length} chars; limit ${MAX_RESULT_CHARS}) — retry with format "jpeg", a smaller clip/viewport, or a shorter fullPage`,
                };
                payload = JSON.stringify(result);
              }
              const posted = await fetch(`${BASE}/result?id=${encodeURIComponent(message.id)}`, {
                method: "POST",
                headers: authHeaders({ "content-type": "application/json" }),
                body: payload,
                signal: fetchSignal(lifetime, 4000),
              });
              if (!posted.ok) {
                void postDiag("panel", {
                  phase: "result-rejected",
                  id: message.id,
                  status: posted.status,
                  chars: payload.length,
                });
              }
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
            resetPanel: () => {
              let closed = 0;
              try {
                const openTabs = ctx.sidebarRight?.openTabs;
                const snapshot =
                  openTabs !== undefined && typeof openTabs.getSnapshot === "function" ? openTabs.getSnapshot() : undefined;
                for (const tab of Array.isArray(snapshot) ? snapshot : []) {
                  const id = typeof tab?.id === "string" ? tab.id : undefined;
                  if (id === undefined) continue;
                  if (tab.kind !== TAB_KIND && id !== TAB_ID) continue;
                  try {
                    ctx.sidebarRight.close(id);
                    closed += 1;
                  } catch {
                    // Already gone.
                  }
                }
              } catch {
                // Opening a fresh tab below still has a chance.
              }
              try {
                ctx.sidebarRight?.openTab?.(TAB_KIND, { revealIfOpened: true });
              } catch {
                // The floating fallback still applies.
              }
              return closed;
            },
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
                // revealIfOpened activates the existing tab: a body that mounts
                // while the tab is not selected can leave the guest unattached
                // (black panel until the next remount).
                ctx.sidebarRight.openTab(TAB_KIND, { revealIfOpened: true });
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
          // Older builds minted a random tab kind per module load. Those tabs
          // stay in the persisted right-sidebar layout with no body and render
          // as black panes; close them now that the tab identity is stable.
          const closedLegacyTabs = new Set();
          const closeStaleTabs = () => {
            try {
              const openTabs = ctx.sidebarRight?.openTabs;
              const snapshot =
                openTabs !== undefined && typeof openTabs.getSnapshot === "function" ? openTabs.getSnapshot() : undefined;
              const ids = staleTabIds(snapshot);
              let closed = 0;
              for (const id of ids) {
                if (closedLegacyTabs.has(id)) continue;
                closedLegacyTabs.add(id);
                try {
                  ctx.sidebarRight.close(id);
                  closed += 1;
                } catch {
                  // Already closed or not closable in this build.
                }
              }
              void postDiag("panel", {
                phase: "stale-tabs-closed",
                closed,
                total: Array.isArray(snapshot) ? snapshot.length : 0,
              });
            } catch (error) {
              void postDiag("panel", { phase: "stale-tabs-cleanup-failed", error: String(error && error.message ? error.message : error) });
            }
          };
          const cleanupTimer = setTimeout(closeStaleTabs, 1500);
          const cleanupTimer2 = setTimeout(closeStaleTabs, 6000);
          ctx.effect(() => () => {
            clearTimeout(cleanupTimer);
            clearTimeout(cleanupTimer2);
          }, "sidebar-browser-control.stale-tabs");
          // Fire-and-forget: never return this promise from apply (boot contract).
          const loop = createBridgeLoop(controller, lifetime.signal);
          loop.catch((error) => {
            void postDiag("panel", { phase: "loop-stopped", error: String(error && error.stack ? error.stack : error) });
          });
        } catch (error) {
          void postDiag("panel", { phase: "apply-failed", error: String(error && error.message ? error.message : error) });
        }
      },
      __test: {
        createPanelController,
        desktopTransport,
        applicationHostBlock,
        assertLoadable,
        describeLoadError,
        loadFailureLine,
        staleTabIds,
        rewriteColorSchemeQuery,
        injectBaseHref,
        clampRect,
        bytesToBase64,
        imageToDataUrl,
        isBlankUrl,
        emulateJs,
        setContentJs,
        metricsJs,
        waitConditionsJs,
      },
    };
  },
});

