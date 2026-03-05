module.exports = {
  apps: [
    {
      name: "lunch-bot",
      script: "index.js",
      max_restarts: 5,
      min_uptime: "30s",
      restart_delay: 5000,
      exp_backoff_restart_delay: 100,
    },
  ],
};
