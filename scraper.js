const axios = require("axios");
const cheerio = require("cheerio");
const { fetchBlavatnik } = require("./blavatnik");
const { fetchSchwarzman } = require("./schwarzman");

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const DAY_PREFIX_RE = new RegExp(
  `^(${DAYS.join("|")})\\s*[–—-]\\s*`,
);

function stripCalories(text) {
  return text
    .replace(/\s*[—–-]\s*~?\d[\d,]*\s*kcal/gi, "")
    .replace(/\s*\(?\s*~?\d[\d,]*\s*kcal\s*\)?/gi, "")
    .trim();
}

// --- Menu sources ---
// Each has a fetch function that returns an array of formatted lines.
// To add Schwarzman, Blavatnik, etc., just add a new entry here.

const MENU_SOURCES = [
  {
    name: "Dakota Café (Cohen Quad)",
    info: "🕐 12:00–13:30 · 💷 £3.80",
    fetch: fetchCohenQuad,
  },
  {
    name: "Blavatnik Café",
    info: "🕐 12:00–13:30 · 💷 £5.50",
    fetch: fetchBlavatnik,
  },
  {
    name: "Schwarzman Centre",
    info: "🕐 12:00–14:00 · 💷 £7.95",
    fetch: fetchSchwarzman,
  },
];

/**
 * Fetch and compile all menus into a single WhatsApp message.
 */
async function getTodaysMenu() {
  const today = DAYS[new Date().getDay()];
  const dateStr = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  let msg = `🍽 *Lunch Menu*\n📅 ${dateStr}\n`;

  let anyItems = false;
  for (const source of MENU_SOURCES) {
    try {
      const items = await source.fetch(today);
      if (items.length) {
        anyItems = true;
        msg += `\n*--- ${source.name} ---*\n`;
        msg += `${source.info}\n`;
        msg += items.join("\n");
        msg += "\n";
      }
    } catch (err) {
      console.error(`Error fetching ${source.name}:`, err.message);
    }
  }

  if (!anyItems) {
    msg += "\nNo menu items found for today.";
  }

  return msg;
}

// --- Cohen Quad (Exeter College) ---

const EXETER_MENU_URL =
  "https://www.exeter.ox.ac.uk/students/catering/todays-menus/";

async function fetchCohenQuad(today) {
  const { data: html } = await axios.get(EXETER_MENU_URL);
  const $ = cheerio.load(html);
  return parseExeterSection($, "Dakota Café (Cohen Quad)", today);
}

/**
 * Parse a section from the Exeter menu page.
 * Finds the <h2> matching sectionName, collects content until the next <h2>.
 * Filters day-specific items to only show today's.
 */
// Sections to skip entirely from the Cohen Quad menu
const SKIP_SECTIONS_RE = /^panini$/i;
// Lines to drop from the output
const SKIP_LINES_RE = /please note.*subject to change|selection of sides and salads/i;

function parseExeterSection($, sectionName, today) {
  const lines = [];

  let sectionH2 = null;
  $("h2").each((_, el) => {
    if ($(el).text().trim().includes(sectionName)) {
      sectionH2 = $(el);
      return false;
    }
  });

  if (!sectionH2) return lines;

  let skipUntilNext = false;
  let current = sectionH2.next();
  while (current.length && !current.is("h2")) {
    const tag = current.prop("tagName");

    if (tag === "H3" || tag === "P") {
      const text = current.text().trim();
      if (!text) {
        current = current.next();
        continue;
      }

      // Check if this heading starts a section we want to skip
      const isHeading =
        tag === "H3" ||
        (tag === "P" &&
          text.length < 60 &&
          !text.includes("•") &&
          !DAY_PREFIX_RE.test(text) &&
          current.next().is("ul"));

      if (isHeading && SKIP_SECTIONS_RE.test(text)) {
        skipUntilNext = true;
        current = current.next();
        continue;
      }

      if (isHeading) {
        skipUntilNext = false;
        lines.push(`\n*${text}*`);
      } else if (!skipUntilNext && !SKIP_LINES_RE.test(text)) {
        lines.push(text);
      }
    } else if (tag === "UL" && !skipUntilNext) {
      current.find("> li").each((_, li) => {
        const liText = $(li).text().trim().replace(/\s+/g, " ");
        const dayMatch = liText.match(DAY_PREFIX_RE);

        if (dayMatch) {
          if (dayMatch[1] === today) {
            lines.push(`• ${stripCalories(liText.replace(DAY_PREFIX_RE, ""))}`);
          }
        } else {
          lines.push(`• ${stripCalories(liText)}`);
        }
      });
    }

    current = current.next();
  }

  return lines;
}

module.exports = { getTodaysMenu, fetchCohenQuad, parseExeterSection };
