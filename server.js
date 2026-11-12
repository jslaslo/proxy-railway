/**
 * BGG Proxy для Railway — со стабилизацией:
 *  - кэш ответов (search / thing)
 *  - single-flight (одинаковые запросы не дублируются)
 *  - очередь к BGG (не чаще 1 запроса в ~1.2с)
 *
 * ENV:
 *   BGG_TOKEN  — Bearer-токен (обязательно)
 *   PORT       — Railway выставляет сам
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const BGG_TOKEN = (process.env.BGG_TOKEN || "").trim();
const BGG_ORIGIN = "https://boardgamegeek.com";
const FETCH_TIMEOUT_MS = 40000;

// --- Кэш и очередь к BGG ---
const cache = new Map(); // key -> { exp, status, body, contentType }
const inflight = new Map(); // key -> Promise
const MAX_CACHE = 400;
const SEARCH_TTL_MS = 30 * 60 * 1000; // 30 мин
const THING_TTL_MS = 6 * 60 * 60 * 1000; // 6 ч
const OTHER_TTL_MS = 10 * 60 * 1000;

let lastBggAt = 0;
const BGG_MIN_GAP_MS = 1200;
let bggChain = Promise.resolve();

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
        cacheSize: cache.size,
        inflight: inflight.size,
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
      "User-Agent": "BoardGameWheel-RailwayProxy/1.1",
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

function cacheKey(url) {
  return url.pathname + url.search;
}

function ttlForPath(pathname) {
  if (pathname.includes("/search")) return SEARCH_TTL_MS;
  if (pathname.includes("/thing")) return THING_TTL_MS;
  return OTHER_TTL_MS;
}

function getCached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    cache.delete(key);
    return null;
  }
  // LRU touch
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function setCache(key, status, body, contentType, ttl) {
  if (status < 200 || status >= 300) return;
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, {
    exp: Date.now() + ttl,
    status,
    body,
    contentType,
  });
}

/** Очередь: не чаще одного upstream-запроса к BGG */
function enqueueBgg(fn) {
  const run = bggChain.then(async () => {
    const wait = Math.max(0, BGG_MIN_GAP_MS - (Date.now() - lastBggAt));
    if (wait > 0) await sleep(wait);
    lastBggAt = Date.now();
    return fn();
  });
  // не роняем цепочку при ошибке
  bggChain = run.catch(() => {});
  return run;
}

async function handleBgg(url, res) {
  if (!BGG_TOKEN) {
    json(res, 500, {
      error: "BGG_TOKEN env is empty. Set it in Railway Variables.",
    });
    return;
  }

  const key = cacheKey(url);
  const cached = getCached(key);
  if (cached) {
    res.writeHead(cached.status, {
      "Content-Type": cached.contentType || "application/xml",
      "Cache-Control": "public, max-age=300",
      "X-Proxy-Cache": "HIT",
      ...cors(),
    });
    res.end(cached.body);
    return;
  }

  // Single-flight: параллельные одинаковые запросы ждут один upstream
  if (inflight.has(key)) {
    try {
      const shared = await inflight.get(key);
      res.writeHead(shared.status, {
        "Content-Type": shared.contentType || "application/xml",
        "Cache-Control": "public, max-age=300",
        "X-Proxy-Cache": "SHARED",
        ...cors(),
      });
      res.end(shared.body);
      return;
    } catch (e) {
      json(res, 502, { error: "BGG upstream failed", detail: String(e?.message || e) });
      return;
    }
  }

  const work = (async () => {
    const target = BGG_ORIGIN + url.pathname + url.search;
    let lastErr = null;

    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const result = await enqueueBgg(() =>
          fetchBuffer(target, {
            Authorization: `Bearer ${BGG_TOKEN}`,
            Accept: "application/xml, text/xml, */*",
            "User-Agent": "BoardGameWheel-RailwayProxy/1.1",
            "Accept-Language": "en-US,en;q=0.9",
          })
        );

        if (result.status === 429 || result.status === 503) {
          await sleep(1500 * attempt);
          continue;
        }

        setCache(
          key,
          result.status,
          result.body,
          result.contentType,
          ttlForPath(url.pathname)
        );
        return result;
      } catch (e) {
        lastErr = e;
        await sleep(700 * attempt);
      }
    }

    throw lastErr || new Error("BGG upstream failed");
  })();

  inflight.set(key, work);

  try {
    const { status, body, contentType } = await work;
    res.writeHead(status, {
      "Content-Type": contentType || "application/xml",
      "Cache-Control": "public, max-age=300",
      "X-Proxy-Cache": "MISS",
      ...cors(),
    });
    res.end(body);
  } catch (e) {
    json(res, 502, {
      error: "BGG upstream failed",
      detail: String(e?.message || e),
    });
  } finally {
    inflight.delete(key);
  }
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

  const imgKey = "img:" + imageUrl.toString();
  const cached = getCached(imgKey);
  if (cached) {
    res.writeHead(cached.status, {
      "Content-Type": cached.contentType || "image/jpeg",
      "Cache-Control": "public, max-age=86400",
      "X-Proxy-Cache": "HIT",
      ...cors(),
    });
    res.end(cached.body);
    return;
  }

  try {
    const { status, body, contentType } = await fetchBuffer(
      imageUrl.toString(),
      {
        Referer: "https://boardgamegeek.com/",
        "User-Agent": "BoardGameWheel-RailwayProxy/1.1",
      }
    );

    if (status >= 200 && status < 300) {
      setCache(imgKey, status, body, contentType, 24 * 60 * 60 * 1000);
    }

    res.writeHead(status, {
      "Content-Type": contentType || "image/jpeg",
      "Cache-Control": "public, max-age=86400",
      ...cors(),
    });
    res.end(body);
  } catch (e) {
    json(res, 502, { error: String(e?.message || e) });
  }
}

function fetchBuffer(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const u = new URL(targetUrl);
    const lib = u.protocol === "http:" ? http : https;

    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        headers: {
          ...headers,
          Connection: "keep-alive",
        },
      },
      (resp) => {
        const chunks = [];
        resp.on("data", (c) => chunks.push(c));
        resp.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({
            status: resp.statusCode || 0,
            body: Buffer.concat(chunks),
            contentType: resp.headers["content-type"],
          });
        });
      }
    );

    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error("upstream timeout"));
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    req.end();
  });
}

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj, null, 2), "utf8");
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    ...cors(),
  });
  res.end(body);
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, headers);
  res.end(body || undefined);
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
