/**
 * Loopback bridge between the DSH Host half and a browser-side client half.
 *
 * Extracted from the plugin so the HTTP contract can be tested in plain Node:
 * the plugin supplies the port/token/state file, tests supply port 0 and a
 * temp state path. No DSH imports, only node builtins.
 *
 * Security posture (see docs/browser-control.md §15):
 * - bound to 127.0.0.1 only;
 * - requires `Authorization: Bearer <token>` on every route (never a query
 *   parameter, which lands in logs and process listings);
 * - rejects a foreign `Host` header (DNS rebinding);
 * - rejects a browser `Origin` that is not the DSH renderer, so a random web
 *   page cannot drive the bridge;
 * - CORS is echoed only for an allowed origin, never `*`.
 */
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { writeFileSync } from "node:fs";

/** Origins allowed to call the bridge from a browser context. */
const DEFAULT_ALLOWED_ORIGINS = ["dsh-app://app", "null"];

function normalizeOrigin(origin) {
  const value = String(origin).trim();
  if (value === "null") return value;
  return value.replace(/\/+$/u, "");
}

function tokenEquals(provided, expected) {
  const left = Buffer.from(String(provided));
  const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * @param {object} options
 * @param {number} options.port 0 asks the OS for a free port (tests).
 * @param {string} options.token shared secret, sent as `Authorization: Bearer`.
 * @param {string} options.stateFile diagnostics file written on every state change.
 * @param {number} [options.pollTimeoutMs] how long one /poll may stay open.
 * @param {number} [options.commandTimeoutMs] how long a command may wait for its result.
 * @param {string[]} [options.allowedOrigins] browser origins allowed to call the bridge.
 * @param {(message: string) => void} [options.log]
 */
export function createBridge(options) {
  const pollTimeoutMs = options.pollTimeoutMs ?? 20000;
  const commandTimeoutMs = options.commandTimeoutMs ?? 10000;
  const allowedOrigins = new Set((options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS).map(normalizeOrigin));
  const log = options.log ?? (() => {});

  /** clientId -> { seenAt, firstSeenAt }. Only the newest registration is routed to. */
  const clients = new Map();
  /** Commands waiting for a client poll. */
  const queue = [];
  /** commandId -> { resolve, timer, sentAt }. */
  const pending = new Map();
  /** Poll waiters currently held open; a command resolves the active client's waiter. */
  const pollWaiters = new Set();
  /** Diagnostic fields that must survive frequent /poll state rewrites. */
  const sticky = {};

  let server;
  let listeningPort;

  /** Newest registered client: stale module instances must not steal commands. */
  function activeClientId() {
    let active;
    let best = -Infinity;
    for (const [id, record] of clients) {
      if (record.firstSeenAt > best) {
        best = record.firstSeenAt;
        active = id;
      }
    }
    return active;
  }

  function writeState(extra = {}) {
    const state = {
      at: new Date().toISOString(),
      listening: server !== undefined,
      port: listeningPort,
      clients: [...clients.entries()].map(([id, record]) => ({ id, seenAt: record.seenAt })),
      activeClient: activeClientId(),
      queue: queue.length,
      pending: pending.size,
      ...sticky,
      ...extra,
    };
    try {
      writeFileSync(options.stateFile, JSON.stringify(state, null, 2));
    } catch {
      // Diagnostics must never break the bridge.
    }
    return state;
  }

  function pushCommand(cmd) {
    const id = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const active = activeClientId();
    let waiter;
    for (const candidate of pollWaiters) {
      if (candidate.clientId === active) {
        waiter = candidate;
        break;
      }
    }
    if (waiter !== undefined) {
      pollWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.respond({ id, cmd });
    } else {
      queue.push({ id, cmd, queuedAt: Date.now() });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A command whose client never came back must not be replayed into a
        // later panel session: drop it from the queue as well as reject.
        const index = queue.findIndex((entry) => entry.id === id);
        if (index >= 0) queue.splice(index, 1);
        pending.delete(id);
        writeState({ lastTimeout: id });
        reject(new Error("browser bridge: no client result before timeout"));
      }, commandTimeoutMs);
      pending.set(id, { resolve, timer, sentAt: Date.now() });
    });
  }

  function settleResult(id, value) {
    const entry = pending.get(id);
    if (entry === undefined) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve({ latencyMs: Date.now() - entry.sentAt, value });
    writeState({ lastResult: id });
    return true;
  }

  function addDiag(value) {
    sticky.diags = [
      ...(sticky.diags ?? []),
      { at: new Date().toISOString(), tag: value?.tag, value: value?.value },
    ].slice(-20);
    writeState();
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) reject(new Error("body too large"));
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  /** Return the origin when it may call the bridge, otherwise reject the request. */
  function deniedOrigin(req) {
    const origin = req.headers.origin;
    if (origin === undefined || origin === "") return undefined;
    const normalized = normalizeOrigin(origin);
    if (allowedOrigins.has(normalized)) return undefined;
    sticky.lastRejectedOrigin = origin;
    log(`rejected origin ${origin}`);
    writeState();
    return origin;
  }

  function deniedHost(req) {
    const host = String(req.headers.host ?? "");
    const allowedHosts = new Set([`127.0.0.1:${listeningPort}`, `localhost:${listeningPort}`]);
    if (allowedHosts.has(host.toLowerCase())) return undefined;
    sticky.lastRejectedHost = host;
    log(`rejected host ${host}`);
    writeState();
    return host;
  }

  function bearerToken(req) {
    const header = String(req.headers.authorization ?? "");
    const match = /^Bearer\s+(.+)$/iu.exec(header);
    return match === null ? undefined : match[1].trim();
  }

  function route(req, res) {
    const origin = req.headers.origin;
    const cors = {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, authorization, access-control-request-private-network",
      "Access-Control-Allow-Private-Network": "true",
      "Access-Control-Max-Age": "600",
      "Cache-Control": "no-store",
      "Vary": "Origin",
    };
    if (origin !== undefined && origin !== "" && allowedOrigins.has(normalizeOrigin(origin))) {
      cors["Access-Control-Allow-Origin"] = origin;
    }
    for (const [key, value] of Object.entries(cors)) res.setHeader(key, value);

    if (deniedHost(req) !== undefined) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("bad host");
      return;
    }
    if (deniedOrigin(req) !== undefined) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("bad origin");
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const token = bearerToken(req);
    if (token === undefined || !tokenEquals(token, options.token)) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("bad token");
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${listeningPort ?? 1}`);
    const json = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "GET" && url.pathname === "/hello") {
      json(200, { ok: true, port: listeningPort, now: Date.now() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/poll") {
      const clientId = url.searchParams.get("client") ?? "anonymous";
      const existing = clients.get(clientId);
      clients.set(clientId, { seenAt: Date.now(), firstSeenAt: existing?.firstSeenAt ?? Date.now() });
      writeState();
      // Only the newest client instance is routed to; stale instances (left by
      // a plugin reinstall before the page reloads) get an immediate empty poll
      // instead of stealing commands.
      if (clientId !== activeClientId()) {
        json(200, {});
        return;
      }
      if (queue.length > 0) {
        // Never replay a command that outlived the client it was meant for: the
        // panel may have been reopened on a different page since then.
        while (queue.length > 0) {
          const entry = queue.shift();
          const ageMs = Date.now() - (entry.queuedAt ?? 0);
          if (ageMs <= commandTimeoutMs) {
            json(200, entry);
            return;
          }
          sticky.lastDroppedStale = { id: entry.id, ageMs, at: new Date().toISOString() };
          writeState();
        }
      }
      const waiter = {
        clientId,
        respond(payload) {
          if (res.writableEnded) return;
          json(200, payload);
        },
        timer: setTimeout(() => {
          pollWaiters.delete(waiter);
          waiter.respond({});
        }, pollTimeoutMs),
      };
      pollWaiters.add(waiter);
      req.on("close", () => {
        clearTimeout(waiter.timer);
        pollWaiters.delete(waiter);
      });
      return;
    }
    if (req.method === "POST" && (url.pathname === "/result" || url.pathname === "/diag")) {
      readBody(req).then(
        (body) => {
          let value;
          try {
            value = JSON.parse(body);
          } catch {
            value = { parseError: body.slice(0, 500) };
          }
          if (url.pathname === "/result") {
            const settled = settleResult(url.searchParams.get("id") ?? "", value);
            json(settled ? 200 : 404, { ok: settled });
          } else {
            addDiag(value);
            json(200, { ok: true });
          }
        },
        (error) => {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end(String(error));
        },
      );
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }

  /** Bind the listener; resolves with the actual port (useful when port is 0). */
  function start() {
    return new Promise((resolve, reject) => {
      server = createServer((req, res) => {
        try {
          route(req, res);
        } catch (error) {
          log(`request failed: ${String(error)}`);
          if (!res.headersSent) res.writeHead(500);
          res.end(String(error));
        }
      });
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", () => {
        listeningPort = server.address().port;
        writeState({ listening: true });
        resolve(listeningPort);
      });
    });
  }

  /** Close the listener and settle every waiter/pending command. */
  function close() {
    // End held long-polls first: server.close() would otherwise wait for their
    // sockets forever and keep the Host process alive.
    for (const waiter of pollWaiters) {
      clearTimeout(waiter.timer);
      try {
        waiter.respond({});
      } catch {
        // The socket may already be gone.
      }
    }
    pollWaiters.clear();
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ latencyMs: -1, value: { ok: false, error: "bridge disposed" } });
    }
    pending.clear();
    server?.closeAllConnections?.();
    server?.close();
    server = undefined;
    writeState({ listening: false });
  }

  return {
    start,
    close,
    pushCommand,
    settleResult,
    addDiag,
    writeState,
    clients,
    queue,
    pending,
    sticky,
    get port() {
      return listeningPort;
    },
  };
}
