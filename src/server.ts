import express, { Request, Response } from "express";
import axios, { AxiosRequestConfig } from "axios";
import path from "path";
import { URL } from "url";
import http from "http";
import https from "https";
import net from "net";
import tls from "tls";
import type { Socket } from "net";

import { rewriteHtml, rewriteJs, rewriteCss } from "./rewriters";
import {
  buildUpstreamCookieHeader,
  rewriteSetCookieHeaders
} from "./utils/cookies";
import {
  wrap,
  absolutize,
  shouldProxyResource
} from "./utils/shared";

const app = express();
const PORT = Number(process.env.PORT || 8080);
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132 Safari/537.36";

app.use(
  express.raw({
    type: "*/*",
    limit: "25mb"
  })
);

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: false
});

app.use(express.static(path.join(__dirname, "..", "public")));

function setCommonHeaders(res: Response) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-credentials", "true");
  res.setHeader("cross-origin-opener-policy", "unsafe-none");
  res.setHeader("cross-origin-embedder-policy", "unsafe-none");
  res.setHeader("cross-origin-resource-policy", "cross-origin");
}

function failWebSocketUpgrade(socket: Socket, statusCode: number, reason: string) {
  try {
    socket.write(
      `HTTP/1.1 ${statusCode} ${reason}\r\n` +
        "Connection: close\r\n" +
        "\r\n"
    );
  } catch {
    // ignore
  }
  socket.destroy();
}

function coalesceCookieHeader(value: string | string[] | undefined) {
  if (!value) return undefined;
  return Array.isArray(value) ? value.join(";") : value;
}

const CONTROLLED_WS_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "origin",
  "cookie",
  "user-agent",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest"
]);

const HEADER_CASE_OVERRIDES: Record<string, string> = {
  "sec-websocket-key": "Sec-WebSocket-Key",
  "sec-websocket-version": "Sec-WebSocket-Version",
  "sec-websocket-extensions": "Sec-WebSocket-Extensions",
  "sec-websocket-protocol": "Sec-WebSocket-Protocol",
  "content-md5": "Content-MD5",
  "dnt": "DNT",
  "te": "TE",
  "www-authenticate": "WWW-Authenticate",
  "x-dns-prefetch-control": "X-DNS-Prefetch-Control"
};

function formatHeaderName(name: string) {
  const lower = name.toLowerCase();
  if (HEADER_CASE_OVERRIDES[lower]) return HEADER_CASE_OVERRIDES[lower];
  return lower
    .split("-")
    .map((part) => {
      if (!part) return part;
      return part[0].toUpperCase() + part.slice(1);
    })
    .join("-");
}

function rewriteLocationHeader(
  value: string | string[] | undefined,
  base: URL
) {
  if (!value) return undefined;
  const raw = Array.isArray(value) ? value[0] : String(value);
  if (!shouldProxyResource(raw)) return raw;
  try {
    const abs = absolutize(base, raw);
    if (!abs) return raw;
    return wrap(abs);
  } catch {
    return raw;
  }
}

function isSecureRequest(req: Request) {
  if (req.secure) return true;
  const forwarded = req.headers["x-forwarded-proto"];
  if (Array.isArray(forwarded)) {
    return forwarded.some((value) => value?.toLowerCase() === "https");
  }
  if (typeof forwarded === "string") {
    return forwarded.toLowerCase() === "https";
  }
  return false;
}

function sanitizeRequestHeaders(req: Request, target: URL) {
  const out: Record<string, string> = {};

  for (const [name, value] of Object.entries(req.headers)) {
    if (value == null) continue;

    const lower = name.toLowerCase();
    if (
      [
        "host",
        "connection",
        "content-length",
        "accept-encoding",
        "upgrade",
        "cookie"
      ].includes(lower)
    )
      continue;

    out[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }

  out["accept-encoding"] = "identity";
  out["host"] = target.host;
  out["origin"] = target.origin;

  if (!out["user-agent"]) {
    out["user-agent"] = DEFAULT_USER_AGENT;
  }

  const cookieHeader = buildUpstreamCookieHeader(
    coalesceCookieHeader(req.headers.cookie),
    target
  );

  if (cookieHeader) {
    out["cookie"] = cookieHeader;
  }

  return out;
}

function stripDangerousResponseHeaders(upHeaders: any, res: Response) {
  for (const [name, value] of Object.entries(upHeaders)) {
    if (value == null) continue;
    const lower = name.toLowerCase();

    if (
      [
        "content-security-policy",
        "content-security-policy-report-only",
        "x-frame-options",
        "x-content-type-options",
        "strict-transport-security",
        "content-length",
        "content-encoding",
        "transfer-encoding",
        "connection",
        "set-cookie"
      ].includes(lower)
    )
      continue;

    res.setHeader(name, value as any);
  }
}

app.all("/proxy", async (req, res) => {
  const raw = String(req.query.url || "");
  if (!raw) return res.status(400).send("Missing ?url=");

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return res.status(400).send("Invalid URL");
  }

  const headers = sanitizeRequestHeaders(req, target);
  const secureProxy = isSecureRequest(req);

  const config: AxiosRequestConfig = {
    url: target.href,
    method: req.method as any,
    headers,
    responseType: "arraybuffer",
    validateStatus: () => true,
    httpAgent,
    httpsAgent,
    maxRedirects: 0
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    config.data = req.body;
  }

  try {
    const upstream = await axios(config);

    const status = upstream.status;
    const ct = String(upstream.headers["content-type"] || "");

    stripDangerousResponseHeaders(upstream.headers, res);
    setCommonHeaders(res);
    const rewrittenSetCookies = rewriteSetCookieHeaders(
      upstream.headers["set-cookie"],
      target,
      { secureProxy }
    );
    if (rewrittenSetCookies.length) {
      res.setHeader("set-cookie", rewrittenSetCookies);
    }
    const rewrittenLocation = rewriteLocationHeader(
      upstream.headers["location"],
      target
    );
    if (rewrittenLocation) {
      res.setHeader("location", rewrittenLocation);
    }

    const buf: Buffer = upstream.data;

    const isHtml = ct.includes("text/html");
    const isJs = ct.includes("javascript");
    const isCss = ct.includes("text/css");

    if (isHtml || isJs || isCss) {
      let text = buf.toString("utf8");

      if (isHtml) text = rewriteHtml(text, target);
      if (isJs) text = rewriteJs(text, target);
      if (isCss) text = rewriteCss(text, target);

      const safeCt = ct.replace(/;\s*charset=[^;]+/i, "") + "; charset=utf-8";
      res.status(status).setHeader("content-type", safeCt);
      return res.send(text);
    }

    res.status(status).send(buf);
  } catch (err: any) {
    console.error("Proxy error:", err?.message || err);
    res.status(502).send("Upstream error");
  }
});


/**
 * ======================================================
 * REAL RAW WEBSOCKET TUNNEL (Discord-safe)
 * ======================================================
 */

const server = http.createServer(app);

server.on("upgrade", (req, socket: Socket, head) => {
  const reject = (code: number, reason: string) =>
    failWebSocketUpgrade(socket, code, reason);

  try {
    const localUrl = new URL("http://local" + (req.url || ""));
    if (localUrl.pathname !== "/proxy_ws") {
      return reject(404, "Not Found");
    }

    const targetRaw = localUrl.searchParams.get("url");
    if (!targetRaw) {
      return reject(400, "Missing Target");
    }

    const target = new URL(targetRaw);
    const clientKey = req.headers["sec-websocket-key"];
    if (!clientKey || Array.isArray(clientKey)) {
      return reject(400, "Missing WebSocket Key");
    }

    const upstreamPath = `${target.pathname || "/"}${target.search || ""}`;
    const isSecure = target.protocol === "wss:";
    const port = Number(target.port || (isSecure ? 443 : 80));

    const cookieHeader = buildUpstreamCookieHeader(
      coalesceCookieHeader(req.headers.cookie),
      target
    );

    const headers: string[] = [
      `GET ${upstreamPath || "/"} HTTP/1.1`,
      `Host: ${target.host}`,
      "Connection: Upgrade",
      "Upgrade: websocket"
    ];

    const forwardHeader = (label: string, value?: string | string[]) => {
      if (!value) return;
      const normalized = Array.isArray(value) ? value.join(", ") : String(value);
      if (!normalized) return;
      headers.push(`${label}: ${normalized}`);
    };

    forwardHeader("Sec-WebSocket-Key", clientKey);
    forwardHeader(
      "Sec-WebSocket-Version",
      req.headers["sec-websocket-version"] as string
    );
    forwardHeader(
      "Sec-WebSocket-Extensions",
      req.headers["sec-websocket-extensions"] as string
    );
    forwardHeader(
      "Sec-WebSocket-Protocol",
      req.headers["sec-websocket-protocol"] as string | string[]
    );
    forwardHeader(
      "User-Agent",
      (req.headers["user-agent"] as string) || DEFAULT_USER_AGENT
    );
    if (req.headers["sec-fetch-site"])
      forwardHeader("Sec-Fetch-Site", req.headers["sec-fetch-site"] as string);
    if (req.headers["sec-fetch-mode"])
      forwardHeader("Sec-Fetch-Mode", req.headers["sec-fetch-mode"] as string);
    if (req.headers["sec-fetch-dest"])
      forwardHeader("Sec-Fetch-Dest", req.headers["sec-fetch-dest"] as string);

    for (const [name, value] of Object.entries(req.headers)) {
      if (value == null) continue;
      const lower = name.toLowerCase();
      if (CONTROLLED_WS_HEADERS.has(lower)) continue;
      const normalized = Array.isArray(value)
        ? value.join(", ")
        : String(value);
      if (!normalized) continue;
      headers.push(`${formatHeaderName(lower)}: ${normalized}`);
    }

    headers.push(`Origin: ${target.origin}`);

    if (cookieHeader) {
      headers.push(`Cookie: ${cookieHeader}`);
    }

    headers.push("", "");
    const requestPayload = headers.join("\r\n");

    const upstream: Socket = isSecure
      ? (tls.connect({
        port,
        host: target.hostname,
        servername: target.hostname,
        rejectUnauthorized: false
      }) as Socket)
      : net.connect({
        port,
        host: target.hostname
      });

    upstream.setNoDelay(true);
    socket.setNoDelay(true);

    let tunneled = false;
    const cleanup = () => {
      upstream.destroy();
      socket.destroy();
    };

    const onConnected = () => {
      tunneled = true;
      upstream.write(requestPayload);
      if (head && head.length) {
        upstream.write(head);
      }
      socket.pipe(upstream);
      upstream.pipe(socket);
    };

    if (isSecure) {
      upstream.once("secureConnect", onConnected);
    } else {
      upstream.once("connect", onConnected);
    }

    upstream.on("error", () => {
      if (!tunneled) {
        reject(502, "Bad Gateway");
      }
      cleanup();
    });
    socket.on("error", () => cleanup());
    socket.on("close", () => upstream.end());
    upstream.on("close", () => socket.end());
  } catch (err) {
    reject(502, "Bad Gateway");
  }
});

server.listen(PORT, () =>
  console.log("Proxy running on http://localhost:" + PORT)
);
