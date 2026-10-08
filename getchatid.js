require('dotenv').config();
const axios = require('axios');
const logError = require('./logerror');

async function getChatId() {
  try {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getUpdates`;
    const res = await axios.get(url);
    console.log(JSON.stringify(res.data, null, 2));
  } catch (err) {
    logError("getUpdates failed:", err);
  }
}

getChatId();