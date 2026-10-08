require('dotenv').config();
const Groq = require('groq-sdk');
const logError = require('./logerror');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

function withSource(text, source) {
  const clean = String(text || '').trim();
  return source ? `${clean}\n\nSource: ${source}` : clean;
}

async function generateMessage(newsData) {
  try {
    const { title, snippet, source } = newsData;

    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        {
          role: "user",
          content: `Write a detailed Telegram news post in English based on this news:

Title: ${title}
Details: ${snippet}
Source: ${source}

Requirements:
- Write 4-6 sentences covering full context, background, and what this means
- Include all relevant information from the details given
- Use a clear, informative news-reporting tone
- End with 2-3 relevant hashtags
- Do not add fake facts not present in the given details
- Only give the message text, nothing else`
        }
      ],
      max_tokens: 400
    });
    return withSource(completion.choices[0].message.content, source);
  } catch (err) {
    logError("Groq Error:", err);
    return withSource(`Latest news: ${newsData.title}\n\n${newsData.snippet}`, newsData.source);
  }
}

module.exports = generateMessage;