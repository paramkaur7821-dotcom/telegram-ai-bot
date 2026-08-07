require('dotenv').config();
const axios = require('axios');

async function getTrendingTopic() {
  try {
    const res = await axios.get('https://serpapi.com/search.json', {
      params: {
        engine: 'google_news',
        gl: 'in',
        hl: 'en',
        api_key: process.env.SERPAPI_KEY
      },
      timeout: 8000
    });

    const articles = res.data.news_results;
    if (articles && articles.length > 0) {
      // Random top news se ek chuno (taaki repeat na ho)
      const topArticles = articles.slice(0, 5);
      const pick = topArticles[Math.floor(Math.random() * topArticles.length)];
      return pick.title;
    }
    return "latest news update";
  } catch (err) {
    console.error("SerpApi Error:", err.message);
    return "latest news update";
  }
}

module.exports = getTrendingTopic;