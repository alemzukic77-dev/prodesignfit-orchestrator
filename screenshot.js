import puppeteer from "puppeteer";

// UZMI URL iz komandne linije: node screenshot.js https://neki-portfolio.com
const urlArg = process.argv[2];

if (!urlArg) {
  console.error("❌ Nisi unio URL.\nKoristi: node screenshot.js https://tvoj-portfolio.com");
  process.exit(1);
}

// Ako korisnik napiše samo domen bez http, dodamo ga mi
const url = urlArg.startsWith("http") ? urlArg : `https://${urlArg}`;

// Jednostavno ime fajla bazirano na URL-u
const safeName = url
  .replace(/^https?:\/\//, "") // makni http/https
  .replace(/[^\w.-]/g, "_");   // očisti neobične znakove

const fileName = `screenshot-${safeName}.png`;

(async () => {
  const browser = await puppeteer.launch({
    headless: "new"
  });

  const page = await browser.newPage();

  await page.goto(url, { waitUntil: "networkidle2" });

  await page.screenshot({
    path: fileName,
    fullPage: true
  });

  console.log(`✅ Screenshot gotov: ${fileName} za URL: ${url}`);

  await browser.close();
})();