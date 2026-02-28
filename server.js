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
const CACHE_TTL = 0; // always fetch fresh — no caching

// ── Deduplication: if a fetch is already in progress, queue callers ──────────
let fetchInProgress = false;
let fetchQueue = [];

// Matches the full share URL and captures: code + optional &type=... param
// Handles all known formats:
//   roblox.com/share?code=ABC
//   roblox.com/share?code=ABC&type=Server
//   www.roblox.com/share?code=ABC&type=Server  (with or without protocol)
const SHARE_REGEX = /(?:https?:\/\/)?(?:www\.)?roblox\.com\/share\?code=([A-Za-z0-9_\-]+)(?:&type=([A-Za-z0-9_\-]+))?/gi;

function extractShareLinks(text) {
  if (!text) return [];
  const seen = new Map();
  let match;
  SHARE_REGEX.lastIndex = 0;
  while ((match = SHARE_REGEX.exec(text)) !== null) {
    const code = match[1];
    const type = match[2] || null;
    if (!seen.has(code)) {
      const url = type
        ? `https://www.roblox.com/share?code=${code}&type=${type}`
        : `https://www.roblox.com/share?code=${code}`;
      seen.set(code, { code, url, type });
    }
  }
  return [...seen.values()];
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

function parsePosts(children) {
  const found = [];
  for (const item of children) {
    const d = item.data;
    const combined =
      (d.title || "") + " " + (d.selftext || "") + " " + (d.url || "") + " " + (d.body || "");
    const links = extractShareLinks(combined);
    links.forEach(({ code, url, type }) =>
      found.push({
        code,
        url,
        type: type || "Server",
        source: `https://reddit.com${d.permalink}`,
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

// Fetch the raw /new feed of a subreddit — catches posts with no keywords at all
async function fetchSubredditNew(subreddit, limit = 100) {
  try {
    const data = await redditGet(
      `https://www.reddit.com/r/${subreddit}/new.json`,
      { limit }
    );
    return parsePosts(data?.data?.children || []);
  } catch (e) {
    console.error(`Subreddit r/${subreddit} /new error:`, e.message);
    return [];
  }
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  PROVIDER: YOUTUBE DATA API v3                                   ║
// ║  Free: 10,000 units/day — Search costs 100 units per call        ║
// ║  Get a key at: console.cloud.google.com → YouTube Data API v3    ║
// ║  Set env var: YOUTUBE_API_KEY                                     ║
// ╚══════════════════════════════════════════════════════════════════╝
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || null;
const YT_BASE = "https://www.googleapis.com/youtube/v3";

async function searchYoutube(query) {
  if (!YOUTUBE_API_KEY) return [];
  try {
    // Step 1: Search for relevant videos (100 units each)
    const searchRes = await http.get(`${YT_BASE}/search`, {
      params: {
        part: "snippet",
        q: query,
        type: "video",
        maxResults: 50,
        order: "date",
        key: YOUTUBE_API_KEY,
      },
    });

    const items = searchRes.data?.items || [];
    if (!items.length) return [];

    const found = [];

    // Step 2: Scan titles + truncated description snippets first (free, no extra units)
    const videoIds = [];
    for (const item of items) {
      const s = item.snippet || {};
      const combined = [s.title, s.description].filter(Boolean).join(" ");
      extractShareLinks(combined).forEach(({ code, url, type }) =>
        found.push({
          code, url, type: type || "Server",
          source: `https://www.youtube.com/watch?v=${item.id?.videoId}`,
          title: s.title || "YouTube video",
          provider: "youtube",
        })
      );
      if (item.id?.videoId) videoIds.push(item.id.videoId);
    }

    // Step 3: Fetch full descriptions in one batch call (1 unit total — very cheap)
    // YouTube snippets in search are truncated to ~100 chars; full descriptions are in /videos
    if (videoIds.length > 0) {
      const videosRes = await http.get(`${YT_BASE}/videos`, {
        params: {
          part: "snippet",
          id: videoIds.join(","),
          key: YOUTUBE_API_KEY,
        },
      });

      for (const video of videosRes.data?.items || []) {
        const desc = video.snippet?.description || "";
        const title = video.snippet?.title || "YouTube video";
        const videoUrl = `https://www.youtube.com/watch?v=${video.id}`;
        extractShareLinks(desc).forEach(({ code, url, type }) =>
          found.push({
            code, url, type: type || "Server",
            source: videoUrl,
            title,
            provider: "youtube",
          })
        );
      }
    }

    return found;
  } catch (e) {
    // 403 = quota exceeded or key invalid — log clearly so the user knows
    if (e.response?.status === 403) {
      console.error("YouTube API error: quota exceeded or invalid key. Check YOUTUBE_API_KEY.");
    } else {
      console.error(`YouTube search [${query}]:`, e.message);
    }
    return [];
  }
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  PROVIDER: GOOGLE CUSTOM SEARCH API                              ║
// ║  Free: 100 queries/day — uses same key as YouTube                ║
// ║  Set env vars: YOUTUBE_API_KEY (already set) + GOOGLE_CX         ║
// ╚══════════════════════════════════════════════════════════════════╝
const GOOGLE_CX = process.env.GOOGLE_CX || null;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || null;

async function searchGoogle(query) {
  if (!GOOGLE_CX || !GOOGLE_API_KEY) return [];
  try {
    const found = [];
    for (let start = 1; start <= 21; start += 10) {
      const res = await http.get("https://www.googleapis.com/customsearch/v1", {
        params: {
          key: GOOGLE_API_KEY,
          cx: GOOGLE_CX,
          q: query,
          num: 10,
          start,
        },
      });

      const items = res.data?.items || [];
      console.log(`Google [${query}] page ${start}: ${items.length} results, totalResults: ${res.data?.searchInformation?.totalResults}`);

      if (!items.length) break;

      for (const item of items) {
        // Check title + snippet + link + all pagemap data for share codes
        const parts = [item.title, item.snippet, item.link];
        // Also dig into pagemap if available (contains more page text)
        if (item.pagemap) {
          const pm = item.pagemap;
          if (pm.metatags) parts.push(...pm.metatags.map(m => Object.values(m).join(" ")));
          if (pm.webpage)  parts.push(...pm.webpage.map(w => [w.description, w.url].join(" ")));
        }
        const combined = parts.filter(Boolean).join(" ");
        const links = extractShareLinks(combined);

        if (links.length > 0) {
          links.forEach(({ code, url, type }) =>
            found.push({
              code, url, type: type || "Server",
              source: item.link || "https://google.com",
              title: item.title || "Google result",
              provider: "google",
            })
          );
        } else {
          // No code found in snippet — but the page itself might BE a share link
          extractShareLinks(item.link || "").forEach(({ code, url, type }) =>
            found.push({
              code, url, type: type || "Server",
              source: item.link,
              title: item.title || "Google result",
              provider: "google",
            })
          );
        }
      }
      if (start < 21) await new Promise((r) => setTimeout(r, 500));
    }
    console.log(`Google [${query}] total found: ${found.length}`);
    return found;
  } catch (e) {
    if (e.response?.status === 429) {
      console.error("Google CSE: daily quota exceeded.");
    } else if (e.response?.status === 403) {
      console.error("Google CSE 403:", e.response?.data?.error?.message || "invalid key or API not enabled for GOOGLE_API_KEY");
    } else {
      console.error(`Google search [${query}]:`, e.message);
    }
    return [];
  }
}

// ── /api/debug-google — paste your Railway URL + /api/debug-google to diagnose ──
app.get("/api/debug-google", async (req, res) => {
  const q = req.query.q || "steal a brainrot roblox";
  if (!GOOGLE_CX || !GOOGLE_API_KEY) {
    return res.json({ error: "Missing env vars", GOOGLE_CX: !!GOOGLE_CX, GOOGLE_API_KEY: !!GOOGLE_API_KEY });
  }
  try {
    const response = await http.get("https://www.googleapis.com/customsearch/v1", {
      params: { key: GOOGLE_API_KEY, cx: GOOGLE_CX, q, num: 10 },
    });
    res.json({
      query: q,
      cx: GOOGLE_CX,
      totalResults: response.data?.searchInformation?.totalResults,
      searchTime: response.data?.searchInformation?.formattedSearchTime,
      items: (response.data?.items || []).map(i => ({
        title: i.title,
        link: i.link,
        snippet: i.snippet,
      })),
    });
  } catch (e) {
    res.json({ error: e.message, status: e.response?.status, details: e.response?.data });
  }
});
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
    ? [
        () => searchReddit(customQuery),
        () => searchReddit(customQuery, "comment"),
        () => searchYoutube(customQuery + " roblox private server"),
        () => searchGoogle(customQuery + " roblox.com/share"),
      ]
    : [
        // ── Reddit posts ──────────────────────────────────────────────────────
        () => searchReddit("steal a brainrot roblox.com/share"),
        () => searchReddit("steal a brainrot private server roblox"),
        () => searchReddit("roblox share code steal brainrot"),
        () => searchReddit('roblox.com/share?code type=Server steal a brainrot'),
        // ── Reddit comments ───────────────────────────────────────────────────
        () => searchReddit("steal a brainrot roblox.com/share", "comment"),
        () => searchReddit('roblox.com/share type=Server steal brainrot', "comment"),
        // ── Subreddits ────────────────────────────────────────────────────────
        () => searchSubreddit("roblox", "steal a brainrot private server"),
        () => searchSubreddit("roblox", "steal a brainrot share code"),
        () => searchSubreddit("roblox", "roblox.com/share type=Server brainrot"),
        () => searchSubreddit("RobloxHelp", "steal a brainrot"),
        () => searchSubreddit("StealaBrainrot1", "roblox.com/share"),
        () => searchSubreddit("StealaBrainrot1", "private server"),
        () => fetchSubredditNew("StealaBrainrot1"),
        // ── YouTube (only runs if YOUTUBE_API_KEY is set) ─────────────────────
        () => searchYoutube("steal a brainrot roblox private server code"),
        () => searchYoutube("steal a brainrot roblox.com/share"),
        // ── Google Custom Search (only runs if GOOGLE_CX + GOOGLE_API_KEY set) ─
        () => searchGoogle("steal a brainrot private server"),
        () => searchGoogle("roblox.com/share steal a brainrot"),
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
      reddit: true,
      youtube: !!YOUTUBE_API_KEY,
      google: !!(GOOGLE_CX && GOOGLE_API_KEY),
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
  console.log(`📡 Reddit: enabled`);
  console.log(`📺 YouTube: ${YOUTUBE_API_KEY ? "enabled" : "disabled (no YOUTUBE_API_KEY)"}`);
  console.log(`🔵 Google: ${(GOOGLE_CX && GOOGLE_API_KEY) ? "enabled" : `disabled (GOOGLE_CX=${!!GOOGLE_CX}, GOOGLE_API_KEY=${!!GOOGLE_API_KEY})`}`);
});
