require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

const getTrendingTopic = require('./gettrend');
const { getTrendingTopics } = require('./gettrend');
const generateMessage = require('./generatemassags');
const getImage = require('./getimags');
const { resolvePublisherUrl, fetchArticleText } = require('./article');
const logError = require('./logerror');

const requiredConfig = ['TELEGRAM_BOT_TOKEN', 'GROQ_API_KEY'];
const missingConfig = requiredConfig.filter((name) => !process.env[name]);
if (missingConfig.length > 0) {
  throw new Error(`Missing required environment variables: ${missingConfig.join(', ')}`);
}

// ---------- Web server (Render ke liye zaroori) ----------
const app = express();
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(process.env.PORT || 3000, () => console.log('Web server chalu hai'));

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Supabase key sirf server-side client ke andar rehti hai, kabhi log/print nahi hoti.
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  : null;
if (!supabase) {
  console.warn("SUPABASE_URL / SUPABASE_KEY set nahi hai, chat history aur settings DB off rahengi.");
}

const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const SCHEDULE_TIMEZONE = 'Asia/Kolkata';

const HISTORY_DAYS = 365;
const HISTORY_LIMIT = 20;
const HISTORY_RETENTION_MS = HISTORY_DAYS * 24 * 60 * 60 * 1000;
let currentTask = null;

console.log("Bot chalu ho gaya hai, ab ye messages sun raha hai...");

async function validateGroqKey() {
  try {
    const models = await groq.models.list();
    const ids = (models.data || []).map(m => m.id);
    console.log(`Groq API key valid hai. Model use ho raha hai: ${GROQ_MODEL}`);
    console.log("Available models:", ids.length ? ids.join(', ') : 'koi model nahi mila');
    if (ids.length > 0 && !ids.includes(GROQ_MODEL)) {
      console.warn(`=> '${GROQ_MODEL}' aapke access mein nahi hai. Upar di gayi list mein se GROQ_MODEL env variable mein set karo.`);
    }
  } catch (error) {
    logError("Groq API check failed:", error);
    console.error("=> Naya GROQ_API_KEY console.groq.com se banao aur .env ke saath hosting secrets mein update karo.");
  }
}

// ---------- Chat memory functions ----------
async function getHistory(chatId) {
  if (!supabase) return [];
  try {
    const since = new Date(Date.now() - HISTORY_RETENTION_MS).toISOString();
    const { data, error } = await supabase
      .from('chat_history')
      .select('role, message')
      .eq('chat_id', String(chatId))
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT);
    if (error) {
      logError("Supabase history fetch failed:", error);
      return [];
    }
    return (data || []).reverse();
  } catch (err) {
    logError("Supabase history fetch failed:", err);
    return [];
  }
}

async function saveMessage(chatId, role, message) {
  if (!supabase) return;
  try {
    const { error } = await supabase
      .from('chat_history')
      .insert([{ chat_id: String(chatId), role, message }]);
    if (error) logError("Supabase save failed:", error);
  } catch (err) {
    logError("Supabase save failed:", err);
  }
}

// ---------- Daily cleanup: 30 din se purani history delete karo ----------
async function cleanupOldHistory() {
  if (!supabase) return;
  try {
    const cutoff = new Date(Date.now() - HISTORY_RETENTION_MS).toISOString();
    const { error } = await supabase
      .from('chat_history')
      .delete()
      .lt('created_at', cutoff);
    if (error) {
      logError("Supabase history cleanup failed:", error);
      return;
    }
    console.log(`History cleanup chal gaya: ${HISTORY_DAYS} din se purani rows delete kar di gayi.`);
  } catch (err) {
    logError("Supabase history cleanup failed:", err);
  }
}

cron.schedule('0 0 * * *', cleanupOldHistory);
console.log(`Daily history cleanup scheduled: har din 00:00 par ${HISTORY_DAYS} din se purani rows delete hongi.`);

// ---------- Duplicate news prevention (posted_news) ----------
const POSTED_NEWS_TABLE = 'posted_news';
const DEDUP_WINDOW_MS = 48 * 60 * 60 * 1000;
const IMAGE_DEDUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TITLE_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'at', 'by', 'with',
  'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its',
  'this', 'that', 'these', 'those', 'after', 'before', 'over', 'under', 'new',
  'news', 'via', 'says', 'said', 'will', 'has', 'have', 'had', 'into', 'about'
]);

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !TITLE_STOPWORDS.has(w))
    .join(' ');
}

function titleWords(normalized) {
  return new Set(String(normalized || '').split(/\s+/).filter(Boolean));
}

// Do titles "very similar" maane jayenge agar unke key words ka Jaccard overlap >= 0.6 ho
function isSimilarTitle(a, b) {
  const setA = titleWords(a);
  const setB = titleWords(b);
  if (setA.size === 0 || setB.size === 0) return false;
  let common = 0;
  for (const w of setA) if (setB.has(w)) common++;
  const union = setA.size + setB.size - common;
  return union > 0 && common / union >= 0.6;
}

async function wasAlreadyPosted(story) {
  if (!supabase) return false;
  try {
    if (story.link) {
      const { data, error } = await supabase
        .from(POSTED_NEWS_TABLE)
        .select('id')
        .eq('link', story.link)
        .limit(1);
      if (error) logError("posted_news link check failed:", error);
      else if (data && data.length) return true;
    }

    const since = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
    const { data, error } = await supabase
      .from(POSTED_NEWS_TABLE)
      .select('normalized_title')
      .gte('created_at', since);
    if (error) {
      logError("posted_news title check failed:", error);
      return false;
    }
    const normalized = normalizeTitle(story.title);
    return (data || []).some((row) => isSimilarTitle(normalized, row.normalized_title));
  } catch (err) {
    logError("posted_news dedup check failed:", err);
    return false;
  }
}

async function getRecentImageUrls() {
  if (!supabase) return new Set();
  try {
    const since = new Date(Date.now() - IMAGE_DEDUP_WINDOW_MS).toISOString();
    const { data, error } = await supabase
      .from(POSTED_NEWS_TABLE)
      .select('image_url')
      .gte('created_at', since)
      .not('image_url', 'is', null);
    if (error) {
      logError("posted_news image check failed:", error);
      return new Set();
    }
    return new Set((data || []).map((row) => row.image_url).filter(Boolean));
  } catch (err) {
    logError("posted_news image check failed:", err);
    return new Set();
  }
}

async function recordPostedNews(story, imageUrl) {
  if (!supabase) return;
  try {
    const { error } = await supabase
      .from(POSTED_NEWS_TABLE)
      .insert([{
        title: story.title,
        link: story.link || null,
        normalized_title: normalizeTitle(story.title),
        image_url: imageUrl || null
      }]);
    if (error) logError("posted_news insert failed:", error);
  } catch (err) {
    logError("posted_news insert failed:", err);
  }
}

// ---------- Posting helpers ----------
const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_CAPTION_LIMIT = 1024;

// Photo caption: headline + up to 1-2 lines, trimmed to a sentence boundary within caption limit
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

// Split long text into chunks <= limit, preferring sentence boundaries
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
  const parts = splitMessage(text, TELEGRAM_TEXT_LIMIT);
  for (const part of parts) {
    await bot.sendMessage(chatId, part);
  }
}

// ---------- Posting function ----------
async function postToChannel() {
  let newsData = null;
  try {
    console.log("Scheduled post shuru ho raha hai...");
    const candidates = await getTrendingTopics();

    for (const story of candidates) {
      if (await wasAlreadyPosted(story)) {
        console.log(`Duplicate story skip: ${story.title}`);
        continue;
      }
      newsData = story;
      break;
    }

    if (!newsData) {
      console.log("Koi nayi story nahi mili, saari candidates recent posts se match kar gayi.");
      return { ok: false, error: "Koi nayi story nahi mili (sab recent posts se match kar gayi)." };
    }
    console.log("News:", newsData.title);

    // Publisher URL + long article text (agar mil jaye)
    const publisherUrl = await resolvePublisherUrl(newsData.link);
    const articleText = publisherUrl ? await fetchArticleText(publisherUrl) : '';
    const articleUrl = publisherUrl || newsData.link || '';

    const messageText = await generateMessage(newsData, { articleText, articleUrl });
    console.log(`Message ready (${messageText.length} chars).`);

    const usedImages = await getRecentImageUrls();
    const image = await getImage(newsData, { usedImages, publisherUrl });
    const imageUrl = image && image.url;
    console.log(`Post image: ${imageUrl || 'none'} (source: ${image?.source || 'none'})`);

    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (imageUrl) {
      const caption = buildCaption(newsData.title, messageText);
      try {
        await bot.sendPhoto(chatId, imageUrl, { caption });
      } catch (imgErr) {
        logError("Image send failed, sending text only:", imgErr);
      }
      await sendFullText(chatId, messageText);
    } else {
      await sendFullText(chatId, messageText);
    }

    await recordPostedNews(newsData, imageUrl);
    console.log(`Channel post successful at ${new Date().toLocaleString()}: ${newsData.title}`);
    return { ok: true };
  } catch (err) {
    logError("Post Error:", err);
    try {
      const fallback = newsData
        ? `${newsData.title}\n\n${newsData.snippet}\n\nSource: ${newsData.source || ''}\n${newsData.link || ''}`.trim()
        : "Aaj ki news abhi available nahi hai. Thodi der baad try karo.";
      await sendFullText(process.env.TELEGRAM_CHAT_ID, fallback);
    } catch (sendErr) {
      logError("Fallback post failed:", sendErr);
    }
    return { ok: false, error: String(err && err.message ? err.message : err).slice(0, 200) };
  }
}

// ---------- Settings load/save ----------
async function loadSettings() {
  if (!supabase) return { mode: 'interval', interval_minutes: 20 };
  try {
    const { data, error } = await supabase
      .from('bot_settings')
      .select('*')
      .eq('id', 1)
      .single();
    if (error || !data) {
      console.log("Settings nahi mile, default use kar rahe hain (20 min)");
      return { mode: 'interval', interval_minutes: 20 };
    }
    return data;
  } catch (err) {
    logError("Settings load failed:", err);
    return { mode: 'interval', interval_minutes: 20 };
  }
}

async function saveSettings(mode, intervalMinutes) {
  if (!supabase) return;
  try {
    const { error } = await supabase
      .from('bot_settings')
      .update({ mode, interval_minutes: intervalMinutes })
      .eq('id', 1);
    if (error) logError("Settings save failed:", error);
  } catch (err) {
    logError("Settings save failed:", err);
  }
}

function startSchedule(intervalMinutes) {
  // Sirf ek scheduler chalna chahiye: purana task hamesha pehle band karo.
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
    console.log("Purana schedule band kiya, naya set kar rahe hain.");
  }

  const minutes = Math.max(1, Math.min(1440, parseInt(intervalMinutes, 10) || 20));
  const runPost = () => {
    console.log(`${minutes} minute ho gaye, post kar rahe hain!`);
    postToChannel();
  };

  if (minutes < 60) {
    currentTask = cron.schedule(`*/${minutes} * * * *`, runPost, { timezone: SCHEDULE_TIMEZONE });
    const next = currentTask.getNextRun && currentTask.getNextRun();
    console.log(`Scheduling set: har ${minutes} minute (cron "*/${minutes} * * * *"), timezone ${SCHEDULE_TIMEZONE}, next run: ${next ? next.toLocaleString() : 'unknown'}`);
  } else if (minutes % 60 === 0) {
    const hours = minutes / 60;
    currentTask = cron.schedule(`0 */${hours} * * *`, runPost, { timezone: SCHEDULE_TIMEZONE });
    const next = currentTask.getNextRun && currentTask.getNextRun();
    console.log(`Scheduling set: har ${hours} ghante (cron "0 */${hours} * * *"), timezone ${SCHEDULE_TIMEZONE}, next run: ${next ? next.toLocaleString() : 'unknown'}`);
  } else {
    const ms = minutes * 60 * 1000;
    const timer = setInterval(runPost, ms);
    currentTask = { stop: () => clearInterval(timer) };
    console.log(`Scheduling set: har ${minutes} minute (setInterval), next run: ${new Date(Date.now() + ms).toLocaleString()}`);
  }
}

function stopSchedule() {
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
    console.log("Scheduled posting band kar di gayi.");
  }
}

// ---------- Message handler (commands + normal chat) ----------
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userText = msg.text;
  if (!userText) return;

  console.log(`Message aaya: ${userText}`);

  const lowerText = userText.toLowerCase().trim();

  try {
    // Command: interval set karo
    const everyMatch = lowerText.match(/(?:\/every|har)\s*(\d+)\s*(?:minute|min)?/);
    if (everyMatch) {
      const minutes = parseInt(everyMatch[1]);
      if (minutes >= 1 && minutes <= 1440) {
        startSchedule(minutes);
        await saveSettings('interval', minutes);
        await bot.sendMessage(chatId, `Theek hai! Ab har ${minutes} minute mein channel par post hoga.`);
        return;
      }
    }

    // Command: posting band karo
    if (lowerText.includes('/stop') || lowerText.includes('posting band')) {
      stopSchedule();
      await saveSettings('stopped', 0);
      await bot.sendMessage(chatId, "Theek hai, automatic posting band kar di hai.");
      return;
    }

    // Command: specific time par ek baar post karo (e.g. "9.55 pa post karo")
    const timePostMatch = lowerText.match(/(\d{1,2})[:.,](\d{2})\s*(am|pm)?/);
    if (timePostMatch && /post/.test(lowerText)) {
      let hour = parseInt(timePostMatch[1]);
      const minute = parseInt(timePostMatch[2]);
      const meridian = timePostMatch[3];
      if (meridian === 'pm' && hour !== 12) hour += 12;
      if (meridian === 'am' && hour === 12) hour = 0;
      if (hour <= 23 && minute <= 59) {
        const cronExpr = `${minute} ${hour} * * *`;
        const oneTimeTask = cron.schedule(cronExpr, () => {
          console.log(`One-time post at ${hour}:${minute} ho raha hai!`);
          postToChannel();
          oneTimeTask.destroy();
        }, { timezone: SCHEDULE_TIMEZONE });
        console.log(`One-time scheduled: ${hour}:${minute}`);
        await bot.sendMessage(chatId, `Theek hai! ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} par channel mein post ho jayegi.`);
        return;
      }
    }

    // Command: abhi post karo (e.g. "post karo", "news post dalo", "channel par post karo")
    const postRequest =
      lowerText.includes('/post') ||
      lowerText.includes('news post') ||
      /(post (karo|kar do|kar de|kardo|dalo|daalo|de do|bhejo|bhej do|now|abhi)|abi post|abhi post|post chahiye|channel (par|pa) post|post send|post kar)/.test(lowerText);
    if (postRequest) {
      const result = await postToChannel();
      await bot.sendMessage(chatId, result.ok
        ? "Theek hai! News abhi channel par post kar di gayi. ✅"
        : `Post nahi ho saka: ${result.error || 'unknown error'}`);
      return;
    }

    // Command: status check karo
    if (lowerText.includes('/status') || lowerText.includes('schedule kya hai')) {
      const settings = await loadSettings();
      if (settings.mode === 'stopped') {
        await bot.sendMessage(chatId, "Abhi automatic posting band hai.");
      } else {
        await bot.sendMessage(chatId, `Abhi har ${settings.interval_minutes} minute mein post ho raha hai.`);
      }
      return;
    }

    // Real-time news context (taaki bot purani/fake news na de)
    let newsContext = '';
    if (/(news|khabar|recent|today|update|latest|chal rha|chal raha|kya chal|kya ho raha|whats happening)/i.test(lowerText)) {
      const topic = await getTrendingTopic();
      if (topic && topic.title !== 'Punjab latest news') {
        newsContext = `Aaj ki real news (${new Date().toLocaleString()}):\nTitle: ${topic.title}\nDetails: ${topic.snippet}\nSource: ${topic.source}`;
        console.log("Chat ke liye real news laayi gayi:", topic.title);
      }
    }

    // Normal AI chat
    const history = await getHistory(chatId);
    const conversation = history.map(h => ({
      role: h.role === 'bot' ? 'assistant' : 'user',
      content: h.message
    }));
    if (newsContext) {
      conversation.push({
        role: 'system',
        content: `You are a Punjab news Telegram bot. Upar diye gaye context ki real news ka use karke sahi, sahih tareeke se jawab do. Kabhi bhi news invent/confirmation mat karo jo context mein na ho. \n\n${newsContext}`
      });
    }
    conversation.push({ role: 'user', content: userText });

    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: conversation,
      max_tokens: 500
    });

    const reply = (completion.choices[0]?.message?.content || "").trim();
    if (!reply) {
      throw new Error("Groq ne koi content nahi diya");
    }
    await bot.sendMessage(chatId, reply);
    console.log("Reply bhej diya!");

    await saveMessage(chatId, 'user', userText);
    await saveMessage(chatId, 'bot', reply);
} catch (err) {
    logError("Chat Error:", err);
    let userMessage = "Sorry, reply generate nahi ho saka. Thodi der baad dobara try karo.";
    if (err && (err.status === 401 || err.code === 'invalid_api_key')) {
      userMessage = "Bot ka AI key kharab hai (GROQ_API_KEY invalid). Admin se new key update karne ko kaho.";
    } else if (err && err.status === 404) {
      userMessage = "Bot ka AI model available nahi hai. Admin se bot update karne ko kaho.";
    }
    await bot.sendMessage(chatId, userMessage).catch((sendError) => {
      logError("Telegram error reply failed:", sendError);
    });
  }
});

bot.on('polling_error', (error) => {
  console.error('Telegram polling error:', error.code || '', error.message);
  if (error.code === 409) {
    console.warn('409 Conflict detected. Restarting polling in 5s...');
    bot.stopPolling();
    setTimeout(async () => {
      try {
        await bot.startPolling({ restart: true });
        console.log('Polling restarted successfully.');
      } catch (e) {
        logError("Retry polling failed:", e);
      }
    }, 5000);
  }
});

bot.on('error', (error) => {
  console.error('Telegram bot error:', error.code || '', error.message);
});

// ---------- Startup: purani settings load karke schedule shuru karo ----------
(async () => {
  try {
    // Long polling cannot receive updates while a webhook remains configured.
    await bot.deleteWebhook({ drop_pending_updates: true });
    await bot.startPolling({ restart: true });
    const botInfo = await bot.getMe();
    console.log(`Telegram polling started for @${botInfo.username}`);
  } catch (error) {
    logError("Telegram polling startup failed:", error);
  }

  await validateGroqKey();

  const settings = await loadSettings();
  if (settings.mode === 'stopped') {
    console.log("Posting abhi band hai (pichli setting ke hisaab se).");
  } else {
    startSchedule(settings.interval_minutes || 20);
  }
})();
