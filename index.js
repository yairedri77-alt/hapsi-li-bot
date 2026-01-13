const express = require("express");
const axios = require("axios");

// (אופציונלי) אם תרצה להשתמש ב-SDK של AliExpress:
// npm i ae_sdk
let AffiliateClient;
try {
  ({ AffiliateClient } = require("ae_sdk"));
} catch (e) {
  // אם לא התקנת - עדיין נרוץ, פשוט נחזיר "לא מחובר"
}

const app = express();
app.use(express.json());

// ===== Render / Green API =====
const PORT = process.env.PORT || 10000;
const GREEN_API_ID = process.env.GREEN_API_ID;
const GREEN_API_TOKEN = process.env.GREEN_API_TOKEN;

// ===== AliExpress (מה שאתה שם ב-Render Env Vars) =====
const ALI_APP_KEY = process.env.ALI_APP_KEY;
const ALI_APP_SECRET = process.env.ALI_APP_SECRET;
const ALI_TRACKING_ID = process.env.ALI_TRACKING_ID; // לדוגמה: aliexpress_yair
const ALI_CURRENCY = process.env.ALI_CURRENCY || "ILS"; // תמיד בשקלים
const ALI_LANGUAGE = process.env.ALI_LANGUAGE || "HE";
const ALI_SHIP_TO = process.env.ALI_SHIP_TO || "IL";

// חלק מהחיבורים דורשים גם:
// const ALI_ACCESS_TOKEN = process.env.ALI_ACCESS_TOKEN;
// const ALI_APP_SIGNATURE = process.env.ALI_APP_SIGNATURE;

// ===== קבוצות מורשות בלבד =====
// שים ב-Render ENV: ALLOWED_GROUPS=120363422161709210@g.us,עודקבוצה@g.us
const ALLOWED_GROUPS = (process.env.ALLOWED_GROUPS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedGroup(chatId) {
  if (!chatId) return false;
  if (!chatId.endsWith("@g.us")) return false; // רק קבוצות
  if (ALLOWED_GROUPS.length === 0) return false; // אם לא הוגדר - לא עונה לאף קבוצה
  return ALLOWED_GROUPS.includes(chatId);
}

function normalizeText(s) {
  return (s || "").toString().trim();
}

function extractQuery(text) {
  // תומך: "חפשי לי ..." וגם "חפש לי ..."
  const t = normalizeText(text);
  const m = t.match(/^(חפשי לי|חפש לי)\s+(.+)$/);
  if (!m) return null;
  return normalizeText(m[2]);
}

async function sendMessage(chatId, message) {
  const url = `https://api.green-api.com/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`;
  await axios.post(url, { chatId, message });
}

/**
 * מחפש 4 מוצרים מאליאקספרס לפי מילת חיפוש.
 * אם החיבור לא פעיל/חסר פרטים – מחזיר null.
 */
async function searchAliExpressProducts(keywords) {
  // אם לא התקנת ae_sdk או חסרים פרטי חיבור בסיסיים – אין חיפוש אמיתי
  if (!AffiliateClient || !ALI_APP_KEY || !ALI_APP_SECRET || !ALI_TRACKING_ID) return null;

  // אם אצלך החיבור דורש ACCESS_TOKEN/APP_SIGNATURE – תוסיף אותם ב-ENV ותפתח כאן:
  const session = process.env.ALI_ACCESS_TOKEN; // אם אין, חלק מהחשבונות לא יעבדו
  const app_signature = process.env.ALI_APP_SIGNATURE; // אם נדרש אצלך

  if (!session) {
    // נחזיר null כדי שהבוט יגיד "לא מחובר"
    return null;
  }

  const affiliateClient = new AffiliateClient({
    app_key: ALI_APP_KEY,
    app_secret: ALI_APP_SECRET,
    session,
  });

  // נשתמש ב-"hot products" עם keywords (עובד מעולה גם לחיפוש כללי)
  const resp = await affiliateClient.getHotProducts({
    keywords,
    page_no: 1,
    page_size: 20,
    platform_product_type: "ALL",
    ship_to_country: ALI_SHIP_TO,
    sort: "SALE_PRICE_ASC",
    target_currency: ALI_CURRENCY,
    target_language: ALI_LANGUAGE,
    tracking_id: ALI_TRACKING_ID,
    app_signature, // אם לא נדרש אצלך זה יכול להיות undefined
  });

  if (!resp?.ok) return [];
  // מבנה הנתונים משתנה לפי החשבון/שיטה, לכן אנחנו מגנים עם fallback:
  const list =
    resp.data?.aliexpress_affiliate_hotproduct_query_response?.resp_result?.result?.products ||
    resp.data?.aliexpress_affiliate_hotproduct_query_response?.result?.products ||
    [];

  // ניקח 4 ראשונים
  const top4 = list.slice(0, 4).map((p) => ({
    title: p.product_title || p.title || "מוצר",
    price: p.target_sale_price || p.sale_price || p.price || "",
    rating: p.evaluate_rate || p.product_rating || p.rating || "",
    image: p.product_main_image_url || p.product_image || p.image_url || "",
    link: p.product_detail_url || p.product_url || p.url || "",
  }));

  // ננסה גם להפוך לקישורי שותפים (אם יש endpoint פעיל)
  // אם לא עובד - נשאיר לינק רגיל
  try {
    const urls = top4.map((x) => x.link).filter(Boolean).join(",");
    if (urls) {
      const linksResp = await affiliateClient.generateAffiliateLinks({
        promotion_link_type: 0,
        source_values: urls,
        tracking_id: ALI_TRACKING_ID,
        app_signature,
      });

      const links =
        linksResp?.data?.aliexpress_affiliate_link_generate_response?.resp_result?.result?.promotion_links ||
        linksResp?.data?.aliexpress_affiliate_link_generate_response?.result?.promotion_links ||
        [];

      // מחליפים לפי סדר (אם חוזר באותו סדר)
      for (let i = 0; i < top4.length; i++) {
        if (links[i]?.promotion_link) top4[i].link = links[i].promotion_link;
      }
    }
  } catch (e) {
    // לא חובה
  }

  return top4;
}

function buildResultsMessage(query, items) {
  // בלי טבלאות כדי שזה יישלח יפה בווטסאפ
  const lines = [];
  lines.push(`🔎 מצאתי עבורך: *${query}*`);
  lines.push("");

  items.forEach((it, idx) => {
    const n = idx + 1;
    lines.push(`*${n})* ${it.title}`);
    if (it.price) lines.push(`💰 מחיר: ${it.price} ${ALI_CURRENCY === "ILS" ? "שקלים" : ALI_CURRENCY}`);
    if (it.rating) lines.push(`⭐ דירוג: ${it.rating}`);
    if (it.link) lines.push(`🔗 קישור: ${it.link}`);
    lines.push("");
  });

  return lines.join("\n").trim();
}

app.get("/", (req, res) => {
  res.send("🤖 WhatsApp bot is running");
});

app.post("/webhook", async (req, res) => {
  try {
    // GREEN API שולח לעיתים extendedTextMessage
    const chatId = req.body?.senderData?.chatId;

    // טקסט יכול להגיע בכמה מבנים:
    const message =
      req.body?.messageData?.textMessageData?.textMessage ||
      req.body?.messageData?.extendedTextMessageData?.text ||
      "";

    // תמיד מחזירים 200 מהר כדי לא לעשות retry
    res.sendStatus(200);

    if (!isAllowedGroup(chatId)) return;

    const text = normalizeText(message);

    // 1) בדיקה
    if (text === "בדיקה") {
      await sendMessage(chatId, "בוט תקין 🤖");
      return;
    }

    // 2) חיפוש
    const query = extractQuery(text);
    if (!query) return; // אם לא התחיל ב"חפשי לי" לא מגיב בכלל

    await sendMessage(chatId, "שניה אחת 1️⃣");

    const items = await searchAliExpressProducts(query);

    if (items === null) {
      await sendMessage(
        chatId,
        "החיפוש עדיין לא מחובר לאלי אקספרס ❌\nחסר ACCESS TOKEN / APP SIGNATURE בחיבור.\nברגע שתשים אותם ב-Render זה יעבוד."
      );
      return;
    }

    if (!items || items.length === 0) {
      await sendMessage(chatId, "מוצר זה לא קיים ❌ ברצונך לבקש משהו אחר ?");
      return;
    }

    const msg = buildResultsMessage(query, items);
    await sendMessage(chatId, msg);
  } catch (err) {
    // לא להפיל את השרת
    console.error("❌ ERROR:", err?.message || err);
    try {
      res.sendStatus(200);
    } catch {}
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
