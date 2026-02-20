const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

const MENU_PATH = path.join(__dirname, "data", "blavatnik-menu.json");
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Connect to Gmail via IMAP, find the latest Blavatnik menu email,
 * download the PNG attachment, parse it with Claude Vision, and save the result.
 */
async function checkForNewMenu() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!user || !pass || !apiKey) {
    console.warn(
      "Blavatnik: missing GMAIL_USER, GMAIL_APP_PASSWORD, or ANTHROPIC_API_KEY — skipping.",
    );
    return;
  }

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");

    try {
      // Search for Blavatnik menu emails by subject (sender may vary)
      const messages = await client.search(
        { subject: "Weekly Menu Update" },
        { uid: true },
      );

      if (!messages.length) {
        console.log("Blavatnik: no menu emails found.");
        return;
      }

      // Fetch the most recent matching message
      const uid = messages[messages.length - 1];
      const raw = await client.download(uid, undefined, { uid: true });

      const parsed = await simpleParser(raw.content);
      const imageAttachments = parsed.attachments.filter(
        (a) => a.contentType === "image/png" || a.contentType === "image/jpeg",
      );

      if (!imageAttachments.length) {
        console.log("Blavatnik: no PNG/JPEG attachment found in latest email.");
        return;
      }

      // Try each image until one yields actual menu data
      let menuData = null;
      for (const attachment of imageAttachments) {
        console.log(`Blavatnik: trying attachment "${attachment.filename}" (${Math.round(attachment.size / 1024)}KB)...`);
        menuData = await parseMenuImage(attachment.content, apiKey);
        const DAYS_CHECK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
        const hasItems = menuData && DAYS_CHECK.some(
          (day) => Array.isArray(menuData[day]) && menuData[day].length > 0,
        );
        if (hasItems) break;
        menuData = null;
      }

      if (menuData) {
        saveMenu(menuData);
        console.log("Blavatnik: menu saved successfully.");
      } else {
        console.log("Blavatnik: no menu data found in any attachment.");
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (err) {
    console.error("Blavatnik: IMAP error:", err.message);
  }
}

/**
 * Send the PNG buffer to Claude Vision API and extract structured menu data.
 */
async function parseMenuImage(imageBuffer, apiKey) {
  const anthropic = new Anthropic({ apiKey });

  const base64Image = imageBuffer.toString("base64");
  const mediaType = "image/png";

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: base64Image,
            },
          },
          {
            type: "text",
            text: `Extract the daily lunch menu from this image. Return ONLY valid JSON with no markdown formatting, no code fences, just the raw JSON object:
{
  "Monday": ["Item description — ~Xkcal", ...],
  "Tuesday": [...],
  "Wednesday": [...],
  "Thursday": [...],
  "Friday": [...]
}
Include all items for each day exactly as shown in the image. If calorie counts are shown, include them.`,
          },
        ],
      },
    ],
  });

  const text = response.content[0].text.trim();
  try {
    return JSON.parse(text);
  } catch {
    // Try to extract JSON from the response if it has extra text
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    console.error("Blavatnik: failed to parse Vision API response:", text);
    return null;
  }
}

/**
 * Save parsed menu data to disk with a timestamp.
 */
function saveMenu(menuData) {
  const payload = {
    weekOf: new Date().toISOString(),
    menu: menuData,
  };
  fs.mkdirSync(path.dirname(MENU_PATH), { recursive: true });
  fs.writeFileSync(MENU_PATH, JSON.stringify(payload, null, 2));
}

/**
 * Read cached menu and return today's items.
 * If no cache or stale (>7 days), refresh from email first.
 */
async function fetchBlavatnik(today) {
  // Check if we need to refresh
  let needsRefresh = true;
  if (fs.existsSync(MENU_PATH)) {
    try {
      const cached = JSON.parse(fs.readFileSync(MENU_PATH, "utf-8"));
      const age = Date.now() - new Date(cached.weekOf).getTime();
      if (age < MAX_AGE_MS) {
        needsRefresh = false;
      }
    } catch {
      // Corrupted file, will refresh
    }
  }

  if (needsRefresh) {
    await checkForNewMenu();
  }

  // Read (possibly refreshed) cache
  if (!fs.existsSync(MENU_PATH)) {
    return [];
  }

  try {
    const cached = JSON.parse(fs.readFileSync(MENU_PATH, "utf-8"));
    const items = cached.menu[today];
    if (items && items.length) {
      return items.map((item) => `• ${item}`);
    }

    // Today not in menu — find the next available weekday
    const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
    const todayIdx = WEEKDAYS.indexOf(today);
    const fallbackDay = WEEKDAYS.find(
      (day, i) => i > todayIdx && cached.menu[day] && cached.menu[day].length,
    ) || WEEKDAYS.find(
      (day) => cached.menu[day] && cached.menu[day].length,
    );

    if (!fallbackDay) return [];
    const fallbackItems = cached.menu[fallbackDay];
    return [`_Next available: ${fallbackDay}_`, ...fallbackItems.map((item) => `• ${item}`)];
  } catch {
    return [];
  }
}

module.exports = { fetchBlavatnik, checkForNewMenu };
