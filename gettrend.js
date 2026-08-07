require('dotenv').config();
const axios = require('axios');

async function getTrendingTopic() {
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
      const topArticles = articles.slice(0, 5);
      const pick = topArticles[Math.floor(Math.random() * topArticles.length)];
      return {
        title: pick.title,
        snippet: pick.snippet || pick.title,
        source: pick.source?.name || ''
      };
    }
    return { title: "Punjab latest news", snippet: "Latest updates from Punjab", source: '' };
  } catch (err) {
    console.error("SerpApi Error:", err.message);
    return { title: "Punjab latest news", snippet: "Latest updates from Punjab", source: '' };
  }
}

module.exports = getTrendingTopic;