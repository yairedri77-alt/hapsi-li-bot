const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const GREEN_API_ID = process.env.GREEN_API_ID;
const GREEN_API_TOKEN = process.env.GREEN_API_TOKEN;

// ✅ הקבוצה היחידה שמותר לבוט להגיב בה
const ALLOWED_GROUP_ID = "120363422161709210@g.us";

// ✅ המילה היחידה שתפעיל תגובה
const TRIGGER_WORD = "בדיקה";

app.get("/", (req, res) => {
  res.send("🤖 WhatsApp bot is running");
});

app.post("/webhook", async (req, res) => {
  try {
    console.log("🔥 WEBHOOK RECEIVED");
    console.log(JSON.stringify(req.body, null, 2));

    // מוציא chatId (מאיפה הגיעה ההודעה)
    const chatId = req.body?.senderData?.chatId;

    // מוציא טקסט הודעה מכל סוגי ההודעות הנפוצים
    const message =
      req.body?.messageData?.textMessageData?.textMessage ||
      req.body?.messageData?.extendedTextMessageData?.text ||
      "";

    // אם אין נתונים - יוצאים
    if (!chatId || !message) return res.sendStatus(200);

    const cleanMessage = String(message).trim();

    // ✅ מגיב רק בקבוצה שהגדרת
    if (chatId !== ALLOWED_GROUP_ID) {
      return res.sendStatus(200);
    }

    // ✅ מגיב רק אם כתבו בדיוק "בדיקה"
    if (cleanMessage !== TRIGGER_WORD) {
      return res.sendStatus(200);
    }

    // שולח תגובה
    await axios.post(
      `https://api.green-api.com/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`,
      {
        chatId,
        message: "בוט תקין 🤖",
      }
    );

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ ERROR:", err?.response?.data || err.message);
    return res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
