const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const {
  ALI_APP_KEY,
  ALI_APP_SECRET,
  ALI_TRACKING_ID,
  ILS_RATE,
  GREEN_API_INSTANCE,
  GREEN_API_TOKEN
} = process.env;

// חתימה לאלי
function sign(params) {
  const sorted = Object.keys(params).sort();
  let str = "";
  sorted.forEach(k => str += k + params[k]);
  return crypto
    .createHmac("sha256", ALI_APP_SECRET)
    .update(str)
    .digest("hex")
    .toUpperCase();
}

// חיפוש מוצרים
async function searchAli(query) {
  const params = {
    app_key: ALI_APP_KEY,
    method: "aliexpress.affiliate.product.query",
    timestamp: Date.now(),
    format: "json",
    v: "2.0",
    sign_method: "sha256",
    keywords: query,
    page_no: 1,
    page_size: 4,
    target_currency: "USD",
    target_language: "he",
    tracking_id: ALI_TRACKING_ID
  };

  params.sign = sign(params);

  const { data } = await axios.get(
    "https://api-sg.aliexpress.com/sync",
    { params, timeout: 15000 }
  );

  return data?.aliexpress_affiliate_product_query_response?.result?.products || [];
}

// שליחה בוואטסאפ
async function sendMessage(chatId, text, image) {
  const url = `https://api.green-api.com/waInstance${GREEN_API_INSTANCE}/sendFileByUrl/${GREEN_API_TOKEN}`;
  await axios.post(url, {
    chatId,
    urlFile: image,
    fileName: "product.jpg",
    caption: text
  });
}

// Webhook
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // 👈 עונים מיד! אין timeout

  try {
    const msg = req.body.message?.textMessageData?.textMessage;
    const chatId = req.body.senderData?.chatId;

    if (!msg || !msg.includes("חפשי לי")) return;

    const query = msg.replace("חפשי לי", "").trim();

    // הודעת ביניים
    await sendMessage(
      chatId,
      "🔥 מחפש עבורך את הדילים הכי טובים...\n⏳ זה לוקח כ־5–7 שניות",
      "https://i.imgur.com/Z6XH5yY.png"
    );

    const products = await searchAli(query);

    if (!products.length) {
      await sendMessage(chatId, "😕 לא מצאתי מוצרים כרגע", "https://i.imgur.com/0Z8FQqM.png");
      return;
    }

    for (const p of products) {
      const price = Math.round((p.target_sale_price || 0) * ILS_RATE);

      const text = 
`🛒 ${p.product_title}
💰 ${price} שקלים
⭐ ${p.evaluate_rate || "לא זמין"}
🔗 ${p.promotion_link}`;

      await sendMessage(chatId, text, p.product_main_image_url);
    }

  } catch (e) {
    console.error("ALI SEARCH FAIL:", e.message);
  }
});

app.listen(10000, () => console.log("✅ Bot running"));
