import express, { Request, Response } from "express";
import axios, { AxiosRequestConfig } from "axios";
import path from "path";
import { URL } from "url";
import http from "http";
import https from "https";
import WebSocket, { WebSocketServer } from "ws";

import { rewriteHtml, rewriteJs, rewriteCss } from "./rewriter";

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

function sanitizeRequestHeaders(
  req: Request,
  target: URL
): Record<string, string> {
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
        "origin"
      ].includes(lower)
    )
      continue;

    if (Array.isArray(value)) out[name] = value.join(", ");
    else out[name] = String(value);
  }

  out["accept-encoding"] = "identity";
  out["host"] = target.host;
  if (!out["user-agent"]) {
    out["user-agent"] =
      "Mozilla/5.0 (compatible; scramjet-lite-proxy/1.0; +https://example.com)";
  }

  return out;
}

function stripDangerousResponseHeaders(
  upstreamHeaders: Record<string, any>,
  res: Response
) {
  for (const [name, value] of Object.entries(upstreamHeaders)) {
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
    ) {
      continue;
    }

    res.setHeader(name, value as any);
  }
}

app.get("/", (_req, res) => {
  res.send(
    `<!doctype html>
<html>
<head><title>BoltProxy</title></head>
<body>
  <h1>BoltProxy</h1>
  <form method="GET" action="/proxy">
    <input type="text" name="url" placeholder="https://discord.com" style="width:300px" />
    <button type="submit">Go</button>
  </form>
</body>
</html>`
  );
});

app.all("/proxy", async (req: Request, res: Response) => {
  const raw = String(req.query.url || "");
  if (!raw) {
    res.status(400).send("Missing ?url=");
    return;
  }

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    res.status(400).send("Invalid URL");
    return;
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

  if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
    config.data = req.body;
  }

  try {
    const upstream = await axios(config);

    const status = upstream.status;
    const ct = String(upstream.headers["content-type"] || "");
    const isHtml = ct.includes("text/html");
    const isJs =
      ct.includes("application/javascript") || ct.includes("text/javascript");
    const isCss = ct.includes("text/css");

    stripDangerousResponseHeaders(upstream.headers, res);
    setCommonHeaders(res);

    const buf: Buffer = upstream.data as Buffer;

    if (isHtml || isJs || isCss) {
      let text = buf.toString("utf8");
      if (isHtml) text = rewriteHtml(text, target);
      else if (isJs) text = rewriteJs(text, target);
      else if (isCss) text = rewriteCss(text, target);

      const safeCt =
        ct.replace(/;\s*charset=[^;]+/i, "") + "; charset=utf-8";
      res.status(status).setHeader("content-type", safeCt);
      res.send(text);
    } else {
      res.status(status);
      res.send(buf);
    }
  } catch (err: any) {
    console.error("Proxy error:", err?.message || err);
    res.status(502).send("Upstream error");
  }
});

/**
 * WebSocket proxy for things like Discord gateways, etc.
 *
 * runtime.js wraps WebSocket URLs with /proxy_ws?url=...
 */
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url || "", "http://local/");
    if (url.pathname !== "/proxy_ws") {
      socket.destroy();
      return;
    }

    const raw = url.searchParams.get("url");
    if (!raw) {
      socket.destroy();
      return;
    }

    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket as any, head, (client) => {
      const upstream = new WebSocket(target.href, {
        rejectUnauthorized: false,
        headers: {
          "User-Agent":
            req.headers["user-agent"] || "Mozilla/5.0 scramjet-lite-ws"
        }
      });

      upstream.on("open", () => {
        client.on("message", (msg) => upstream.send(msg));
      });

      upstream.on("message", (msg) => {
        try {
          client.send(msg);
        } catch {
        }
      });

      const closeBoth = () => {
        try {
          client.close();
        } catch {}
        try {
          upstream.close();
        } catch {}
      };

      upstream.on("close", closeBoth);
      upstream.on("error", closeBoth);
      client.on("close", closeBoth);
      client.on("error", closeBoth);
    });
  } catch (e) {
    console.error("WS upgrade error:", e);
    try {
      socket.destroy();
    } catch {}
  }
});

server.listen(PORT, () => {
  console.log("Proxy running on http://localhost:" + PORT);
});
