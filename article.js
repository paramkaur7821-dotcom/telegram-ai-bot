require('dotenv').config();
const axios = require('axios');
const logError = require('./logerror');

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

const MAX_ARTICLE_CHARS = 3000;

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

function decodeEntities(str) {
  return String(str)
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(parseInt(d, 10)));
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, ' '));
}

const JUNK_LINE = /cookie|subscribe|newsletter|sign ?up|log ?in|advertisement|advert|read more|share this|follow us|all rights reserved|comments?|privacy policy|terms of (use|service)|click here|download (the )?app/i;

// Simple, dependency-free main article text extractor (ignores menus, ads, comments)
function extractArticleText(html) {
  let body = String(html || '');
  body = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ')
    .replace(/<figure[\s\S]*?<\/figure>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const seen = new Set();
  const paragraphs = [];
  for (const match of body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = stripTags(match[1]).replace(/\s+/g, ' ').trim();
    if (text.length < 60) continue;
    if (JUNK_LINE.test(text)) continue;
    const key = text.slice(0, 120).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    paragraphs.push(text);
    if (paragraphs.join(' ').length >= MAX_ARTICLE_CHARS) break;
  }

  return paragraphs.join(' ').slice(0, MAX_ARTICLE_CHARS).trim();
}

async function fetchArticleText(url) {
  if (!url || !/^https?:\/\//i.test(url)) return '';
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      responseType: 'text',
      maxRedirects: 5,
      maxContentLength: 5 * 1024 * 1024,
      headers: BROWSER_HEADERS
    });
    const text = extractArticleText(res.data);
    if (text.length < 400) {
      console.log(`Article text chhota/mila nahi (${text.length} chars): ${url}`);
      return '';
    }
    console.log(`Article text mila (${text.length} chars).`);
    return text;
  } catch (err) {
    logError(`Article fetch failed for "${url}":`, err);
    return '';
  }
}

module.exports = {
  resolvePublisherUrl,
  fetchArticleText,
  extractArticleText,
  hostnameOf,
  isGoogleHost,
  isGoogleNewsLink,
  decodeUrl
};
