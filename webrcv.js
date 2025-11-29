#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

// -------------------- CLI ARGUMENT HANDLING --------------------
const args = process.argv.slice(2);
if (args.length === 0 || !/^https?:\/\//.test(args[0])) {
  console.log("❌ Please provide a valid URL.\n");
  console.log("Usage: Webrcv <website_url>");
  console.log("Example: Webrcv https://example.com");
  process.exit(1);
}

const ROOT = args[0];
const domain = new URL(ROOT).hostname;
const OUT = path.join(process.cwd(), "downloads", domain);
fs.mkdirSync(OUT, { recursive: true });

// -------------------- GLOBALS --------------------
const visited = new Set();
const queued = new Set([ROOT]);
const saving = new Set();

// -------------------- UTILITIES --------------------
function cleanURL(url) {
  let u = url.replace(ROOT, "").replace(/\?.*$/, "");
  if (u === "" || u === "/") return "index.html";
  if (u.endsWith("/")) u += "index.html";
  return u.replace(/^\//, "");
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function writeFile(file, data) {
  ensureDir(file);
  fs.writeFileSync(file, data);
}

function rewriteHTML(html) {
  return html
    .replace(new RegExp(ROOT.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "g"), "")
    .replace(/href="\//g, 'href="')
    .replace(/src="\//g, 'src="')
    .replace(/url\("\//g, 'url("');
}

function rewriteCSS(css) {
  return css
    .replace(new RegExp(`url\\(\"${ROOT}`, "g"), 'url("')
    .replace(new RegExp(`url\\(${ROOT}`, "g"), "url(")
    .replace(new RegExp(ROOT.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "g"), "");
}

// -------------------- NETWORK SNIFFER --------------------
async function setupSniffer(context) {
  context.on("response", async (res) => {
    try {
      const url = res.url();
      if (!url.startsWith(ROOT)) return;

      const cleaned = cleanURL(url);
      if (saving.has(cleaned)) return;
      saving.add(cleaned);

      const file = path.join(OUT, cleaned);
      let body = await res.body();

      if (cleaned.endsWith(".css")) {
        let css = body.toString("utf8");
        css = rewriteCSS(css);
        writeFile(file, css);
        return;
      }

      writeFile(file, body);
    } catch (err) {
      console.log("Error saving asset:", err);
    }
  });
}

// -------------------- CRAWLER --------------------
async function extractLinks(page) {
  return await page.evaluate(() =>
    Array.from(document.querySelectorAll("a"))
      .map((a) => a.href.trim())
      .filter((x) => x.startsWith(location.origin) && !x.includes("#"))
  );
}

async function fullScroll(page) {
  await page.evaluate(async () => {
    let total = 0;
    const step = 600;
    await new Promise((done) => {
      const t = setInterval(() => {
        const h = document.body.scrollHeight;
        window.scrollBy(0, step);
        total += step;
        if (total >= h - window.innerHeight) {
          clearInterval(t);
          done();
        }
      }, 100);
    });
  });
}

async function worker(browser) {
  const context = await browser.newContext();
  await setupSniffer(context);

  while (queued.size > 0) {
    const url = [...queued][0];
    queued.delete(url);

    if (visited.has(url)) continue;
    visited.add(url);

    console.log("🔗 Crawling:", url);

    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

      await fullScroll(page);

      let html = await page.content();
      html = rewriteHTML(html);

      const savePath = path.join(OUT, cleanURL(url));
      writeFile(savePath, html);

      const links = await extractLinks(page);
      for (const link of links) {
        if (!visited.has(link)) queued.add(link);
      }

      await page.close();
    } catch (err) {
      console.log("❗ Retry:", url);
      queued.add(url);
    }
  }

  await context.close();
}

// -------------------- SITEMAP --------------------
async function loadSitemap(browser) {
  try {
    const res = await browser.newContext().then((ctx) =>
      ctx.request.get(`${ROOT}/sitemap.xml`)
    );

    if (!res.ok()) return;

    const xml = await res.text();
    const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
    urls.forEach((u) => queued.add(u));
    console.log("🗺️ Sitemap URLs added:", urls.length);
  } catch (err) {
    console.log("ℹ️ No sitemap found.");
  }
}

// -------------------- MAIN --------------------
(async () => {
  const browser = await chromium.launch({ headless: true });

  await loadSitemap(browser);

  const THREADS = 4;
  const workers = [];
  for (let i = 0; i < THREADS; i++) workers.push(worker(browser));

  await Promise.all(workers);

  await browser.close();
  console.log(`✅ DONE — Offline mirror saved to ${OUT}`);
})();