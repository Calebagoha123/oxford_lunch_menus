const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

const MENU_PATH = path.join(__dirname, "data", "blavatnik-menu.json");
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

/**
 * Returns the Monday of the current week (at midnight UTC).
 */
function getWeekMonday(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

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
        const hasItems = menuData && WEEKDAYS.some(
          (day) => menuData[day] && (menuData[day].meat || menuData[day].veg || menuData[day].side),
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
              media_type: "image/png",
              data: base64Image,
            },
          },
          {
            type: "text",
            text: `Extract the weekly lunch menu from this image. Return ONLY valid JSON with no markdown or code fences:
{
  "Monday": {"meat": "meat or fish option — ~Xkcal", "veg": "vegetarian or vegan option — ~Xkcal", "side": "soup or side — ~Xkcal"},
  "Tuesday": {"meat": "...", "veg": "...", "side": "..."},
  "Wednesday": {"meat": "...", "veg": "...", "side": "..."},
  "Thursday": {"meat": "...", "veg": "...", "side": "..."},
  "Friday": {"meat": "...", "veg": "...", "side": "..."}
}
Use empty string "" for any category not present. Include calorie counts if shown.`,
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
    console.error("Blavatnik: failed to parse Vision API response:", text);
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
 * Format a day's {main, veg, side} object as a numbered list.
 */
function formatDayMenu(dayMenu) {
  if (!dayMenu) return [];
  const lines = [];
  if (dayMenu.meat) lines.push(`1. ${dayMenu.meat}`);
  if (dayMenu.veg)  lines.push(`2. ${dayMenu.veg}`);
  if (dayMenu.side) lines.push(`3. ${dayMenu.side}`);
  return lines;
}

/**
 * Read cached menu and return today's items.
 * Refreshes only when the cached week differs from the current week.
 */
async function fetchBlavatnik(today) {
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
    await checkForNewMenu();
  }

  if (!fs.existsSync(MENU_PATH)) return [];

  try {
    const cached = JSON.parse(fs.readFileSync(MENU_PATH, "utf-8"));
    const dayMenu = cached.menu[today];
    const lines = formatDayMenu(dayMenu);
    if (lines.length) return lines;

    // Today not in menu — find the next available weekday
    const todayIdx = WEEKDAYS.indexOf(today);
    const fallbackDay =
      WEEKDAYS.find((day, i) => i > todayIdx && cached.menu[day] && (cached.menu[day].meat || cached.menu[day].veg)) ||
      WEEKDAYS.find((day) => cached.menu[day] && (cached.menu[day].meat || cached.menu[day].veg));

    if (!fallbackDay) return [];
    return [`_Next available: ${fallbackDay}_`, ...formatDayMenu(cached.menu[fallbackDay])];
  } catch {
    return [];
  }
}

module.exports = { fetchBlavatnik, checkForNewMenu, getWeekMonday };
