const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

// ─── Config ────────────────────────────────────────────────────────────────
// Game ID for "Steal a Brainrot" on Roblox
const GAME_NAME = "steal a brainrot";
const SHARE_PATTERN = "roblox.com/share?code=";

// ─── In-memory cache ────────────────────────────────────────────────────────
let cachedLinks = [];
let lastFetch = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ─── Helpers ────────────────────────────────────────────────────────────────
function extractShareCodes(text) {
  const regex = /roblox\.com\/share\?code=([A-Za-z0-9_-]+)/g;
  const codes = new Set();
  let match;
  while ((match = regex.exec(text)) !== null) {
    codes.add(match[1]);
  }
  return [...codes];
}

// ─── Search Providers ───────────────────────────────────────────────────────

// 1. Bing Web Search API (requires BING_API_KEY env var)
async function searchBing(query) {
  const key = process.env.BING_API_KEY;
  if (!key) return [];

  try {
    const res = await axios.get("https://api.bing.microsoft.com/v7.0/search", {
      headers: { "Ocp-Apim-Subscription-Key": key },
      params: {
        q: query,
        count: 50,
        responseFilter: "Webpages",
        safeSearch: "Off",
      },
      timeout: 8000,
    });

    const pages = res.data?.webPages?.value || [];
    const found = [];
    for (const page of pages) {
      const combined = (page.url || "") + " " + (page.snippet || "");
      const codes = extractShareCodes(combined);
      codes.forEach((code) =>
        found.push({
          code,
          url: `https://www.roblox.com/share?code=${code}`,
          source: page.url,
          title: page.name,
          provider: "bing",
        })
      );
    }
    return found;
  } catch (e) {
    console.error("Bing error:", e.message);
    return [];
  }
}

// 2. Google Custom Search API (requires GOOGLE_API_KEY + GOOGLE_CX env vars)
async function searchGoogle(query) {
  const key = process.env.GOOGLE_API_KEY;
  const cx = process.env.GOOGLE_CX;
  if (!key || !cx) return [];

  try {
    const res = await axios.get(
      "https://www.googleapis.com/customsearch/v1",
      {
        params: { key, cx, q: query, num: 10 },
        timeout: 8000,
      }
    );

    const items = res.data?.items || [];
    const found = [];
    for (const item of items) {
      const combined =
        (item.link || "") +
        " " +
        (item.snippet || "") +
        " " +
        (item.htmlSnippet || "");
      const codes = extractShareCodes(combined);
      codes.forEach((code) =>
        found.push({
          code,
          url: `https://www.roblox.com/share?code=${code}`,
          source: item.link,
          title: item.title,
          provider: "google",
        })
      );
    }
    return found;
  } catch (e) {
    console.error("Google error:", e.message);
    return [];
  }
}

// 3. SerpAPI fallback (requires SERPAPI_KEY env var)
async function searchSerpApi(query) {
  const key = process.env.SERPAPI_KEY;
  if (!key) return [];

  try {
    const res = await axios.get("https://serpapi.com/search", {
      params: { q: query, api_key: key, num: 50 },
      timeout: 10000,
    });

    const results = res.data?.organic_results || [];
    const found = [];
    for (const r of results) {
      const combined = (r.link || "") + " " + (r.snippet || "");
      const codes = extractShareCodes(combined);
      codes.forEach((code) =>
        found.push({
          code,
          url: `https://www.roblox.com/share?code=${code}`,
          source: r.link,
          title: r.title,
          provider: "serpapi",
        })
      );
    }
    return found;
  } catch (e) {
    console.error("SerpAPI error:", e.message);
    return [];
  }
}

// ─── Core Search Logic ──────────────────────────────────────────────────────
async function findPrivateServers(customQuery = null) {
  const queries = customQuery
    ? [customQuery]
    : [
        `site:twitter.com "${SHARE_PATTERN}" "${GAME_NAME}"`,
        `site:reddit.com "${SHARE_PATTERN}" "${GAME_NAME}"`,
        `"roblox.com/share?code=" "steal a brainrot" private server`,
        `roblox private server steal brainrot "share?code="`,
        `"steal a brainrot" roblox server link 2024`,
        `"steal a brainrot" roblox server link 2025`,
      ];

  const allResults = [];

  for (const query of queries) {
    const [bingRes, googleRes, serpRes] = await Promise.allSettled([
      searchBing(query),
      searchGoogle(query),
      searchSerpApi(query),
    ]);

    for (const res of [bingRes, googleRes, serpRes]) {
      if (res.status === "fulfilled") allResults.push(...res.value);
    }
  }

  // Deduplicate by code
  const seen = new Map();
  for (const r of allResults) {
    if (!seen.has(r.code)) seen.set(r.code, r);
  }

  return [...seen.values()];
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// GET /api/servers — main endpoint
app.get("/api/servers", async (req, res) => {
  const forceRefresh = req.query.refresh === "true";
  const customQuery = req.query.q || null;

  if (
    !forceRefresh &&
    !customQuery &&
    cachedLinks.length > 0 &&
    lastFetch &&
    Date.now() - lastFetch < CACHE_TTL
  ) {
    return res.json({
      success: true,
      count: cachedLinks.length,
      cached: true,
      lastFetch: new Date(lastFetch).toISOString(),
      results: cachedLinks,
    });
  }

  try {
    const results = await findPrivateServers(customQuery);

    if (!customQuery) {
      cachedLinks = results;
      lastFetch = Date.now();
    }

    res.json({
      success: true,
      count: results.length,
      cached: false,
      lastFetch: new Date().toISOString(),
      results,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/status — health check + config status
app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    providers: {
      bing: !!process.env.BING_API_KEY,
      google: !!(process.env.GOOGLE_API_KEY && process.env.GOOGLE_CX),
      serpapi: !!process.env.SERPAPI_KEY,
    },
    cached: cachedLinks.length,
    lastFetch: lastFetch ? new Date(lastFetch).toISOString() : null,
  });
});

// GET / — serve frontend
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀 Brainrot Server Finder running on port ${PORT}`);
});
