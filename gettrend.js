require('dotenv').config();
const axios = require('axios');
const logError = require('./logerror');

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Accept': 'application/rss+xml,application/xml,text/xml,*/*'
};

// Direct publisher RSS feeds (main news source). These links go straight to the
// article and items usually carry media:content / media:thumbnail / enclosure images,
// so no Google News resolution is needed. Edit this array to add/remove feeds.
//
// All entries below are VERIFIED: HTTP 200, valid RSS, items with a link, and
// usually an image. Punjab/Chandigarh-specific feeds come first, broader ones after.
//
// Verified as NOT usable (kept here as a note, do not re-add without re-testing):
//   - The Tribune:                 https://www.tribuneindia.com/rss/feed           -> HTTP 403
//   - Hindustan Times (Punjab):    https://www.hindustantimes.com/feeds/rss/punjab/rssfeed.xml      -> empty feed
//   - Hindustan Times (Chandigarh):https://www.hindustantimes.com/feeds/rss/chandigarh/rssfeed.xml -> empty feed
//   - Dainik Bhaskar:              https://www.bhaskar.com/rss/latest-news/        -> HTTP 404
//   - Punjab Kesari:               https://www.punjabkesari.in/rss/punjab          -> HTTP 404
const PUBLISHER_FEEDS = [
  // Punjab / Chandigarh-specific
  { name: 'The Hindu', url: 'https://www.thehindu.com/news/national/punjab/feeder/default.rss' },
  { name: 'The Indian Express', url: 'https://indianexpress.com/section/cities/chandigarh/feed/' },
  { name: 'Amar Ujala', url: 'https://www.amarujala.com/rss/punjab.xml' },
  // Broader publisher-direct fallbacks
  { name: 'The Hindu', url: 'https://www.thehindu.com/news/national/other-states/feeder/default.rss' },
  { name: 'Hindustan Times', url: 'https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml' },
  { name: 'NDTV', url: 'https://feeds.feedburner.com/ndtvnews-india-news' },
  { name: 'The Indian Express', url: 'https://indianexpress.com/section/cities/feed/' }
];

const FALLBACK_TOPIC = {
  title: "Punjab latest news",
  snippet: "Latest updates from Punjab",
  source: '',
  sourceUrl: '',
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
  let t = String(title || '').trim();
  if (source) {
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`\\s*[-|]\\s*${escaped}\\s*$`, 'i'), '').trim();
  }
  return t;
}

function extractTag(content, tag) {
  const m = String(content).match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!m) return '';
  return decodeXml(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
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

function findDescriptionImage(itemXml) {
  const desc = extractTag(itemXml, 'description');
  const m = desc.match(/<img[^>]*\bsrc=["']([^"']+)["']/i);
  return m && /^https?:\/\//i.test(m[1]) ? decodeXml(m[1]) : null;
}

function parseRssFeed(xml, sourceName) {
  const posts = [];
  for (const m of String(xml).matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const content = m[0];
    const title = cleanTitle(extractTag(content, 'title'), sourceName);
    if (!title) continue;

    let link = extractTag(content, 'link');
    if (!link) {
      const hrefMatch = content.match(/<link[^>]*\bhref=["']([^"']+)["']/i);
      link = hrefMatch ? decodeXml(hrefMatch[1]) : '';
    }
    if (!link || !/^https?:\/\//i.test(link)) continue;

    const descHtml = extractTag(content, 'description');
    const snippet = descHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 250) || title;
    const image = findArticleImage(content);
    const descImage = image ? null : findDescriptionImage(content);

    posts.push({
      title,
      snippet,
      source: sourceName,
      sourceUrl: '',
      link,
      image: image ? image.url : descImage,
      imageWidth: image ? image.width : null,
      imageHeight: image ? image.height : null
    });
  }
  return posts;
}

// Main source: direct publisher RSS feeds
async function fetchFromPublisherFeeds() {
  const results = await Promise.allSettled(
    PUBLISHER_FEEDS.map(async (feed) => {
      const res = await axios.get(feed.url, {
        timeout: 9000,
        maxRedirects: 5,
        headers: BROWSER_HEADERS
      });
      const xml = String(res.data || '');
      if (!/<rss|<feed|<item/i.test(xml)) throw new Error('valid RSS nahi hai');
      const posts = parseRssFeed(xml, feed.name);
      if (posts.length === 0) throw new Error('koi item with link nahi mila');
      console.log(`Feed OK: ${feed.name} (${posts.length} items)`);
      return posts;
    })
  );

  const all = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      all.push(...result.value);
    } else {
      const reason = result.reason && (result.reason.response
        ? `HTTP ${result.reason.response.status}`
        : result.reason.message);
      console.log(`Feed skip: ${PUBLISHER_FEEDS[index].name} (${reason})`);
    }
  });
  return all;
}

// Last fallback: Google News RSS (headline only; links usually cannot be resolved)
async function fetchFromGoogleNewsRss() {
  const url = 'https://news.google.com/rss/search?q=Punjab&hl=en-IN&gl=IN&ceid=IN:en';
  const res = await axios.get(url, {
    timeout: 8000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });

  const posts = [];
  for (const m of String(res.data || '').matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const content = m[1];
    const sourceTag = content.match(/<source[^>]*\burl=["']([^"']+)["'][^>]*>(.*?)<\/source>/i);
    const sourceUrl = sourceTag ? decodeXml(sourceTag[1]).trim() : '';
    const source = sourceTag
      ? decodeXml(sourceTag[2]).trim()
      : decodeXml((content.match(/<source[^>]*>(.*?)<\/source>/) || [, ''])[1]).trim();
    const title = cleanTitle(extractTag(content, 'title'), source);
    if (!title) continue;
    const descHtml = extractTag(content, 'description');
    const snippet = descHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 250) || title;
    const link = extractTag(content, 'link');
    const image = findArticleImage(content);
    posts.push({
      title,
      snippet,
      source,
      sourceUrl,
      link,
      image: image ? image.url : null,
      imageWidth: image ? image.width : null,
      imageHeight: image ? image.height : null
    });
  }

  return posts.slice(0, 5);
}

// Even later fallback: SerpApi (free plan sirf 100 searches/month de sakta hai)
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
        sourceUrl: pick.source?.link || '',
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
  const publisherTopics = await fetchFromPublisherFeeds().catch((err) => {
    logError("Publisher feed fetch failed:", err);
    return [];
  });
  if (publisherTopics.length) return publisherTopics;

  const googleTopics = await fetchFromGoogleNewsRss().catch((err) => {
    logError("Google News RSS Error:", err);
    return [];
  });
  if (googleTopics.length) return googleTopics;

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
module.exports.PUBLISHER_FEEDS = PUBLISHER_FEEDS;
