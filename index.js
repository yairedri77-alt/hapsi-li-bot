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

  // ✅ רק הקבוצה הזאת תעבוד (chatId של הקבוצה)
  // דוגמה: 120363422161709210@g.us
  ALLOW_CHAT_ID = "",

  // אופציונלי: אם תרצה להמיר מדולר לשקלים במקרה שה־API מחזיר USD
  ILS_RATE = "3.7",
} = process.env;

const GREEN_BASE = "https://api.green-api.com";
const ALI_API = "https://gw.api.taobao.com/router/rest";

/* =========================
   HELPERS
========================= */
function assertEnv() {
  const missing = [];
  ["GREEN_API_ID", "GREEN_API_TOKEN", "ALI_APP_KEY", "ALI_APP_SECRET", "ALI_TRACKING_ID"].forEach((k) => {
    if (!process.env[k]) missing.push(k);
  });
  if (missing.length) throw new Error("Missing env vars: " + missing.join(", "));
}

function tsChina() {
  // gateway אוהב: YYYY-MM-DD HH:mm:ss
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

  const { data } = await axios.post(ALI_API, null, {
    params: { ...baseParams, sign },
    timeout: 35000, // יותר זמן כדי לא ליפול
  });

  return data;
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

function extractChatId(body) {
  return body?.senderData?.chatId || body?.chatId || body?.messageData?.chatId || "";
}

async function greenSendMessage(chatId, message) {
  const url = `${GREEN_BASE}/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`;
  await axios.post(url, { chatId, message }, { timeout: 30000 });
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
    { timeout: 45000 }
  );
}

function toNumberLoose(x) {
  const s = String(x ?? "");
  const n = Number(s.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function formatPriceToShekels(priceStr) {
  const n = toNumberLoose(priceStr);
  if (!n) return "";

  const looksUsd = /usd|\$|us\s*\$/i.test(String(priceStr));
  const rate = Number(ILS_RATE) || 3.7;
  const ils = looksUsd ? n * rate : n;

  const rounded = Math.round(ils);
  return `${rounded} שקלים`;
}

function pickTop4(products) {
  return (products || [])
    .map((p) => {
      const price = toNumberLoose(p.target_sale_price || p.sale_price || p.original_price);
      const orders = toNumberLoose(p.sales || p.volume || p.orders);
      const rate = toNumberLoose(p.evaluate_rate || p.score || p.rating);

      const score = orders * 0.6 + rate * 25 - price * 0.25;
      return { p, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((x) => x.p);
}

/* =========================
   ALI LOGIC
========================= */
function safeAliError(data) {
  try {
    const j = JSON.stringify(data);
    if (j.includes("error_response")) return j.slice(0, 800);
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
    page_size: 30,
    target_currency: ALI_CURRENCY,
    target_language: ALI_LANGUAGE,
    tracking_id: ALI_TRACKING_ID,
  });

  const err = safeAliError(data);
  if (err) throw new Error("Ali API error: " + err);

  const products = extractAliProducts(data);
  return Array.isArray(products) ? products : [];
}

async function generateAffiliateLinks(productUrls) {
  const data = await aliCall("aliexpress.affiliate.link.generate", {
    tracking_id: ALI_TRACKING_ID,
    promotion_link_type: 0,
    source_values: productUrls.join(","),
  });

  const err = safeAliError(data);
  if (err) throw new Error("Ali Link API error: " + err);

  const links =
    data?.aliexpress_affiliate_link_generate_response?.resp_result?.result?.promotion_links?.promotion_link ||
    data?.resp_result?.result?.promotion_links?.promotion_link ||
    [];

  const arr = Array.isArray(links) ? links : [];
  const map = new Map();
  for (const item of arr) {
    const src = item?.source_value;
    const url = item?.promotion_link;
    if (src && url) map.set(src, url);
  }
  return map;
}

function buildCaption(products, affMap) {
  const lines = [];
  lines.push("מצאתי לך 4 אפשרויות טובות 👇");

  products.forEach((p, idx) => {
    const title = String(p.product_title || p.title || "מוצר").trim();
    const priceRaw = p.target_sale_price || p.sale_price || p.original_price || "";
    const priceTxt = priceRaw ? formatPriceToShekels(priceRaw) : "";

    const srcUrl = p.product_detail_url || p.product_url || p.url || "";
    const aff = (srcUrl && affMap.get(srcUrl)) || srcUrl;

    lines.push("");
    lines.push(`${idx + 1}. ${title}`);
    if (priceTxt) lines.push(`💰 ${priceTxt}`);
    if (aff) lines.push(`🔗 ${aff}`);
  });

  return lines.join("\n");
}

/* =========================
   MAIN SEARCH FLOW (async)
========================= */
async function handleSearch(chatId, query) {
  try {
    await greenSendMessage(chatId, "🔎 מחפש עבורך… זה לוקח כ־5–7 שניות 🔥");

    const productsRaw = await searchAliProducts(query);
    if (!productsRaw.length) {
      await greenSendMessage(chatId, "לא מצאתי כרגע תוצאות 😕 נסה לרשום בצורה אחרת.");
      return;
    }

    const top4 = pickTop4(productsRaw);
    if (!top4.length) {
      await greenSendMessage(chatId, "לא מצאתי כרגע תוצאות 😕 נסה לרשום בצורה אחרת.");
      return;
    }

    const urls = top4
      .map((p) => p.product_detail_url || p.product_url || p.url)
      .filter(Boolean);

    const affMap = urls.length ? await generateAffiliateLinks(urls) : new Map();

    const imageUrl =
      top4[0]?.product_main_image_url ||
      top4[0]?.main_image_url ||
      top4[0]?.image_url ||
      "";

    const caption = buildCaption(top4, affMap);

    if (imageUrl) {
      await greenSendImageByUrl(chatId, imageUrl, caption);
    } else {
      await greenSendMessage(chatId, caption);
    }
  } catch (err) {
    console.error("SEARCH ERROR:", err?.message || err);
    try {
      await greenSendMessage(chatId, "⚠️ הייתה בעיה זמנית בחיפוש, נסה שוב עוד רגע.");
    } catch {}
  }
}

/* =========================
   ROUTES
========================= */
app.get("/", (req, res) => res.status(200).send("OK"));

app.post("/webhook", async (req, res) => {
  // תמיד מחזירים 200 מייד (כדי לא לקבל timeout)
  res.sendStatus(200);

  try {
    assertEnv();

    const chatId = extractChatId(req.body);
    const text = extractText(req.body);

    if (!chatId || !text) return;

// ✅ פילטר: רק הקבוצה/צ'אט שאתה רוצה (לפני לוגים!)
if (ALLOW_CHAT_ID && chatId !== ALLOW_CHAT_ID) return;

console.log("📩 WEBHOOK HIT | chatId:", chatId);
console.log("📝 TEXT:", text);
    // בדיקה
    if (text === "בדיקה") {
      await greenSendMessage(chatId, "בוט תקין 🤖");
      return;
    }

    // חפשי לי ...
    const m = text.match(/^חפשי לי\s+(.+)/);
    if (!m) return;

    const query = String(m[1] || "").trim();
    if (!query) return;

    // מריצים async בלי לחסום
    setImmediate(() => {
      handleSearch(chatId, query);
    });
  } catch (err) {
    console.error("WEBHOOK ERROR:", err?.message || err);
  }
});

/* =========================
   START
========================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("✅ Bot ready on", PORT));
