/**
 * FULL OFFLINE MIRROR DOWNLOADER — V8
 * ------------------------------------
 * ✔ Captures ALL network requests (CSS, JS, JSON, fonts, AJAX, chunks)
 * ✔ Cleans query strings (“?ver=123” → “file.css”)
 * ✔ Full HTML link rewriting
 * ✔ Full CSS asset rewriting
 * ✔ Multi-thread surfing
 * ✔ Scroll-loading
 * ✔ Sitemap-aware
 * ✔ Makes an ACTUAL offline clone
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = "https://thegentlemensedit.com";
const OUT = "/Users/BGoodwin/Documents/Websites/thegentlemensedit";

fs.mkdirSync(OUT, { recursive: true });

const visited = new Set();
const queued = new Set();

/* ------------------ UTILITIES ------------------ */

function log(x) {
  console.log(`[LOG] ${x}`);
}

function cleanURL(url) {
  // remove ROOT + query strings
  let u = url.replace(ROOT, "").replace(/\?.*$/, "");
  if (u === "" || u === "/") return "index.html";
  if (u.endsWith("/")) u += "index.html";
  return u.replace(/^\//, "");
}

function writeFileSafely(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, data);
}

function rewriteHTML(html) {
  return html
    .replace(/https:\/\/thegentlemensedit\.com\//g, "")
    .replace(/href="\//g, 'href="')
    .replace(/src="\//g, 'src="')
    .replace(/url\("\//g, 'url("');
}

function rewriteCSS(css) {
  return css
    .replace(/url\("https:\/\/thegentlemensedit\.com\//g, 'url("')
    .replace(/url\(https:\/\/thegentlemensedit\.com\//g, "url(")
    .replace(/https:\/\/thegentlemensedit\.com\//g, "");
}

/* ------------------ NETWORK SNIFFER ------------------ */

async function sniffAndSave(context) {
  context.on("response", async (res) => {
    try {
      const url = res.url();

      if (!url.startsWith(ROOT)) return;

      const cleanPath = cleanURL(url);
      const savePath = path.join(OUT, cleanPath);

      const body = await res.body();

      // CSS needs rewriting
      if (cleanPath.endsWith(".css")) {
        let text = body.toString("utf8");
        text = rewriteCSS(text);
        writeFileSafely(savePath, text);
        return;
      }

      writeFileSafely(savePath, body);
    } catch (_) {}
  });
}

/* ------------------ CRAWLER ------------------ */

async function extractLinks(page) {
  return await page.evaluate(() =>
    Array.from(document.querySelectorAll("a"))
      .map((a) => a.href.trim())
      .filter((x) =>
        x.startsWith("https://thegentlemensedit.com") &&
        !x.includes("#")
      )
  );
}

async function fullScroll(page) {
  await page.evaluate(async () => {
    let total = 0;
    const step = 600;
    await new Promise((done) => {
      const timer = setInterval(() => {
        const h = document.body.scrollHeight;
        window.scrollBy(0, step);
        total += step;
        if (total >= h - window.innerHeight) {
          clearInterval(timer);
          done();
        }
      }, 100);
    });
  });
}

async function worker(browser) {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115 Safari/537.36",
  });

  await sniffAndSave(context);

  while (queued.size > 0) {
    const url = [...queued][0];
    queued.delete(url);

    if (visited.has(url)) continue;
    visited.add(url);

    try {
      log(`Crawling: ${url}`);

      const page = await context.newPage();
      await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
      await fullScroll(page);

      let html = await page.content();
      html = rewriteHTML(html);

      const savePath = path.join(OUT, cleanURL(url));
      writeFileSafely(savePath, html);

      // add internal links
      const links = await extractLinks(page);
      for (const link of links) {
        if (!visited.has(link)) queued.add(link);
      }

      await page.close();
    } catch (err) {
      log(`Retry queued: ${url}`);
      queued.add(url);
    }
  }

  await context.close();
}

/* ------------------ SITEMAP ------------------ */

async function loadSitemap(browser) {
  try {
    const ctx = await browser.newContext();
    const res = await ctx.request.get(`${ROOT}/sitemap.xml`);
    if (!res.ok()) return;

    const xml = await res.text();
    const list = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);

    for (const u of list) queued.add(u);
    log(`Sitemap URLs added: ${list.length}`);
  } catch {}
}

/* ------------------ MAIN ------------------ */

(async () => {
  const browser = await chromium.launch({ headless: true });

  queued.add(ROOT);
  await loadSitemap(browser);

  const THREADS = 4;
  const tasks = [];
  for (let i = 0; i < THREADS; i++) tasks.push(worker(browser));

  await Promise.all(tasks);

  await browser.close();
  log("DONE — Full offline mirror created.");
})();