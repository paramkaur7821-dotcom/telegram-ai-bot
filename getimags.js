require('dotenv').config();
const axios = require('axios');

async function getImage(query) {
  try {
    const res = await axios.get('https://pixabay.com/api/', {
      params: {
        key: process.env.PIXABAY_KEY,
        q: query,
        image_type: 'photo',
        per_page: 5
      }
    });
    const hit = res.data.hits?.[0];
    return hit ? hit.largeImageURL : null;
  } catch (err) {
    console.error("Pixabay Error:", err.message);
    return null;
  }
}

module.exports = getImage;