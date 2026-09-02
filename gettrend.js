require('dotenv').config();
const axios = require('axios');

const FALLBACK_TOPIC = {
  title: "Punjab latest news",
  snippet: "Latest updates from Punjab",
  source: '',
  thumbnail: null
};

function decodeXml(str) {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#160;/g, ' ')
    .replace(/&nbsp;/g, ' ');
}

function cleanTitle(title, source) {
  let t = title.trim();
  if (source) {
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`\\s*[-|]\\s*${escaped}\\s*$`, 'i'), '').trim();
  }
  return t;
}

// Free Google News RSS (koi API key nahi chahiye) - SerpApi quota exhaust hone par bhi kaam karta hai
async function fetchFromGoogleNewsRss() {
  const url = 'https://news.google.com/rss/search?q=Punjab&hl=en-IN&gl=IN&ceid=IN:en';
  const res = await axios.get(url, {
    timeout: 8000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });

  const items = [...res.data.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  const posts = [];
  for (const m of items) {
    const content = m[1];
    const source = decodeXml((content.match(/<source[^>]*>(.*?)<\/source>/) || [, ''])[1]).trim();
    const title = cleanTitle(decodeXml((content.match(/<title>(.*?)<\/title>/) || [, ''])[1]), source);
    if (!title) continue;
    const descHtml = decodeXml((content.match(/<description>(.*?)<\/description>/) || [, ''])[1]);
    const snippet = descHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 250) || title;
    posts.push({ title, snippet, source, thumbnail: null });
  }

  if (posts.length === 0) return null;
  const top = posts.slice(0, 5);
  const pick = top[Math.floor(Math.random() * top.length)];
  return { title: pick.title, snippet: pick.snippet, source: pick.source, thumbnail: null };
}

// Backup: SerpApi (free plan sirf 100 searches/month de sakta hai)
async function fetchFromSerpApi() {
  try {
    const res = await axios.get('https://serpapi.com/search.json', {
      params: {
        engine: 'google_news',
        q: 'Punjab',
        gl: 'in',
        hl: 'en',
        api_key: process.env.SERPAPI_KEY
      },
      timeout: 8000
    });

    const articles = res.data.news_results;
    if (articles && articles.length > 0) {
      const topArticles = articles.slice(0, 5);
      const pick = topArticles[Math.floor(Math.random() * topArticles.length)];
      return {
        title: pick.title,
        snippet: pick.snippet || pick.title,
        source: pick.source?.name || '',
        thumbnail: pick.thumbnail || null
      };
    }
    return null;
  } catch (err) {
    console.error("SerpApi Error:", err.message);
    return null;
  }
}

async function getTrendingTopic() {
  const rssTopic = await fetchFromGoogleNewsRss().catch((err) => {
    console.error("Google News RSS Error:", err.message);
    return null;
  });
  if (rssTopic) return rssTopic;

  const serpTopic = await fetchFromSerpApi();
  if (serpTopic) return serpTopic;

  console.error("Koi news source kaam nahi kiya, fallback use ho raha hai.");
  return FALLBACK_TOPIC;
}

module.exports = getTrendingTopic;