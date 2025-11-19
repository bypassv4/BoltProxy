"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const axios_1 = __importDefault(require("axios"));
const path_1 = __importDefault(require("path"));
const url_1 = require("url");
const http_1 = __importDefault(require("http"));
const https_1 = __importDefault(require("https"));
const ws_1 = __importStar(require("ws"));
const rewriter_1 = require("./rewriter");
const app = (0, express_1.default)();
const PORT = Number(process.env.PORT || 8080);
// Allow binary bodies to pass through (needed for POSTs, etc.).
app.use(express_1.default.raw({
    type: "*/*",
    limit: "25mb"
}));
const httpAgent = new http_1.default.Agent({ keepAlive: true });
const httpsAgent = new https_1.default.Agent({
    keepAlive: true,
    rejectUnauthorized: false // lets you hit some weird TLS setups
});
// Serve static assets (including runtime.js) from /public
app.use(express_1.default.static(path_1.default.join(__dirname, "..", "public")));
// ---- CORS / COOP helpers ----
function setCommonHeaders(res) {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("cross-origin-opener-policy", "unsafe-none");
    res.setHeader("cross-origin-embedder-policy", "unsafe-none");
    res.setHeader("cross-origin-resource-policy", "cross-origin");
}
function sanitizeRequestHeaders(req, target) {
    const out = {};
    for (const [name, value] of Object.entries(req.headers)) {
        if (value == null)
            continue;
        const lower = name.toLowerCase();
        // Drop hop-by-hop + stuff we’re overriding
        if ([
            "host",
            "connection",
            "content-length",
            "accept-encoding",
            "upgrade",
            "origin"
        ].includes(lower))
            continue;
        if (Array.isArray(value))
            out[name] = value.join(", ");
        else
            out[name] = String(value);
    }
    // Let axios give us decoded body so we can safely rewrite it
    out["accept-encoding"] = "identity";
    // Set correct host / origin for upstream
    out["host"] = target.host;
    if (!out["user-agent"]) {
        out["user-agent"] =
            "Mozilla/5.0 (compatible; scramjet-lite-proxy/1.0; +https://example.com)";
    }
    return out;
}
function stripDangerousResponseHeaders(upstreamHeaders, res) {
    for (const [name, value] of Object.entries(upstreamHeaders)) {
        if (value == null)
            continue;
        const lower = name.toLowerCase();
        // Things that break embedding / rewriting
        if ([
            "content-security-policy",
            "content-security-policy-report-only",
            "x-frame-options",
            "x-content-type-options",
            "strict-transport-security",
            "content-length",
            "content-encoding",
            "transfer-encoding",
            "connection"
        ].includes(lower)) {
            continue;
        }
        res.setHeader(name, value);
    }
}
// Simple landing page
app.get("/", (_req, res) => {
    res.send(`<!doctype html>
<html>
<head><title>BoltProxy</title></head>
<body>
  <h1>BoltProxy</h1>
  <form method="GET" action="/proxy">
    <input type="text" name="url" placeholder="https://discord.com" style="width:300px" />
    <button type="submit">Go</button>
  </form>
</body>
</html>`);
});
/**
 * Main HTTP proxy endpoint. runtime.js will hit this as /proxy?url=...
 */
app.all("/proxy", async (req, res) => {
    const raw = String(req.query.url || "");
    if (!raw) {
        res.status(400).send("Missing ?url=");
        return;
    }
    let target;
    try {
        target = new url_1.URL(raw);
    }
    catch {
        res.status(400).send("Invalid URL");
        return;
    }
    const headers = sanitizeRequestHeaders(req, target);
    const config = {
        url: target.href,
        method: req.method,
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
        const upstream = await (0, axios_1.default)(config);
        const status = upstream.status;
        const ct = String(upstream.headers["content-type"] || "");
        const isHtml = ct.includes("text/html");
        const isJs = ct.includes("application/javascript") || ct.includes("text/javascript");
        const isCss = ct.includes("text/css");
        stripDangerousResponseHeaders(upstream.headers, res);
        setCommonHeaders(res);
        const buf = upstream.data;
        if (isHtml || isJs || isCss) {
            // Assume UTF-8. Most modern sites are.
            let text = buf.toString("utf8");
            if (isHtml)
                text = (0, rewriter_1.rewriteHtml)(text, target);
            else if (isJs)
                text = (0, rewriter_1.rewriteJs)(text, target);
            else if (isCss)
                text = (0, rewriter_1.rewriteCss)(text, target);
            const safeCt = ct.replace(/;\s*charset=[^;]+/i, "") + "; charset=utf-8";
            res.status(status).setHeader("content-type", safeCt);
            res.send(text);
        }
        else {
            // Non-text: just pipe raw data
            res.status(status);
            res.send(buf);
        }
    }
    catch (err) {
        console.error("Proxy error:", err?.message || err);
        res.status(502).send("Upstream error");
    }
});
/**
 * WebSocket proxy for things like Discord gateways, etc.
 *
 * runtime.js wraps WebSocket URLs with /proxy_ws?url=...
 */
const server = http_1.default.createServer(app);
const wss = new ws_1.WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
    try {
        const url = new url_1.URL(req.url || "", "http://local/");
        if (url.pathname !== "/proxy_ws") {
            socket.destroy();
            return;
        }
        const raw = url.searchParams.get("url");
        if (!raw) {
            socket.destroy();
            return;
        }
        let target;
        try {
            target = new url_1.URL(raw);
        }
        catch {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (client) => {
            const upstream = new ws_1.default(target.href, {
                rejectUnauthorized: false,
                headers: {
                    "User-Agent": req.headers["user-agent"] || "Mozilla/5.0 scramjet-lite-ws"
                }
            });
            upstream.on("open", () => {
                client.on("message", (msg) => upstream.send(msg));
            });
            upstream.on("message", (msg) => {
                try {
                    client.send(msg);
                }
                catch {
                    /* ignore */
                }
            });
            const closeBoth = () => {
                try {
                    client.close();
                }
                catch { }
                try {
                    upstream.close();
                }
                catch { }
            };
            upstream.on("close", closeBoth);
            upstream.on("error", closeBoth);
            client.on("close", closeBoth);
            client.on("error", closeBoth);
        });
    }
    catch (e) {
        console.error("WS upgrade error:", e);
        try {
            socket.destroy();
        }
        catch { }
    }
});
server.listen(PORT, () => {
    console.log("Proxy running on http://localhost:" + PORT);
});
