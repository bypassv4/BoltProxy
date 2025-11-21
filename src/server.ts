import express, { Request, Response } from "express";
import axios, { AxiosRequestConfig } from "axios";
import path from "path";
import { URL } from "url";
import http from "http";
import https from "https";
import WebSocket, { WebSocketServer } from "ws";

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
  out["referer"] = target.href;
  if (req.headers["accept-language"]) {
    out["accept-language"] = String(req.headers["accept-language"]);
  }
  if (req.headers["sec-fetch-site"])
    out["sec-fetch-site"] = String(req.headers["sec-fetch-site"]);
  if (req.headers["sec-fetch-mode"])
    out["sec-fetch-mode"] = String(req.headers["sec-fetch-mode"]);
  if (req.headers["sec-fetch-dest"])
    out["sec-fetch-dest"] = String(req.headers["sec-fetch-dest"]);
  if (req.headers["sec-ch-ua"])
    out["sec-ch-ua"] = String(req.headers["sec-ch-ua"]);
  if (req.headers["sec-ch-ua-platform"])
    out["sec-ch-ua-platform"] = String(req.headers["sec-ch-ua-platform"]);
  if (req.headers["sec-ch-ua-mobile"])
    out["sec-ch-ua-mobile"] = String(req.headers["sec-ch-ua-mobile"]);

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
    maxRedirects: 0,
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    // Forward the exact bytes the client sent; axios will set content-length.
    config.data = req.body && (req.body as Buffer).length ? req.body : undefined;
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
 * WEBSOCKET RELAY (Discord-safe, bidirectional)
 * ======================================================
 */

const server = http.createServer(app);
const wsServer = new WebSocketServer({ noServer: true });

function buildUpstreamWsHeaders(req: http.IncomingMessage, target: URL) {
  const headers: Record<string, string> = {
    Host: target.host,
    Origin: target.origin,
    Referer: target.href,
    "User-Agent": (req.headers["user-agent"] as string) || DEFAULT_USER_AGENT
  };

  if (req.headers["accept-language"]) {
    headers["Accept-Language"] = String(req.headers["accept-language"]);
  }
  if (req.headers["sec-websocket-protocol"]) {
    headers["Sec-WebSocket-Protocol"] = String(
      req.headers["sec-websocket-protocol"]
    );
  }
  if (req.headers["sec-websocket-extensions"]) {
    headers["Sec-WebSocket-Extensions"] = String(
      req.headers["sec-websocket-extensions"]
    );
  }

  const cookieHeader = buildUpstreamCookieHeader(
    coalesceCookieHeader(req.headers.cookie),
    target
  );
  if (cookieHeader) {
    headers["Cookie"] = cookieHeader;
  }

  return headers;
}

function proxyWebSocket(client: WebSocket, req: http.IncomingMessage, target: URL) {
  const protocolsRaw = req.headers["sec-websocket-protocol"];
  const protocols = Array.isArray(protocolsRaw)
    ? protocolsRaw
    : protocolsRaw
      ? String(protocolsRaw)
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
      : undefined;

  const upstreamHeaders = buildUpstreamWsHeaders(req, target);
  const upstream = new WebSocket(target.href, protocols, {
    headers: upstreamHeaders,
    rejectUnauthorized: false,
    perMessageDeflate: false
  });

  const closeBoth = (code = 1011, reason?: string) => {
    try {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(code, reason);
      }
    } catch {
      // ignore
    }
    try {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close(code, reason);
      }
    } catch {
      // ignore
    }
  };

  upstream.on("open", () => {
    client.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      }
    });
    upstream.on("message", (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });
  });

  client.on("close", (code, reason) => {
    upstream.close(code || 1000, reason.toString());
  });
  upstream.on("close", (code, reason) => {
    client.close(code || 1011, reason.toString());
  });

  client.on("error", () => closeBoth(1011, "Client error"));
  upstream.on("error", () => closeBoth(1011, "Upstream error"));
}

server.on("upgrade", (req, socket, head) => {
  if (!req.url?.startsWith("/proxy_ws")) {
    socket.destroy();
    return;
  }

  try {
    const full = new URL("http://localhost" + req.url);
    const targetParam = full.searchParams.get("url");
    if (!targetParam) {
      socket.destroy();
      return;
    }

    const target = new URL(targetParam);

    wsServer.handleUpgrade(req, socket, head, (client) => {
      proxyWebSocket(client, req, target);
    });
  } catch (err) {
    console.error("WebSocket Proxy Error:", err);
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  }
});

server.listen(PORT, () =>
  console.log("Proxy running on http://localhost:" + PORT)
);
