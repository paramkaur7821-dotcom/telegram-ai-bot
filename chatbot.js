require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

const getTrendingTopic = require('./gettrend');
const generateMessage = require('./generatemassags');
const getImage = require('./getimags');

// ---------- Web server (Render ke liye zaroori) ----------
const app = express();
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(process.env.PORT || 3000, () => console.log('Web server chalu hai'));

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const MAX_MESSAGES = 200;
let currentTask = null;

console.log("Bot chalu ho gaya hai, ab ye messages sun raha hai...");

// ---------- Chat memory functions ----------
async function getHistory(chatId) {
  const { data, error } = await supabase
    .from('chat_history')
    .select('role, message')
    .eq('chat_id', String(chatId))
    .order('created_at', { ascending: true })
    .limit(MAX_MESSAGES);
  if (error) { console.error("Supabase fetch error:", error.message); return []; }
  return data || [];
}

async function saveMessage(chatId, role, message) {
  const { error } = await supabase
    .from('chat_history')
    .insert([{ chat_id: String(chatId), role, message }]);
  if (error) console.error("Supabase save error:", error.message);
}

async function trimHistory(chatId) {
  const { data, error } = await supabase
    .from('chat_history')
    .select('id')
    .eq('chat_id', String(chatId))
    .order('created_at', { ascending: false });
  if (error || !data) return;
  if (data.length > MAX_MESSAGES) {
    const idsToDelete = data.slice(MAX_MESSAGES).map(row => row.id);
    await supabase.from('chat_history').delete().in('id', idsToDelete);
  }
}

// ---------- Posting function ----------
async function postToChannel() {
  try {
    console.log("Scheduled post shuru ho raha hai...");
    const topic = await getTrendingTopic();
    console.log("Topic:", topic);

    const messageText = await generateMessage(topic);
    console.log("Message:", messageText);

    const imageUrl = await getImage(topic);

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
  } catch (err) {
    console.error("Post Error:", err.message);
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

    // Normal AI chat
    const history = await getHistory(chatId);
    const conversation = history.map(h => ({
      role: h.role === 'bot' ? 'assistant' : 'user',
      content: h.message
    }));
    conversation.push({ role: 'user', content: userText });

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: conversation,
      max_tokens: 500
    });

    const reply = completion.choices[0].message.content.trim();
    await bot.sendMessage(chatId, reply);
    console.log("Reply bhej diya!");

    await saveMessage(chatId, 'user', userText);
    await saveMessage(chatId, 'bot', reply);
    await trimHistory(chatId);
  } catch (err) {
    console.error("Error:", err.message);
    await bot.sendMessage(chatId, "Sorry, kuch error aa gaya, dobara try karo.");
  }
});

// ---------- Startup: purani settings load karke schedule shuru karo ----------
(async () => {
  const settings = await loadSettings();
  if (settings.mode === 'stopped') {
    console.log("Posting abhi band hai (pichli setting ke hisaab se).");
  } else {
    startSchedule(settings.interval_minutes || 20);
  }
})();