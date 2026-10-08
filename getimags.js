require('dotenv').config();
const axios = require('axios');
const Groq = require('groq-sdk');
const logError = require('./logerror');

const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

const KEYWORD_NOISE = new Set([
  'the', 'a', 'an', 'here', 'are', 'is', 'was', 'were', 'for', 'of', 'to', 'in',
  'on', 'at', 'and', 'or', 'with', 'this', 'that', 'these', 'photo', 'image',
  'images', 'picture', 'pictures', 'showing', 'shows', 'related', 'news',
  'headline', 'keywords', 'keyword', 'about', 'from', 'latest', 'breaking'
]);

function decodeUrl(url) {
  return String(url).replace(/&amp;/g, '&').replace(/&#38;/g, '&').replace(/&quot;/g, '"');
}

// Step 2: article page ke HTML se og:image meta tag
async function fetchOgImage(url) {
  try {
    const res = await axios.get(url, {
      timeout: 8000,
      responseType: 'text',
      maxRedirects: 5,
      maxContentLength: 5 * 1024 * 1024,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    const html = String(res.data || '');
    const match =
      html.match(/<meta[^>]*\bproperty=["']og:image["'][^>]*\bcontent=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]*\bcontent=["']([^"']+)["'][^>]*\bproperty=["']og:image["']/i);

    if (match && /^https?:\/\//i.test(match[1])) return decodeUrl(match[1]);

    console.log(`Page par og:image nahi mili: ${url}`);
    return null;
  } catch (err) {
    logError(`og:image fetch failed for "${url}":`, err);
    return null;
  }
}

async function searchPixabay(query) {
  try {
    const res = await axios.get('https://pixabay.com/api/', {
      params: {
        key: process.env.PIXABAY_KEY,
        q: query,
        image_type: 'photo',
        safesearch: true,
        per_page: 15,
        order: 'popular'
      },
      timeout: 8000
    });
    const hits = res.data.hits;
    if (hits && hits.length > 0) {
      const topHits = hits.slice(0, 8);
      const pick = topHits[Math.floor(Math.random() * topHits.length)];
      if (pick.largeImageURL && pick.largeImageURL.startsWith('http')) {
        return pick.largeImageURL;
      }
    }
    return null;
  } catch (err) {
    logError(`Pixabay Error for "${query}":`, err);
    return null;
  }
}

function extractKeywords(text) {
  const stopWords = ['the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'with'];
  const words = text
    .replace(/[^\w\s]/g, '')
    .split(' ')
    .filter(w => w.length > 3 && !stopWords.includes(w.toLowerCase()));
  return words.slice(0, 4).join(' ') || 'Punjab news';
}

// Step 3: AI headline se 2-3 chhote English keyword banata hai (Pixabay search ke liye)
async function generateImageKeyword(headline) {
  const fallback = extractKeywords(headline).split(' ').slice(0, 3).join(' ');

  if (!groq) {
    console.error("GROQ_API_KEY set nahi hai, AI keyword ki jagah fallback keyword use hoga.");
    return fallback;
  }

  try {
    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        {
          role: 'user',
          content: `Reply with exactly 2 or 3 plain English keywords for a generic stock photo that fits this news headline. Reply with ONLY the keywords separated by spaces - no quotes, no punctuation, no explanation.\nHeadline: ${headline}`
        }
      ],
      max_tokens: 25
    });

    const raw = (completion.choices[0]?.message?.content || '').trim();
    const words = raw
      .replace(/[^A-Za-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .map(w => w.toLowerCase())
      .filter(w => w && !KEYWORD_NOISE.has(w) && w.length > 2)
      .slice(0, 3);

    if (words.length >= 2) return words.join(' ');
    console.log(`AI keyword useful nahi tha ("${raw}"), fallback use kar rahe hain.`);
    return fallback;
  } catch (err) {
    logError("AI keyword generation failed:", err);
    return fallback;
  }
}

async function getImage(newsData) {
  // Step 1: Article ki apni image (RSS media:content/media:thumbnail/enclosure ya news API thumbnail)
  const ownImage = newsData.image || newsData.thumbnail;
  if (ownImage && /^https?:\/\//i.test(ownImage)) {
    console.log("Article ki apni image use ho rahi hai.");
    return ownImage;
  }

  // Step 2: Article URL ke HTML se og:image meta tag
  if (newsData.link && /^https?:\/\//i.test(newsData.link)) {
    const ogImage = await fetchOgImage(newsData.link);
    if (ogImage) {
      console.log("og:image mil gayi, wo use kar rahe hain.");
      return ogImage;
    }
  } else {
    console.log("Article URL nahi mila, og:image step skip kar rahe hain.");
  }

  // Step 3: AI-generated short keyword se Pixabay search
  const keyword = await generateImageKeyword(newsData.title || 'Punjab news');
  console.log(`Pixabay par search kar rahe hain: "${keyword}"`);
  const image = await searchPixabay(keyword);
  if (image) {
    console.log("Pixabay se image mil gayi!");
    return image;
  }

  console.log("Koi image nahi mili, text-only post hoga.");
  return null;
}

module.exports = getImage;
