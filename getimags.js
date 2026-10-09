require('dotenv').config();
const axios = require('axios');
const logError = require('./logerror');

const MIN_IMAGE_WIDTH = 300;
const MIN_IMAGE_HEIGHT = 200;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

const STOCK_HOSTS = [
  'pixabay.com', 'pexels.com', 'unsplash.com', 'shutterstock.com', 'gettyimages.com',
  'istockphoto.com', 'adobe.com', 'stock.adobe.com', 'dreamstime.com', 'freepik.com',
  'alamy.com', 'depositphotos.com', '123rf.com', 'canstockphoto.com', 'bigstockphoto.com',
  'vectorstock.com', 'pond5.com', 'stocksy.com', 'envato.com', 'creativecommons.org'
];

const SOURCE_STOPWORDS = new Set(['the', 'and', 'of', 'for', 'a', 'an', 'news', 'media', 'daily']);

function decodeUrl(url) {
  return String(url).replace(/&amp;/g, '&').replace(/&#38;/g, '&').replace(/&quot;/g, '"');
}

function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
}

// Registrable domain (e.g. images.ndtv.com -> ndtv.com, news.bbc.co.uk -> bbc.co.uk)
function registrableDomain(host) {
  const clean = String(host || '').toLowerCase().replace(/^www\./, '');
  if (!clean) return '';
  const parts = clean.split('.');
  if (parts.length <= 2) return clean;
  const secondLast = parts[parts.length - 2];
  const tld = parts[parts.length - 1];
  if (tld.length === 2 && ['co', 'com', 'org', 'net', 'gov', 'ac', 'edu'].includes(secondLast)) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
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

function isStockHost(url) {
  const host = hostnameOf(url);
  return STOCK_HOSTS.some((s) => host === s || host.endsWith(`.${s}`));
}

// Reject Google-owned/stock images, obvious logos/placeholders, non-http URLs
function isBadImageUrl(url) {
  const value = String(url || '').toLowerCase();
  if (!/^https?:\/\//i.test(value)) return true;
  if (isGoogleHost(value)) return true;
  if (isStockHost(value)) return true;
  if (/logo|favicon|placeholder|default/.test(value)) return true;
  return false;
}

function isTooSmall(width, height) {
  const w = parseInt(width, 10);
  const h = parseInt(height, 10);
  if (Number.isFinite(w) && w < MIN_IMAGE_WIDTH) return true;
  if (Number.isFinite(h) && h < MIN_IMAGE_HEIGHT) return true;
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

// og:image, publisher page ke same publisher domain se honi chahiye
function samePublisherDomain(imageUrl, publisherUrl) {
  const imgDomain = registrableDomain(hostnameOf(imageUrl));
  const pubDomain = registrableDomain(hostnameOf(publisherUrl));
  return Boolean(imgDomain) && imgDomain === pubDomain;
}

// Source name domain se match kare (e.g. NDTV -> ndtv.com)
function sourceMatchesDomain(source, host) {
  const words = String(source || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !SOURCE_STOPWORDS.has(w));
  if (words.length === 0) return true;
  const compact = String(host || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return words.some((w) => compact.includes(w));
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

// Publisher page ke HTML se og:image meta tag (+ width/height)
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

// Sirf article ki apni image: pehle RSS media/enclosure, phir og:image (same publisher domain)
async function getImage(newsData, options = {}) {
  const usedKeys = new Set();
  if (options.usedImages) {
    for (const url of options.usedImages) usedKeys.add(imageKey(url));
  }
  const acceptable = (url, width, height) =>
    url && !isBadImageUrl(url) && !isTooSmall(width, height) && !usedKeys.has(imageKey(url));

  // Step 1: Article ki apni RSS media / enclosure image
  const ownImage = newsData.image || newsData.thumbnail;
  if (acceptable(ownImage, newsData.imageWidth, newsData.imageHeight)) {
    console.log("Image source: RSS media");
    return { url: ownImage, source: 'rss' };
  }
  if (ownImage) {
    console.log("RSS media image reject hui (bad/stock/duplicate/small).");
  }

  // Step 2: Publisher URL resolve karke og:image, same publisher domain se
  const publisherUrl = await resolvePublisherUrl(newsData.link);
  if (publisherUrl) {
    const ogImage = await fetchOgImage(publisherUrl);
    if (ogImage) {
      const publisherHost = hostnameOf(publisherUrl);
      if (!samePublisherDomain(ogImage.url, publisherUrl)) {
        console.log(`og:image reject hui: publisher domain se match nahi (${ogImage.url}).`);
      } else if (!sourceMatchesDomain(newsData.source, publisherHost)) {
        console.log(`og:image reject hui: source "${newsData.source || ''}" domain se match nahi.`);
      } else if (acceptable(ogImage.url, ogImage.width, ogImage.height)) {
        console.log("Image source: og:image");
        return { url: ogImage.url, source: 'og:image' };
      } else {
        console.log("og:image reject hui (bad/stock/duplicate/small).");
      }
    }
  } else if (!newsData.link) {
    console.log("Article URL nahi mila, og:image step skip.");
  }

  console.log("Koi valid article image nahi mili, text-only post hoga.");
  return { url: null, source: 'none' };
}

module.exports = getImage;
module.exports.imageKey = imageKey;
module.exports.isBadImageUrl = isBadImageUrl;
