require('dotenv').config();
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const getTrendingTopic = require('./gettrend');
const generateMessage = require('./generatemassags');
const getImage = require('./getimags');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });

async function run() {
  try {
    const topic = await getTrendingTopic();
    console.log("Topic:", topic);

    const messageText = await generateMessage(topic);
    console.log("Message:", messageText);

    const imageUrl = await getImage(topic);

    if (imageUrl) {
      await bot.sendPhoto(process.env.TELEGRAM_CHAT_ID, imageUrl, { caption: messageText });
    } else {
      await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, messageText);
    }

    console.log("Posted successfully!");
  } catch (err) {
    console.error("Error:", err.message);
  }
}

run();
