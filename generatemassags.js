require('dotenv').config();
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function generateMessage(newsData) {
  try {
    const { title, snippet, source } = newsData;

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
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
    return completion.choices[0].message.content.trim();
  } catch (err) {
    console.error("Groq Error:", err.message);
    return `Latest news: ${newsData.title}\n\n${newsData.snippet}`;
  }
}

module.exports = generateMessage;