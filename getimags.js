require('dotenv').config();
const axios = require('axios');
const Groq = require('groq-sdk');
const logError = require('./logerror');

const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

const MIN_IMAGE_SIZE = 200;

const KEYWORD_NOISE = new Set([
  'the', 'a', 'an', 'here', 'are', 'is', 'was', 'were', 'for', 'of', 'to', 'in',
  'on', 'at', 'and', 'or', 'with', 'this', 'that', 'these', 'photo', 'image',
  'images', 'picture', 'pictures', 'showing', 'shows', 'related', 'news',
  'headline', 'keywords', 'keyword', 'about', 'from', 'latest', 'breaking'
]);

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

function decodeUrl(url) {
  return String(url).replace(/&amp;/g, '&').replace(/&#38;/g, '&').replace(/&quot;/g, '"');
}

function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
}

function isGoogleNewsLink(url) {
  return /(^|\.)news\.google\.com$/i.test(hostnameOf(url));
}

function isGoogleHost(url) {
  const host = hostnameOf(url);
  return host === 'google.com' || host.endsWith('.google.com') ||
    host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com') ||
    host === 'gstatic.com' || host.endsWith('.gstatic.com');
}

// Reject Google-owned images, obvious logos/placeholders, non-http URLs
function isBadImageUrl(url) {
  const value = String(url || '').toLowerCase();
  if (!/^https?:\/\//i.test(value)) return true;
  if (/news\.google\.com|gstatic\.com|googleusercontent\.com|google\.com/.test(value)) return true;
  if (/logo|favicon|placeholder|default/.test(value)) return true;
  return false;
}

function isTooSmall(width, height) {
  const w = parseInt(width, 10);
  const h = parseInt(height, 10);
  if (Number.isFinite(w) && w < MIN_IMAGE_SIZE) return true;
  if (Number.isFinite(h) && h < MIN_IMAGE_SIZE) return true;
  return false;
}

// Dedup key: origin + path (tracking query params ignore)
function imageKey(url) {
  try {
    const u = new URL(decodeUrl(url));
    return (u.origin + u.pathname).toLowerCase();
  } catch (e) {
    return String(url || '').split('?')[0].toLowerCase();
  }
}

// Google News encoded links ka legacy base64 payload se publisher URL nikalo
function decodeGoogleNewsId(link) {
  const match = String(link).match(/\/articles\/([A-Za-z0-9_-]+)/);
  if (!match) return '';
  try {
    let b64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const text = Buffer.from(b64, 'base64').toString('latin1');
    const urlMatch = text.match(/https?:\/\/[\x21-\x7e]+/);
    if (urlMatch) {
      const cleaned = urlMatch[0].replace(/["'\\,;].*$/, '');
      if (!isGoogleHost(cleaned) && !isGoogleNewsLink(cleaned)) return cleaned;
    }
  } catch (e) { /* ignore */ }
  return '';
}

// Google News RSS link ko real publisher URL mein resolve karo
async function resolvePublisherUrl(link) {
  if (!link || !/^https?:\/\//i.test(link)) return '';
  if (!isGoogleNewsLink(link)) return link;

  const decoded = decodeGoogleNewsId(link);
  if (decoded) return decoded;

  try {
    const res = await axios.get(link, {
      timeout: 8000,
      responseType: 'text',
      maxRedirects: 10,
      maxContentLength: 5 * 1024 * 1024,
      headers: BROWSER_HEADERS
    });
    const finalUrl =
      res?.request?.res?.responseUrl ||
      res?.request?._redirectable?._currentUrl ||
      '';
    if (finalUrl && /^https?:\/\//i.test(finalUrl) && !isGoogleHost(finalUrl)) {
      return finalUrl;
    }
  } catch (err) {
    logError(`Google News resolve failed for "${link}":`, err);
  }
  console.log(`Publisher URL resolve nahi ho paayi: ${link}`);
  return '';
}

// Step 2: publisher page ke HTML se og:image meta tag (+ width/height)
async function fetchOgImage(url) {
  try {
    const res = await axios.get(url, {
      timeout: 8000,
      responseType: 'text',
      maxRedirects: 5,
      maxContentLength: 5 * 1024 * 1024,
      headers: BROWSER_HEADERS
    });

    const html = String(res.data || '');
    const match =
      html.match(/<meta[^>]*\bproperty=["']og:image["'][^>]*\bcontent=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]*\bcontent=["']([^"']+)["'][^>]*\bproperty=["']og:image["']/i);

    if (!match || !/^https?:\/\//i.test(match[1])) {
      console.log(`Page par og:image nahi mili: ${url}`);
      return null;
    }

    const width = (html.match(/<meta[^>]*\bproperty=["']og:image:width["'][^>]*\bcontent=["'](\d+)["']/i) || [])[1];
    const height = (html.match(/<meta[^>]*\bproperty=["']og:image:height["'][^>]*\bcontent=["'](\d+)["']/i) || [])[1];

    return {
      url: decodeUrl(match[1]),
      width: width ? parseInt(width, 10) : null,
      height: height ? parseInt(height, 10) : null
    };
  } catch (err) {
    logError(`og:image fetch failed for "${url}":`, err);
    return null;
  }
}

async function searchPixabay(keywords, usedKeys) {
  if (!process.env.PIXABAY_KEY) {
    console.error("PIXABAY_KEY set nahi hai, Pixabay step skip.");
    return null;
  }

  const queries = [...keywords];
  for (let i = queries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queries[i], queries[j]] = [queries[j], queries[i]];
  }

  for (const query of queries) {
    try {
      const res = await axios.get('https://pixabay.com/api/', {
        params: {
          key: process.env.PIXABAY_KEY,
          q: query,
          image_type: 'photo',
          safesearch: true,
          per_page: 20,
          order: 'latest'
        },
        timeout: 8000
      });

      const hits = res.data.hits || [];
      const candidates = hits.filter((hit) =>
        hit.largeImageURL &&
        !isBadImageUrl(hit.largeImageURL) &&
        !isTooSmall(hit.imageWidth, hit.imageHeight) &&
        !usedKeys.has(imageKey(hit.largeImageURL))
      );

      if (candidates.length > 0) {
        console.log(`Pixabay ("${query}") se ${candidates.length} nayi image mili.`);
        return candidates[Math.floor(Math.random() * candidates.length)].largeImageURL;
      }
      console.log(`Pixabay ("${query}") mein koi nayi image nahi mili.`);
    } catch (err) {
      logError(`Pixabay Error for "${query}":`, err);
    }
  }
  return null;
}

function extractKeywords(text) {
  const stopWords = ['the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'with'];
  const words = text
    .replace(/[^\w\s]/g, '')
    .split(' ')
    .filter(w => w.length > 3 && !stopWords.includes(w.toLowerCase()));
  return words.slice(0, 4).join(' ') || 'Punjab news';
}

// Step 3: AI headline se 5 alag-alag short English keywords banata hai (Pixabay ke liye)
async function generateImageKeywords(headline) {
  const fallback = extractKeywords(headline);

  if (!groq) {
    console.error("GROQ_API_KEY set nahi hai, AI keyword ki jagah fallback keyword use hoga.");
    return [fallback];
  }

  try {
    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        {
          role: 'system',
          content: 'You suggest English stock-photo search keywords.'
        },
        {
          role: 'user',
          content: `Give 5 DIFFERENT 2 to 3 word English stock-photo search keyword phrases for this news headline. Reply with ONLY the phrases, one per line, no numbering, no punctuation, no explanation.\nHeadline: ${headline}`
        }
      ],
      max_completion_tokens: 150,
      reasoning_effort: 'low'
    });

    const lines = (completion.choices[0]?.message?.content || '')
      .split(/\r?\n/)
      .map(l => l.replace(/[^A-Za-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase())
      .filter(l => l.length > 2);

    const cleaned = lines
      .filter(l => l.split(' ').some(w => w && !KEYWORD_NOISE.has(w)))
      .slice(0, 5);

    if (cleaned.length > 0) return cleaned;

    console.log("AI keywords useful nahi the, fallback use kar rahe hain.");
    return [fallback];
  } catch (err) {
    logError("AI keyword generation failed:", err);
    return [fallback];
  }
}

async function getImage(newsData, options = {}) {
  const usedKeys = new Set();
  if (options.usedImages) {
    for (const url of options.usedImages) usedKeys.add(imageKey(url));
  }
  const acceptable = (url, width, height) =>
    url && !isBadImageUrl(url) && !isTooSmall(width, height) && !usedKeys.has(imageKey(url));

  // Step 1: Article ki apni image (RSS media:content/media:thumbnail/enclosure ya news API thumbnail)
  const ownImage = newsData.image || newsData.thumbnail;
  if (acceptable(ownImage, newsData.imageWidth, newsData.imageHeight)) {
    console.log("RSS media image use ho rahi hai.");
    return { url: ownImage, source: 'RSS media' };
  }
  if (ownImage) {
    console.log("RSS media image reject hui (bad/duplicate/small), agli source try kar rahe hain.");
  }

  // Step 2: Publisher URL resolve karke og:image
  const publisherUrl = await resolvePublisherUrl(newsData.link);
  if (publisherUrl) {
    const ogImage = await fetchOgImage(publisherUrl);
    if (ogImage && acceptable(ogImage.url, ogImage.width, ogImage.height)) {
      console.log("og:image use ho rahi hai.");
      return { url: ogImage.url, source: 'og:image' };
    }
    if (ogImage) {
      console.log("og:image reject hui (bad/duplicate/small), Pixabay try kar rahe hain.");
    }
  } else if (!newsData.link) {
    console.log("Article URL nahi mila, og:image step skip kar rahe hain.");
  }

  // Step 3: AI-generated keywords se Pixabay search
  const keywords = await generateImageKeywords(newsData.title || 'Punjab news');
  console.log(`Pixabay par search kar rahe hain: "${keywords.join('" | "')}"`);
  const pixabayUrl = await searchPixabay(keywords, usedKeys);
  if (pixabayUrl) {
    console.log("Pixabay se image mil gayi!");
    return { url: pixabayUrl, source: 'Pixabay' };
  }

  console.log("Koi image nahi mili, text-only post hoga.");
  return { url: null, source: null };
}

module.exports = getImage;
module.exports.imageKey = imageKey;
module.exports.isBadImageUrl = isBadImageUrl;
