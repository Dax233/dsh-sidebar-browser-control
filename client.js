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
        const rect = el.getBoundingClientRect();
        const viewport = {
          width: Math.round(window.innerWidth || 0),
          height: Math.round(window.innerHeight || 0),
          devicePixelRatio: window.devicePixelRatio || 1
        };
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
        if (SCHEME === 'light' || SCHEME === 'dark') {
          state.scheme = SCHEME;
          if (document.documentElement && document.documentElement.style) document.documentElement.style.colorScheme = SCHEME;
          scan();
          if (typeof MutationObserver === 'function' && document.documentElement) {
            if (!state.observer) {
              state.observer = new MutationObserver(() => {
                if (state.scanTimer) return;
                state.scanTimer = setTimeout(() => { state.scanTimer = undefined; scan(); }, 120);
              });
              state.observer.observe(document.documentElement, { subtree: true, childList: true });
            }
          }
          if (!state.poll) {
            let remaining = 20;
            state.poll = setInterval(() => {
              scan();
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
      const captureTimeoutMs = options.captureTimeoutMs ?? 12000;
      const viewportSettleMs = options.viewportSettleMs ?? 2000;

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
      let lastNavigation = { url: "", title: "" };
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
        mountContainer = undefined;
        viewportState = undefined;
        themeState = "auto";
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

      /** Draw stitched viewport captures into one canvas and encode it. */
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
        for (const segment of segments) {
          const image = new ImageCtor();
          image.src = segment.dataUrl;
          if (typeof image.decode === "function") await image.decode();
          else {
            await new Promise((resolve, reject) => {
              image.onload = resolve;
              image.onerror = () => reject(new Error("a fullPage capture segment could not be decoded"));
            });
          }
          context.drawImage(image, 0, segment.actualY, Math.round(width), Math.round(viewportHeight));
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
       */
      async function captureFullPage(current, options = {}) {
        if (typeof current.capturePage !== "function") throw new Error("capturePage is not available in this webview");
        const format = options.format === "jpeg" ? "jpeg" : "png";
        const quality = options.quality;
        let scrollbarsHidden = false;
        let originalScrollY = 0;
        try {
          // Hide scrollbars first: the layout width grows by the scrollbar
          // width, so dimensions must be read after it is applied.
          try {
            const hidden = await current.executeJavaScript(scrollbarVisibilityJs(true));
            scrollbarsHidden = hidden?.hidden === true;
          } catch {
            scrollbarsHidden = false;
          }
          if (scrollbarsHidden) await sleepImpl(60);
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
            // `behavior: 'instant'` bypasses a page's `scroll-behavior: smooth`,
            // which would otherwise animate and make the capture frame lag.
            await current.executeJavaScript(`(() => { window.scrollTo({ top: ${targetY}, left: 0, behavior: 'instant' }); return 1; })()`);
            await sleepImpl(60);
            const image = await withCaptureTimeout(Promise.resolve(current.capturePage()), captureTimeoutMs, "capturePage");
            // The browser clamps a scroll near the bottom; record where the
            // frame really starts so the stitched output stays aligned.
            const at = await current.executeJavaScript(scrollStateJs());
            const actualY = Math.max(0, Math.round(Number(at?.scrollY ?? targetY)));
            segments.push({ actualY, dataUrl: await imageToDataUrl(image, "png", 100) });
            if (actualY >= capturedHeight - viewportHeight) break;
            targetY += viewportHeight;
          }
          const dataUrl = await stitchSegments(segments, viewportWidth, capturedHeight, viewportHeight, format, quality);
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
            },
            viewportInfo: { innerWidth: viewportWidth, innerHeight: viewportHeight },
          };
        } finally {
          try {
            await current.executeJavaScript(`(() => { window.scrollTo({ top: ${originalScrollY}, left: 0, behavior: 'instant' }); return 1; })()`);
          } catch {
            // The page may have navigated away mid-capture.
          }
          if (scrollbarsHidden) {
            try {
              await current.executeJavaScript(scrollbarVisibilityJs(false));
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

      /** Navigation invalidates the in-page cursor/refs; replay emulation if set. */
      async function afterNavigation(current, info, fallbackUrl) {
        lastSnapshot = undefined;
        lastNavigation = { url: info.url || fallbackUrl || "", title: info.title || "" };
        await replayTheme(current);
      }

      /**
       * Ensure the panel exists and its webview is ready, reopening a released
       * guest when needed. Shared by open/navigate so a navigate can be the
       * first call (qa, agent shortcuts) instead of failing on a closed panel.
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
        try {
          await waitReady(2500);
        } catch {
          // The DSH right sidebar can keep a stale tab entry that never mounts
          // its body after plugin reloads; fall back to a floating panel so the
          // tool stays usable.
          await ensureFallbackMounted();
          await waitReady();
        }
      }

      async function handle(command) {
        const type = String(command?.type ?? "");
        switch (type) {
          case "status":
            return { ok: true, ...status() };
          case "open": {
            const url = toHttpUrl(command.url);
            await ensurePanelReady();
            const current = await requireReady();
            await current.loadURL(url);
            await sleepImpl(Number(command.waitMs ?? 350));
            const info = await pageInfo();
            await afterNavigation(current, info, url);
            return { ok: true, url: info.url || url, title: info.title, themeReapplied: themeState !== "auto" };
          }
          case "navigate": {
            const url = toHttpUrl(command.url);
            await ensurePanelReady();
            const current = await requireReady();
            await current.loadURL(url);
            await sleepImpl(Number(command.waitMs ?? 350));
            const info = await pageInfo();
            await afterNavigation(current, info, url);
            return { ok: true, url: info.url || url, title: info.title, themeReapplied: themeState !== "auto" };
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
            if (command.reset === true) {
              viewportState = undefined;
              applyViewportStyle(undefined);
              const settled = await settleViewport(current, panelSize());
              return { ok: true, reset: true, width: settled.actual.innerWidth, height: settled.actual.innerHeight, actual: settled.actual, matched: settled.matched, settledMs: settled.settledMs };
            }
            const width = Math.max(64, Math.min(10000, Math.round(Number(command.width))));
            const height = Math.max(64, Math.min(10000, Math.round(Number(command.height ?? 800))));
            if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error("viewport requires numeric width and height");
            const scale = computeScale(width, height);
            viewportState = { width, height, scale };
            applyViewportStyle(viewportState);
            const settled = await settleViewport(current, { width, height });
            return { ok: true, width, height, scale, actual: settled.actual, matched: settled.matched, settledMs: settled.settledMs, panel: panelSize() };
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
            if (command.ref !== undefined || command.selector !== undefined) {
              const target = await current.executeJavaScript(
                screenshotTargetJs({
                  ...(command.ref === undefined || command.ref === null ? {} : { ref: String(command.ref) }),
                  ...(typeof command.selector === "string" && command.selector !== "" ? { selector: command.selector } : {}),
                }),
              );
              if (target === undefined || target === null || target.ok !== true) {
                throw new Error(target?.error ?? "screenshot target not found; take a snapshot first");
              }
              rect = target.rect;
              viewportInfo = target.viewport;
              elementInfo = { target: target.target, clippedToViewport: target.clipped === true };
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
          console: { errors: consoleCounts.error, warnings: consoleCounts.warning, total: consoleTotal, buffer: consoleLog.length },
          lastUrl: lastNavigation.url || url,
          lastTitle: lastNavigation.title || lastSnapshot?.title || "",
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
      __test: {
        createPanelController,
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
