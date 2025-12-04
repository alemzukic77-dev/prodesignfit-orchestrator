import express from "express";
import dotenv from "dotenv";
import puppeteer from "puppeteer";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";

dotenv.config();

const app = express();
app.use(express.json());

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.post("/review", async (req, res) => {
  try {
    const { email, url } = req.body;

    if (!url) {
      return res.status(400).json({ error: "URL is required" });
    }

    console.log("➡️ Primljen URL:", url);

    // 1️⃣ Pokreni Puppeteer
   const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox"]
});

    const page = await browser.newPage();

    await page.goto(url, { waitUntil: "networkidle2" });

    // ime fajla
    const fileName = `portfolio-${Date.now()}.png`;

    // 2️⃣ Screenshot
    await page.screenshot({
      path: fileName,
      fullPage: true,
    });

    await browser.close();

    // 3️⃣ Upload u Supabase Storage
    const fileBuffer = fs.readFileSync(fileName);

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(process.env.SUPABASE_BUCKET)
      .upload(fileName, fileBuffer, {
        contentType: "image/png",
      });

    if (uploadError) {
      console.error(uploadError);
      return res.status(500).json({ error: "Upload failed" });
    }

    // 4️⃣ Dobijamo PUBLIC URL
    const { data: publicURL } = supabase.storage
      .from(process.env.SUPABASE_BUCKET)
      .getPublicUrl(fileName);

    console.log("📸 Screenshot URL:", publicURL.publicUrl);

    // 5️⃣ Upis u bazu
    await supabase.from("portfolio_reviews").insert([
      {
        email,
        url,
        status: "done",
        screenshot_url: publicURL.publicUrl,
      },
    ]);

    // 6️⃣ Obriši lokalni fajl
    fs.unlinkSync(fileName);

    return res.json({
      success: true,
      screenshot_url: publicURL.publicUrl,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});
// ------------------------------
// 🆕 NOVI ENDPOINT: /analyze
// ------------------------------
app.post("/analyze", async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: "Portfolio URL required" });
    }

    console.log("🔍 Starting simple crawl:", url);

    // 1️⃣ Pokreni Puppeteer
   const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox"]
});


    const page = await browser.newPage();

    await page.goto(url, { waitUntil: "networkidle2" });

    // 2️⃣ Izvuci sve linkove sa stranice
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a"))
        .map(a => a.href)
        .filter(Boolean)
    );

    // 3️⃣ Filtracija — uzimamo linkove gdje ime sugerira "case study"
    const caseStudyLinks = links.filter(link =>
      link.includes("case") ||
      link.includes("work") ||
      link.includes("project")
    );

    if (caseStudyLinks.length === 0) {
      await browser.close();
      return res.json({
        ok: true,
        portfolio: url,
        caseStudies: [],
        message: "No case study pages found",
      });
    }

    // Uzmemo prva 3
    const selected = caseStudyLinks.slice(0, 3);

    console.log("📄 Case studies found:", selected);

    const screenshotResults = [];

    // 4️⃣ Screenshotamo svaku case study stranicu
    for (const csUrl of selected) {
      const csPage = await browser.newPage();

      await csPage.goto(csUrl, { waitUntil: "networkidle2" });

      // Desktop screenshot
      await csPage.setViewport({ width: 1280, height: 800 });
      const desktopFile = `desktop-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.png`;
      await csPage.screenshot({ path: desktopFile });

      // Mobile screenshot
      await csPage.setViewport({ width: 375, height: 812, isMobile: true });
      const mobileFile = `mobile-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.png`;
      await csPage.screenshot({ path: mobileFile });

      // Upload oba fajla u Supabase
      const desktopBuffer = fs.readFileSync(desktopFile);
      const mobileBuffer = fs.readFileSync(mobileFile);

      const bucket = process.env.SUPABASE_BUCKET;

      await supabase.storage
        .from(bucket)
        .upload(desktopFile, desktopBuffer, { contentType: "image/png" });

      await supabase.storage
        .from(bucket)
        .upload(mobileFile, mobileBuffer, { contentType: "image/png" });

      const desktopPublic = supabase.storage
        .from(bucket)
        .getPublicUrl(desktopFile).data.publicUrl;

      const mobilePublic = supabase.storage
        .from(bucket)
        .getPublicUrl(mobileFile).data.publicUrl;

      // Spremaj u rezultate
      screenshotResults.push({
        url: csUrl,
        desktop: desktopPublic,
        mobile: mobilePublic,
      });

      // Obriši lokalne fajlove
      fs.unlinkSync(desktopFile);
      fs.unlinkSync(mobileFile);
    }

    await browser.close();

    // 5️⃣ Finalni response za Wix / frontend
    return res.json({
      ok: true,
      portfolio: url,
      caseStudies: screenshotResults,
    });

  } catch (error) {
    console.error("❌ ERROR in /analyze:", error);
    return res.status(500).json({ error: "Server error during analysis" });
  }
});
// ------------------------------
// 🆕 KRAJ NOVOG ENDPOINTA
// ------------------------------

//app.listen(3001, () => {
 // console.log("🚀 Server radi na http://localhost:3001");
//});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Server radi na http://localhost:${PORT}`);
});
