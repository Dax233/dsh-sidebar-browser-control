/**
 * Policy-compliant local preview server for the Agent Browser.
 *
 * The DSH desktop shell only admits `http:`/`https:` frame navigation and
 * cancels `file:` requests (see docs/browser-control.md §5.1), so `file://`
 * previews are not available to a plugin. Instead of asking the user to run
 * their own static server, this module exposes a read-only static server:
 *
 * - bound to 127.0.0.1 only;
 * - every URL carries a random per-server token prefix, so nothing else on
 *   the machine can guess the URL;
 * - GET/HEAD only; no directory listings (directory → index.html, else 404);
 * - path traversal is rejected by resolving the real path and requiring it to
 *   stay inside the served directory (covers `..`, encoded `..`, backslashes,
 *   and symlinks that point outside);
 * - the owning plugin closes it on dispose.
 *
 * No third-party dependencies: node builtins only.
 */
import { createServer } from "node:http";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";

/** Largest single file the preview server will read into memory (64 MiB). */
const MAX_SERVE_BYTES = 64 * 1024 * 1024;

/** Extension → content type. Anything unknown is served as octet-stream. */
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

export function mimeTypeFor(file) {
  return MIME_TYPES[extname(String(file)).toLowerCase()] ?? "application/octet-stream";
}

function insideRoot(rootReal, candidateReal) {
  return candidateReal === rootReal || candidateReal.startsWith(rootReal + sep);
}

/**
 * Start a static preview server for one directory.
 *
 * @param {object} options
 * @param {string} options.dir directory to serve (must exist).
 * @param {string} [options.file] file served at the base URL instead of index.html.
 * @param {number} [options.port] 0 (default) asks the OS for a free port.
 * @param {string} [options.token] path token; random when omitted (tests).
 * @returns {Promise<{url:string, port:number, token:string, dir:string, file:string|null, close:() => Promise<void>, address:() => string}>}
 */
export function createPreviewServer(options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let rootReal;
    try {
      rootReal = realpathSync(resolve(String(options.dir ?? "")));
      if (!statSync(rootReal).isDirectory()) throw new Error("not a directory");
    } catch (error) {
      rejectPromise(new Error(`preview: cannot serve directory ${String(options.dir ?? "")}: ${String(error && error.message ? error.message : error)}`));
      return;
    }
    const token = typeof options.token === "string" && options.token !== "" ? options.token : randomBytes(16).toString("hex");
    const prefix = `/${token}/`;

    /** Resolve one request path inside the served directory; never escapes it. */
    function resolveInside(relativePath) {
      if (typeof relativePath !== "string" || relativePath.includes("\0")) return { bad: true };
      const withoutLeading = normalize(relativePath)
        .replace(/^([/\\])+/u, "")
        .replace(/\\/gu, "/");
      if (withoutLeading === "" || withoutLeading === ".") return { directory: true, real: rootReal };
      const lexical = resolve(rootReal, withoutLeading);
      if (!insideRoot(rootReal, lexical)) return { bad: true };
      let real;
      try {
        real = realpathSync(lexical);
      } catch {
        return { missing: true };
      }
      if (!insideRoot(rootReal, real)) return { bad: true };
      return { real };
    }

    /** Pick the file for one decoded request path, honoring index.html default. */
    function targetFor(relativePath) {
      let current = relativePath;
      for (let depth = 0; depth < 8; depth += 1) {
        if (current === "") current = "index.html";
        const resolved = resolveInside(current);
        if (resolved.bad === true || resolved.missing === true) return undefined;
        if (resolved.directory === true) {
          current = current.replace(/\/+$/u, "") + "/index.html";
          continue;
        }
        try {
          if (statSync(resolved.real).isDirectory()) {
            current = current.replace(/\/+$/u, "") + "/index.html";
            continue;
          }
        } catch {
          return undefined;
        }
        return resolved.real;
      }
      return undefined;
    }

    // The file served at the bare base URL (preview {file} option).
    let baseFileReal;
    if (typeof options.file === "string" && options.file.trim() !== "") {
      const file = options.file.trim().replace(/\\/gu, "/").replace(/^([/\\])+/u, "");
      const resolved = resolveInside(file);
      if (resolved.bad === true || resolved.missing === true || resolved.directory === true) {
        rejectPromise(new Error(`preview: file "${options.file}" is not inside ${rootReal}`));
        return;
      }
      baseFileReal = resolved.real;
    }

    function send(res, status, headers, body) {
      res.writeHead(status, headers);
      if (body === undefined) res.end();
      else res.end(body);
    }

    const server = createServer((req, res) => {
      try {
        if (req.method !== "GET" && req.method !== "HEAD") {
          send(res, 405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "method not allowed");
          return;
        }
        let pathname = "/";
        try {
          pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        } catch {
          send(res, 400, { "content-type": "text/plain; charset=utf-8" }, "bad request");
          return;
        }
        // An unguessable token prefix gates every path; answer 404 so the
        // existence of the server is not confirmed by a 403.
        if (!pathname.startsWith(prefix)) {
          send(res, 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "not found");
          return;
        }
        const rawRelative = pathname.slice(prefix.length);
        let relativePath;
        try {
          relativePath = decodeURIComponent(rawRelative);
        } catch {
          send(res, 400, { "content-type": "text/plain; charset=utf-8" }, "bad request");
          return;
        }
        const file = baseFileReal !== undefined && (relativePath === "" || relativePath === "/") ? baseFileReal : targetFor(relativePath);
        if (file === undefined) {
          send(res, 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "not found");
          return;
        }
        // A preview is for source/assets, not multi-GB media: refuse an entry
        // that would be read into Host memory whole.
        let stats;
        try {
          stats = statSync(file);
        } catch {
          send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "not found");
          return;
        }
        if (!stats.isFile()) {
          send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "not found");
          return;
        }
        if (stats.size > MAX_SERVE_BYTES) {
          send(
            res,
            413,
            { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
            `file too large for preview (${stats.size} bytes; limit ${MAX_SERVE_BYTES})`,
          );
          return;
        }
        let bytes;
        try {
          bytes = readFileSync(file);
        } catch {
          send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "not found");
          return;
        }
        const headers = {
          "content-type": mimeTypeFor(file),
          "content-length": String(bytes.length),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        };
        if (req.method === "HEAD") send(res, 200, headers);
        else send(res, 200, headers, bytes);
      } catch (error) {
        try {
          send(res, 500, { "content-type": "text/plain; charset=utf-8" }, String(error && error.message ? error.message : error));
        } catch {
          // Socket already gone.
        }
      }
    });

    let closed = false;
    function close() {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise((resolveClose) => {
        server.closeAllConnections?.();
        server.close(() => resolveClose());
        // A server that never started listening resolves immediately below.
        if (!server.listening) resolveClose();
      });
    }

    server.once("error", (error) => {
      rejectPromise(new Error(`preview server: ${String(error && error.message ? error.message : error)}`));
    });
    server.listen(Number(options.port ?? 0), "127.0.0.1", () => {
      const address = server.address();
      const port = address.port;
      const basePath = typeof options.file === "string" && options.file.trim() !== "" ? options.file.trim().replace(/\\/gu, "/").replace(/^([/\\])+/u, "") : "";
      resolvePromise({
        url: `http://127.0.0.1:${port}${prefix}${basePath}`,
        port,
        host: address.address,
        token,
        dir: rootReal,
        file: options.file ?? null,
        close,
        address: () => `http://127.0.0.1:${port}`,
      });
    });
  });
}

export const __test = { mimeTypeFor, insideRoot, isAbsolute };
