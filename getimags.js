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
        per_page: 10,
        order: 'popular'
      },
      timeout: 8000
    });
    const hits = res.data.hits;
    if (hits && hits.length > 0 && hits[0].largeImageURL && hits[0].largeImageURL.startsWith('http')) {
      return hits[0].largeImageURL;
    }
    return null;
  } catch (err) {
    console.error(`Pixabay Error for "${query}":`, err.message);
    return null;
  }
}

async function getImage(topic) {
  // Pehle exact topic try karo
  let image = await searchPixabay(topic);
  if (image) return image;

  // Agar na mile, to generic fallback try karo
  console.log("Exact topic ki image nahi mili, fallback try kar rahe hain...");
  image = await searchPixabay("news breaking update");
  if (image) return image;

  return null;
}

module.exports = getImage;