const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const GREEN_API_ID = process.env.GREEN_API_ID;
const GREEN_API_TOKEN = process.env.GREEN_API_TOKEN;

// ✅ הקבוצה המורשית בלבד
const ALLOWED_GROUPS = [
  "120363422161709210@g.us"
];

// 🔍 בדיקת קישור / ספאם
function containsLink(text) {
  return /(https?:\/\/|www\.|\.com|\.co|\.il|\.net)/i.test(text);
}

// 🛒 מוצרים לדוגמה (בשלב הבא מוחלף באלי אקספרס אמיתי)
function mockAliExpressProducts(query) {
  return [
    {
      title: `${query} איכותי`,
      price: "49 ₪",
      rating: "⭐ 4.6",
      link: "https://s.click.aliexpress.com/example1"
    },
    {
      title: `${query} פרימיום`,
      price: "59 ₪",
      rating: "⭐ 4.7",
      link: "https://s.click.aliexpress.com/example2"
    },
    {
      title: `${query} הנמכר ביותר`,
      price: "39 ₪",
      rating: "⭐ 4.5",
      link: "https://s.click.aliexpress.com/example3"
    },
    {
      title: `${query} מומלץ 🔥`,
      price: "69 ₪",
      rating: "⭐ 4.8",
      link: "https://s.click.aliexpress.com/example4"
    }
  ];
}

// 🌐 בדיקת שרת
app.get("/", (req, res) => {
  res.send("🤖 WhatsApp bot is running");
});

// 📩 Webhook
app.post("/webhook", async (req, res) => {
  try {
    const message =
      req.body.messageData?.textMessageData?.textMessage ||
      req.body.messageData?.extendedTextMessageData?.text;

    const chatId = req.body.senderData?.chatId;

    if (!message || !chatId) return res.sendStatus(200);

    // ❌ רק קבוצות מורשות
    if (!ALLOWED_GROUPS.includes(chatId)) return res.sendStatus(200);

    const cleanMessage = message.trim();

    // ❌ מחיקת קישורים / ספאם
    if (containsLink(cleanMessage)) {
      await axios.post(
        `https://api.green-api.com/waInstance${GREEN_API_ID}/deleteMessage/${GREEN_API_TOKEN}`,
        {
          chatId,
          idMessage: req.body.idMessage
        }
      );
      return res.sendStatus(200);
    }

    // ✅ בדיקה
    if (cleanMessage === "בדיקה") {
      await axios.post(
        `https://api.green-api.com/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`,
        {
          chatId,
          message: "בוט תקין 🤖"
        }
      );
      return res.sendStatus(200);
    }

    // 🔎 חפשי לי ...
    if (cleanMessage.startsWith("חפשי לי ")) {
      const query = cleanMessage.replace("חפשי לי", "").trim();

      if (!query) {
        await axios.post(
          `https://api.green-api.com/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`,
          {
            chatId,
            message: "❌ לא ציינת מוצר לחיפוש"
          }
        );
        return res.sendStatus(200);
      }

      // ⏳ הודעת ביניים
      await axios.post(
        `https://api.green-api.com/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`,
        {
          chatId,
          message: "שניה אחת 1️⃣"
        }
      );

      const products = mockAliExpressProducts(query);

      let reply = `🔎 חיפשתי עבורך: *${query}*\n\n`;

      products.forEach((p, i) => {
        reply += `*${i + 1}. ${p.title}*\n`;
        reply += `${p.rating}\n`;
        reply += `💰 ${p.price}\n`;
        reply += `🔗 ${p.link}\n\n`;
      });

      await axios.post(
        `https://api.green-api.com/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`,
        {
          chatId,
          message: reply
        }
      );

      return res.sendStatus(200);
    }

    // ❌ כל דבר אחר – נמחק
    await axios.post(
      `https://api.green-api.com/waInstance${GREEN_API_ID}/deleteMessage/${GREEN_API_TOKEN}`,
      {
        chatId,
        idMessage: req.body.idMessage
      }
    );

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ ERROR:", err.message);
    res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
