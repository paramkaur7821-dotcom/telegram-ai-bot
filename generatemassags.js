require('dotenv').config();
const Groq = require('groq-sdk');
const logError = require('./logerror');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

function withSource(text, source) {
  const clean = String(text || '').trim();
  return source ? `${clean}\n\nSource: ${source}` : clean;
}

const CHANNEL_LANGUAGE = 'English';
const MAX_COMPLETION_TOKENS = 1500;

function trimToLastSentence(text) {
  const clean = String(text || '').trim();
  const end = Math.max(clean.lastIndexOf('.'), clean.lastIndexOf('!'), clean.lastIndexOf('?'));
  if (end === -1) return clean;
  return clean.slice(0, end + 1).trim();
}

async function generateMessage(newsData) {
  try {
    const { title, snippet, source } = newsData;

    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        {
          role: "system",
          content: `You write Telegram news posts in ${CHANNEL_LANGUAGE}.
Use ONLY the facts present in the Title, Details and Source given by the user.
Never invent or guess names, first names, numbers, dates, quotes, statistics or any other details that are not in the provided text.
Never write filler such as "details are limited" or "further information is awaited".
Write 3 to 5 sentences using only the given facts, and always end with a complete sentence.
Reply with only the post text, nothing else.`
        },
        {
          role: "user",
          content: `Write a Telegram news post in ${CHANNEL_LANGUAGE} based on this news:

Title: ${title}
Details: ${snippet}
Source: ${source}

Requirements:
- Write 3 to 5 sentences using only the facts in the Title, Details and Source above
- Never invent names, first names, numbers, quotes or details
- Never write filler like "details are limited" or "further information is awaited"
- Always end with a complete sentence
- End with at most 3 short hashtags
- Only give the message text, nothing else`
        }
      ],
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      reasoning_effort: 'low'
    });

    const choice = completion.choices[0];
    let text = choice?.message?.content || '';
    if (choice?.finish_reason === 'length') {
      console.warn("Groq output 'length' se kata, last complete sentence tak trim kar rahe hain.");
      text = trimToLastSentence(text);
    }
    if (!text.trim()) {
      throw new Error("Groq ne koi post text nahi diya");
    }
    return withSource(text, source);
  } catch (err) {
    logError("Groq Error:", err);
    return withSource(`Latest news: ${newsData.title}\n\n${newsData.snippet}`, newsData.source);
  }
}

module.exports = generateMessage;