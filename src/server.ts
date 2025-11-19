import express, { Request, Response } from "express";
import axios, { AxiosRequestConfig } from "axios";
import path from "path";
import { URL } from "url";
import http from "http";
import https from "https";
import WebSocket from "ws";

import { rewriteHtml, rewriteJs, rewriteCss } from "./rewriters";

const app = express();
const PORT = Number(process.env.PORT || 8080);

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
        "upgrade"
      ].includes(lower)
    )
      continue;

    out[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }

  out["accept-encoding"] = "identity";
  out["host"] = target.host;
  out["origin"] = target.origin;

  if (!out["user-agent"]) {
    out["user-agent"] =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132 Safari/537.36";
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
        "connection"
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

  const config: AxiosRequestConfig = {
    url: target.href,
    method: req.method as any,
    headers,
    responseType: "arraybuffer",
    validateStatus: () => true,
    httpAgent,
    httpsAgent
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


// ===============
// REAL WS TUNNEL
// ===============

const server = http.createServer(app);

/**
 * WARNING:
 * This is the ONLY correct approach.
 * You MUST pipe raw TCP → raw TCP.
 */
server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL("http://host" + req.url);
    if (url.pathname !== "/proxy_ws") return socket.destroy();

    const target = url.searchParams.get("url");
    if (!target) return socket.destroy();

    const upstream = new WebSocket(target, {
      rejectUnauthorized: false,
      headers: {
        "User-Agent": req.headers["user-agent"] || "Mozilla",
        "Origin": new URL(target).origin
      }
    });

    upstream.on("open", () => {
      // Accept the WebSocket handshake manually
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "\r\n"
      );

      // RAW piping: THIS is what Discord requires.
      (socket as any).pipe((upstream as any)._socket).pipe(socket);
    });

    upstream.on("error", () => socket.destroy());
    upstream.on("close", () => socket.end());
    socket.on("error", () => upstream.terminate());
  } catch (err) {
    socket.destroy();
  }
});

server.listen(PORT, () =>
  console.log("Proxy running on http://localhost:" + PORT)
);
