const express = require("express");
const axios = require("axios");

// נסה להשתמש ב-ae_sdk אם קיים
let AffiliateClient;
try {
  ({ AffiliateClient } = require("ae_sdk"));
} catch (e) {
  // אם אין, נמשיך ונזרוק שגיאה ברורה כשנחפש
}

const app = express();
app.use(express.json({ limit: "3mb" }));

const PORT = process.env.PORT || 10000;

// ====== Green-API env ======
const GREEN_API_ID = process.env.GREEN_API_ID;
const GREEN_API_TOKEN = process.env.GREEN_API_TOKEN;

// ====== AliExpress env ======
const ALI_APP_KEY = process.env.ALI_APP_KEY;
const ALI_APP_SECRET = process.env.ALI_APP_SECRET;
const ALI_TRACKING_ID = process.env.ALI_TRACKING_ID;
const ALI_CURRENCY = process.env.ALI_CURRENCY || "ILS";
const ILS_RATE = Number(process.env.ILS_RATE || 1); // אם ה-API כבר מחזיר ILS, תשאיר 1

// ====== axios (עם טיימאאוט מוגדל) ======
const http = axios.create({
  timeout: 60000,
  headers: { "Content-Type": "application/json" },
});

// =========================
// Green API helpers
// =========================
function greenBase() {
  if (!GREEN_API_ID || !GREEN_API_TOKEN) {
    throw new Error("Missing GREEN_API_ID / GREEN_API_TOKEN");
  }
  return `https://api.green-api.com/waInstance${GREEN_API_ID}`;
}

async function greenSendMessage(chatId, text) {
  const url = `${greenBase()}/sendMessage/${GREEN_API_TOKEN}`;
  await http.post(url, { chatId, message: text });
}

async function greenSendImageByUrl(chatId, imageUrl, caption) {
  const url = `${greenBase()}/sendFileByUrl/${GREEN_API_TOKEN}`;
  await http.post(url, {
    chatId,
    urlFile: imageUrl,
    fileName: "product.jpg",
    caption: caption || "",
  });
}

// =========================
// AliExpress helpers (בלי Access Token)
// =========================
function aliClient() {
  if (!AffiliateClient) return null;
  if (!ALI_APP_KEY || !ALI_APP_SECRET) return null;

  // חלק מהגרסאות של ae_sdk מקבלות appKey/appSecret
  return new AffiliateClient({
    appKey: ALI_APP_KEY,
    appSecret: ALI_APP_SECRET,
  });
}

async function searchAliProducts(keyword) {
  const client = aliClient();
  if (!client) {
    throw new Error("AliExpress client not ready (missing ae_sdk or ALI_APP_KEY/ALI_APP_SECRET)");
  }
  if (!ALI_TRACKING_ID) {
    throw new Error("Missing ALI_TRACKING_ID");
  }

  // ניסיון לקריאה נפוצה ב-Affiliate API
  // אם באלי אקספרס אצלך השם של השיטה שונה, נחליף לפי הלוגים.
  const methodName = "aliexpress.affiliate.product.query";

  const params = {
    keywords: keyword,
    page_no: 1,
    page_size: 20,
    tracking_id: ALI_TRACKING_ID,
    target_currency: ALI_CURRENCY,
    target_language: "HE",
  };

  const res = await client.call(methodName, params);

  // מנסים לחלץ רשימה בצורה גמישה (כי לפעמים זה עטוף)
  const data = res?.result || res?.data || res;
  const list =
    data?.products?.product || // פורמט נפוץ
    data?.product_list ||      // פורמט אחר
    data?.products ||          // לפעמים מערך ישיר
    [];

  if (!Array.isArray(list)) return [];

  // ננרמל שדות
  return list.map((p) => ({
    title: p.product_title || p.title || p.productTitle || "מוצר מאלי אקספרס",
    price: Number(p.target_sale_price || p.sale_price || p.price || 0),
    currency: p.target_currency || p.currency || ALI_CURRENCY,
    rating: Number(p.evaluate_rate || p.rating || p.score || 0),
    image: p.product_main_image_url || p.image_url || p.main_image_url || p.image || "",
    url:
      p.product_detail_url ||
      p.product_url ||
      p.url ||
      "",
    orders: Number(p.lastest_volume || p.orders || p.sales || 0),
  }));
}

async function generateAffiliateLinks(urls) {
  const client = aliClient();
  if (!client) return new Map();
  if (!urls?.length) return new Map();

  const methodName = "aliexpress.affiliate.link.generate";
  const params = {
    promotion_link_type: 0,
    source_values: urls.join(","),
    tracking_id: ALI_TRACKING_ID,
  };

  try {
    const res = await client.call(methodName, params);
    const data = res?.result || res?.data || res;
    const items =
      data?.promotion_links?.promotion_link ||
      data?.promotion_links ||
      data?.links ||
      [];

    const map = new Map();
    if (Array.isArray(items)) {
      for (const it of items) {
        const src = it?.source_value || it?.sourceValue || it?.source || "";
        const link = it?.promotion_link || it?.promotionLink || it?.link || "";
        if (src && link) map.set(src, link);
      }
    }
    return map;
  } catch (e) {
    // אם נפל, נחזיר מפה ריקה ונשלח בלי שותפים במקום להיתקע
    console.error("ALI LINK GENERATE FAIL:", e?.message || e);
    return new Map();
  }
}

function toShekels(price, currency) {
  if (!price || Number.isNaN(price)) return null;
  // אם כבר ILS — מחיר 그대로
  if ((currency || "").toUpperCase() === "ILS") return Math.round(price);

  // אחרת ממיר לפי ILS_RATE (אם הגדרת)
  return Math.round(price * ILS_RATE);
}

function pickTop4(items) {
  // “הכי טוב הכי זול”: ניקוד = מחיר נמוך + דירוג גבוה + הזמנות
  // (זה פשוט אבל עובד טוב)
  const scored = items
    .filter((x) => x.url)
    .map((x) => {
      const price = x.price || 0;
      const rating = x.rating || 0;
      const orders = x.orders || 0;
      const score = (rating * 3) + (Math.log10(orders + 1)) - (price / 50);
      return { ...x, _score: score };
    })
    .sort((a, b) => b._score - a._score);

  return scored.slice(0, 4);
}

function buildCaption(items, affMap) {
  const lines = [];
  lines.push("🔥 מצאתי לך 4 תוצאות שוות באלי אקספרס 🔥");
  lines.push("");

  items.forEach((p, i) => {
    const shekels = toShekels(p.price, p.currency);
    const priceLine = shekels ? `${shekels} שקלים` : "לא זמין כרגע";

    const cleanUrl = p.url;
    const affUrl = affMap.get(cleanUrl) || cleanUrl;

    const ratingText = p.rating ? `${p.rating}` : "לא זמין";

    lines.push(`🛒 ${i + 1}) ${p.title}`);
    lines.push(`💰 מחיר: ${priceLine}`);
    lines.push(`💫 דירוג: ${ratingText}`);
    lines.push(`🔗 קישור: ${affUrl}`);
    lines.push("");
  });

  return lines.join("\n").trim();
}

// =========================
// Webhook route (חשוב! מחזיר 200 מיד)
// =========================
app.post("/webhook", async (req, res) => {
  // ✅ תשובה מיד — כדי ש-Green לא יפיל timeout
  res.status(200).send("ok");

  // ואז עובדים ברקע
  try {
    const body = req.body || {};

    // Green API שולח בכמה פורמטים, נחלץ הכי נפוץ
    const message =
      body?.messageData?.textMessageData?.textMessage ||
      body?.messageData?.extendedTextMessageData?.text ||
      body?.messageData?.message ||
      body?.messageData?.text ||
      body?.text ||
      "";

    const chatId =
      body?.senderData?.chatId ||
      body?.chatId ||
      body?.messageData?.chatId ||
      body?.messageData?.sender ||
      "";

    const text = (message || "").trim();
    if (!chatId || !text) return;

    // ====== בדיקה ======
    if (text === "בדיקה") {
      await greenSendMessage(chatId, "בוט תקין 🤖");
      return;
    }

    // ====== חיפוש ======
    const m = text.match(/^חפשי לי\s+(.+)/);
    if (!m) return;

    const query = (m[1] || "").trim();
    if (!query) return;

    await greenSendMessage(chatId, "כמה שניות זה אצלי… 🔥");

    // 1) חיפוש מוצרים
    let products;
    try {
      products = await searchAliProducts(query);
    } catch (e) {
      console.error("ALI SEARCH FAIL:", e?.message || e);
      await greenSendMessage(chatId, "נפלתי בחיפוש באלי אקספרס 😕 (בעיה בגישה/טיימאאוט). נסה שוב עוד רגע.");
      return;
    }

    if (!products.length) {
      await greenSendMessage(chatId, "לא מצאתי תוצאות כרגע 😕 נסה מילה אחרת.");
      return;
    }

    // 2) לבחור 4
    const top4 = pickTop4(products);

    // 3) לינקים שותפים (לא מפיל אם נכשל)
    const urls = top4.map((p) => p.url).filter(Boolean);
    const affMap = await generateAffiliateLinks(urls);

    // 4) טקסט
    const caption = buildCaption(top4, affMap);

    // 5) תמונה אחת של המוצר הראשון (fallback לטקסט אם לא עובד)
    const imageUrl = top4[0]?.image || "";

    try {
      if (imageUrl) {
        await greenSendImageByUrl(chatId, imageUrl, caption);
      } else {
        await greenSendMessage(chatId, caption);
      }
    } catch (e) {
      console.error("GREEN SEND FAIL:", e?.message || e);
      await greenSendMessage(chatId, caption);
    }
  } catch (err) {
    console.error("WEBHOOK HANDLER FAIL:", err?.message || err);
  }
});

// health
app.get("/", (req, res) => res.status(200).send("OK"));

app.listen(PORT, () => {
  console.log(`✅ Server running on ${PORT}`);
});
