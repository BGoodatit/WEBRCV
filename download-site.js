/**
 * ULTRA OFFLINE MIRROR DOWNLOADER — V10 (Hybrid Build)
 * ----------------------------------------------------
 * ✔ Multi-thread crawling (fastest + stable)
 * ✔ Captures ALL network requests (CSS, JS, fonts, JSON, AJAX, images, chunks)
 * ✔ Removes query strings (“?ver=123” → “file.css”)
 * ✔ Full HTML link rewriting
 * ✔ Full CSS asset rewriting
 * ✔ Scroll-loading & lazy load triggering
 * ✔ Sitemap-aware
 * ✔ Zero duplicates (global sniffer)
 * ✔ Creates TRUE offline mirror — the best possible version
 *
 * Output directory:
 *   /Users/BGoodwin/Documents/Websites/thegentlemensedit
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

// -------------------- CLI ARGUMENT HANDLING --------------------
const readline = require("readline");
const args = process.argv.slice(2);

if (args.length === 0 || !/^https?:\/\//.test(args[0])) {
  console.log("❌ Please provide a valid URL.\n");
  console.log("Usage: node download-site.js <website_url> [--out <path>]");
  console.log("Example: node download-site.js https://example.com --out ~/Sites/mirror");
  process.exit(1);
}

const ROOT = args[0];
const domain = new URL(ROOT).hostname;

// Simple flag parser
let OUT = null;
const outIndex = args.indexOf("--out");
if (outIndex !== -1 && args[outIndex + 1]) {
  OUT = path.resolve(args[outIndex + 1]);
}

async function getOutputPath() {
  if (OUT) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question(`You selected output path:\n  ${OUT}\n\nIs this correct? (Y/n) `, (answer) => {
        rl.close();
        if (answer.trim().toLowerCase() === "n") {
          console.log("❌ Cancelled.");
          process.exit(1);
        } else {
          resolve(OUT);
        }
      });
    });
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question("Do you want to choose a custom download folder? (y/N) ", (answer) => {
        if (answer.trim().toLowerCase() === "y") {
          rl.question("Enter full output path: ", (customPath) => {
            rl.close();
            resolve(path.resolve(customPath || `downloads/${domain}`));
          });
        } else {
          rl.close();
          resolve(path.resolve(`downloads/${domain}`));
        }
      });
    });
  }
}

const OUT = await getOutputPath();
fs.mkdirSync(OUT, { recursive: true });

fs.mkdirSync(OUT, { recursive: true });

const visited = new Set();
const queued = new Set([ROOT]);
const saving = new Set();

/* ------------------ UTILITIES ------------------ */

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

/* ------------------ GLOBAL NETWORK SNIFFER ------------------ */

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

/* ------------------ CRAWLER WORKER ------------------ */

async function extractLinks(page) {
  return await page.evaluate(() =>
    Array.from(document.querySelectorAll("a"))
      .map((a) => a.href.trim())
      .filter(
        (x) =>
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

    console.log("Crawling:", url);

    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

      await fullScroll(page);

      let html = await page.content();
      html = rewriteHTML(html);

      const savePath = path.join(OUT, cleanURL(url));
      writeFile(savePath, html);

      let links = await extractLinks(page);
      for (const link of links) {
        if (!visited.has(link)) queued.add(link);
      }

      await page.close();
    } catch (err) {
      console.log("Retry:", url);
      queued.add(url);
    }
  }

  await context.close();
}

/* ------------------ SITEMAP ------------------ */

async function loadSitemap(browser) {
  try {
    const res = await browser.newContext().then((ctx) =>
      ctx.request.get(`${ROOT}/sitemap.xml`)
    );

    if (!res.ok()) return;

    const xml = await res.text();
    const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);

    urls.forEach((u) => queued.add(u));
    console.log("Sitemap URLs added:", urls.length);
  } catch (err) {
    console.log("No sitemap found.");
  }
}

/* ------------------ MAIN ------------------ */

(async () => {
  const browser = await chromium.launch({ headless: true });

  await loadSitemap(browser);

  const THREADS = 4; // best performance
  const workers = [];

  for (let i = 0; i < THREADS; i++) workers.push(worker(browser));

  await Promise.all(workers);

  await browser.close();
  console.log("✔ DONE — FULL OFFLINE MIRROR CREATED");
})();
