# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm start            # Start the bot
npm test             # Run tests (Jest)
node index.js --send-now  # Send today's menu immediately (useful for testing)
```

Tests live in `tests/` and use Jest with mocked external dependencies (IMAP, Axios, Anthropic SDK).

## Architecture

This is a Node.js WhatsApp bot that scrapes daily lunch menus from multiple Oxford cafés and sends them to a WhatsApp group at 11:00 AM on weekdays.

**Main modules:**

- **`index.js`** — Entry point. Initializes WhatsApp client (via `whatsapp-web.js`/Puppeteer), handles QR auth, registers cron job (11 AM Mon–Fri), listens for `!menu` commands in the group.
- **`scraper.js`** — Fetches the Dakota Café menu by scraping the Exeter College website with Axios + Cheerio. Also orchestrates combining all menus into one formatted message via `MENU_SOURCES`.
- **`blavatnik.js`** — Fetches the Blavatnik Café menu by connecting to Gmail via IMAP (`imapflow`), extracting PNG attachments from emails with subject "Weekly Menu Update", sending the image to Claude Vision API (`@anthropic-ai/sdk`) for text extraction, and caching results in `data/blavatnik-menu.json` weekly.
- **`schwarzman.js`** — Fetches the Schwarzman Centre "Build Your Own" menu via the same Gmail/IMAP/Claude Vision pipeline, searching for emails with subject "Schwarzman Menu". Returns a category-based format (Base, Sides, Protein, etc.). Cached weekly in `data/schwarzman-menu.json`.

**Data flow:**
1. Cron fires (or `!menu` received) → `sendMenuToGroup()` in `index.js`
2. `index.js` refreshes email-based caches (Blavatnik + Schwarzman) before sending
3. `scraper.js` fetches Dakota menu from web + calls `blavatnik.js` and `schwarzman.js`
4. Each email-based module checks cache freshness; if stale, fetches Gmail → extracts image → calls Claude Vision → saves JSON cache
5. Combined message sent to the WhatsApp group matched by `GROUP_NAME`

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
- **Runtime data**: `data/blavatnik-menu.json` and `data/schwarzman-menu.json` are auto-created; they cache menus to avoid redundant Gmail/Claude API calls.
- Use PM2 or systemd to keep the process running persistently.
