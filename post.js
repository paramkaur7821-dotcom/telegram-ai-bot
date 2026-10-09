require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const getTrendingTopic = require('./gettrend');
const generateMessage = require('./generatemassags');
const getImage = require('./getimags');
const { resolvePublisherUrl, fetchArticleText } = require('./article');
const logError = require('./logerror');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });

const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_CAPTION_LIMIT = 1024;

function buildCaption(title, text) {
  const cleanTitle = String(title || '').trim();
  const body = String(text || '').trim();
  const sentences = body.match(/[^.!?]+[.!?]+/g) || (body ? [body] : []);
  let caption = cleanTitle;
  for (const sentence of sentences.slice(0, 2)) {
    const candidate = `${caption}\n${sentence.trim()}`;
    if (candidate.length > TELEGRAM_CAPTION_LIMIT) break;
    caption = candidate;
  }
  if (caption.length > TELEGRAM_CAPTION_LIMIT) {
    const cut = caption.lastIndexOf('. ', TELEGRAM_CAPTION_LIMIT - 1);
    caption = cut > 0 ? caption.slice(0, cut + 1) : caption.slice(0, TELEGRAM_CAPTION_LIMIT);
  }
  return caption;
}

function splitMessage(text, limit) {
  const chunks = [];
  let remaining = String(text || '').trim();
  while (remaining.length > limit) {
    let cut = -1;
    for (const end of ['. ', '! ', '? ', '\n']) {
      const idx = remaining.lastIndexOf(end, limit - 1);
      if (idx > cut) cut = idx + (end === '\n' ? 0 : 1);
    }
    if (cut < limit * 0.5) {
      const space = remaining.lastIndexOf(' ', limit - 1);
      cut = space > 0 ? space : limit;
    }
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

async function sendFullText(chatId, text) {
  for (const part of splitMessage(text, TELEGRAM_TEXT_LIMIT)) {
    await bot.sendMessage(chatId, part);
  }
}

async function run() {
  try {
    const topic = await getTrendingTopic();
    console.log("Topic:", topic.title);

    const publisherUrl = await resolvePublisherUrl(topic.link);
    const articleText = publisherUrl ? await fetchArticleText(publisherUrl) : '';
    const articleUrl = publisherUrl || topic.link || '';

    const messageText = await generateMessage(topic, { articleText, articleUrl });
    console.log(`Message ready (${messageText.length} chars).`);

    const image = await getImage(topic, { publisherUrl });
    const imageUrl = image && image.url;
    console.log(`Post image: ${imageUrl || 'none'} (source: ${image?.source || 'none'})`);

    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (imageUrl) {
      const caption = buildCaption(topic.title, messageText);
      try {
        await bot.sendPhoto(chatId, imageUrl, { caption });
      } catch (imgErr) {
        logError("Image send failed, sending text only:", imgErr);
      }
      await sendFullText(chatId, messageText);
    } else {
      await sendFullText(chatId, messageText);
    }

    console.log("Posted successfully!");
  } catch (err) {
    logError("Error:", err);
  }
}

run();
