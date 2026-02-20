const fs = require("fs");
const path = require("path");

// Mock the heavy external deps before requiring the module
jest.mock("imapflow");
jest.mock("mailparser");
jest.mock("@anthropic-ai/sdk");

const { fetchBlavatnik } = require("../blavatnik");

const MENU_PATH = path.join(__dirname, "../data/blavatnik-menu.json");

const SAMPLE_MENU = {
  Monday: ["Tomato Soup — ~120kcal", "Grilled Chicken — ~380kcal"],
  Tuesday: ["Lentil Dhal — ~310kcal", "Caesar Salad — ~290kcal"],
  Wednesday: ["Pasta Arrabiata — ~420kcal"],
  Thursday: ["Fish Pie — ~450kcal"],
  Friday: ["Veggie Burrito — ~390kcal"],
};

function freshCache() {
  return JSON.stringify({ weekOf: new Date().toISOString(), menu: SAMPLE_MENU });
}

function staleCache() {
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  return JSON.stringify({ weekOf: eightDaysAgo, menu: SAMPLE_MENU });
}

// ── fetchBlavatnik ────────────────────────────────────────────────────────────

describe("fetchBlavatnik", () => {
  let existsSpy, readSpy;

  beforeEach(() => {
    existsSpy = jest.spyOn(fs, "existsSync");
    readSpy = jest.spyOn(fs, "readFileSync");
  });

  afterEach(() => jest.restoreAllMocks());

  test("returns formatted items from a fresh cache", async () => {
    existsSpy.mockReturnValue(true);
    readSpy.mockReturnValue(freshCache());

    const items = await fetchBlavatnik("Monday");
    expect(items).toEqual(["• Tomato Soup — ~120kcal", "• Grilled Chicken — ~380kcal"]);
  });

  test("prefixes each item with a bullet point", async () => {
    existsSpy.mockReturnValue(true);
    readSpy.mockReturnValue(freshCache());

    const items = await fetchBlavatnik("Wednesday");
    items.forEach((item) => expect(item).toMatch(/^• /));
  });

  test("returns empty array when today has no items in cache", async () => {
    const cacheWithGap = JSON.stringify({
      weekOf: new Date().toISOString(),
      menu: { Monday: [], Tuesday: ["Something"] },
    });
    existsSpy.mockReturnValue(true);
    readSpy.mockReturnValue(cacheWithGap);

    const items = await fetchBlavatnik("Monday");
    expect(items).toEqual([]);
  });

  test("returns empty array when no cache file exists and checkForNewMenu finds nothing", async () => {
    existsSpy.mockReturnValue(false);

    const items = await fetchBlavatnik("Monday");
    expect(items).toEqual([]);
  });

  test("attempts refresh when cache is stale", async () => {
    // First call (age check) returns stale; second call (post-refresh read) returns false
    existsSpy.mockReturnValueOnce(true).mockReturnValue(false);
    readSpy.mockReturnValue(staleCache());

    const items = await fetchBlavatnik("Monday");
    // After stale cache triggers refresh and no new cache is written, returns []
    expect(items).toEqual([]);
  });

  test("returns empty array on corrupted cache", async () => {
    existsSpy.mockReturnValue(true);
    readSpy.mockReturnValue("not valid json {{");

    const items = await fetchBlavatnik("Monday");
    expect(items).toEqual([]);
  });
});
