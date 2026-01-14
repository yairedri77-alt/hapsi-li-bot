const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "2mb" }));

// ====== ENV ======
const {
  GREEN_API_ID,
  GREEN_API_TOKEN,

  ALI_APP_KEY,
  ALI_APP_SECRET,
  ALI_TRACKING_ID,

  ALI_CURRENCY = "ILS",
  ALI_LANGUAGE = "HE",
} = process.env;

const GREEN_BASE = "https://api.green-api.com";
const ALI_API = "https://gw.api.taobao.com/router/rest";

// ====== Helpers ======
function assertEnv() {
  const missing = [];
  ["GREEN_API_ID", "GREEN_API_TOKEN", "ALI_APP_KEY", "ALI_APP_SECRET", "ALI_TRACKING_ID"].forEach((k) => {
    if (!process.env[k]) missing.push(k);
  });
  if (missing.length) throw new Error("Missing env vars: " + missing.join(", "));
}

function tsChina() {
  // Ali/taobao gateway אוהב פורמט זמן כזה
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function makeSign(params, secret) {
  // MD5 sign: secret + (sorted key+value) + secret
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
    timeout: 20000,
  });

  return data;
}

function pickTop4(products) {
  // נסיון לבחור “הכי טוב הכי זול”: נותן ניקוד לפי מכירות + דירוג + מחיר
  const normNum = (x) => {
    const n = Number(String(x ?? "").replace(/[^\d.]/g, ""));
    return Number.isFinite(n) ? n : 0;
  };

  return products
    .map((p) => {
      const price = normNum(p.target_sale_price || p.sale_price || p.original_price);
      const orders = normNum(p.sales || p.volume || p.orders);
      const rate = normNum(p.evaluate_rate || p.score || p.rating);

      // מחיר נמוך טוב, מכירות ודירוג טובים
      const score = orders * 0.6 + rate * 20 - price * 0.2;
      return { p, price, orders, rate, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((x) => x.p);
}

async function greenSendMessage(chatId, message) {
  const url = `${GREEN_BASE}/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`;
  await axios.post(url, { chatId, message }, { timeout: 20000 });
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
    { timeout: 30000 }
  );
}

// ====== AliExpress logic ======
async function searchAliProducts(query) {
  // Affiliate product search
  const data = await aliCall("aliexpress.affiliate.product.query", {
    keywords: query,
    page_no: 1,
    page_size: 30,
    target_currency: ALI_CURRENCY,
    target_language: ALI_LANGUAGE,
    tracking_id: ALI_TRACKING_ID,
  });

  // המבנה יכול להשתנות, אז נעשה “איסוף” בטוח:
  const jsonStr = JSON.stringify(data);
  if (jsonStr.includes("error_response")) {
    throw new Error("Ali API error: " + jsonStr.slice(0, 600));
  }

  // נסיון לאתר רשימת מוצרים בתוך response:
  const products =
    data?.aliexpress_affiliate_product_query_response?.resp_result?.result?.products?.product ||
    data?.aliexpress_affiliate_product_query_response?.result?.products?.product ||
    data?.resp_result?.result?.products?.product ||
    [];

  return Array.isArray(products) ? products : [];
}

async function generateAffiliateLinks(productUrls) {
  const data = await aliCall("aliexpress.affiliate.link.generate", {
    tracking_id: ALI_TRACKING_ID,
    promotion_link_type: 0,
    source_values: productUrls.join(","),
  });

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
  // תמונה = מוצר ראשון, אבל מציגים 4 מסודרים
  const lines = [];
  lines.push("מצאתי לך 4 אפשרויות טובות 👇");

  products.forEach((p, idx) => {
    const title = (p.product_title || p.title || "").toString().trim();
    const price = (p.target_sale_price || p.sale_price || p.original_price || "").toString().trim();
    const srcUrl = p.product_detail_url || p.product_url || p.url;
    const aff = affMap.get(srcUrl) || srcUrl;

    lines.push("");
    lines.push(`${idx + 1}. ${title}`);
    if (price) lines.push(`💰 ${price} ${ALI_CURRENCY}`);
    lines.push(`🔗 ${aff}`);
  });

  return lines.join("\n");
}

// ====== Routes ======
app.get("/", (req, res) => res.status(200).send("OK"));

app.post("/webhook", async (req, res) => {
  try {
    assertEnv();

    // Green API notification format (פשוט תופסים טקסט)
    const chatId =
      req.body?.senderData?.chatId ||
      req.body?.chatId ||
      req.body?.messageData?.chatId;

    const text =
      req.body?.messageData?.textMessageData?.textMessage ||
      req.body?.messageData?.extendedTextMessageData?.text ||
      req.body?.text ||
      "";

    // תמיד להחזיר 200 מהר כדי ש-Render לא יתקע
    res.status(200).json({ ok: true });

    if (!chatId || !text) return;

    // טריגר: "חפשי לי ..."
    const m = text.trim().match(/^חפשי לי\s+(.+)/);
    if (!m) return;

    const query = m[1].trim();
    if (!query) return;

    await greenSendMessage(chatId, "שניה אחת 1️⃣");

    const productsRaw = await searchAliProducts(query);
    if (!productsRaw.length) {
      await greenSendMessage(chatId, "לא מצאתי כרגע תוצאות 😕 נסה לרשום בצורה אחרת.");
      return;
    }

    const top4 = pickTop4(productsRaw);
    const urls = top4
      .map((p) => p.product_detail_url || p.product_url || p.url)
      .filter(Boolean);

    const affMap = await generateAffiliateLinks(urls);

    const imageUrl =
      top4[0]?.product_main_image_url ||
      top4[0]?.main_image_url ||
      top4[0]?.image_url;

    const caption = buildCaption(top4, affMap);

    if (imageUrl) {
      await greenSendImageByUrl(chatId, imageUrl, caption);
    } else {
      await greenSendMessage(chatId, caption);
    }
  } catch (err) {
    // אם כבר שלחנו 200 אין בעיה—רק לוג
    console.error("WEBHOOK ERROR:", err?.message || err);
  }
});

// ====== Start ======
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("✅ Server running on", PORT));
