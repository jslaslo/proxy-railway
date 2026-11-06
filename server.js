/**
 * BGG Proxy для Railway
 *
 * ENV:
 *   BGG_TOKEN  — Bearer-токен с https://boardgamegeek.com/applications  (обязательно)
 *   PORT       — Railway выставляет сам
 *
 * Эндпоинты:
 *   GET /health
 *   GET /test
 *   GET /xmlapi2/...   → https://boardgamegeek.com/xmlapi2/...
 *   GET /img?u=URL     → прокси обложек (geekdo-images / boardgamegeek)
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const BGG_TOKEN = (process.env.BGG_TOKEN || "").trim();
const BGG_ORIGIN = "https://boardgamegeek.com";
const FETCH_TIMEOUT_MS = 40000;

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      send(res, 204, null, cors());
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname === "/" || url.pathname === "/health") {
      json(res, 200, {
        ok: true,
        service: "bgg-proxy-railway",
        hasToken: Boolean(BGG_TOKEN),
      });
      return;
    }

    if (url.pathname === "/test") {
      await handleTest(res);
      return;
    }

    if (url.pathname === "/img") {
      await handleImage(url, res);
      return;
    }

    if (url.pathname.startsWith("/xmlapi2/")) {
      await handleBgg(url, res);
      return;
    }

    json(res, 404, {
      error: "Not found",
      hint: "/health  /test  /xmlapi2/search?query=Catan&type=boardgame  /img?u=",
    });
  } catch (err) {
    json(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`bgg-proxy listening on :${PORT}, hasToken=${Boolean(BGG_TOKEN)}`);
});

async function handleTest(res) {
  const result = {
    hasToken: Boolean(BGG_TOKEN),
    tokenLength: BGG_TOKEN.length,
  };

  if (!BGG_TOKEN) {
    json(res, 500, {
      ...result,
      ok: false,
      error: "BGG_TOKEN env is empty. Railway → Variables → BGG_TOKEN",
    });
    return;
  }

  const target = `${BGG_ORIGIN}/xmlapi2/search?query=Catan&type=boardgame`;
  const started = Date.now();

  try {
    const { status, body, contentType } = await fetchBuffer(target, {
      Authorization: `Bearer ${BGG_TOKEN}`,
      Accept: "application/xml",
      "User-Agent": "BoardGameWheel-RailwayProxy/1.0",
    });

    const text = body.toString("utf8");
    result.ok = status >= 200 && status < 300 && text.trimStart().startsWith("<");
    result.status = status;
    result.ms = Date.now() - started;
    result.contentType = contentType;
    result.bodyPreview = text.slice(0, 240);
    result.looksLikeXml = text.trimStart().startsWith("<");
    result.looksLikeHtmlChallenge =
      text.includes("Just a moment") ||
      text.includes("cf-mitigated") ||
      text.includes("Enable JavaScript");

    if (!result.ok) {
      result.error = result.looksLikeHtmlChallenge
        ? "Cloudflare challenge вместо XML"
        : `Unexpected response HTTP ${status}`;
      json(res, 502, result);
      return;
    }

    json(res, 200, result);
  } catch (e) {
    result.ok = false;
    result.ms = Date.now() - started;
    result.error = String(e?.message || e);
    json(res, 502, result);
  }
}

async function handleBgg(url, res) {
  if (!BGG_TOKEN) {
    json(res, 500, {
      error: "BGG_TOKEN env is empty. Set it in Railway Variables.",
    });
    return;
  }

  const target = BGG_ORIGIN + url.pathname + url.search;
  let lastErr = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { status, body, contentType } = await fetchBuffer(target, {
        Authorization: `Bearer ${BGG_TOKEN}`,
        Accept: "application/xml, text/xml, */*",
        "User-Agent": "BoardGameWheel-RailwayProxy/1.0",
        "Accept-Language": "en-US,en;q=0.9",
      });

      if (status === 429 || status === 503) {
        await sleep(800 * attempt);
        continue;
      }

      res.writeHead(status, {
        "Content-Type": contentType || "application/xml",
        "Cache-Control": "public, max-age=300",
        ...cors(),
      });
      res.end(body);
      return;
    } catch (e) {
      lastErr = e;
      await sleep(600 * attempt);
    }
  }

  json(res, 502, {
    error: "BGG upstream failed",
    detail: String(lastErr?.message || lastErr),
  });
}

async function handleImage(url, res) {
  const raw = url.searchParams.get("u");
  if (!raw) {
    json(res, 400, { error: "Missing ?u=imageUrl" });
    return;
  }

  let imageUrl;
  try {
    imageUrl = new URL(raw);
  } catch {
    json(res, 400, { error: "Invalid image URL" });
    return;
  }

  const host = imageUrl.hostname.toLowerCase();
  if (
    !host.endsWith("geekdo-images.com") &&
    !host.endsWith("boardgamegeek.com")
  ) {
    json(res, 403, { error: "Host not allowed" });
    return;
  }

  try {
    const { status, body, contentType } = await fetchBuffer(
      imageUrl.toString(),
      {
        Referer: "https://boardgamegeek.com/",
        "User-Agent": "BoardGameWheel-RailwayProxy/1.0",
      }
    );

    if (status < 200 || status >= 300) {
      json(res, 502, { error: `Image fetch HTTP ${status}` });
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentType || "image/jpeg",
      "Cache-Control": "public, max-age=86400",
      ...cors(),
    });
    res.end(body);
  } catch (e) {
    json(res, 502, { error: String(e?.message || e) });
  }
}

function fetchBuffer(targetUrl, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const lib = u.protocol === "http:" ? http : https;

    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        headers,
        timeout: FETCH_TIMEOUT_MS,
      },
      (resp) => {
        const chunks = [];
        resp.on("data", (c) => chunks.push(c));
        resp.on("end", () => {
          resolve({
            status: resp.statusCode || 0,
            body: Buffer.concat(chunks),
            contentType: resp.headers["content-type"],
          });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout after ${FETCH_TIMEOUT_MS}ms: ${targetUrl}`));
    });
    req.on("error", reject);
    req.end();
  });
}

function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj, null, 2), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    ...cors(),
  });
  res.end(body);
}

function send(res, status, body, headers) {
  res.writeHead(status, headers || {});
  res.end(body || "");
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}