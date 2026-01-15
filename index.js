/**
 * ✅ hapshi-li-bot (Green-API + AliExpress Affiliate)
 *
 * מה הקוד עושה בדיוק לפי הבקשה שלך:
 * 1) קורא רק מהקבוצה הזו: 120363422161709210@g.us (ולא שום קבוצה אחרת)
 * 2) "בדיקה" => מחזיר "בוט תקין 🤖"
 * 3) "חפשי לי ..." => מחזיר הודעת "מחפש עבורך... 5–7 שניות 🔥" ואז שולח מודעה אחת מסודרת (מוצר אחד)
 * 4) אם יש תקלה — מדפיס בלוגים "מה התקלה" + שולח לך הודעת שגיאה עם הסיבה (בקצרה וברור)
 *
 * ENV שחייבים להיות מוגדרים ב-Render:
 * GREEN_API_ID
 * GREEN_API_TOKEN
 * ALI_APP_KEY
 * ALI_APP_SECRET
 * ALI_TRACKING_ID
 *
 * אופציונלי:
 * ALLOW_CHAT_ID (אם תרצה לשנות קבוצה בעתיד בלי לשנות קוד)
 * ALI_CURRENCY (ברירת מחדל ILS)
 * ALI_LANGUAGE (ברירת מחדל HE)
 * ILS_RATE (ברירת מחדל 3.7 - רק אם המחיר מגיע כ-USD)
 */

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "2mb" }));

/* =========================
   ENV
========================= */
const {
  GREEN_API_ID,
  GREEN_API_TOKEN,

  ALI_APP_KEY,
  ALI_APP_SECRET,
  ALI_TRACKING_ID,

  ALI_CURRENCY = "ILS",
  ALI_LANGUAGE = "HE",

  ILS_RATE = "3.7",

  // אם לא תשים ENV - זה ינעל על הקבוצה שנתת
  ALLOW_CHAT_ID = "120363422161709210@g.us",
} = process.env;

const GREEN_BASE = "https://api.green-api.com";
const ALI_API = "https://gw.api.taobao.com/router/rest";

/* =========================
   REQUIRED ENV CHECK
========================= */
function assertEnv() {
  const missing = [];
  ["GREEN_API_ID", "GREEN_API_TOKEN", "ALI_APP_KEY", "ALI_APP_SECRET", "ALI_TRACKING_ID"].forEach((k) => {
    if (!process.env[k]) missing.push(k);
  });
  if (missing.length) throw new Error("Missing env vars: " + missing.join(", "));
}

/* =========================
   SMALL UTILS
========================= */
function tsChina() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function makeSign(params, secret) {
  const keys = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== "")
    .sort();

  let base = secret;
  for (const k of keys) base += k + String(params[k]);
  base += secret;

  return crypto.createHash("md5").update(base, "utf8").digest("hex").toUpperCase();
}

function toNumberLoose(x) {
  const s = String(x ?? "");
  const n = Number(s.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function formatPriceToShekels(priceStr) {
  const raw = String(priceStr ?? "").trim();
  const n = toNumberLoose(raw);
  if (!n) return "";

  // Heuristic קטן: אם יש $, USD, US $ וכו'
  const looksUsd = /usd|\$|us\s*\$/i.test(raw);
  const rate = Number(ILS_RATE) || 3.7;

  const ils = looksUsd ? n * rate : n;
  const rounded = Math.round(ils);

  return `${rounded} שקלים`;
}

function safeShort(s, max = 120) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/* =========================
   GREEN API HELPERS
========================= */
function extractChatId(body) {
  return body?.senderData?.chatId || body?.chatId || body?.messageData?.chatId || "";
}

function extractText(body) {
  const text =
    body?.messageData?.textMessageData?.textMessage ||
    body?.messageData?.extendedTextMessageData?.text ||
    body?.messageData?.quotedMessage?.textMessageData?.textMessage ||
    body?.messageData?.quotedMessage?.extendedTextMessageData?.text ||
    body?.text ||
    "";
  return String(text || "").trim();
}

function getWebhookType(body) {
  // Green-API בדרך כלל שולח typeWebhook
  return String(body?.typeWebhook || "").trim();
}

async function greenSendMessage(chatId, message) {
  const url = `${GREEN_BASE}/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`;
  await axios.post(url, { chatId, message }, { timeout: 45000 });
}

async function greenSendImageByUrl(chatId, imageUrl, caption) {
  const url = `${GREEN_BASE}/waInstance${GREEN_API_ID}/sendFileByUrl/${GREEN_API_TOKEN}`;
  await axios.post(
    url,
    {
      chatId,
      urlFile: imageUrl,
      fileName: "product.jpg",
      caption,
    },
    { timeout: 65000 }
  );
}

/* =========================
   ALI API (WITH RETRIES)
========================= */
async function aliCall(method, extraParams = {}) {
  const baseParams = {
    method,
    app_key: ALI_APP_KEY,
    sign_method: "md5",
    timestamp: tsChina(),
    format: "json",
    v: "2.0",
    ...extraParams,
  };

  const sign = makeSign(baseParams, ALI_APP_SECRET);

  const attempts = 3;
  let lastErr;

  for (let i = 1; i <= attempts; i++) {
    try {
      const { data } = await axios.post(ALI_API, null, {
        params: { ...baseParams, sign },
        timeout: 65000, // ✅ יותר זמן
      });
      return data;
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || "");
      const isTimeout = msg.includes("timeout");
      const isNet =
        msg.includes("ECONN") || msg.includes("ENOTFOUND") || msg.includes("ETIMEDOUT") || msg.includes("socket hang up");

      console.error(`ALI CALL FAIL (try ${i}/${attempts}) | method=${method} |`, msg);

      if (!isTimeout && !isNet) throw err;
      await new Promise((r) => setTimeout(r, 900 * i));
    }
  }

  throw lastErr;
}

function safeAliError(data) {
  try {
    const j = JSON.stringify(data);
    if (j.includes("error_response")) return j.slice(0, 900);
    return "";
  } catch {
    return "";
  }
}

function extractAliProducts(data) {
  const candidates = [
    data?.aliexpress_affiliate_product_query_response?.resp_result?.result?.products?.product,
    data?.aliexpress_affiliate_product_query_response?.result?.products?.product,
    data?.resp_result?.result?.products?.product,
    data?.result?.products?.product,
    data?.aliexpress_affiliate_product_query_response?.resp_result?.result?.products,
    data?.resp_result?.result?.products,
  ];

  for (const c of candidates) {
    if (Array.isArray(c)) return c;
    if (c && typeof c === "object" && Array.isArray(c.product)) return c.product;
  }
  return [];
}

async function searchAliProducts(query) {
  const data = await aliCall("aliexpress.affiliate.product.query", {
    keywords: query,
    page_no: 1,
    page_size: 40,
    target_currency: ALI_CURRENCY,
    target_language: ALI_LANGUAGE,
    tracking_id: ALI_TRACKING_ID,
  });

  const err = safeAliError(data);
  if (err) throw new Error("Ali API error: " + err);

  const products = extractAliProducts(data);
  return Array.isArray(products) ? products : [];
}

async function generateAffiliateLink(oneUrl) {
  // קישור אחד בלבד (כמו שביקשת)
  const data = await aliCall("aliexpress.affiliate.link.generate", {
    tracking_id: ALI_TRACKING_ID,
    promotion_link_type: 0,
    source_values: oneUrl,
  });

  const err = safeAliError(data);
  if (err) throw new Error("Ali Link API error: " + err);

  const links =
    data?.aliexpress_affiliate_link_generate_response?.resp_result?.result?.promotion_links?.promotion_link ||
    data?.resp_result?.result?.promotion_links?.promotion_link ||
    [];

  const arr = Array.isArray(links) ? links : [];
  const first = arr[0];
  const aff = first?.promotion_link;
  return aff || "";
}

/* =========================
   PICK ONE PRODUCT (BEST/LOW PRICE)
========================= */
function pickBestOne(products) {
  // ניקוד: מכירות + דירוג - מחיר
  // (מוצר אחד בלבד)
  const scored = (products || []).map((p) => {
    const price = toNumberLoose(p.target_sale_price || p.sale_price || p.original_price);
    const orders = toNumberLoose(p.sales || p.volume || p.orders);
    const rate = toNumberLoose(p.evaluate_rate || p.score || p.rating);

    const score = orders * 0.6 + rate * 25 - price * 0.25;
    return { p, score, price, orders, rate };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

/* =========================
   BUILD ONE BEAUTIFUL AD
========================= */
function buildOneAd(sc) {
  const p = sc.p;

  const title = safeShort(p.product_title || p.title || "מוצר", 110);

  const priceRaw = p.target_sale_price || p.sale_price || p.original_price || "";
  const priceTxt = priceRaw ? formatPriceToShekels(priceRaw) : "";

  const orders = sc.orders ? `${Math.round(sc.orders).toLocaleString("he-IL")} נרכשו` : "";
  const rate = sc.rate ? `${sc.rate}⭐` : "";

  // לפעמים יש גם shop / store
  const store = safeShort(p.shop_name || p.store_name || "", 60);

  const lines = [];
  lines.push("🔥 מצאתי לך מוצר מומלץ מאלי אקספרס");
  lines.push("");
  lines.push(`🛍️ ${title}`);
  if (store) lines.push(`🏪 ${store}`);
  if (priceTxt) lines.push(`💰 מחיר: ${priceTxt}`);
  if (orders) lines.push(`📦 ${orders}`);
  if (rate) lines.push(`⭐ דירוג: ${rate}`);
  lines.push("");
  lines.push("🔗 קישור לרכישה:"); // את הקישור נכניס בהמשך

  return lines;
}

/* =========================
   MAIN SEARCH FLOW
========================= */
async function handleSearch(chatId, query) {
  const started = Date.now();

  try {
    await greenSendMessage(chatId, "🔎 מחפש עבורך… זה לוקח בין 5–7 שניות 🔥");

    const productsRaw = await searchAliProducts(query);
    if (!productsRaw.length) {
      await greenSendMessage(chatId, "לא מצאתי כרגע תוצאות 😕 נסה לכתוב את זה אחרת.");
      return;
    }

    const best = pickBestOne(productsRaw);
    if (!best) {
      await greenSendMessage(chatId, "לא מצאתי כרגע תוצאה טובה 😕 נסה שוב עוד רגע.");
      return;
    }

    const p = best.p;
    const srcUrl = p.product_detail_url || p.product_url || p.url || "";
    if (!srcUrl) {
      await greenSendMessage(chatId, "מצאתי מוצר אבל חסר קישור מקור 😕 נסה שוב.");
      return;
    }

    // Affiliate link (עם fallback לקישור רגיל אם נכשל)
    let finalLink = srcUrl;
    try {
      const aff = await generateAffiliateLink(srcUrl);
      if (aff) finalLink = aff;
    } catch (e) {
      console.error("AFF LINK FAIL (fallback to normal):", e?.message || e);
    }

    const imageUrl =
      p.product_main_image_url || p.main_image_url || p.image_url || "";

    const adLines = buildOneAd(best);
    adLines.push(finalLink);

    const caption = adLines.join("\n");

    // שולח תמונה + מודעה
    if (imageUrl) {
      await greenSendImageByUrl(chatId, imageUrl, caption);
    } else {
      await greenSendMessage(chatId, caption);
    }

    const ms = Date.now() - started;
    console.log(`✅ SEARCH OK | query="${query}" | took ${ms}ms`);
  } catch (err) {
    const reason = String(err?.message || err);
    console.error("❌ SEARCH ERROR:", reason);

    // שולח לך גם למה זה נפל (קצר וברור)
    try {
      await greenSendMessage(chatId, `⚠️ תקלה בחיפוש: ${safeShort(reason, 160)}\nנסה שוב עוד רגע.`);
    } catch (e2) {
      console.error("❌ FAILED TO SEND ERROR MESSAGE:", e2?.message || e2);
    }
  }
}

/* =========================
   ROUTES
========================= */
app.get("/", (req, res) => res.status(200).send("OK"));

app.post("/webhook", (req, res) => {
     res.sendStatus(200);
  console.log("🔥 WEBHOOK ARRIVED");
  console.log("typeWebhook:", req.body?.typeWebhook);
  console.log("chatId:", req.body?.senderData?.chatId || req.body?.messageData?.chatId || req.body?.chatId);
  // ✅ תמיד מחזירים 200 מיד כדי ש-Render/GreenAPI לא יעשו timeout
  res.sendStatus(200);

  // ריצה אסינכרונית שלא חוסמת את ה-response
  setImmediate(async () => {
    try {
      assertEnv();

      const type = getWebhookType(req.body);
      const chatId = extractChatId(req.body);
      const text = extractText(req.body);

      // ✅ רק הודעות נכנסות (לא outgoing / status וכו')
      // אם אצלך typeWebhook לפעמים ריק - לא נחסום, רק נעדיף incoming
      if (type && type !== "incomingMessageReceived") return;

      // ✅ רק הקבוצה שלך - זה העיקר!
      if (chatId !== ALLOW_CHAT_ID) return;

      // לוגים
      console.log("📩 WEBHOOK HIT | type:", type || "(no-type)", "| chatId:", chatId);
      console.log("📝 TEXT:", text);

      if (!text) return;

      // 1) בדיקה
      if (text === "בדיקה") {
        await greenSendMessage(chatId, "בוט תקין 🤖");
        return;
      }

      // 2) חפשי לי ...
      const m = text.match(/^חפשי לי\s+(.+)/);
      if (!m) return;

      const query = String(m[1] || "").trim();
      if (!query) return;

      await handleSearch(chatId, query);
    } catch (err) {
      console.error("❌ WEBHOOK ERROR:", err?.message || err);
      // אין פה send למשתמש כי אולי אין chatId / או כבר חזרנו
    }
  });
});

/* =========================
   START
========================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("✅ Bot ready on", PORT));
