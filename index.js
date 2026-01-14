const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "2mb" }));

/* ================= ENV ================= */
const {
  GREEN_API_ID,
  GREEN_API_TOKEN,
  ALI_APP_KEY,
  ALI_APP_SECRET,
  ALI_TRACKING_ID,
  ILS_RATE = 3.7,
} = process.env;

const GREEN_BASE = "https://api.green-api.com";
const ALI_API = "https://gw.api.taobao.com/router/rest";

/* ================= HELPERS ================= */
function chinaTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function sign(params) {
  const keys = Object.keys(params).sort();
  let s = ALI_APP_SECRET;
  for (const k of keys) s += k + params[k];
  s += ALI_APP_SECRET;
  return crypto.createHash("md5").update(s).digest("hex").toUpperCase();
}

async function aliCall(method, extra) {
  const params = {
    method,
    app_key: ALI_APP_KEY,
    sign_method: "md5",
    timestamp: chinaTime(),
    format: "json",
    v: "2.0",
    ...extra,
  };

  const { data } = await axios.post(
    ALI_API,
    null,
    { params: { ...params, sign: sign(params) }, timeout: 10000 }
  );

  if (JSON.stringify(data).includes("error_response")) {
    throw new Error("ALI API ERROR");
  }
  return data;
}

async function sendText(chatId, text) {
  await axios.post(
    `${GREEN_BASE}/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`,
    { chatId, message: text },
    { timeout: 10000 }
  );
}

async function sendImage(chatId, imageUrl, caption) {
  await axios.post(
    `${GREEN_BASE}/waInstance${GREEN_API_ID}/sendFileByUrl/${GREEN_API_TOKEN}`,
    {
      chatId,
      urlFile: imageUrl,
      fileName: "product.jpg",
      caption,
    },
    { timeout: 15000 }
  );
}

/* ================= LOGIC ================= */
async function handleSearch(chatId, query) {
  try {
    const data = await aliCall("aliexpress.affiliate.product.query", {
      keywords: query, // אפשר גם לתרגם לאנגלית בעתיד
      page_no: 1,
      page_size: 20,
      tracking_id: ALI_TRACKING_ID,
      target_currency: "ILS",
      target_language: "HE",
    });

    const products =
      data?.aliexpress_affiliate_product_query_response?.resp_result?.result?.products?.product;

    if (!Array.isArray(products) || products.length === 0) {
      await sendText(chatId, "😕 לא מצאתי תוצאות כרגע, נסה לנסח אחרת");
      return;
    }

    const top = products.slice(0, 4);

    const image =
      top[0]?.product_main_image_url ||
      top[0]?.main_image_url ||
      null;

    let msg = "🛒 מצאתי עבורך 4 אפשרויות טובות 👇\n";

    top.forEach((p, i) => {
      const title = p.product_title || "מוצר מאלי אקספרס";
      const price = p.target_sale_price || p.sale_price || "לא זמין";
      const link = p.product_detail_url || p.product_url;

      msg += `\n${i + 1}. ${title}\n💰 ${price} שקלים\n🔗 ${link}\n`;
    });

    if (image) {
      await sendImage(chatId, image, msg);
    } else {
      await sendText(chatId, msg);
    }

  } catch (err) {
    console.error("ALI FAIL:", err.message);
    await sendText(chatId, "⚠️ הייתה בעיה זמנית בחיפוש, נסה שוב בעוד רגע");
  }
}

/* ================= WEBHOOK ================= */
app.post("/webhook", (req, res) => {
  console.log("📩 WEBHOOK HIT");
  res.sendStatus(200); // <<< הכי חשוב – עונים מיד

  const chatId =
    req.body?.senderData?.chatId ||
    req.body?.messageData?.chatId;

  const text =
    req.body?.messageData?.textMessageData?.textMessage ||
    "";
  console.log("📝 TEXT:", text);

  if (!chatId || !text) return;

  if (text === "בדיקה") {
    sendText(chatId, "בוט תקין 🤖");
    return;
  }

  const m = text.match(/^חפשי לי (.+)/);
  if (!m) return;

  sendText(chatId, "🔍 מחפש עבורך... תן לי כמה שניות 🔥");
  setTimeout(() => handleSearch(chatId, m[1]), 100);
});

app.get("/", (_, res) => res.send("OK"));

app.listen(process.env.PORT || 10000, () =>
  console.log("✅ Bot ready")
);
