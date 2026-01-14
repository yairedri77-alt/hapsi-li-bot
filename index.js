const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const FormData = require("form-data");

const app = express();
app.use(express.json({ limit: "6mb" }));

// ====== ENV ======
const PORT = process.env.PORT || 10000;

// Green API
const GREEN_API_ID = process.env.GREEN_API_ID;
const GREEN_API_TOKEN = process.env.GREEN_API_TOKEN;

// AliExpress
const ALI_APP_KEY = process.env.ALI_APP_KEY;
const ALI_APP_SECRET = process.env.ALI_APP_SECRET;
const ALI_TRACKING_ID = process.env.ALI_TRACKING_ID;
const ALI_CURRENCY = process.env.ALI_CURRENCY || "ILS"; // keep "ILS"
const ILS_RATE = Number(process.env.ILS_RATE || "3.7");

// Groups
const ALLOWED_GROUP_IDS = (process.env.ALLOWED_GROUP_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ====== Helpers ======
function greenUrl(path) {
  return `https://api.green-api.com/waInstance${GREEN_API_ID}${path}/${GREEN_API_TOKEN}`;
}

function isAllowedGroup(chatId) {
  return ALLOWED_GROUP_IDS.includes(chatId);
}

function hasAnyUrl(text) {
  return /https?:\/\/\S+/i.test(text || "");
}

function isAliLink(text) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("aliexpress.com") ||
    t.includes("s.click.aliexpress.com") ||
    t.includes("a.aliexpress.com") ||
    t.includes("aliexpress.us")
  );
}

function shorten(s, max) {
  const t = String(s || "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

function extractPriceNumber(v) {
  const s = String(v || "");
  const m = s.match(/(\d+(\.\d+)?)/);
  return m ? Number(m[1]) : 0;
}

function usdToIls(priceUsd) {
  const n = Number(priceUsd || 0);
  if (!n) return 0;
  return Math.round(n * ILS_RATE);
}

// ====== Green API actions ======
async function sendText(chatId, message) {
  await axios.post(greenUrl("/sendMessage"), { chatId, message }, { timeout: 15000 });
}

async function deleteIncoming(chatId, idMessage) {
  if (!idMessage) return;
  try {
    await axios.post(greenUrl("/deleteMessage"), { chatId, idMessage }, { timeout: 15000 });
  } catch (e) {
    // אם אין הרשאה למחיקה – לא מפיל את הבוט
  }
}

async function sendImageByUpload(chatId, jpegBuffer, caption) {
  const form = new FormData();
  form.append("chatId", chatId);
  form.append("caption", caption);
  form.append("file", jpegBuffer, { filename: "product.jpg", contentType: "image/jpeg" });

  await axios.post(greenUrl("/sendFileByUpload"), form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    timeout: 30000
  });
}

// ====== AliExpress signature (TOP style) ======
function aliSign(params, secret) {
  const keys = Object.keys(params).sort();
  let base = secret;
  for (const k of keys) base += `${k}${params[k]}`;
  base += secret;
  return crypto.createHash("md5").update(base, "utf8").digest("hex").toUpperCase();
}

// ====== AliExpress search (Affiliate) ======
async function aliSearchProducts(keyword) {
  if (!ALI_APP_KEY || !ALI_APP_SECRET || !ALI_TRACKING_ID) {
    throw new Error("Missing Ali env: ALI_APP_KEY / ALI_APP_SECRET / ALI_TRACKING_ID");
  }

  // Endpoint נפוץ ב-OpenService
  const url = "https://gw.api.alibaba.com/openapi/param2/2/portals.open/api.get";

  const params = {
    app_key: ALI_APP_KEY,
    timestamp: Date.now().toString(),
    format: "json",
    v: "2.0",
    sign_method: "md5",

    // Affiliate search
    method: "aliexpress.affiliate.product.query",
    keywords: keyword,
    tracking_id: ALI_TRACKING_ID,
    target_currency: ALI_CURRENCY,
    target_language: "HE",
    page_no: "1",
    page_size: "12",
    sort: "SALE_PRICE_ASC",
    fields:
      "product_id,product_title,product_main_image_url,product_detail_url,sale_price,original_price,evaluate_rate"
  };

  const sign = aliSign(params, ALI_APP_SECRET);
  const fullParams = { ...params, sign };

  const res = await axios.get(url, { params: fullParams, timeout: 20000 });
  const data = res.data;

  // חילוץ גמיש (כי לפעמים המבנה משתנה)
  const list =
    data?.result?.products?.product ||
    data?.result?.products ||
    data?.result?.product_list ||
    data?.products ||
    [];

  const arr = Array.isArray(list) ? list : [];

  const products = arr
    .map((p) => {
      const title = p.product_title || p.title || "";
      const img = p.product_main_image_url || p.image_url || "";
      const link = p.product_detail_url || p.product_detail_url || "";
      const rate = Number(p.evaluate_rate || 0);
      const sale = extractPriceNumber(p.sale_price || "");
      const original = extractPriceNumber(p.original_price || "");
      return { title, img, link, rate, sale, original };
    })
    .filter((p) => p.title && p.img && p.link);

  return products.slice(0, 4);
}

// מוריד תמונה אחת של המוצר הראשון
async function downloadImageBuffer(url) {
  const r = await axios.get(url, { responseType: "arraybuffer", timeout: 20000 });
  // לרוב התמונות ב-AliExpress הן jpg/webp; WhatsApp יסתדר. נשמור כ-jpg בשם.
  return Buffer.from(r.data);
}

function buildCaption(query, products) {
  const header = `🔍 ${query}\n\n`;

  const lines = products
    .map((p, idx) => {
      const usd = p.sale || p.original || 0;
      const ils = usdToIls(usd);
      const rating = p.rate ? p.rate.toFixed(1) : "—";

      return (
        `${idx + 1}. 🛒 ${shorten(p.title, 70)}\n` +
        `💰 מחיר: ${ils ? `${ils} ₪` : "לא זמין"}\n` +
        `💫 דירוג: ${rating}\n` +
        `🔗 ${p.link}\n`
      );
    })
    .join("\n");

  return header + lines;
}

// ====== Routes ======
app.get("/", (req, res) => res.send("🤖 Bot is running"));

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body || {};
    const chatId = body?.senderData?.chatId;
    const idMessage = body?.idMessage || body?.messageData?.idMessage;

    if (!chatId || !isAllowedGroup(chatId)) return;

    // טקסט נכנס
    const text =
      body?.messageData?.textMessageData?.textMessage ||
      body?.messageData?.extendedTextMessageData?.text ||
      "";

    const msg = String(text || "").trim();
    if (!msg) return;

    const isTest = msg === "בדיקה";
    const isSearch = msg.startsWith("חפשי לי");

    // ✅ מחיקה רק ללינקים שהם לא AliExpress
    if (hasAnyUrl(msg) && !isAliLink(msg) && !isTest && !isSearch) {
      await deleteIncoming(chatId, idMessage);
      return;
    }

    // ✅ בדיקה
    if (isTest) {
      await sendText(chatId, "בוט תקין 🤖");
      return;
    }

    // ✅ חיפוש
    if (isSearch) {
      const query = msg.replace(/^חפשי לי\s*/i, "").trim();

      if (!query) {
        await sendText(chatId, "תרשום ככה: חפשי לי מטען נייד 🔍");
        return;
      }

      await sendText(chatId, "שניה אחת 1️⃣");

      const products = await aliSearchProducts(query);

      if (!products || products.length === 0) {
        await sendText(chatId, "מוצר זה לא קיים ❌ ברצונך לבקש משהו אחר ?");
        return;
      }

      const caption = buildCaption(query, products);

      // ✅ תמונה אחת: של המוצר הראשון
      const mainImgUrl = products[0].img;
      const imgBuffer = await downloadImageBuffer(mainImgUrl);

      await sendImageByUpload(chatId, imgBuffer, caption);
      return;
    }

    // אחרת - מתעלמים
  } catch (err) {
    console.error("❌ ERROR:", err?.message || err);
  }
});

app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
