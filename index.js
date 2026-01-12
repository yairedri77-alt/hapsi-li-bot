const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GREEN_API_ID = process.env.GREEN_API_ID;
const GREEN_API_TOKEN = process.env.GREEN_API_TOKEN;

app.get("/", (req, res) => {
  res.send("🤖 WhatsApp bot is running");
});

app.get("/test-green", async (req, res) => {
  try {
    const url = `https://api.green-api.com/waInstance${GREEN_API_ID}/getStateInstance/${GREEN_API_TOKEN}`;
    const response = await axios.get(url);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
