require('dotenv').config();
const axios = require('axios');

async function searchGoogleImages(query) {
  try {
    const res = await axios.get('https://serpapi.com/search.json', {
      params: {
        engine: 'google_images',
        q: query,
        gl: 'in',
        hl: 'en',
        api_key: process.env.SERPAPI_KEY
      },
      timeout: 8000
    });

    const images = res.data.images_results;
    if (images && images.length > 0) {
      const topImages = images.slice(0, 8);
      const pick = topImages[Math.floor(Math.random() * topImages.length)];
      if (pick.original && pick.original.startsWith('http')) {
        return pick.original;
      }
    }
    return null;
  } catch (err) {
    console.error(`Google Images Error for "${query}":`, err.message);
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
    console.error(`Pixabay Error for "${query}":`, err.message);
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

async function getImage(newsData) {
  // Step 1: Real news article ki apni photo (agar SerpApi ne di ho)
  if (newsData.thumbnail && newsData.thumbnail.startsWith('http')) {
    console.log("Real news article ki asli photo mil gayi!");
    return newsData.thumbnail;
  }

  // Step 2: SerpApi Google Images se, news ke exact keywords se search
  const searchText = `${newsData.title} ${newsData.snippet}`;
  const keywords = extractKeywords(searchText);
  console.log(`Google Images mein search kar rahe hain: "${keywords}"`);

  let image = await searchGoogleImages(keywords);
  if (image) {
    console.log("News se related image Google Images se mil gayi!");
    return image;
  }

  // Step 3: Pixabay fallback (agar upar dono fail ho jayein)
  console.log("Google Images mein nahi mili, Pixabay try kar rahe hain...");
  image = await searchPixabay(keywords);
  if (image) return image;

  image = await searchPixabay('Punjab India news');
  return image;
}

module.exports = getImage;