const fs = require("fs");
const path = require("path");

// Mock the heavy external deps before requiring the module
jest.mock("imapflow");
jest.mock("mailparser");
jest.mock("@anthropic-ai/sdk");

const { getWeekMonday } = require("../blavatnik");
const { fetchSchwarzman } = require("../schwarzman");

const MENU_PATH = path.join(__dirname, "../data/schwarzman-menu.json");

const SAMPLE_MENU = {
  Base: ["Bulgur w/ Roasted Mediterranean Veg", "Coconut Jasmin Rice"],
  Sides: ["Polenta chips w/ Parmesan", "Yellow peas Dahal", "Cheesy Spinach"],
  Protein: [
    "Brazilian Marinated Chicken Katsu",
    "Creamy Meatball Pasta",
    "Tempeh Korma curry",
    "Stuffed Peppers & Spicy Bean w/ Mozzarella",
  ],
  Toppings: ["Crispy Onions", "Garlic Migas", "Mixed seeds", "Curried Croutons", "Jalapeno"],
  "Sauces & Pickles": [
    "Mango Chutney",
    "Salted cucumber Riata",
    "Fermented Chili sauce",
    "Pickled Red cabbage",
  ],
};

function freshCache() {
  return JSON.stringify({ weekCommencing: getWeekMonday().toISOString(), menu: SAMPLE_MENU });
}

function staleCache() {
  const lastMonday = new Date(getWeekMonday());
  lastMonday.setDate(lastMonday.getDate() - 7);
  return JSON.stringify({ weekCommencing: lastMonday.toISOString(), menu: SAMPLE_MENU });
}

// ── fetchSchwarzman ──────────────────────────────────────────────────────────

describe("fetchSchwarzman", () => {
  let existsSpy, readSpy;

  beforeEach(() => {
    existsSpy = jest.spyOn(fs, "existsSync");
    readSpy = jest.spyOn(fs, "readFileSync");
  });

  afterEach(() => jest.restoreAllMocks());

  test("returns formatted menu with Build Your Own header from fresh cache", async () => {
    existsSpy.mockReturnValue(true);
    readSpy.mockReturnValue(freshCache());

    const items = await fetchSchwarzman("Monday");
    expect(items[0]).toBe("*1 Base + 1 Protein + 2 Sides*");
  });

  test("includes bold category headers for main categories", async () => {
    existsSpy.mockReturnValue(true);
    readSpy.mockReturnValue(freshCache());

    const items = await fetchSchwarzman("Monday");
    expect(items).toContain("*Base*");
    expect(items).toContain("*Sides*");
    expect(items).toContain("*Protein*");
  });

  test("omits toppings and sauces & pickles sections", async () => {
    existsSpy.mockReturnValue(true);
    readSpy.mockReturnValue(freshCache());

    const items = await fetchSchwarzman("Monday");
    const joined = items.join("\n");
    expect(joined).not.toContain("Toppings");
    expect(joined).not.toContain("Sauces & Pickles");
    expect(joined).not.toContain("Crispy Onions");
    expect(joined).not.toContain("Mango Chutney");
  });

  test("shows base and sides items as bullet lists", async () => {
    existsSpy.mockReturnValue(true);
    readSpy.mockReturnValue(freshCache());

    const items = await fetchSchwarzman("Monday");
    expect(items).toContain("• Bulgur w/ Roasted Mediterranean Veg");
    expect(items).toContain("• Coconut Jasmin Rice");
    expect(items).toContain("• Polenta chips w/ Parmesan");
  });

  test("returns same menu regardless of which weekday is passed", async () => {
    existsSpy.mockReturnValue(true);
    readSpy.mockReturnValue(freshCache());

    const monday = await fetchSchwarzman("Monday");
    const friday = await fetchSchwarzman("Friday");
    expect(monday).toEqual(friday);
  });

  test("returns empty array when no cache file exists and check finds nothing", async () => {
    existsSpy.mockReturnValue(false);

    const items = await fetchSchwarzman("Monday");
    expect(items).toEqual([]);
  });

  test("attempts refresh when cache is from a previous week", async () => {
    existsSpy.mockReturnValueOnce(true).mockReturnValue(false);
    readSpy.mockReturnValue(staleCache());

    const items = await fetchSchwarzman("Monday");
    expect(items).toEqual([]);
  });

  test("returns empty array on corrupted cache", async () => {
    existsSpy.mockReturnValue(true);
    readSpy.mockReturnValue("not valid json {{");

    const items = await fetchSchwarzman("Monday");
    expect(items).toEqual([]);
  });
});
