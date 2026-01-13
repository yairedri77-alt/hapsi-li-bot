const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const GREEN_API_ID = process.env.GREEN_API_ID;
const GREEN_API_TOKEN = process.env.GREEN_API_TOKEN;

// ✅ קבוצה מורשית בלבד
const ALLOWED_GROUPS = [
  "120363422161709210@g.us"
];

// 🔗 בדיקת קישור
function containsLink(text) {
  return /(https?:\/\/|www\.|\.com|\.co|\.il|\.net)/i.test(text);
}

// 🟢 קישור אלי אקספרס – מותר
function isAliExpressLink(text) {
  return /(aliexpress\.com|s\.click\.aliexpress\.com)/i.test(text);
}

// 🛒 מוצרים לדוגמה
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
      title: `${query} נמכר ביותר`,
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

app.get("/", (req, res) => {
  res.send("🤖 WhatsApp bot is running");
});

app.post("/webhook", async (req, res) => {
  try {
    const message =
      req.body.messageData?.textMessageData?.textMessage ||
      req.body.messageData?.extendedTextMessageData?.text;

    const chatId = req.body.senderData?.chatId;
    const idMessage = req.body.idMessage;

    if (!message || !chatId) return res.sendStatus(200);

    // ❌ רק קבוצה מורשית
    if (!ALLOWED_GROUPS.includes(chatId)) return res.sendStatus(200);

    const text = message.trim();

    // ❌ קישור לא קשור → מחיקה
    if (containsLink(text) && !isAliExpressLink(text)) {
      await axios.post(
        `https://api.green-api.com/waInstance${GREEN_API_ID}/deleteMessage/${GREEN_API_TOKEN}`,
        { chatId, idMessage }
      );
      return res.sendStatus(200);
    }

    // ✅ בדיקה
    if (text === "בדיקה") {
      await axios.post(
        `https://api.green-api.com/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`,
        { chatId, message: "בוט תקין 🤖" }
      );
      return res.sendStatus(200);
    }

    // 🔎 חפשי לי ...
    if (text.startsWith("חפשי לי ")) {
      const query = text.replace("חפשי לי", "").trim();

      if (!query) return res.sendStatus(200);

      await axios.post(
        `https://api.green-api.com/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`,
        { chatId, message: "שניה אחת 1️⃣" }
      );

      const products = mockAliExpressProducts(query);

      let reply = `🔎 *${query}*\n\n`;

      products.forEach((p, i) => {
        reply += `*${i + 1}. ${p.title}*\n`;
        reply += `${p.rating}\n`;
        reply += `💰 ${p.price}\n`;
        reply += `🔗 ${p.link}\n\n`;
      });

      await axios.post(
        `https://api.green-api.com/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`,
        { chatId, message: reply }
      );

      return res.sendStatus(200);
    }

    // ❌ כל טקסט אחר – לא נמחק, פשוט מתעלמים
    res.sendStatus(200);

  } catch (err) {
    console.error("❌ ERROR:", err.message);
    q;
    res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
