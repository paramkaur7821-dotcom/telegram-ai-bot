require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const getTrendingTopic = require('./gettrend');
const generateMessage = require('./generatemassags');
const getImage = require('./getimags');
const logError = require('./logerror');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });

async function run() {
  try {
    const topic = await getTrendingTopic();
    console.log("Topic:", topic);

    const messageText = await generateMessage(topic);
    console.log("Message:", messageText);

    const imageUrl = await getImage(topic);

    if (imageUrl) {
      try {
        await bot.sendPhoto(process.env.TELEGRAM_CHAT_ID, imageUrl, { caption: messageText });
      } catch (imgErr) {
        logError("Image send failed, sending text only:", imgErr);
        await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, messageText);
      }
    } else {
      await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, messageText);
    }

    console.log("Posted successfully!");
  } catch (err) {
    logError("Error:", err);
  }
}

run();
