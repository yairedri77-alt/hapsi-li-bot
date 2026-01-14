const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "2mb" }));

/* ===== ENV ===== */
const {
  GREEN_API_ID,
  GREEN_API_TOKEN,
  ALI_APP_KEY,
  ALI_APP_SECRET,
  ALI_TRACKING_ID,
  ALI_CURRENCY = "ILS",
  ALI_LANGUAGE = "HE"
} = process.env;

const GREEN_BASE = "https://api.green-api.com";
const ALI_API = "https://gw.api.taobao.com/router/rest";

/* ===== Utils ===== */
function tsChina() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function sign(params) {
  const keys = Object.keys(params).sort();
  let base = ALI_APP_SECRET;
  for (const k of keys) base += k + params[k];
  base += ALI_APP_SECRET;
  return crypto.createHash("md5").update(base).digest("hex").toUpperCase();
}

async function aliCall(method, extra) {
  const params = {
    method,
    app_key: ALI_APP_KEY,
    sign_method: "md5",
    timestamp: tsChina(),
    format: "json",
    v: "2.0",
    ...extra
  };
  params.sign = sign(params);

  const { data } = await axios.post(ALI_API, null, {
    params,
    timeout: 15000
  });

  if (JSON.stringify(data).includes("error_response")) {
    throw new Error("ALI ERROR");
  }
  return data;
}

/* ===== Green API ===== */
async function sendText(chatId, text) {
  await axios.post(
    `${GREEN_BASE}/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`,
    { chatId, message: text },
    { timeout: 15000 }
  );
}

async function sendImage(chatId, image, caption) {
  await axios.post(
    `${GREEN_BASE}/waInstance${GREEN_API_ID}/sendFileByUrl/${GREEN_API_TOKEN}`,
    {
      chatId,
      urlFile: image,
      fileName: "product.jpg",
      caption
    },
    { timeout: 20000 }
  );
}

/* ===== Ali logic ===== */
async function searchAli(query) {
  const data = await aliCall("aliexpress.affiliate.product.query", {
    keywords: query,
    page_no: 1,
    page_size: 20,
    tracking_id: ALI_TRACKING_ID,
    target_currency: ALI_CURRENCY,
    target_language: ALI_LANGUAGE
  });

  const list =
    data?.aliexpress_affiliate_product_query_response
      ?.resp_result?.result?.products?.product || [];

  return Array.isArray(list) ? list.slice(0, 4) : [];
}

async function genLinks(urls) {
  if (!urls.length) return new Map();

  const data = await aliCall("aliexpress.affiliate.link.generate", {
    tracking_id: ALI_TRACKING_ID,
    promotion_link_type: 0,
    source_values: urls.join(",")
  });

  const links =
    data?.aliexpress_affiliate_link_generate_response
      ?.resp_result?.result?.promotion_links?.promotion_link || [];

  const map = new Map();
  for (const l of links) {
    if (l?.source_value && l?.promotion_link) {
      map.set(l.source_value, l.promotion_link);
    }
  }
  return map;
}

/* ===== Routes ===== */
app.get("/", (_, res) => res.send("OK"));

app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // חשוב: לא לחכות

  try {
    const chatId =
      req.body?.senderData?.chatId ||
      req.body?.messageData?.chatId;

    const text =
      req.body?.messageData?.textMessageData?.textMessage || "";

    if (!chatId || !text) return;

    if (text.trim() === "בדיקה") {
      await sendText(chatId, "🤖 בוט תקין");
      return;
    }

    const m = text.match(/^חפשי לי\s+(.+)/);
    if (!m) return;

    const query = m[1].trim();
    await sendText(chatId, "מחפש עבורך… 🔥 זה לוקח כ־5–7 שניות");

    const products = await searchAli(query);
    if (!products.length) {
      await sendText(chatId, "לא מצאתי תוצאות כרגע 😕");
      return;
    }

    const urls = products
      .map(p => p.product_detail_url)
      .filter(Boolean);

    const aff = await genLinks(urls);

    const lines = ["🛒 מצאתי 4 אפשרויות טובות:"];
    products.forEach((p, i) => {
      const price = p.target_sale_price || p.sale_price || "";
      const link = aff.get(p.product_detail_url) || p.product_detail_url;
      lines.push(
        `\n${i+1}. ${p.product_title}\n💰 ${price} שקלים\n🔗 ${link}`
      );
    });

    const img = products[0]?.product_main_image_url;
    if (img) {
      await sendImage(chatId, img, lines.join("\n"));
    } else {
      await sendText(chatId, lines.join("\n"));
    }

  } catch (e) {
    console.error("BOT ERROR:", e.message);
  }
});

/* ===== Start ===== */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("✅ Server running on", PORT));
