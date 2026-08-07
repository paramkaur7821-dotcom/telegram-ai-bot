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
      // Random image top results mein se, taaki hamesha same na aaye
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

// Topic se simple keywords nikalo (extra words hata ke)
function extractKeywords(topic) {
  const words = topic
    .replace(/[^\w\s]/g, '')
    .split(' ')
    .filter(w => w.length > 3);
  return words.slice(0, 3).join(' ') || 'news';
}

async function getImage(topic) {
  const keywords = extractKeywords(topic);

  // Pehle extracted keywords try karo
  let image = await searchPixabay(keywords);
  if (image) return image;

  // Fallback: random generic news category
  const fallbackTopics = ['news update', 'world news', 'current affairs', 'breaking news'];
  const fallback = fallbackTopics[Math.floor(Math.random() * fallbackTopics.length)];
  console.log(`Exact topic ki image nahi mili, "${fallback}" try kar rahe hain...`);
  image = await searchPixabay(fallback);
  return image;
}

module.exports = getImage;