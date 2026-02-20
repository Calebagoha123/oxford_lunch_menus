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
      // Search for emails from the Blavatnik mailing list (most recent first)
      const messages = await client.search(
        {
          from: "blavatnik",
          subject: "menu",
        },
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
      const pngAttachment = parsed.attachments.find(
        (a) =>
          a.contentType === "image/png" || a.contentType === "image/jpeg",
      );

      if (!pngAttachment) {
        console.log("Blavatnik: no PNG/JPEG attachment found in latest email.");
        return;
      }

      console.log("Blavatnik: found menu image, sending to Claude Vision...");
      const menuData = await parseMenuImage(pngAttachment.content, apiKey);

      if (menuData) {
        saveMenu(menuData);
        console.log("Blavatnik: menu saved successfully.");
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
    if (!items || !items.length) return [];
    return items.map((item) => `• ${item}`);
  } catch {
    return [];
  }
}

module.exports = { fetchBlavatnik, checkForNewMenu };
