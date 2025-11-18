import express, { Request, Response } from "express"
import path from "path"
import http from "http"
import axios from "axios"
import https from "https"
import { URL } from "url"

const app = express()
const PORT = 8080

const agent = new https.Agent({ rejectUnauthorized: false })

const pub = path.join(__dirname, "..", "public")
app.use(express.static(pub))

app.get("/", (_req, res) => {
  res.sendFile(path.join(pub, "index.html"))
})

function norm(u: string) {
  const t = u.trim()
  if (!/^https?:\/\//i.test(t)) return "https://" + t
  return t
}

function skip(u: string) {
  const x = u.toLowerCase()
  return (
    x.startsWith("javascript:") ||
    x.startsWith("mailto:") ||
    x.startsWith("tel:") ||
    x.startsWith("#")
  )
}

function abs(v: string, base: URL) {
  if (v.startsWith("//")) return base.protocol + v
  if (/^https?:\/\//i.test(v)) return v
  if (v.startsWith("/")) return base.origin + v
  return new URL(v, base).href
}

function rewriteUrl(v: string, base: URL) {
  if (!v || skip(v)) return v
  const real = abs(v, base)
  return "/proxy?url=" + encodeURIComponent(real)
}

function rewriteAll(t: string, base: string) {
  const b = new URL(base)
  let r = t

  r = r.replace(/(href|src)=["']([^"']+)["']/gi, (_, a, v) => `${a}="${rewriteUrl(v, b)}"`)

  r = r.replace(/action=["']([^"']+)["']/gi, (_, v) => `action="${rewriteUrl(v, b)}"`)

  r = r.replace(/formaction=["']([^"']+)["']/gi, (_, v) => `formaction="${rewriteUrl(v, b)}"`)

  r = r.replace(/import\s*["']([^"']+)["']/gi, (_, v) => `import "${rewriteUrl(v, b)}"`)

  r = r.replace(/fetch\(["']([^"']+)["']/gi, (_, v) => `fetch("${rewriteUrl(v, b)}"`)

  r = r.replace(/url\(["']?([^"')]+)["']?\)/gi, (_, v) => `url(${rewriteUrl(v, b)})`)

  return r
}

function buildHeaders(h: any) {
  const out: any = {}
  for (const k in h) {
    const low = k.toLowerCase()
    if (low === "host") continue
    if (low === "content-length") continue
    out[k] = h[k]
  }
  return out
}

app.use("/proxy", async (req: Request, res: Response) => {
  try {
    const raw = req.query.url
    if (!raw || typeof raw !== "string") {
      res.status(400).send("Missing url")
      return
    }

    const target = norm(raw)
    const url = new URL(target)

    const ax = await axios({
      method: req.method,
      url: target,
      data: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
      headers: buildHeaders(req.headers),
      responseType: "arraybuffer",
      validateStatus: () => true,
      httpsAgent: agent
    })

    const type = ax.headers["content-type"] || ""
    res.set("content-type", type)
    res.set("access-control-allow-origin", "*")
    res.set("access-control-allow-headers", "*")
    res.set("access-control-allow-methods", "*")

    if (req.method === "OPTIONS") {
      res.status(200).end()
      return
    }

    if (
      type.includes("text/html") ||
      type.includes("application/javascript") ||
      type.includes("text/javascript") ||
      type.includes("text/css")
    ) {
      const txt = ax.data.toString("utf8")
      const out = rewriteAll(txt, target)
      res.send(out)
    } else {
      res.send(Buffer.from(ax.data))
    }
  } catch (e: any) {
    res.status(500).send("Proxy error: " + e.message)
  }
})

http.createServer(app).listen(PORT, () => {
  console.log("Proxy running at http://localhost:" + PORT)
})
