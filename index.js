const express = require("express");
const axios = require("axios");
const sharp = require("sharp");
const { v4: uuidv4 } = require("uuid");

let AffiliateClient;
try {
  ({ AffiliateClient } = require("ae_sdk"));
} catch (e) {
  // אם ae_sdk לא מותקן עדיין – Render יתקין אחרי קומיט
}

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

const GREEN_API_ID = (process.env.GREEN_API_ID || "").trim();
const GREEN_API_TOKEN = (process.env.GREEN_API_TOKEN || "").trim();

const ALI_APP_KEY = (process.env.ALI_APP_KEY || "").trim();
const ALI_APP_SECRET = (process.env.ALI_APP_SECRET || "").trim();
const ALI_TRACKING_ID = (process.env.ALI_TRACKING_ID || "").trim();
const ALI_ACCESS_TOKEN = (process.env.ALI_ACCESS_TOKEN || "").trim();
const ALI_APP_SIGNATURE = (process.env.ALI_APP_SIGNATURE || "").trim();

const ILS_RATE = Number(process.env.ILS_RATE || "3.7");

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");

const allowedGroupIds = new Set(
  (process.env.ALLOWED_GROUP_IDS || "")
    .split(/[,\n\r\t ]+/)
    .map((s) => s.trim())
    .filter(Boolean)
);

const collageStore = new Map(); // id -> { buffer, expiresAt }

function nowMs() {
  return Date.now();
}

function isAllowedGroup(chatId) {
  return allowedGroupIds.size === 0 ? false : allowedGroupIds.has(chatId);
}

function extractText(body) {
  // מכסה גם textMessage וגם extendedTextMessage
  return (
    body?.messageData?.textMessageData?.textMessage ||
    body?.messageData?.extendedTextMessageData?.text ||
    body?.messageData?.extendedTextMessageData?.textMessage ||
    body?.messageData?.messageData?.textMessageData?.textMessage ||
    body?.messageData?.messageData?.extendedTextMessageData?.text ||
    ""
  ).toString();
}

function extractChatId(body) {
  return body?.senderData?.chatId || "";
}

function extractIdMessage(body) {
  return body?.idMessage || body?.messageData?.idMessage || body?.messageData?.messageData?.idMessage || "";
}

function hasAnyUrl(text) {
  return /(https?:\/\/|www\.)\S+/i.test(text);
}

function isAliExpressUrl(text) {
  // לא מוחקים לינקים של אליאקספרס / אפילייט
  return /(aliexpress\.com|s\.click\.aliexpress\.com|a\.aliexpress\.com|vi\.aliexpress\.com)/i.test(text);
}

function isCommandAllowed(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (t === "בדיקה") return true;
  if (t.startsWith("חפשי לי")) return true;
  if (t.startsWith("חפש לי")) return true;
  return false;
}

async function greenApiPost(methodPath, payload) {
  const url = `https://api.green-api.com/waInstance${GREEN_API_ID}/${methodPath}/${GREEN_API_TOKEN}`;
  return axios.post(url, payload, { timeout: 20000 });
}

async function greenApiSendText(chatId, message) {
  await greenApiPost("sendMessage", { chatId, message });
}

async function greenApiDeleteMessage(chatId, idMessage) {
  // עובד רק אם אתה אדמין/יש הרשאות מחיקה בקבוצה
  if (!chatId || !idMessage) return;
  await greenApiPost("deleteMessage", { chatId, idMessage });
}

async function greenApiSendFileByUrl(chatId, urlFile, fileName, caption) {
  await greenApiPost("sendFileByUrl", { chatId, urlFile, fileName, caption });
}

function buildHeader(query) {
  return `🔍 ${query}\n`;
}

function formatILS(value) {
  if (!Number.isFinite(value)) return "לא זמין";
  return `${Math.round(value)} ₪`;
}

function pickFirst4(arr) {
  return (Array.isArray(arr) ? arr : []).slice(0, 4);
}

async function downloadImageToBuffer(url) {
  const r = await axios.get(url, { responseType: "arraybuffer", timeout: 20000 });
  return Buffer.from(r.data);
}

async function buildCollage4(images) {
  // 2x2 קולאז׳
  const size = 600; // כל תמונה
  const canvasW = size * 2;
  const canvasH = size * 2;

  const buffers = await Promise.all(
    images.map(async (u) => {
      const buf = await downloadImageToBuffer(u);
      return sharp(buf)
        .resize(size, size, { fit: "cover" })
        .jpeg({ quality: 80 })
        .toBuffer();
    })
  );

  const base = sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 3,
      background: { r: 20, g: 20, b: 20 }
    }
  });

  const composed = await base
    .composite([
      { input: buffers[0], left: 0, top: 0 },
      { input: buffers[1], left: size, top: 0 },
      { input: buffers[2], left: 0, top: size },
      { input: buffers[3], left: size, top: size }
    ])
    .png()
    .toBuffer();

  return composed;
}

function getAffiliateClient() {
  if (!AffiliateClient) return null;
  if (!ALI_APP_KEY || !ALI_APP_SECRET || !ALI_ACCESS_TOKEN) return null;

  return new AffiliateClient({
    app_key: ALI_APP_KEY,
    app_secret: ALI_APP_SECRET,
    session: ALI_ACCESS_TOKEN
  });
}

function safeLower(s) {
  return (s || "").toString().trim();
}

async function aliSearchProducts(query) {
  const client = getAffiliateClient();
  if (!client) {
    return { ok: false, message: "חסרים ALI_ACCESS_TOKEN / ae_sdk" };
  }

  // משתמשים ב-callAPIDirectly כדי לא להיות תלויים בשמות פונקציות משתנים
  const resp = await client.callAPIDirectly("aliexpress.affiliate.product.query", {
    app_signature: ALI_APP_SIGNATURE,
    keywords: query,
    page_no: 1,
    page_size: 20,
    target_language: "he",
    target_currency: "USD",
    ship_to_country: "IL",
    sort: "SALE_PRICE_ASC"
  });

  if (!resp?.ok) return { ok: false, message: resp?.message || "AliExpress API error", raw: resp };

  // מבנה תוצאות יכול להשתנות – שולפים הכי גמיש שאפשר
  const root = resp.data || {};
  const container =
    root.aliexpress_affiliate_product_query_response ||
    root.aliexpress_affiliate_product_query_resp ||
    root.aliexpress_affiliate_product_query_result ||
    root;

  const result = container.result || container?.resp_result || container;
  const products =
    result?.products?.product ||
    result?.products ||
    result?.product_list ||
    result?.product ||
    [];

  const list = Array.isArray(products) ? products : [];

  return { ok: true, products: list };
}

async function aliGenerateLinks(urls) {
  const client = getAffiliateClient();
  if (!client) return { ok: false, message: "חסרים ALI_ACCESS_TOKEN / ae_sdk" };

  const source_values = urls.join(",");
  const resp = await client.generateAffiliateLinks({
    promotion_link_type: 0,
    source_values,
    tracking_id: ALI_TRACKING_ID,
    app_signature: ALI_APP_SIGNATURE
  });

  if (!resp?.ok) return { ok: false, message: resp?.message || "link generate error", raw: resp };

  const root = resp.data || {};
  const container =
    root.aliexpress_affiliate_link_generate_response ||
    root.aliexpress_affiliate_link_generate_resp ||
    root;

  const result = container.result || container;
  const links =
    result?.promotion_links?.promotion_link ||
    result?.promotion_links ||
    result?.links ||
    [];

  const arr = Array.isArray(links) ? links : [];
  return { ok: true, links: arr };
}

function extractProductUrl(p) {
  return (
    p?.product_detail_url ||
    p?.product_detail_url_short ||
    p?.productUrl ||
    p?.product_url ||
    ""
  );
}

function extractImageUrl(p) {
  return (
    p?.product_main_image_url ||
    p?.product_main_image_url_https ||
    p?.product_main_image_url_http ||
    p?.imageUrl ||
    p?.product_image ||
    ""
  );
}

function extractTitle(p) {
  return (
    p?.product_title ||
    p?.title ||
    p?.product_name ||
    "מוצר"
  );
}

function extractRating(p) {
  // לפעמים מגיע כ evaluate_rate / commission_rate וכו
  const r =
    p?.evaluate_rate ||
    p?.evaluation_score ||
    p?.rating ||
    p?.score ||
    "";
  const num = Number(r);
  if (Number.isFinite(num) && num > 0) return num.toFixed(1);
  return "לא זמין";
}

function extractPriceUSD(p) {
  // לפעמים sale_price: "US $12.34" או "12.34"
  const raw =
    p?.sale_price ||
    p?.target_sale_price ||
    p?.salePrice ||
    p?.price ||
    "";

  const s = raw.toString();
  const m = s.match(/(\d+(\.\d+)?)/);
  if (!m) return NaN;
  return Number(m[1]);
}

function buildCaption(query, items) {
  let out = "";
  out += buildHeader(query);
  out += "💥 מצאתי לך 4 תוצאות טובות:\n\n";

  items.forEach((it, idx) => {
    out += `🛒 ${idx + 1}. ${it.title}\n`;
    out += `💰 מחיר: ${it.priceILS}\n`;
    out += `💫 דירוג: ${it.rating}\n`;
    out += `🔗 קישור: ${it.link}\n\n`;
  });

  out += "🧠 רוצה שאחפש עוד משהו? כתבו: חפשי לי ____";
  return out.trim();
}

app.get("/", (req, res) => {
  res.send("🤖 WhatsApp bot is running");
});

app.get("/collage/:id", (req, res) => {
  const id = req.params.id;
  const item = collageStore.get(id);

  if (!item || item.expiresAt < nowMs()) {
    collageStore.delete(id);
    return res.status(404).send("Not found");
  }

  res.setHeader("Content-Type", "image/png");
  res.send(item.buffer);
});

app.post("/webhook", async (req, res) => {
  // תמיד להחזיר 200 מהר כדי ש-Webhook לא יתקע
  res.sendStatus(200);

  const body = req.body || {};
  const chatId = extractChatId(body);
  const text = extractText(body).trim();
  const idMessage = extractIdMessage(body);

  if (!chatId || !isAllowedGroup(chatId)) return;
  if (!text) return;

  // מחיקת לינקים לא קשורים (רק אם זה באמת לינק, והוא לא אליאקספרס, והוא לא פקודה)
  // לא מוחקים "בוט תקין 🤖" / "בדיקה" / "חפשי לי ..."
  try {
    if (hasAnyUrl(text) && !isAliExpressUrl(text) && !isCommandAllowed(text)) {
      await greenApiDeleteMessage(chatId, idMessage);
      return;
    }
  } catch (e) {
    // אם אין הרשאות מחיקה – פשוט מתעלמים
  }

  // בדיקה
  if (text === "בדיקה") {
    await greenApiSendText(chatId, "בוט תקין 🤖");
    return;
  }

  // חיפוש
  const t = safeLower(text);
  const prefix1 = "חפשי לי";
  const prefix2 = "חפש לי";

  let query = "";
  if (t.startsWith(prefix1)) query = text.slice(prefix1.length).trim();
  else if (t.startsWith(prefix2)) query = text.slice(prefix2.length).trim();

  if (!query) return;

  // הודעת "שניה אחת"
  await greenApiSendText(chatId, "שניה אחת 1️⃣");

  // חובה: אם חסר טוקן אמיתי של אלי אקספרס
  if (!ALI_ACCESS_TOKEN || !ALI_APP_SIGNATURE) {
    await greenApiSendText(
      chatId,
      "חסר לי ALI_ACCESS_TOKEN / ALI_APP_SIGNATURE כדי להביא מוצרים אמיתיים מאלי אקספרס ❌\nכשתוסיף אותם ב-Render זה יעבוד מיד."
    );
    return;
  }

  // חיפוש מוצרים
  let search;
  try {
    search = await aliSearchProducts(query);
  } catch (e) {
    await greenApiSendText(chatId, "יש תקלה בחיפוש באלי אקספרס ❌ נסה שוב עוד דקה.");
    return;
  }

  if (!search.ok) {
    await greenApiSendText(chatId, "לא הצלחתי לחפש כרגע ❌ ברצונך לבקש משהו אחר?");
    return;
  }

  const rawProducts = pickFirst4(search.products);
  if (!rawProducts.length) {
    await greenApiSendText(chatId, "מוצר זה לא קיים ❌ ברצונך לבקש משהו אחר?");
    return;
  }

  const urls = rawProducts.map(extractProductUrl).filter(Boolean).slice(0, 4);
  const imgs = rawProducts.map(extractImageUrl).filter(Boolean).slice(0, 4);

  if (urls.length < 4 || imgs.length < 4) {
    await greenApiSendText(chatId, "מצאתי תוצאות אבל חסר מידע (לינק/תמונה). נסה ניסוח אחר 🙏");
    return;
  }

  // לינקים שותפים
  let gen;
  try {
    gen = await aliGenerateLinks(urls);
  } catch (e) {
    await greenApiSendText(chatId, "בעיה ביצירת לינק שותפים ❌ נסה שוב עוד דקה.");
    return;
  }

  if (!gen.ok) {
    await greenApiSendText(chatId, "בעיה ביצירת לינק שותפים ❌ ברצונך לבקש משהו אחר?");
    return;
  }

  // ממפים לינקים לפי input url
  const linkMap = new Map();
  (gen.links || []).forEach((l) => {
    const inUrl = l?.source_value || l?.original_link || l?.source || "";
    const outUrl = l?.promotion_link || l?.short_link || l?.url || "";
    if (inUrl && outUrl) linkMap.set(inUrl, outUrl);
  });

  const items = rawProducts.slice(0, 4).map((p) => {
    const title = extractTitle(p);
    const rating = extractRating(p);
    const priceUSD = extractPriceUSD(p);
    const priceILS = formatILS(priceUSD * ILS_RATE);

    const u = extractProductUrl(p);
    const link = linkMap.get(u) || u;

    return { title, rating, priceILS, link };
  });

  // קולאז׳ תמונות
  let collageBuffer;
  try {
    collageBuffer = await buildCollage4(imgs);
  } catch (e) {
    // אם נכשל קולאז׳ – שולחים בלי תמונה
    const captionOnly = buildCaption(query, items);
    await greenApiSendText(chatId, captionOnly);
    return;
  }

  const collageId = uuidv4();
  collageStore.set(collageId, { buffer: collageBuffer, expiresAt: nowMs() + 10 * 60 * 1000 });

  const collageUrl = `${PUBLIC_BASE_URL}/collage/${collageId}`;
  const caption = buildCaption(query, items);

  try {
    await greenApiSendFileByUrl(chatId, collageUrl, `results-${Date.now()}.png`, caption);
  } catch (e) {
    // אם שליחת תמונה נכשלה – שולחים טקסט בלבד
    await greenApiSendText(chatId, caption);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ Allowed groups: ${Array.from(allowedGroupIds).join(", ")}`);
});
