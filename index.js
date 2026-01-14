const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "10mb" }));

/* =======================
   HEALTH CHECK
======================= */
app.get("/health", (req, res) => res.send("OK"));

/* =======================
   GREEN API SEND
======================= */
async function sendText(chatId, text) {
  const url = `https://api.green-api.com/waInstance${process.env.GREEN_API_INSTANCE}/sendMessage/${process.env.GREEN_API_TOKEN}`;
  await axios.post(url, { chatId, message: text }, { timeout: 15000 });
}

async function sendImage(chatId, imageUrl, caption) {
  const url = `https://api.green-api.com/waInstance${process.env.GREEN_API_INSTANCE}/sendFileByUrl/${process.env.GREEN_API_TOKEN}`;
  await axios.post(
    url,
    {
      chatId,
      urlFile: imageUrl,
      fileName: "product.jpg",
      caption,
    },
    { timeout: 20000 }
  );
}

/* =======================
   ALIEXPRESS SEARCH
======================= */
function sign(params) {
  const sorted = Object.keys(params)
    .sort()
    .map(k => k + params[k])
    .join("");
  return crypto
    .createHmac("sha256", process.env.ALI_APP_SECRET)
    .update(sorted)
    .digest("hex")
    .toUpperCase();
}

async function searchAli(keyword) {
  const params = {
    app_key: process.env.ALI_APP_KEY,
    method: "aliexpress.affiliate.product.query",
    format: "json",
    v: "2.0",
    sign_method: "sha256",
    timestamp: Date.now(),
    keywords: keyword,
    page_no: 1,
    page_size: 4,
    tracking_id: process.env.ALI_TRACKING_ID,
    target_currency: "ILS",
    target_language: "HE",
  };

  params.sign = sign(params);

  const res = await axios.get(
    "https://gw.api.alibaba.com/openapi/param2/2/portals.open/api",
    { params, timeout: 15000 }
  );

  return res.data?.aliexpress_affiliate_product_query_response?.result?.products || [];
}

/* =======================
   WEBHOOK
======================= */
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body.message?.textMessage?.textMessage;
    const chatId = req.body.message?.chatId;
    if (!msg || !chatId) return;

    // בדיקה
    if (msg.trim() === "בדיקה") {
      await sendText(chatId, "🤖 בוט תקין");
      return;
    }

    // חיפוש
    if (msg.startsWith("חפשי לי")) {
      const keyword = msg.replace("חפשי לי", "").trim();
      if (!keyword) return;

      await sendText(
        chatId,
        "🔥 מחפש עבורך את הדילים הכי טובים...\n⏳ זה לוקח כ־5–7 שניות"
      );

      const products = await searchAli(keyword);
      if (!products.length) {
        await sendText(chatId, "😕 לא מצאתי מוצרים כרגע, נסה מילה אחרת");
        return;
      }

      const p = products[0];
      const image = p.product_main_image_url;
      const caption =
        `🛒 ${keyword}\n\n` +
        products
          .map(
            (x, i) =>
              `🔹 מוצר ${i + 1}\n💰 ${Math.round(
                x.target_sale_price
              )} שקלים\n⭐ ${x.evaluate_rate || "4.5"}\n🔗 ${x.promotion_link}`
          )
          .join("\n\n");

      await sendImage(chatId, image, caption);
    }
  } catch (e) {
    console.error("BOT ERROR:", e.message);
  }
});

/* =======================
   SERVER
======================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("✅ Bot running on port", PORT)
);
