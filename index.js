const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const GREEN_API_ID = process.env.GREEN_API_ID;
const GREEN_API_TOKEN = process.env.GREEN_API_TOKEN;

app.get("/", (req, res) => {
  res.send("🤖 WhatsApp bot is running");
});

app.post("/webhook", async (req, res) => {
  console.log("🔥 WEBHOOK RECEIVED");
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const message = req.body.messageData?.textMessageData?.textMessage;
    const chatId = req.body.senderData?.chatId;

    if (!message || !chatId) return res.sendStatus(200);

    await axios.post(
      `https://api.green-api.com/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`,
      { chatId, message: `קיבלתי ממך: ${message}` }
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
