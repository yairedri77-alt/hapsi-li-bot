const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ===== ENV =====
const PORT = process.env.PORT || 10000;
const GREEN_API_ID = process.env.GREEN_API_ID;
const GREEN_API_TOKEN = process.env.GREEN_API_TOKEN;

const GREEN_BASE_URL = `https://${GREEN_API_ID}.api.greenapi.com/waInstance${GREEN_API_ID}`;

// ===== HOME =====
app.get("/", (req, res) => {
  res.send("🤖 WhatsApp bot is running");
});

// ===== WEBHOOK =====
app.post("/webhook", async (req, res) => {
  console.log("🔥 WEBHOOK RECEIVED");
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const messageData = req.body.messageData;
    const senderData = req.body.senderData;

    if (!messageData || !senderData) {
      return res.sendStatus(200);
    }

    // טקסט שנשלח
    const text =
      messageData.textMessageData?.textMessage ||
      messageData.extendedTextMessageData?.text ||
      null;

    if (!text) {
      return res.sendStatus(200);
    }

    const chatId = senderData.chatId;

    // ===== SEND REPLY =====
    const sendUrl = `${GREEN_BASE_URL}/sendMessage/${GREEN_API_TOKEN}`;

    await axios.post(sendUrl, {
      chatId: chatId,
      message: `קיבלתי: "${text}" ✅`,
    });

    console.log("✅ Reply sent to", chatId);
  } catch (err) {
    console.error("❌ ERROR:", err.message);
  }

  res.sendStatus(200);
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
