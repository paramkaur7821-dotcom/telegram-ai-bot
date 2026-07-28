require('dotenv').config();
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function generateMessage(topic) {
  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "user",
          content: `Ek short, engaging Telegram post (max 250 characters) likho iss topic pe: "${topic}". Sirf message text do, kuch aur nahi.`
        }
      ],
      max_tokens: 150
    });
    return completion.choices[0].message.content.trim();
  } catch (err) {
    console.error("Groq Error:", err.message);
    return `Latest update on: ${topic}`;
  }
}

module.exports = generateMessage;