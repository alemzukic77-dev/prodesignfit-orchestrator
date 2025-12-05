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

// =====================================================
// EXISTING: /review endpoint (keep as is)
// =====================================================
app.post("/review", async (req, res) => {
  try {
    const { email, url } = req.body;

    if (!url) {
      return res.status(400).json({ error: "URL is required" });
    }

    console.log("➡️ Primljen URL:", url);

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2" });

    const fileName = `portfolio-${Date.now()}.png`;

    await page.screenshot({
      path: fileName,
      fullPage: true,
    });

    await browser.close();

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

    const { data: publicURL } = supabase.storage
      .from(process.env.SUPABASE_BUCKET)
      .getPublicUrl(fileName);

    console.log("📸 Screenshot URL:", publicURL.publicUrl);

    await supabase.from("portfolio_reviews").insert([
      {
        email,
        url,
        status: "done",
        screenshot_url: publicURL.publicUrl,
      },
    ]);

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

// =====================================================
// SYSTEM PROMPT FOR AI ANALYSIS
// =====================================================
const SYSTEM_PROMPT = `You are a senior UX portfolio reviewer with 15+ years of hiring experience at Google, Apple, Meta, and Airbnb.

TASK: Analyze the design portfolio content provided.

SCORING (0-100 for each):
1. UX THINKING: Problem definition, research, design rationale
2. CLARITY: Information hierarchy, readability, navigation
3. STORYTELLING: Narrative flow, engagement, before/after
4. PROFESSIONALISM: Polish, consistency, attention to detail

RESPOND ONLY WITH VALID JSON (no markdown, no backticks):
{
  "overallScore": <0-100>,
  "scores": {
    "uxThinking": <0-100>,
    "clarity": <0-100>,
    "storytelling": <0-100>,
    "professionalism": <0-100>
  },
  "summary": "<2-3 sentences>",
  "strengths": ["<strength1>", "<strength2>", "<strength3>"],
  "weaknesses": ["<weakness1>", "<weakness2>"],
  "interviewReadiness": "<Ready for interviews|Almost ready|Needs more work|Significant improvements needed>",
  "standoutFeature": "<one thing or null>",
  "topRecommendations": [
    {"priority": "high", "category": "<cat>", "text": "<rec>"},
    {"priority": "high", "category": "<cat>", "text": "<rec>"},
    {"priority": "medium", "category": "<cat>", "text": "<rec>"}
  ]
}`;

const CASE_STUDY_PROMPT = `You are a senior UX portfolio reviewer. Analyze this case study page content.

RESPOND ONLY WITH VALID JSON:
{
  "score": <0-100>,
  "scores": {
    "uxThinking": <0-100>,
    "clarity": <0-100>,
    "storytelling": <0-100>,
    "professionalism": <0-100>
  },
  "summary": "<2 sentences>",
  "strengths": ["<str1>", "<str2>"],
  "sections": [
    {"name": "<section name>", "aiReview": "<review>", "score": <0-100>, "suggestions": ["<sug1>"]}
  ],
  "recommendations": [
    {"priority": "high", "text": "<rec>"},
    {"priority": "medium", "text": "<rec>"}
  ]
}`;

// =====================================================
// HELPER: Call OpenAI API
// =====================================================
async function callOpenAI(systemPrompt, userMessage) {
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    console.error("❌ OPENAI_API_KEY not set!");
    return null;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage }
        ],
        temperature: 0.7,
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      console.error("OpenAI API error:", response.status);
      return null;
    }

    const result = await response.json();
    let content = result.choices[0].message.content.trim();

    // Remove markdown code blocks if present
    if (content.startsWith("```")) {
      const match = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (match) content = match[1];
    }

    return JSON.parse(content);
  } catch (error) {
    console.error("OpenAI error:", error.message);
    return null;
  }
}

// =====================================================
// HELPER: Extract text from page
// =====================================================
async function extractPageContent(page) {
  return await page.evaluate(() => {
    // Remove script and style elements
    const scripts = document.querySelectorAll('script, style, noscript');
    scripts.forEach(s => s.remove());
    
    // Get text content
    let text = document.body.innerText || '';
    
    // Clean up whitespace
    text = text.replace(/\s+/g, ' ').trim();
    
    // Limit length
    if (text.length > 8000) {
      text = text.substring(0, 8000) + '...';
    }
    
    return text;
  });
}

// =====================================================
// HELPER: Detect sections in content
// =====================================================
function detectSections(content) {
  const sections = [];
  const patterns = [
    { type: 'problem', names: ['problem', 'challenge', 'issue'], display: 'Problem Statement' },
    { type: 'research', names: ['research', 'discovery', 'user research'], display: 'User Research' },
    { type: 'process', names: ['process', 'approach', 'methodology'], display: 'Design Process' },
    { type: 'solution', names: ['solution', 'design', 'final'], display: 'Solution' },
    { type: 'results', names: ['results', 'outcome', 'impact'], display: 'Results & Impact' }
  ];

  const lowerContent = content.toLowerCase();

  for (const pattern of patterns) {
    for (const name of pattern.names) {
      if (lowerContent.includes(name)) {
        sections.push({ type: pattern.type, name: pattern.display });
        break;
      }
    }
  }

  return sections.length > 0 ? sections : [{ type: 'overview', name: 'Overview' }];
}

// =====================================================
// NEW: /analyze endpoint with FULL AI analysis
// =====================================================
app.post("/analyze", async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ success: false, error: "Portfolio URL required" });
    }

    console.log("========================================");
    console.log("🔍 FULL PORTFOLIO ANALYSIS");
    console.log("URL:", url);
    console.log("========================================");

    // 1️⃣ Launch Puppeteer
    console.log("\n📍 Step 1: Launching browser...");
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // 2️⃣ Go to portfolio homepage
    console.log("📍 Step 2: Loading portfolio...");
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    // 3️⃣ Extract homepage content for overall analysis
    console.log("📍 Step 3: Extracting content...");
    const homepageContent = await extractPageContent(page);

    // 4️⃣ Find case study links
    console.log("📍 Step 4: Finding case studies...");
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a"))
        .map(a => ({ href: a.href, text: a.innerText }))
        .filter(l => l.href && l.href.startsWith('http'))
    );

    const caseStudyLinks = links.filter(link => {
      const lower = (link.href + ' ' + link.text).toLowerCase();
      return lower.includes("case") || 
             lower.includes("work") || 
             lower.includes("project") ||
             lower.includes("portfolio");
    });

    // Select up to 3 case studies
    const selectedLinks = caseStudyLinks.slice(0, 3);
    console.log(`Found ${caseStudyLinks.length} potential case studies, analyzing ${selectedLinks.length}`);

    // 5️⃣ Analyze each case study
    console.log("\n📍 Step 5: Analyzing case studies...");
    const caseStudyResults = [];

    for (let i = 0; i < selectedLinks.length; i++) {
      const csLink = selectedLinks[i];
      console.log(`\n  📄 Case Study ${i + 1}: ${csLink.text || csLink.href}`);

      try {
        const csPage = await browser.newPage();
        await csPage.setViewport({ width: 1280, height: 800 });
        await csPage.goto(csLink.href, { waitUntil: "networkidle2", timeout: 30000 });

        // Extract content
        const csContent = await extractPageContent(csPage);
        const title = await csPage.title() || csLink.text || `Case Study ${i + 1}`;

        // Take screenshots
        console.log("    📸 Taking screenshots...");
        
        // Desktop full
        const desktopFile = `desktop-${Date.now()}-${i}.png`;
        await csPage.screenshot({ path: desktopFile, fullPage: true });

        // Desktop above fold
        const foldFile = `fold-${Date.now()}-${i}.png`;
        await csPage.screenshot({ path: foldFile });

        // Mobile
        await csPage.setViewport({ width: 375, height: 812, isMobile: true });
        const mobileFile = `mobile-${Date.now()}-${i}.png`;
        await csPage.screenshot({ path: mobileFile });

        // Upload to Supabase
        const bucket = process.env.SUPABASE_BUCKET;
        
        const desktopBuffer = fs.readFileSync(desktopFile);
        const foldBuffer = fs.readFileSync(foldFile);
        const mobileBuffer = fs.readFileSync(mobileFile);

        await supabase.storage.from(bucket).upload(desktopFile, desktopBuffer, { contentType: "image/png" });
        await supabase.storage.from(bucket).upload(foldFile, foldBuffer, { contentType: "image/png" });
        await supabase.storage.from(bucket).upload(mobileFile, mobileBuffer, { contentType: "image/png" });

        const desktopUrl = supabase.storage.from(bucket).getPublicUrl(desktopFile).data.publicUrl;
        const foldUrl = supabase.storage.from(bucket).getPublicUrl(foldFile).data.publicUrl;
        const mobileUrl = supabase.storage.from(bucket).getPublicUrl(mobileFile).data.publicUrl;

        // Clean up local files
        fs.unlinkSync(desktopFile);
        fs.unlinkSync(foldFile);
        fs.unlinkSync(mobileFile);

        // AI Analysis for this case study
        console.log("    🤖 AI analyzing...");
        const aiAnalysis = await callOpenAI(
          CASE_STUDY_PROMPT,
          `Case Study Title: ${title}\n\nContent:\n${csContent.substring(0, 4000)}`
        );

        // Detect sections
        const detectedSections = detectSections(csContent);

        // Build result
        caseStudyResults.push({
          url: csLink.href,
          title: title,
          wordCount: csContent.split(/\s+/).length,
          score: aiAnalysis?.score || 70,
          scores: aiAnalysis?.scores || { uxThinking: 70, clarity: 70, storytelling: 70, professionalism: 70 },
          screenshots: {
            desktopFull: desktopUrl,
            desktopFold: foldUrl,
            mobileFull: mobileUrl
          },
          sections: aiAnalysis?.sections || detectedSections.map(s => ({
            type: s.type,
            name: s.name,
            aiReview: "Section detected but detailed analysis pending.",
            score: 70,
            suggestions: []
          })),
          summary: aiAnalysis?.summary || "Case study analyzed.",
          strengths: aiAnalysis?.strengths || ["Content present"],
          recommendations: aiAnalysis?.recommendations || []
        });

        await csPage.close();

      } catch (csError) {
        console.error(`    ❌ Error analyzing case study: ${csError.message}`);
        caseStudyResults.push({
          url: csLink.href,
          title: csLink.text || "Unknown",
          wordCount: 0,
          score: 50,
          scores: { uxThinking: 50, clarity: 50, storytelling: 50, professionalism: 50 },
          screenshots: { desktopFull: "", desktopFold: "", mobileFull: "" },
          sections: [],
          summary: "Could not analyze this case study.",
          strengths: [],
          recommendations: []
        });
      }
    }

    await browser.close();

    // 6️⃣ Overall portfolio AI analysis
    console.log("\n📍 Step 6: Overall portfolio analysis...");
    
    const csSummaries = caseStudyResults.map(cs => `- ${cs.title}: Score ${cs.score}`).join('\n');
    const overallAnalysis = await callOpenAI(
      SYSTEM_PROMPT,
      `Portfolio URL: ${url}\n\nHomepage Content:\n${homepageContent.substring(0, 3000)}\n\nCase Studies Found:\n${csSummaries}`
    );

    // 7️⃣ Calculate averages if AI failed
    const avgScore = caseStudyResults.length > 0
      ? Math.round(caseStudyResults.reduce((sum, cs) => sum + cs.score, 0) / caseStudyResults.length)
      : 70;

    // 8️⃣ Build final response
    const totalTime = Date.now() - startTime;
    
    const response = {
      success: true,
      data: {
        portfolioUrl: url,
        analyzedAt: new Date().toISOString(),
        analysisVersion: "2.0",

        overallScore: overallAnalysis?.overallScore || avgScore,
        scores: overallAnalysis?.scores || {
          uxThinking: avgScore,
          clarity: avgScore,
          storytelling: avgScore,
          professionalism: avgScore
        },

        summary: overallAnalysis?.summary || "Portfolio analysis complete.",
        strengths: overallAnalysis?.strengths || ["Portfolio reviewed"],
        weaknesses: overallAnalysis?.weaknesses || [],
        interviewReadiness: overallAnalysis?.interviewReadiness || "Needs more work",
        standoutFeature: overallAnalysis?.standoutFeature || null,

        caseStudies: caseStudyResults,

        topRecommendations: overallAnalysis?.topRecommendations || [
          { priority: "high", category: "General", text: "Add more case studies with detailed process documentation" }
        ]
      },
      timing: {
        totalMs: totalTime
      }
    };

    console.log("\n========================================");
    console.log("✅ ANALYSIS COMPLETE!");
    console.log(`Overall Score: ${response.data.overallScore}`);
    console.log(`Case Studies: ${caseStudyResults.length}`);
    console.log(`Total Time: ${totalTime}ms`);
    console.log("========================================\n");

    return res.json(response);

  } catch (error) {
    console.error("❌ ERROR in /analyze:", error);
    return res.status(500).json({ 
      success: false, 
      error: "Server error during analysis",
      details: error.message 
    });
  }
});

// =====================================================
// Health check endpoint
// =====================================================
app.get("/healthz", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({ 
    service: "ProDesign Fit Orchestrator",
    version: "2.0",
    endpoints: ["/analyze", "/review", "/healthz"]
  });
});

// =====================================================
// Start server
// =====================================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
