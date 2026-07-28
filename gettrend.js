require('dotenv').config();
const axios = require('axios');

async function getTrendingTopic() {
  try {
    const res = await axios.get('https://serpapi.com/search.json', {
      params: {
        engine: 'google_trends_trending_now',
        geo: 'IN',
        api_key: process.env.SERPAPI_KEY
      }
    });
    const topic = res.data.trending_searches?.[0]?.query || "technology";
    return topic;
  } catch (err) {
    console.error("SerpApi Error:", err.message);
    return "technology";
  }
}

module.exports = getTrendingTopic;