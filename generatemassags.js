require('dotenv').config();
const Groq = require('groq-sdk');
const logError = require('./logerror');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

const CHANNEL_LANGUAGE = 'English';
const MAX_LONG_TOKENS = 2500;
const MAX_SHORT_TOKENS = 1500;
const MIN_ARTICLE_CHARS = 400;

const TAG_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'at', 'by',
  'with', 'from', 'as', 'is', 'are', 'was', 'were', 'after', 'before', 'over',
  'under', 'new', 'news', 'says', 'said', 'will', 'its', 'his', 'her', 'their'
]);

function trimToLastSentence(text) {
  const clean = String(text || '').trim();
  const end = Math.max(clean.lastIndexOf('.'), clean.lastIndexOf('!'), clean.lastIndexOf('?'));
  if (end === -1) return clean;
  return clean.slice(0, end + 1).trim();
}

function buildHashtags(title) {
  const words = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !TAG_STOPWORDS.has(w));
  const unique = [...new Set(words)].slice(0, 3);
  return unique.map((w) => `#${w}`).join(' ');
}

function buildFooter(source, url, title) {
  const rows = [];
  if (source) rows.push(`Source: ${source}`);
  if (url) rows.push(url);
  const tags = buildHashtags(title);
  if (tags) rows.push(tags);
  return rows.join('\n');
}

function withFooter(text, source, url, title) {
  const body = String(text || '').trim();
  const footer = buildFooter(source, url, title);
  return footer ? `${body}\n\n${footer}` : body;
}

async function generateMessage(newsData, options = {}) {
  const { title, snippet, source } = newsData;
  const articleUrl = options.articleUrl || newsData.link || '';
  const articleText = String(options.articleText || '').trim();
  const hasArticle = articleText.length >= MIN_ARTICLE_CHARS;

  try {
    const messages = hasArticle
      ? [
          {
            role: 'system',
            content: `You are a professional news writer for a Telegram news channel. Write in ${CHANNEL_LANGUAGE}.
Write an original, detailed news post of 8 to 12 sentences in your own words.
Use ONLY facts present in the Article text, Title and Source provided below.
Never copy sentences from the Article text; rewrite everything in your own words.
Never invent or guess names, first names, numbers, dates, quotes, statistics or other details not present in the provided text.
Always end with a complete sentence.
Reply with only the post body text. Do not add a source line, link or hashtags.`
          },
          {
            role: 'user',
            content: `Title: ${title}
Source: ${source}

Article text:
${articleText}

Write the detailed news post now.`
          }
        ]
      : [
          {
            role: 'system',
            content: `You are a news writer for a Telegram news channel. Write in ${CHANNEL_LANGUAGE}.
Use ONLY the facts present in the Title, Details and Source.
Never invent or guess names, first names, numbers, dates, quotes or details.
Never write filler such as "details are limited" or "further information is awaited".
Write 3 to 5 sentences and always end with a complete sentence.
Reply with only the post body text. Do not add a source line, link or hashtags.`
          },
          {
            role: 'user',
            content: `Title: ${title}
Details: ${snippet}
Source: ${source}

Write the post now.`
          }
        ];

    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages,
      max_completion_tokens: hasArticle ? MAX_LONG_TOKENS : MAX_SHORT_TOKENS,
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
    return withFooter(text, source, articleUrl, title);
  } catch (err) {
    logError("Groq Error:", err);
    return withFooter(`Latest news: ${title}\n\n${snippet}`, source, articleUrl, title);
  }
}

module.exports = generateMessage;
