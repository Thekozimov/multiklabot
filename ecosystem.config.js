// PM2 bilan ishga tushirish: pm2 start ecosystem.config.js
module.exports = {
  apps: [{
    name: 'multfilm-bot',
    script: 'index.js',
    autorestart: true,
    max_memory_restart: '200M',
    restart_delay: 3000
  }]
};
