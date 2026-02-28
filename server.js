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

async function searchDuckDuckGo(query) {
  try {
    // Step 1: get token
    const tokenRes = await axios.post("https://duckduckgo.com/", 
      `q=${encodeURIComponent(query)}`,
      { 
        headers: { 
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        },
        timeout: 8000
      }
    );
    
    const vtc = tokenRes.data.match(/vqd=([\d-]+)/)?.[1];
    if (!vtc) return [];

    // Step 2: search
    const searchRes = await axios.get("https://links.duckduckgo.com/d.js", {
      params: { q: query, vqd: vtc, p: 1 },
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      timeout: 8000
    });

    const found = [];
    const data = searchRes.data;
    const urlRegex = /"u":"([^"]+)"/g;
    const snippetRegex = /"a":"([^"]+)"/g;
    
    let urlMatch, snippetMatch;
    const urls = [];
    const snippets = [];
    
    while ((urlMatch = urlRegex.exec(data)) !== null) urls.push(urlMatch[1]);
    while ((snippetMatch = snippetRegex.exec(data)) !== null) snippets.push(snippetMatch[1]);

    for (let i = 0; i < urls.length; i++) {
      const combined = urls[i] + " " + (snippets[i] || "");
      const codes = extractShareCodes(combined);
      codes.forEach(code => found.push({
        code,
        url: `https://www.roblox.com/share?code=${code}`,
        source: urls[i],
        title: urls[i],
        provider: "duckduckgo"
      }));
    }
    return found;
  } catch (e) {
    console.error("DDG error:", e.message);
    return [];
  }
}

async function findPrivateServers(customQuery = null) {
  const queries = customQuery ? [customQuery] : [
    `site:twitter.com "roblox.com/share?code=" "steal a brainrot"`,
    `site:reddit.com "roblox.com/share?code=" "steal a brainrot"`,
    `"roblox.com/share?code=" "steal a brainrot" private server`,
    `roblox "steal a brainrot" private server link 2025`,
    `"steal a brainrot" roblox server "share?code="`,
  ];

  const allResults = [];
  for (const query of queries) {
    const results = await searchDuckDuckGo(query);
    allResults.push(...results);
    await new Promise(r => setTimeout(r, 1000));
  }

  const seen = new Map();
  for (const r of allResults) {
    if (!seen.has(r.code)) seen.set(r.code, r);
  }
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
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    providers: { bing: false, google: false, serpapi: false, duckduckgo: true },
    cached: cachedLinks.length,
    lastFetch: lastFetch ? new Date(lastFetch).toISOString() : null,
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀 Brainrot Server Finder running on port ${PORT}`);
});
