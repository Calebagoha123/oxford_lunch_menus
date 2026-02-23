const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");
const { getWeekMonday } = require("./blavatnik");

const MENU_PATH = path.join(__dirname, "data", "schwarzman-menu.json");

// Categories to omit from the formatted output (minor items, keeps message concise)
const SKIP_CATEGORIES = ["toppings", "sauces & pickles"];

/**
 * Connect to Gmail via IMAP, find the latest Schwarzman menu email,
 * download the image attachment, parse it with Claude Vision, and save the result.
 */
async function checkForNewSchwarzmanMenu() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!user || !pass || !apiKey) {
    console.warn(
      "Schwarzman: missing GMAIL_USER, GMAIL_APP_PASSWORD, or ANTHROPIC_API_KEY — skipping.",
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
      const messages = await client.search(
        { subject: "Schwarzman Menu" },
        { uid: true },
      );

      if (!messages.length) {
        console.log("Schwarzman: no menu emails found.");
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
        console.log("Schwarzman: no PNG/JPEG attachment found in latest email.");
        return;
      }

      // Try each image until one yields actual menu data
      let menuData = null;
      for (const attachment of imageAttachments) {
        console.log(`Schwarzman: trying attachment "${attachment.filename}" (${Math.round(attachment.size / 1024)}KB)...`);
        menuData = await parseMenuImage(attachment.content, attachment.contentType, apiKey);
        const hasCategories = menuData && Object.keys(menuData).length > 0;
        if (hasCategories) break;
        menuData = null;
      }

      if (menuData) {
        saveMenu(menuData);
        console.log("Schwarzman: menu saved successfully.");
      } else {
        console.log("Schwarzman: no menu data found in any attachment.");
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (err) {
    console.error("Schwarzman: IMAP error:", err.message);
  }
}

/**
 * Send the image buffer to Claude Vision API and extract structured menu data.
 */
async function parseMenuImage(imageBuffer, contentType, apiKey) {
  const anthropic = new Anthropic({ apiKey });

  const base64Image = imageBuffer.toString("base64");
  const mediaType = contentType === "image/jpeg" ? "image/jpeg" : "image/png";

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
            text: `Extract the "Build Your Own" lunch menu from this image. Return ONLY valid JSON with no markdown or code fences.

The menu has categories like Base, Sides, Protein, Toppings, Sauces & Pickles, etc. Return a JSON object where keys are the category names exactly as shown and values are arrays of items:
{
  "Base": ["item1", "item2"],
  "Sides": ["item1", "item2", "item3"],
  "Protein": ["item1", "item2"],
  "Toppings": ["item1", "item2"],
  "Sauces & Pickles": ["item1", "item2"]
}

Important:
- Strip any calorie counts and pricing info from items
- Preserve category names exactly as they appear on the board
- Preserve the exact order items appear in each category
- Include ALL categories and ALL items you can read`,
          },
        ],
      },
    ],
  });

  const text = response.content[0].text.trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    console.error("Schwarzman: failed to parse Vision API response:", text);
    return null;
  }
}

/**
 * Save parsed menu data to disk, tagged with the Monday of the current week.
 */
function saveMenu(menuData) {
  const payload = {
    weekCommencing: getWeekMonday().toISOString(),
    menu: menuData,
  };
  fs.mkdirSync(path.dirname(MENU_PATH), { recursive: true });
  fs.writeFileSync(MENU_PATH, JSON.stringify(payload, null, 2));
}

/**
 * Format the Schwarzman "Build Your Own" menu for WhatsApp.
 */
function formatMenu(menuData) {
  const lines = [];
  lines.push("*1 Base + 1 Protein + 2 Sides*");

  for (const [category, items] of Object.entries(menuData)) {
    if (!Array.isArray(items) || !items.length) continue;
    if (SKIP_CATEGORIES.includes(category.toLowerCase())) continue;

    lines.push("");
    lines.push(`*${category}*`);
    for (const item of items) {
      lines.push(`• ${item}`);
    }
  }

  return lines;
}

/**
 * Read cached menu and return formatted items.
 * Since the Schwarzman menu is the same all week, the `today` parameter is ignored.
 * Refreshes only when the cached week differs from the current week.
 */
async function fetchSchwarzman(_today) {
  let needsRefresh = true;
  if (fs.existsSync(MENU_PATH)) {
    try {
      const cached = JSON.parse(fs.readFileSync(MENU_PATH, "utf-8"));
      const cachedMonday = cached.weekCommencing
        ? new Date(cached.weekCommencing).toDateString()
        : null;
      const currentMonday = getWeekMonday().toDateString();
      if (cachedMonday === currentMonday) needsRefresh = false;
    } catch {
      // Corrupted file, will refresh
    }
  }

  if (needsRefresh) {
    await checkForNewSchwarzmanMenu();
  }

  if (!fs.existsSync(MENU_PATH)) return [];

  try {
    const cached = JSON.parse(fs.readFileSync(MENU_PATH, "utf-8"));
    return formatMenu(cached.menu);
  } catch {
    return [];
  }
}

module.exports = { fetchSchwarzman, checkForNewSchwarzmanMenu };
