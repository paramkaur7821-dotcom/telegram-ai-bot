require('dotenv').config();
const axios = require('axios');
const logError = require('./logerror');

const FALLBACK_TOPIC = {
  title: "Punjab latest news",
  snippet: "Latest updates from Punjab",
  source: '',
  link: '',
  image: null,
  imageWidth: null,
  imageHeight: null,
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

// RSS item se article ki apni image: media:content -> media:thumbnail -> enclosure
function findArticleImage(itemXml) {
  const tags = ['media:content', 'media:thumbnail', 'enclosure'];
  for (const tag of tags) {
    const re = new RegExp(`<${tag}\\b([^>]*)>`, 'i');
    const match = itemXml.match(re);
    if (!match) continue;
    const attrs = match[1];
    const urlMatch = attrs.match(/\burl=["']([^"']+)["']/i);
    if (!urlMatch || !/^https?:\/\//i.test(urlMatch[1])) continue;
    const width = parseInt((attrs.match(/\bwidth=["']?(\d+)/i) || [])[1], 10) || null;
    const height = parseInt((attrs.match(/\bheight=["']?(\d+)/i) || [])[1], 10) || null;
    return { url: decodeXml(urlMatch[1]), width, height };
  }
  return null;
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
    const link = decodeXml((content.match(/<link>(.*?)<\/link>/) || [, ''])[1]).trim();
    const image = findArticleImage(content);
    posts.push({
      title,
      snippet,
      source,
      link,
      image: image ? image.url : null,
      imageWidth: image ? image.width : null,
      imageHeight: image ? image.height : null
    });
  }

  if (posts.length === 0) return [];
  return posts.slice(0, 5);
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
      return articles.slice(0, 5).map((pick) => ({
        title: pick.title,
        snippet: pick.snippet || pick.title,
        source: pick.source?.name || '',
        link: pick.link || '',
        image: pick.thumbnail || null,
        thumbnail: pick.thumbnail || null
      }));
    }
    return [];
  } catch (err) {
    logError("SerpApi Error:", err);
    return [];
  }
}

// Ek se zyada candidates do, taaki duplicate story skip karke agli utha sakein
async function getTrendingTopics() {
  const rssTopics = await fetchFromGoogleNewsRss().catch((err) => {
    logError("Google News RSS Error:", err);
    return [];
  });
  if (rssTopics.length) return rssTopics;

  const serpTopics = await fetchFromSerpApi();
  if (serpTopics.length) return serpTopics;

  console.error("Koi news source kaam nahi kiya, fallback use ho raha hai.");
  return [FALLBACK_TOPIC];
}

async function getTrendingTopic() {
  const topics = await getTrendingTopics();
  return topics[Math.floor(Math.random() * topics.length)];
}

module.exports = getTrendingTopic;
module.exports.getTrendingTopics = getTrendingTopics;