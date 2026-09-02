require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

const getTrendingTopic = require('./gettrend');
const generateMessage = require('./generatemassags');
const getImage = require('./getimags');

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
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

const MAX_MESSAGES = 200;
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
    console.error(`Groq API check failed: ${error.message}`);
    console.error("=> Naya GROQ_API_KEY console.groq.com se banao aur .env ke saath hosting secrets mein update karo.");
  }
}

// ---------- Chat memory functions ----------
async function getHistory(chatId) {
  const { data, error } = await supabase
    .from('chat_history')
    .select('role, message')
    .eq('chat_id', String(chatId))
    .order('created_at', { ascending: false })
    .limit(MAX_MESSAGES);
  if (error) { console.error("Supabase fetch error:", error.message); return []; }
  return (data || []).reverse();
}

async function saveMessage(chatId, role, message) {
  const { error } = await supabase
    .from('chat_history')
    .insert([{ chat_id: String(chatId), role, message }]);
  if (error) console.error("Supabase save error:", error.message);
}

// ---------- Posting function ----------
async function postToChannel() {
  try {
    console.log("Scheduled post shuru ho raha hai...");
    const newsData = await getTrendingTopic();
    console.log("News:", newsData.title);

    const messageText = await generateMessage(newsData);
    console.log("Message:", messageText);

    const imageUrl = await getImage(newsData);

    if (imageUrl) {
      try {
        await bot.sendPhoto(process.env.TELEGRAM_CHAT_ID, imageUrl, { caption: messageText });
      } catch (imgErr) {
        console.error("Image send failed, sending text only:", imgErr.message);
        await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, messageText);
      }
    } else {
      await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, messageText);
    }
    console.log("Channel post successful!");
    return true;
  } catch (err) {
    console.error("Post Error:", err.message);
    return false;
  }
}

// ---------- Settings load/save ----------
async function loadSettings() {
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
}

async function saveSettings(mode, intervalMinutes) {
  const { error } = await supabase
    .from('bot_settings')
    .update({ mode, interval_minutes: intervalMinutes })
    .eq('id', 1);
  if (error) console.error("Settings save error:", error.message);
}

function startSchedule(intervalMinutes) {
  if (currentTask) {
    currentTask.stop();
  }
  const cronExpr = `*/${intervalMinutes} * * * *`;
  currentTask = cron.schedule(cronExpr, () => {
    console.log(`${intervalMinutes} minute ho gaye, post kar rahe hain!`);
    postToChannel();
  });
  console.log(`Scheduling set ho gayi: har ${intervalMinutes} minute mein post hoga.`);
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
        });
        console.log(`One-time scheduled: ${hour}:${minute}`);
        await bot.sendMessage(chatId, `Theek hai! ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} par channel mein post ho jayegi.`);
        return;
      }
    }

    // Command: abhi post karo (e.g. "post karo", "/post", "abi post")
    const postRequest =
      lowerText.includes('/post') ||
      /(post (karo|kar do|kar de|now|abhi|de do)|abi post|abhi post|post chahiye|channel (par|pa) post|post send)/.test(lowerText);
    if (postRequest) {
      const ok = await postToChannel();
      await bot.sendMessage(chatId, ok
        ? "Theek hai! News abhi channel par post kar di gayi. ✅"
        : "Post nahi ho saka. Logs dekho (shayad API keys ya quota ka issue hai).");
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
    console.error("Error:", err.message);
    let userMessage = "Sorry, reply generate nahi ho saka. Thodi der baad dobara try karo.";
    if (err && (err.status === 401 || err.code === 'invalid_api_key')) {
      userMessage = "Bot ka AI key kharab hai (GROQ_API_KEY invalid). Admin se new key update karne ko kaho.";
    } else if (err && err.status === 404) {
      userMessage = "Bot ka AI model available nahi hai. Admin se bot update karne ko kaho.";
    }
    await bot.sendMessage(chatId, userMessage).catch((sendError) => {
      console.error("Telegram error reply failed:", sendError.message);
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
        console.error('Retry polling failed:', e.message);
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
    console.error('Telegram polling startup failed:', error.message);
  }

  await validateGroqKey();

  const settings = await loadSettings();
  if (settings.mode === 'stopped') {
    console.log("Posting abhi band hai (pichli setting ke hisaab se).");
  } else {
    startSchedule(settings.interval_minutes || 20);
  }
})();
