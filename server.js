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

function extractShareCodes(text) {
  const regex = /roblox\.com\/share\?code=([A-Za-z0-9_-]+)/g;
  const codes = new Set();
  let match;
  while ((match = regex.exec(text)) !== null) {
    codes.add(match[1]);
  }
  return [...codes];
}

async function searchReddit(query) {
  try {
    const res = await axios.get("https://www.reddit.com/search.json", {
      params: { q: query, limit: 100, sort: "new", t: "all" },
      headers: { "User-Agent": "RobloxServerFinder/1.0" },
      timeout: 10000,
    });
    const posts = res.data?.data?.children || [];
    const found = [];
    for (const post of posts) {
      const d = post.data;
      const combined = (d.title || "") + " " + (d.selftext || "") + " " + (d.url || "");
      const codes = extractShareCodes(combined);
      codes.forEach((code) => found.push({ code, url: `https://www.roblox.com/share?code=${code}`, source: `https://reddit.com${d.permalink}`, title: d.title, provider: "reddit" }));
    }
    return found;
  } catch (e) { console.error("Reddit error:", e.message); return []; }
}

async function searchRedditComments(query) {
  try {
    const res = await axios.get("https://www.reddit.com/search.json", {
      params: { q: query, limit: 100, sort: "new", t: "all", type: "comment" },
      headers: { "User-Agent": "RobloxServerFinder/1.0" },
      timeout: 10000,
    });
    const comments = res.data?.data?.children || [];
    const found = [];
    for (const comment of comments) {
      const d = comment.data;
      const codes = extractShareCodes(d.body || "");
      codes.forEach((code) => found.push({ code, url: `https://www.roblox.com/share?code=${code}`, source: `https://reddit.com${d.permalink}`, title: "Reddit comment", provider: "reddit" }));
    }
    return found;
  } catch (e) { console.error("Reddit comments error:", e.message); return []; }
}

async function searchSubreddit(subreddit, query) {
  try {
    const res = await axios.get(`https://www.reddit.com/r/${subreddit}/search.json`, {
      params: { q: query, limit: 100, sort: "new", restrict_sr: true },
      headers: { "User-Agent": "RobloxServerFinder/1.0" },
      timeout: 10000,
    });
    const posts = res.data?.data?.children || [];
    const found = [];
    for (const post of posts) {
      const d = post.data;
      const combined = (d.title || "") + " " + (d.selftext || "") + " " + (d.url || "");
      const codes = extractShareCodes(combined);
      codes.forEach((code) => found.push({ code, url: `https://www.roblox.com/share?code=${code}`, source: `https://reddit.com${d.permalink}`, title: d.title, provider: "reddit" }));
    }
    return found;
  } catch (e) { console.error(`Subreddit ${subreddit} error:`, e.message); return []; }
}

async function findPrivateServers(customQuery = null) {
  const allResults = [];
  if (customQuery) {
    allResults.push(...await searchReddit(customQuery));
  } else {
    const results = await Promise.allSettled([
      searchReddit(`steal a brainrot roblox.com/share`),
      searchReddit(`steal a brainrot private server roblox`),
      searchReddit(`roblox share code steal brainrot`),
      searchRedditComments(`steal a brainrot roblox.com/share`),
      searchSubreddit("roblox", "steal a brainrot private server"),
      searchSubreddit("roblox", "steal a brainrot share code"),
      searchSubreddit("RobloxHelp", "steal a brainrot"),
    ]);
    for (const r of results) {
      if (r.status === "fulfilled") allResults.push(...r.value);
    }
  }
  const seen = new Map();
  for (const r of allResults) { if (!seen.has(r.code)) seen.set(r.code, r); }
  return [...seen.values()];
}

app.get("/api/servers", async (req, res) => {
  const forceRefresh = req.query.refresh === "true";
  const customQuery = req.query.q || null;
  if (!forceRefresh && !customQuery && cachedLinks.length > 0 && lastFetch && Date.now() - lastFetch < CACHE_TTL) {
    return res.json({ success: true, count: cachedLinks.length, cached: true, lastFetch: new Date(lastFetch).toISOString(), results: cachedLinks });
  }
  try {
    const results = await findPrivateServers(customQuery);
    if (!customQuery) { cachedLinks = results; lastFetch = Date.now(); }
    res.json({ success: true, count: results.length, cached: false, lastFetch: new Date().toISOString(), results });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/status", (req, res) => {
  res.json({ status: "online", providers: { bing: false, google: false, serpapi: false, duckduckgo: false, reddit: true }, cached: cachedLinks.length, lastFetch: lastFetch ? new Date(lastFetch).toISOString() : null });
});

app.get("/", (req, res) => { res.sendFile(path.join(__dirname, "public", "index.html")); });

app.listen(PORT, () => { console.log(`🚀 Brainrot Server Finder running on port ${PORT}`); });
