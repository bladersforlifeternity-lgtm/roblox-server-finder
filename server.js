const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

let cachedLinks = [];
let lastFetch = null;
const CACHE_TTL = 5 * 60 * 1000;

// ── Deduplication: if a fetch is already in progress, queue callers ──────────
let fetchInProgress = false;
let fetchQueue = [];

function extractShareCodes(text) {
  const regex = /roblox\.com\/share\?code=([A-Za-z0-9_-]+)/g;
  const codes = new Set();
  let match;
  while ((match = regex.exec(text)) !== null) {
    codes.add(match[1]);
  }
  return [...codes];
}

// Shared axios instance with conservative timeout & retry
const http = axios.create({
  headers: { "User-Agent": "RobloxServerFinder/1.0" },
  timeout: 12000,
});

async function redditGet(url, params, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await http.get(url, { params });
      return res.data;
    } catch (e) {
      const status = e.response?.status;
      // 429 = rate limited — back off and retry
      if (status === 429 && i < retries) {
        const delay = (i + 1) * 3000;
        console.warn(`Reddit 429 — waiting ${delay}ms before retry ${i + 1}`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
}

function parsePosts(children, permalinkKey = "permalink") {
  const found = [];
  for (const item of children) {
    const d = item.data;
    const combined =
      (d.title || "") + " " + (d.selftext || "") + " " + (d.url || "") + " " + (d.body || "");
    const codes = extractShareCodes(combined);
    codes.forEach((code) =>
      found.push({
        code,
        url: `https://www.roblox.com/share?code=${code}`,
        source: `https://reddit.com${d[permalinkKey]}`,
        title: d.title || "Reddit comment",
        provider: "reddit",
      })
    );
  }
  return found;
}

async function searchReddit(query, type = "link") {
  try {
    const data = await redditGet("https://www.reddit.com/search.json", {
      q: query,
      limit: 100,
      sort: "new",
      t: "all",
      type,
    });
    return parsePosts(data?.data?.children || []);
  } catch (e) {
    console.error(`Reddit search error [${query}]:`, e.message);
    return [];
  }
}

async function searchSubreddit(subreddit, query) {
  try {
    const data = await redditGet(
      `https://www.reddit.com/r/${subreddit}/search.json`,
      { q: query, limit: 100, sort: "new", restrict_sr: true }
    );
    return parsePosts(data?.data?.children || []);
  } catch (e) {
    console.error(`Subreddit r/${subreddit} error:`, e.message);
    return [];
  }
}

// Run searches in controlled batches to avoid hammering Reddit
async function runBatch(tasks, batchSize = 2, delayMs = 1200) {
  const results = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map((fn) => fn()));
    for (const r of settled) {
      if (r.status === "fulfilled") results.push(...r.value);
    }
    if (i + batchSize < tasks.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return results;
}

async function findPrivateServers(customQuery = null) {
  const tasks = customQuery
    ? [() => searchReddit(customQuery), () => searchReddit(customQuery, "comment")]
    : [
        () => searchReddit("steal a brainrot roblox.com/share"),
        () => searchReddit("steal a brainrot private server roblox"),
        () => searchReddit("roblox share code steal brainrot"),
        () => searchReddit("steal a brainrot roblox.com/share", "comment"),
        () => searchSubreddit("roblox", "steal a brainrot private server"),
        () => searchSubreddit("roblox", "steal a brainrot share code"),
        () => searchSubreddit("RobloxHelp", "steal a brainrot"),
      ];

  const allResults = await runBatch(tasks, 2, 1200);

  const seen = new Map();
  for (const r of allResults) {
    if (!seen.has(r.code)) seen.set(r.code, r);
  }
  return [...seen.values()];
}

// ── /api/servers — deduplicated so rapid requests share one in-flight fetch ──
app.get("/api/servers", async (req, res) => {
  const forceRefresh = req.query.refresh === "true";
  const customQuery = req.query.q || null;

  // Serve cache when valid
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

  // If a non-custom fetch is already running, queue this response
  if (!customQuery && fetchInProgress) {
    console.log("Request queued — fetch already in progress");
    return new Promise((resolve) => {
      fetchQueue.push({ res, resolve });
    });
  }

  if (!customQuery) fetchInProgress = true;

  try {
    const results = await findPrivateServers(customQuery);

    if (!customQuery) {
      cachedLinks = results;
      lastFetch = Date.now();
      fetchInProgress = false;

      // Resolve all queued requests with the same data
      const payload = {
        success: true,
        count: results.length,
        cached: true,
        lastFetch: new Date(lastFetch).toISOString(),
        results,
      };
      for (const queued of fetchQueue) {
        queued.res.json(payload);
        queued.resolve();
      }
      fetchQueue = [];
    }

    res.json({
      success: true,
      count: results.length,
      cached: false,
      lastFetch: new Date().toISOString(),
      results,
    });
  } catch (err) {
    fetchInProgress = false;
    for (const queued of fetchQueue) {
      queued.res.status(500).json({ success: false, error: err.message });
      queued.resolve();
    }
    fetchQueue = [];
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    providers: {
      bing: false,
      google: false,
      serpapi: false,
      duckduckgo: false,
      reddit: true,
    },
    cached: cachedLinks.length,
    lastFetch: lastFetch ? new Date(lastFetch).toISOString() : null,
    fetchInProgress,
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀 Brainrot Server Finder running on port ${PORT}`);
});
