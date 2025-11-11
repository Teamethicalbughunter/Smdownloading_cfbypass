import chromium from "@sparticuz/chromium-min";
import puppeteer from "puppeteer-core";

// Utility: random mobile user agent
function randomUserAgent() {
  const androidVersions = ["9", "10", "11", "12", "13"];
  const chromeMajor = Math.floor(Math.random() * 30) + 100; // 100–130
  const build = Math.floor(Math.random() * 9999);
  const device = String.fromCharCode(65 + Math.floor(Math.random() * 26)); // random A–Z
  const android = androidVersions[Math.floor(Math.random() * androidVersions.length)];
  return `Mozilla/5.0 (Linux; Android ${android}; ${device}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.${build} Mobile Safari/537.36`;
}

export default async function handler(req, res) {
  // Allow calls from any frontend (CORS)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end(); // Handle CORS preflight
  }

  const targetUrl = req.query.TARGET_URL;
  if (!targetUrl) {
    return res.status(400).json({
      error: "Please provide ?TARGET_URL=<video_url>"
    });
  }

  const postUrl = "https://getindevice.com/wp-json/aio-dl/video-data/";
  let browser = null;

  try {
    // Launch headless Chrome in Vercel
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    // Random user agent for each session
    await page.setUserAgent(randomUserAgent());

    // Visit homepage (this triggers and passes Cloudflare)
    await page.goto("https://getindevice.com", { waitUntil: "networkidle2" });

    // Wait 3–5 seconds to ensure CF JS challenge clears
    await page.waitForTimeout(4000);

    // Run actual POST request from within browser context
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

    // Return API result to user
    return res.status(200).json({
      status: "success",
      requested_url: targetUrl,
      api_status: result.status,
      response: result.data
    });

  } catch (err) {
    if (browser) await browser.close();
    return res.status(500).json({ error: err.message });
  }
}
