require('dotenv').config();
const axios = require('axios');

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
  return words.slice(0, 3).join(' ') || 'Punjab news';
}

async function getImage(newsData) {
  // Step 1: Asli news article ki image try karo (SerpApi se mili thumbnail)
  if (newsData.thumbnail && newsData.thumbnail.startsWith('http')) {
    console.log("Real news image mil gayi (article ki asli photo)!");
    return newsData.thumbnail;
  }

  // Step 2: Agar real image na mile, Pixabay se relevant keyword try karo
  console.log("News ki apni image nahi mili, Pixabay se related image dhoond rahe hain...");
  const searchText = `${newsData.title} ${newsData.snippet}`;
  const keywords = extractKeywords(searchText);

  let image = await searchPixabay(keywords);
  if (image) return image;

  image = await searchPixabay('Punjab India');
  if (image) return image;

  image = await searchPixabay('news update India');
  return image;
}

module.exports = getImage;