const cheerio = require("cheerio");
const axios = require("axios");

jest.mock("axios");
jest.mock("../blavatnik");

const { parseExeterSection, fetchCohenQuad, getTodaysMenu } = require("../scraper");
const { fetchBlavatnik } = require("../blavatnik");

// Realistic mock of the Exeter menu page structure
const MOCK_EXETER_HTML = `
<html><body>
  <h2>Another Section</h2>
  <p>Some other content</p>

  <h2>Dakota Café (Cohen Quad)</h2>
  <h3>Main Course</h3>
  <ul>
    <li>Monday – Pasta Bolognese • Roasted Tomato Sauce • Parmesan</li>
    <li>Tuesday – Fish &amp; Chips • Mushy Peas • Tartare Sauce</li>
    <li>Wednesday – Roast Chicken • Roast Potatoes • Gravy</li>
    <li>Thursday – Beef Stir Fry • Egg Fried Rice</li>
    <li>Friday – Veggie Burger • Sweet Potato Fries</li>
  </ul>
  <h3>Daily Options</h3>
  <ul>
    <li>Salad Bar</li>
    <li>Soup of the Day</li>
    <li>Fresh Bread Rolls</li>
  </ul>

  <h2>Hall</h2>
  <p>Hall content here</p>
</body></html>
`;

// ── parseExeterSection ────────────────────────────────────────────────────────

describe("parseExeterSection", () => {
  test("returns items only for the requested day", () => {
    const $ = cheerio.load(MOCK_EXETER_HTML);
    const lines = parseExeterSection($, "Dakota Café (Cohen Quad)", "Monday");
    expect(lines).toContain("• Pasta Bolognese • Roasted Tomato Sauce • Parmesan");
    expect(lines.join("\n")).not.toMatch(/Fish|Roast Chicken|Beef Stir Fry|Veggie Burger/);
  });

  test("includes items without a day prefix on all days", () => {
    const $ = cheerio.load(MOCK_EXETER_HTML);
    const lines = parseExeterSection($, "Dakota Café (Cohen Quad)", "Friday");
    expect(lines).toContain("• Salad Bar");
    expect(lines).toContain("• Soup of the Day");
    expect(lines).toContain("• Fresh Bread Rolls");
  });

  test("includes h3 headings formatted as bold", () => {
    const $ = cheerio.load(MOCK_EXETER_HTML);
    const lines = parseExeterSection($, "Dakota Café (Cohen Quad)", "Monday");
    expect(lines).toContain("\n*Main Course*");
    expect(lines).toContain("\n*Daily Options*");
  });

  test("returns empty array when section is not found", () => {
    const $ = cheerio.load(MOCK_EXETER_HTML);
    const lines = parseExeterSection($, "Nonexistent Café", "Monday");
    expect(lines).toHaveLength(0);
  });

  test("stops collecting at the next h2", () => {
    const $ = cheerio.load(MOCK_EXETER_HTML);
    const lines = parseExeterSection($, "Dakota Café (Cohen Quad)", "Monday");
    expect(lines.join("\n")).not.toContain("Hall content here");
  });
});

// ── fetchCohenQuad ────────────────────────────────────────────────────────────

describe("fetchCohenQuad", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns menu items for the given day", async () => {
    axios.get.mockResolvedValue({ data: MOCK_EXETER_HTML });
    const items = await fetchCohenQuad("Wednesday");
    expect(items).toContain("• Roast Chicken • Roast Potatoes • Gravy");
    expect(items.join("\n")).not.toMatch(/Monday|Tuesday|Thursday|Friday/);
  });

  test("returns empty array when site has no matching section", async () => {
    axios.get.mockResolvedValue({ data: "<html><body><h2>Other</h2></body></html>" });
    const items = await fetchCohenQuad("Monday");
    expect(items).toHaveLength(0);
  });

  test("throws when axios fails", async () => {
    axios.get.mockRejectedValue(new Error("Network error"));
    await expect(fetchCohenQuad("Monday")).rejects.toThrow("Network error");
  });
});

// ── getTodaysMenu ─────────────────────────────────────────────────────────────

describe("getTodaysMenu", () => {
  beforeEach(() => jest.clearAllMocks());

  test("includes Cohen Quad section when items are returned", async () => {
    axios.get.mockResolvedValue({ data: MOCK_EXETER_HTML });
    fetchBlavatnik.mockResolvedValue([]);

    // Force a day that has items in the mock HTML
    jest.spyOn(Date.prototype, "getDay").mockReturnValue(1); // Monday

    const msg = await getTodaysMenu();
    expect(msg).toContain("Lunch Menu");
    expect(msg).toContain("Dakota Café (Cohen Quad)");
    expect(msg).toContain("Pasta Bolognese");

    jest.restoreAllMocks();
  });

  test("includes Blavatnik section when items are returned", async () => {
    axios.get.mockResolvedValue({ data: "<html><body></body></html>" });
    fetchBlavatnik.mockResolvedValue(["• Tomato Soup — ~120kcal", "• Grilled Salmon — ~380kcal"]);

    const msg = await getTodaysMenu();
    expect(msg).toContain("Blavatnik Café");
    expect(msg).toContain("Tomato Soup");
    expect(msg).toContain("Grilled Salmon");
  });

  test("includes both sections when both return items", async () => {
    axios.get.mockResolvedValue({ data: MOCK_EXETER_HTML });
    fetchBlavatnik.mockResolvedValue(["• Tomato Soup — ~120kcal"]);

    jest.spyOn(Date.prototype, "getDay").mockReturnValue(2); // Tuesday

    const msg = await getTodaysMenu();
    expect(msg).toContain("Dakota Café (Cohen Quad)");
    expect(msg).toContain("Blavatnik Café");

    jest.restoreAllMocks();
  });

  test("shows fallback message when both sources return nothing", async () => {
    axios.get.mockResolvedValue({ data: "<html><body></body></html>" });
    fetchBlavatnik.mockResolvedValue([]);

    const msg = await getTodaysMenu();
    expect(msg).toContain("No menu items found for today");
  });

  test("continues if one source throws", async () => {
    axios.get.mockRejectedValue(new Error("Network error"));
    fetchBlavatnik.mockResolvedValue(["• Tomato Soup — ~120kcal"]);

    const msg = await getTodaysMenu();
    expect(msg).toContain("Blavatnik Café");
    expect(msg).not.toContain("Dakota Café (Cohen Quad)");
  });
});
