const fs = require("fs");
const path = require("path");

// Mock the heavy external deps before requiring the module
jest.mock("imapflow");
jest.mock("mailparser");
jest.mock("@anthropic-ai/sdk");

const { fetchBlavatnik } = require("../blavatnik");

const MENU_PATH = path.join(__dirname, "../data/blavatnik-menu.json");

const { getWeekMonday } = require("../blavatnik");

const SAMPLE_MENU = {
  Monday:    ["Grilled Chicken — ~1,380kcal", "Tomato Soup — ~120kcal", "Side Salad — ~80kcal"],
  Tuesday:   ["Lentil Dhal — ~310kcal", "Caesar Salad — ~290kcal", "Garlic Bread — ~1,150kcal"],
  Wednesday: ["Pasta Arrabiata — ~420kcal", "Veggie Stew — ~300kcal", "Bread Roll — ~120kcal"],
  Thursday:  ["Fish Pie — ~450kcal", "Mushroom Risotto — ~400kcal", "Coleslaw — ~90kcal"],
  Friday:    ["Veggie Burrito — ~390kcal", "Falafel Wrap — ~350kcal", "Corn Chips — ~200kcal"],
};

function freshCache() {
  return JSON.stringify({ weekCommencing: getWeekMonday().toISOString(), menu: SAMPLE_MENU });
}

function staleCache() {
  const lastMonday = new Date(getWeekMonday());
  lastMonday.setDate(lastMonday.getDate() - 7);
  return JSON.stringify({ weekCommencing: lastMonday.toISOString(), menu: SAMPLE_MENU });
}

// ── fetchBlavatnik ────────────────────────────────────────────────────────────

describe("fetchBlavatnik", () => {
  let existsSpy, readSpy;

  beforeEach(() => {
    existsSpy = jest.spyOn(fs, "existsSync");
    readSpy = jest.spyOn(fs, "readFileSync");
  });

  afterEach(() => jest.restoreAllMocks());

  test("returns formatted numbered list from a fresh cache", async () => {
    existsSpy.mockReturnValue(true);
    readSpy.mockReturnValue(freshCache());

    const items = await fetchBlavatnik("Monday");
    expect(items).toEqual([
      "1. Grilled Chicken",
      "2. Tomato Soup (V)",
      "3. Side Salad",
    ]);
  });

  test("falls back to next available day with a label when today has no menu", async () => {
    const cacheWithGap = JSON.stringify({
      weekCommencing: getWeekMonday().toISOString(),
      menu: { Monday: [], Tuesday: ["Lentil Dhal"] },
    });
    existsSpy.mockReturnValue(true);
    readSpy.mockReturnValue(cacheWithGap);

    const items = await fetchBlavatnik("Monday");
    expect(items[0]).toBe("_Next available: Tuesday_");
    expect(items[1]).toBe("1. Lentil Dhal");
  });

  test("numbers items in order 1, 2, 3", async () => {
    existsSpy.mockReturnValue(true);
    readSpy.mockReturnValue(freshCache());

    const items = await fetchBlavatnik("Wednesday");
    expect(items[0]).toMatch(/^1\./);
    expect(items[1]).toMatch(/^2\./);
    expect(items[2]).toMatch(/^3\./);
  });

  test("returns empty array when all days in cache are empty", async () => {
    const emptyCache = JSON.stringify({
      weekCommencing: getWeekMonday().toISOString(),
      menu: { Monday: [], Tuesday: [] },
    });
    existsSpy.mockReturnValue(true);
    readSpy.mockReturnValue(emptyCache);

    const items = await fetchBlavatnik("Monday");
    expect(items).toEqual([]);
  });

  test("returns empty array when no cache file exists and checkForNewMenu finds nothing", async () => {
    existsSpy.mockReturnValue(false);

    const items = await fetchBlavatnik("Monday");
    expect(items).toEqual([]);
  });

  test("attempts refresh when cache is from a previous week", async () => {
    // First call (week check) returns last week's cache; second call (post-refresh read) returns false
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
