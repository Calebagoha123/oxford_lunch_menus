# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm start            # Start the bot
node index.js --send-now  # Send today's menu immediately (useful for testing)
```

There are no tests configured.

## Architecture

This is a Node.js WhatsApp bot that scrapes daily lunch menus from multiple Oxford cafés and sends them to a WhatsApp group at 11:00 AM on weekdays.

**Three main modules:**

- **`index.js`** — Entry point. Initializes WhatsApp client (via `whatsapp-web.js`/Puppeteer), handles QR auth, registers cron job (11 AM Mon–Fri), listens for `!menu` commands in the group.
- **`scraper.js`** — Fetches the Dakota Café menu by scraping the Exeter College website with Axios + Cheerio. Also orchestrates combining all menus into one formatted message.
- **`blavatnik.js`** — Fetches the Blavatnik Café menu by connecting to Gmail via IMAP (`imapflow`), extracting PNG attachments from emails, sending the image to Claude Vision API (`@anthropic-ai/sdk`) for text extraction, and caching results in `data/blavatnik-menu.json` for 7 days.

**Data flow:**
1. Cron fires (or `!menu` received) → `sendMenuToGroup()` in `index.js`
2. `scraper.js` fetches Dakota menu from web + calls `blavatnik.js`
3. `blavatnik.js` checks cache freshness; if stale, fetches Gmail → extracts PNG → calls Claude Vision → saves JSON cache
4. Combined message sent to the WhatsApp group matched by `GROUP_NAME`

## Environment Variables

Required in `.env` (see `.env.example`):

```
GROUP_NAME=            # Exact WhatsApp group name to send menus to
GMAIL_USER=            # Gmail address receiving Blavatnik menu emails
GMAIL_APP_PASSWORD=    # Gmail App Password (requires 2FA enabled)
ANTHROPIC_API_KEY=     # Anthropic API key for Claude Vision
```

## Deployment Notes

- **WhatsApp auth**: On first run, scan the QR code. The session is persisted in `.wwebjs_auth/`. Keep this directory across restarts.
- **EC2/memory-constrained**: Puppeteer is already configured with `--single-process`, `--no-sandbox`, `--disable-dev-shm-usage`, etc. to reduce memory on t2.micro.
- **Runtime data**: `data/blavatnik-menu.json` is auto-created; it caches the Blavatnik menu to avoid redundant Gmail/Claude API calls.
- Use PM2 or systemd to keep the process running persistently.
