import chromium from "@sparticuz/chromium-min";
import puppeteer from "puppeteer-core";

/**
 * Simple in-memory cache (keeps entries in insertion order).
 * Note: stored in module-global scope so it persists across warm invocations
 * but will be lost on cold starts or when Vercel spins down the instance.
 */
const DEFAULT_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || "300", 10); // 5 minutes default
const MAX_ENTRIES = parseInt(process.env.CACHE_MAX_ENTRIES || "50", 10);

const cache = new Map(); // key -> { value, expiresAt (ms) }

function getCacheKey(targetUrl) {
  // Basic normalization
  return String(targetUrl).trim();
}

function getFromCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return {
    value: entry.value,
    ttl: Math.round((entry.expiresAt - Date.now()) / 1000)
  };
}

function setCache(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  // If too many entries, remove oldest
  while (cache.size >= MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000
  });
}

/* Utility: create a randomized UA similar to Android Chrome */
function randomUserAgent() {
  const androidVersions = ["9", "10", "11", "12", "13"];
  const chromeMajor = Math.floor(Math.random() * 30) + 100; // 100–129
  const build = Math.floor(Math.random() * 9999);
  const device = String.fromCharCode(65 + Math.floor(Math.random() * 26)); // random A–Z
  const android = androidVersions[Math.floor(Math.random() * androidVersions.length)];
  return `Mozilla/5.0 (Linux; Android ${android}; ${device}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.${build} Mobile Safari/537.36`;
}

/* Main handler exported for Vercel */
export default async function handler(req, res) {
  // CORS (so frontends can call it)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const targetUrl = req.query.TARGET_URL || req.query.target_url || req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: "Please provide ?TARGET_URL=<video_url>" });
  }

  const cacheKey = getCacheKey(targetUrl);
  const cached = getFromCache(cacheKey);
  if (cached) {
    return res.status(200).json({
      status: "success",
      cached: true,
      ttl: cached.ttl,
      requested_url: targetUrl,
      response: cached.value
    });
  }

  const postUrl = "https://getindevice.com/wp-json/aio-dl/video-data/";
  let browser = null;

  try {
    // Launch headless Chromium within Vercel
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });

    const page = await browser.newPage();
    await page.setUserAgent(randomUserAgent());

    // Visit site to solve Cloudflare JS challenge
    await page.goto("https://getindevice.com", { waitUntil: "networkidle2" });

    // Wait a short time to let CF finish challenge (adjust if needed)
    await page.waitForTimeout(4000);

    // Run POST inside browser context so CF challenge tokens are present
    const result = await page.evaluate(async (targetUrl, postUrl) => {
      const token = Math.random().toString(36).substring(2, 10);
      const formData = new URLSearchParams();
      formData.append("url", targetUrl);
      formData.append("token", token);

      const response = await fetch(postUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData
      });

      let data;
      try {
        data = await response.json();
      } catch {
        data = { raw: await response.text() };
      }

      return {
        status: response.status,
        data
      };
    }, targetUrl, postUrl);

    await browser.close();

    // Save in cache (only store the `data` part to keep memory reasonable)
    // Choose TTL from env or default
    const ttlSeconds = parseInt(process.env.CACHE_TTL_SECONDS || String(DEFAULT_TTL_SECONDS), 10);
    setCache(cacheKey, result.data, ttlSeconds);

    return res.status(200).json({
      status: "success",
      cached: false,
      ttl: ttlSeconds,
      requested_url: targetUrl,
      api_status: result.status,
      response: result.data
    });

  } catch (err) {
    if (browser) await browser.close();
    return res.status(500).json({ error: err.message });
  }
}
