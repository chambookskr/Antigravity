const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const appDir = __dirname;
const publicDir = path.join(appDir, "public");
const exportDir = path.join(appDir, "exports");
const profileDir = path.join(appDir, "chrome-profile");
const startPort = Number(process.env.PORT || 4177);
const maxBodyBytes = 1024 * 1024;

const targetGroups = ["니즈키워드", "지역+마음수련", "지역+명상", "지역+상담"];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

let browserContext;
let activePage;
let busy = false;
let activeProfileDir = profileDir;

function loadPlaywright() {
  try {
    return require("playwright");
  } catch {
    const home = process.env.USERPROFILE || "C:\\Users\\mj";
    const nodeModules = path.join(
      home,
      ".cache",
      "codex-runtimes",
      "codex-primary-runtime",
      "dependencies",
      "node",
      "node_modules"
    );
    const candidates = [
      path.join(nodeModules, ".pnpm", "playwright@1.60.0", "node_modules", "playwright"),
      path.join(nodeModules, "playwright"),
    ];

    for (const candidate of candidates) {
      try {
        return require(candidate);
      } catch {
        // Try the next bundled path.
      }
    }
  }

  throw new Error("Playwright를 불러오지 못했습니다.");
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function publicError(error) {
  const message = String(error?.message || error || "");
  if (/Target page, context or browser has been closed|launchPersistentContext|Browser logs|remote-debugging-pipe|user-data-dir/i.test(message)) {
    return "Chrome 프로필을 여는 중 문제가 생겼습니다. 이미 열린 자동화 Chrome 창을 닫고 다시 시도해 주세요. 앱은 필요하면 이번 실행용 임시 Chrome 프로필로 다시 열도록 준비되어 있습니다.";
  }
  if (/Executable doesn't exist|Chrome|chromium/i.test(message) && /launch/i.test(message)) {
    return "Chrome을 열 수 없습니다. Chrome 설치 상태를 확인해 주세요.";
  }
  return message.length > 500 ? `${message.slice(0, 500)}...` : message;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw new Error("요청 내용이 너무 큽니다.");
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function validateNaverUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("올바른 URL을 입력해 주세요.");
  }

  const isNaver = parsed.hostname === "naver.com" || parsed.hostname.endsWith(".naver.com");
  if (!isNaver || !["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("naver.com 주소만 사용할 수 있습니다.");
  }

  return parsed.toString();
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function numericValue(value) {
  const text = normalizeText(value);
  const match = text.match(/\d[\d,]*/);
  return match ? Number(match[0].replace(/,/g, "")) : NaN;
}

function cleanKeywordText(value) {
  let cleaned = normalizeText(value);
  // Remove Naver Ads badges/suffixes
  cleaned = cleaned.replace(/\s*적은검색량/g, "");
  cleaned = cleaned.replace(/\s*노출제한/g, "");
  cleaned = cleaned.replace(/\s*검토중/g, "");
  cleaned = cleaned.replace(/\s*보류/g, "");
  cleaned = cleaned.replace(/\s*중지/g, "");
  cleaned = cleaned.replace(/\s*승인/g, "");
  cleaned = cleaned.replace(/\s*반려/g, "");
  cleaned = cleaned.replace(/\s*노출가능/g, "");
  return normalizeText(cleaned);
}

function isKeyword(value) {
  const text = normalizeText(value);
  if (text.length < 2 || text.length > 80) return false;
  if (!/[가-힣a-zA-Z]/.test(text)) return false;
  if (/https?:|www\.|naver\.com/i.test(text)) return false;
  if (/^[\d\s.,%()+\-~원]+$/.test(text)) return false;
  if (/^(키워드|노출수|클릭수|비용|상태|광고그룹|캠페인|순위|검색어|노출|노출\s*수|전체\s*결과|확장검색\s*결과|노출가능)$/i.test(text)) return false;
  if (/\d+개\s*결과$/.test(text)) return false;
  return true;
}

function monthRange(year, month) {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0);
  const dashed = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const dotted = (date) =>
    `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;

  return {
    label: `${year}년 ${month}월`,
    startDashed: dashed(start),
    endDashed: dashed(end),
    startDotted: dotted(start),
    endDotted: dotted(end),
    rangeDotted: `${dotted(start)} ~ ${dotted(end)}`,
    rangeDashed: `${dashed(start)} ~ ${dashed(end)}`,
  };
}

function validPeriods(year, months) {
  const parsedYear = Number(year);
  const nowYear = new Date().getFullYear();
  if (!Number.isInteger(parsedYear) || parsedYear < 2020 || parsedYear > nowYear + 1) {
    throw new Error("연도를 확인해 주세요.");
  }

  const unique = [...new Set((Array.isArray(months) ? months : []).map(Number))]
    .filter((month) => Number.isInteger(month) && month >= 1 && month <= 12)
    .sort((a, b) => a - b);

  if (!unique.length) {
    throw new Error("추출할 월을 하나 이상 체크해 주세요.");
  }

  return unique.map((month) => ({ year: parsedYear, month }));
}

async function ensureBrowser() {
  if (browserContext) return browserContext;

  await fs.mkdir(profileDir, { recursive: true });
  const { chromium } = loadPlaywright();
  const launchOptions = {
    channel: "chrome",
    headless: false,
    ignoreHTTPSErrors: true,
    locale: "ko-KR",
    viewport: { width: 1440, height: 1000 },
    args: ["--disable-gpu"],
  };

  try {
    activeProfileDir = profileDir;
    browserContext = await chromium.launchPersistentContext(profileDir, launchOptions);
  } catch (error) {
    const sessionProfileDir = path.join(appDir, `chrome-profile-session-${process.pid}`);
    await fs.mkdir(sessionProfileDir, { recursive: true });
    activeProfileDir = sessionProfileDir;
    try {
      browserContext = await chromium.launchPersistentContext(sessionProfileDir, launchOptions);
    } catch {
      throw new Error(publicError(error));
    }
  }

  browserContext.setDefaultTimeout(15000);
  browserContext.setDefaultNavigationTimeout(45000);
  browserContext.on("close", () => {
    browserContext = undefined;
    activePage = undefined;
  });

  activePage = browserContext.pages()[0] || (await browserContext.newPage());
  return browserContext;
}

async function page() {
  const context = await ensureBrowser();
  if (activePage && !activePage.isClosed()) return activePage;
  activePage = context.pages().find((item) => !item.isClosed()) || (await context.newPage());
  return activePage;
}

async function visibleFrames(currentPage) {
  const frames = [];
  for (const frame of currentPage.frames()) {
    try {
      if ((await frame.locator("body").count()) > 0) frames.push(frame);
    } catch {
      // Frame detached during SPA updates.
    }
  }
  return frames;
}

async function waitForRendered(currentPage) {
  await currentPage.waitForLoadState("domcontentloaded", { timeout: 45000 }).catch(() => {});
  await currentPage.waitForLoadState("load", { timeout: 45000 }).catch(() => {});
  await currentPage.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await currentPage.waitForTimeout(800);
}

function looksLikeLogin(currentPage) {
  return /nid\.naver\.com|login/i.test(currentPage.url());
}

async function firstVisible(currentPage, selectors) {
  for (const frame of await visibleFrames(currentPage)) {
    for (const selector of selectors) {
      const locator = frame.locator(selector);
      const count = Math.min(await locator.count().catch(() => 0), 80);
      for (let index = 0; index < count; index += 1) {
        const item = locator.nth(index);
        if (await item.isVisible().catch(() => false)) return item;
      }
    }
  }

  return undefined;
}

async function clickText(currentPage, text) {
  const escaped = text.replace(/"/g, '\\"');
  const locator = await firstVisible(currentPage, [
    `button:has-text("${escaped}")`,
    `a:has-text("${escaped}")`,
    `[role="button"]:has-text("${escaped}")`,
    `[role="link"]:has-text("${escaped}")`,
    `[role="row"]:has-text("${escaped}")`,
    `[role="gridcell"]:has-text("${escaped}")`,
    `text="${escaped}"`,
  ]);

  if (!locator) return false;
  await locator.click({ timeout: 12000 }).catch(() => {});
  await waitForRendered(currentPage);
  return true;
}

async function openDatePanel(currentPage) {
  console.log(`[DEBUG] Running openDatePanel...`);
  const locator = await firstVisible(currentPage, [
    'input[placeholder*="날짜"]',
    'input[placeholder*="기간"]',
    'input[aria-label*="날짜"]',
    'input[aria-label*="기간"]',
    'button:has-text("기간")',
    'button:has-text("날짜")',
    'button:has-text("오늘")',
    'button:has-text("최근")',
    'button:has-text("지난")',
    'button:has-text("~")',
    'button:has-text(".")',
    '[role="button"]:has-text("기간")',
    '[role="button"]:has-text("날짜")',
    '[role="button"]:has-text("오늘")',
    '[role="button"]:has-text("최근")',
    '[role="button"]:has-text("지난")',
    '[role="button"]:has-text("~")',
    '[role="button"]:has-text(".")',
  ]);

  if (locator) {
    console.log(`[DEBUG] Found date panel button/input to click.`);
    await locator.click({ timeout: 8000 }).catch(() => {});
    await currentPage.waitForTimeout(500);
    const c1 = await clickText(currentPage, "직접입력").catch(() => false);
    const c2 = await clickText(currentPage, "직접 설정").catch(() => false);
    const c3 = await clickText(currentPage, "사용자 지정").catch(() => false);
    console.log(`[DEBUG] Clicked sub-actions - 직접입력: ${c1}, 직접 설정: ${c2}, 사용자 지정: ${c3}`);
    return true;
  }

  console.log(`[DEBUG] No date panel button/input found.`);
  return false;
}

async function setInputValue(input, value) {
  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.click({ timeout: 5000 }).catch(() => {});
  try {
    await input.fill(value, { timeout: 5000 });
  } catch {
    await input.evaluate(
      (node, nextValue) => {
        node.removeAttribute("readonly");
        node.removeAttribute("disabled");
        node.value = nextValue;
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
      },
      value
    );
  }
}

async function fillVisibleDateInputs(currentPage, range) {
  console.log(`[DEBUG] Running fillVisibleDateInputs... Target range: ${JSON.stringify(range)}`);
  for (const frame of await visibleFrames(currentPage)) {
    const inputs = frame.locator("input");
    const count = Math.min(await inputs.count().catch(() => 0), 80);
    const candidates = [];

    for (let index = 0; index < count; index += 1) {
      const input = inputs.nth(index);
      if (!(await input.isVisible().catch(() => false))) continue;

      const type = normalizeText(await input.getAttribute("type").catch(() => ""));
      const placeholder = normalizeText(await input.getAttribute("placeholder").catch(() => ""));
      const aria = normalizeText(await input.getAttribute("aria-label").catch(() => ""));
      const title = normalizeText(await input.getAttribute("title").catch(() => ""));
      const value = normalizeText(await input.inputValue().catch(() => ""));
      const meta = `${type} ${placeholder} ${aria} ${title} ${value}`;

      if (
        type === "date" ||
        /날짜|기간|시작|종료|date|from|to/i.test(meta) ||
        /^\d{4}[-.]\d{1,2}[-.]\d{1,2}\.?$/.test(value)
      ) {
        console.log(`[DEBUG] Found date input candidate: index=${index}, meta="${meta}"`);
        candidates.push({ input, meta, type });
      }
    }

    console.log(`[DEBUG] Candidates count: ${candidates.length}`);
    if (candidates.length >= 2) {
      const useDashed = candidates.some((item) => item.type === "date" || /\d{4}-\d{1,2}-\d{1,2}/.test(item.meta));
      const hasTrailingDot = candidates.some((item) => /\d{4}[-.]\d{1,2}[-.]\d{1,2}\./.test(item.meta));
      const startInput =
        candidates.find((item) => /시작|from|start/i.test(item.meta))?.input || candidates[0].input;
      const endInput = candidates.find((item) => /종료|to|end/i.test(item.meta))?.input || candidates[1].input;
      
      let startVal = useDashed ? range.startDashed : range.startDotted;
      let endVal = useDashed ? range.endDashed : range.endDotted;
      if (hasTrailingDot && !useDashed) {
        startVal += ".";
        endVal += ".";
      }
      
      console.log(`[DEBUG] Filling inputs: startVal="${startVal}", endVal="${endVal}"`);
      await setInputValue(startInput, startVal);
      await setInputValue(endInput, endVal);
      return true;
    }

    if (candidates.length === 1) {
      const hasTrailingDot = /\d{4}[-.]\d{1,2}[-.]\d{1,2}\./.test(candidates[0].meta);
      let rangeVal = range.rangeDotted;
      if (hasTrailingDot) {
        rangeVal = rangeVal.replace(/(\d{4}\.\d{2}\.\d{2})/g, "$1.");
      }
      console.log(`[DEBUG] Filling single input: rangeVal="${rangeVal}"`);
      await setInputValue(candidates[0].input, rangeVal);
      return true;
    }
  }

  return false;
}

async function applyDateRange(currentPage, period) {
  const range = monthRange(period.year, period.month);
  console.log(`[DEBUG] applyDateRange for Period: ${period.year}년 ${period.month}월`);

  let filled = await fillVisibleDateInputs(currentPage, range);
  console.log(`[DEBUG] First fill attempt result: ${filled}`);
  if (!filled) {
    console.log(`[DEBUG] Opening date panel...`);
    const opened = await openDatePanel(currentPage);
    console.log(`[DEBUG] Date panel opened: ${opened}`);
    filled = await fillVisibleDateInputs(currentPage, range);
    console.log(`[DEBUG] Second fill attempt result: ${filled}`);
  }

  if (!filled) {
    throw new Error(
      `${range.label}: 기간 필터를 자동으로 조작하지 못했습니다. 열린 Chrome에서 기간 필터 영역이 보이도록 한 번 열어둔 뒤 다시 추출해 주세요.`
    );
  }

  // 1. Close calendar popup by clicking "확인" or "적용"
  console.log(`[DEBUG] Closing calendar popup...`);
  const closed = await clickText(currentPage, "확인").catch(() => false) ||
                 await clickText(currentPage, "적용").catch(() => false);
  console.log(`[DEBUG] Calendar popup closed: ${closed}`);

  await currentPage.waitForTimeout(1000);

  // 2. Refresh main grid by clicking "조회" or "검색"
  console.log(`[DEBUG] Refreshing main grid...`);
  const refreshed = await clickText(currentPage, "조회").catch(() => false) ||
                    await clickText(currentPage, "검색").catch(() => false);
  console.log(`[DEBUG] Grid refreshed: ${refreshed}`);

  await waitForRendered(currentPage);
  return range.label;
}

async function openKeywordTab(currentPage) {
  let opened = false;
  for (const frame of await visibleFrames(currentPage)) {
    // Look for exact "키워드" text inside clickable elements to avoid matching ad group titles like "니즈키워드"
    const selectors = [
      'button:text-is("키워드")',
      'a:text-is("키워드")',
      '[role="tab"]:text-is("키워드")',
      '[role="button"]:text-is("키워드")',
      'text="키워드"'
    ];
    for (const selector of selectors) {
      const locator = frame.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const item = locator.nth(index);
        if (await item.isVisible().catch(() => false)) {
          const text = String(await item.innerText().catch(() => "")).trim();
          if (text === "키워드") {
            await item.click({ timeout: 8000 }).catch(() => {});
            opened = true;
            break;
          }
        }
      }
      if (opened) break;
    }
    if (opened) break;
  }

  if (opened) {
    await waitForRendered(currentPage);
    await currentPage.waitForTimeout(1000);
  }
}

async function waitForTableRows(frame) {
  const rowSelectors = [".ag-row", "table tbody tr", '[role="row"]', ".ReactVirtualized__Table__row"];
  const startTime = Date.now();
  while (Date.now() - startTime < 10000) {
    for (const selector of rowSelectors) {
      try {
        const count = await frame.locator(selector).count();
        if (count >= 2) return true; // Header + at least one data row
      } catch {}
    }
    try {
      const text = await frame.locator("body").innerText().catch(() => "");
      if (text.includes("결과가 없습니다") || text.includes("등록된 키워드가 없습니다") || text.includes("조회 결과가 없습니다")) {
        return true; // Loaded but empty
      }
    } catch {}
    await frame.page().waitForTimeout(500);
  }
  return false;
}

async function clickNextPage(frame) {
  const nextSelectors = [
    'li.ant-pagination-next:not(.ant-pagination-disabled)',
    'button.ant-pagination-next:not(:disabled)',
    'a.ant-pagination-next',
    'button:has-text(">")',
    'a:has-text(">")',
    '[aria-label="Next Page"]',
    '[aria-label="다음 페이지"]',
    '[class*="pagination"] button:has-text(">")',
    '[class*="pagination"] [class*="next"]'
  ];

  for (const selector of nextSelectors) {
    const locator = frame.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const item = locator.nth(i);
      if (await item.isVisible().catch(() => false)) {
        const isDisabled = await item.evaluate(el => {
          return el.hasAttribute('disabled') || 
                 el.classList.contains('disabled') || 
                 el.classList.contains('ant-pagination-disabled') ||
                 el.getAttribute('aria-disabled') === 'true';
        }).catch(() => false);
        
        if (!isDisabled) {
          console.log(`[DEBUG] Clicking next page using selector: ${selector}`);
          await item.click({ timeout: 5000 }).catch(() => {});
          return true;
        }
      }
    }
  }
  return false;
}

function getPageSignature(rows) {
  if (!rows || rows.length < 2) return "";
  return rows.slice(1, 4).map(r => r.join(" ")).join("\n");
}

function detectColumns(rows) {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 12); rowIndex += 1) {
    const cells = rows[rowIndex];
    const joined = cells.join(" ");
    if (!/키워드|검색어/.test(joined) || !/노출|impressions?/i.test(joined)) continue;

    let keywordIndex = -1;
    let impressionsIndex = -1;
    cells.forEach((cell, index) => {
      if (keywordIndex === -1 && /키워드|검색어/.test(cell)) keywordIndex = index;
      if (
        impressionsIndex === -1 &&
        /노출|impressions?/i.test(cell) &&
        !/순위|평균|비율|률/.test(cell)
      ) {
        impressionsIndex = index;
      }
    });

    if (keywordIndex >= 0 && impressionsIndex >= 0) {
      return { headerRow: rowIndex, keywordIndex, impressionsIndex };
    }
  }

  return undefined;
}

function parseKeywordRows(rows, group, period) {
  const columns = detectColumns(rows);
  const parsed = [];

  rows.forEach((cells, rowIndex) => {
    if (!cells.length) return;
    if (columns && rowIndex <= columns.headerRow) return;

    let keyword = "";
    let impressions = NaN;

    if (columns) {
      keyword = cleanKeywordText(cells[columns.keywordIndex]);
      impressions = numericValue(cells[columns.impressionsIndex]);
    } else {
      const rawKeyword = cells.find((cell) => isKeyword(cleanKeywordText(cell)));
      keyword = rawKeyword ? cleanKeywordText(rawKeyword) : "";
      const numbers = cells
        .map((cell) => numericValue(cell))
        .filter((value) => Number.isFinite(value) && value > 0);
      impressions = numbers.length ? Math.max(...numbers) : NaN;
    }

    if (isKeyword(keyword) && Number.isFinite(impressions) && impressions >= 1) {
      parsed.push({ group, period, keyword, impressions });
    }
  });

  return parsed;
}

async function readRowsFromFrame(frame) {
  const selectors = ["table tr", "table tbody tr", '[role="row"]', ".ag-row", ".ReactVirtualized__Table__row"];

  for (const selector of selectors) {
    const rows = frame.locator(selector);
    const count = Math.min(await rows.count().catch(() => 0), 800);
    if (count < 2) continue;

    const result = [];
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      if (!(await row.isVisible().catch(() => false))) continue;

      const cells = row.locator('th, td, [role="columnheader"], [role="cell"], [role="gridcell"]');
      const cellCount = Math.min(await cells.count().catch(() => 0), 80);
      let values = [];

      if (cellCount > 1) {
        values = (await cells.allInnerTexts().catch(() => [])).map(normalizeText);
      } else {
        values = normalizeText(await row.innerText().catch(() => ""))
          .split(/\t|\n| {2,}/)
          .map(normalizeText)
          .filter(Boolean);
      }

      if (values.some(v => v !== "")) result.push(values);
    }

    if (result.length) return result;
  }

  return [];
}

async function readKeywordTable(currentPage, group, period) {
  await openKeywordTab(currentPage);
  const collected = [];

  console.log(`\n=== [DEBUG] readKeywordTable ===`);
  console.log(`Group: ${group}, Period: ${period}`);
  console.log(`URL: ${currentPage.url()}`);
  
  const frames = await visibleFrames(currentPage);
  console.log(`Frames Count: ${frames.length}`);
  
  for (let i = 0; i < frames.length; i++) {
    const text = await frames[i].locator("body").innerText().catch(() => "");
    console.log(`Frame ${i} text length: ${text.length}`);
    console.log(`Frame ${i} text preview: ${text.slice(0, 500).replace(/\n/g, ' | ')}`);
  }
  
  let primaryFrame = frames[0];
  if (primaryFrame) {
    let loaded = await waitForTableRows(primaryFrame);
    if (!loaded) {
      console.log(`[DEBUG] Table not loaded for group ${group}. Reloading page...`);
      await currentPage.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await waitForRendered(currentPage);
      await openKeywordTab(currentPage);
      const newFrames = await visibleFrames(currentPage);
      primaryFrame = newFrames[0] || primaryFrame;
      await waitForTableRows(primaryFrame);
    }
  }
  
  const activeFrames = primaryFrame ? [primaryFrame] : frames;
  for (const frame of activeFrames) {
    let pageNum = 1;
    while (true) {
      console.log(`[DEBUG] Reading page ${pageNum} for group ${group}...`);
      const rows = await readRowsFromFrame(frame);
      if (!rows.length) {
        console.log(`[DEBUG] No rows found on page ${pageNum}`);
        break;
      }
      
      const parsed = parseKeywordRows(rows, group, period);
      console.log(`[DEBUG] Parsed ${parsed.length} keywords on page ${pageNum}`);
      collected.push(...parsed);
      
      const prevSig = getPageSignature(rows);
      const clicked = await clickNextPage(frame);
      if (!clicked) {
        console.log(`[DEBUG] No active next page button found. Stopping pagination loop.`);
        break;
      }
      
      pageNum++;
      
      // Wait for page content update
      let updated = false;
      const startTime = Date.now();
      while (Date.now() - startTime < 6000) {
        const nextRows = await readRowsFromFrame(frame);
        const nextSig = getPageSignature(nextRows);
        if (nextSig !== prevSig) {
          updated = true;
          break;
        }
        await currentPage.waitForTimeout(250);
      }
      
      if (!updated) {
        console.log(`[DEBUG] Page didn't update in 6s. Waiting 1s just in case.`);
        await currentPage.waitForTimeout(1000);
      }
    }
  }
  console.log(`[DEBUG] Completed group ${group}. Total raw keywords collected: ${collected.length}`);
  console.log(`=================================\n`);

  const unique = new Map();
  for (const row of collected) {
    const key = `${row.period}\u0000${row.group}\u0000${row.keyword}\u0000${row.impressions}`;
    if (!unique.has(key)) unique.set(key, row);
  }

  return [...unique.values()];
}

async function readGroups(currentPage, periodLabel, campaignUrl) {
  const raw = [];
  const errors = [];

  for (const group of targetGroups) {
    // Go back to the main campaign URL to see the list of all ad groups before clicking
    await currentPage.goto(campaignUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await waitForRendered(currentPage);

    const opened = await clickText(currentPage, group);
    if (!opened) {
      errors.push(`${periodLabel} / ${group}: 광고 그룹을 찾지 못했습니다.`);
      continue;
    }

    const rows = await readKeywordTable(currentPage, group, periodLabel);
    if (!rows.length) {
      errors.push(`${periodLabel} / ${group}: 키워드와 노출수 테이블을 찾지 못했습니다.`);
      continue;
    }

    raw.push(...rows);
  }

  return { raw, errors };
}

function aggregateRows(rawRows) {
  const byKeyword = new Map();

  for (const row of rawRows) {
    const key = row.keyword.replace(/\s+/g, " ").trim().toLowerCase();
    const previous = byKeyword.get(key) || { keyword: row.keyword, impressions: 0 };
    previous.impressions += row.impressions;
    byKeyword.set(key, previous);
  }

  const byImpressions = new Map();
  for (const row of byKeyword.values()) {
    const bucket = byImpressions.get(row.impressions) || [];
    bucket.push(row.keyword);
    byImpressions.set(row.impressions, bucket);
  }

  return [...byImpressions.entries()]
    .map(([impressions, keywords]) => ({
      impressions,
      keywords: keywords.sort((a, b) => a.localeCompare(b, "ko")).join(", "),
    }))
    .sort((a, b) => b.impressions - a.impressions || a.keywords.localeCompare(b.keywords, "ko"));
}

async function saveCsv(rows) {
  await fs.mkdir(exportDir, { recursive: true });
  const fileName = `naver-place-keywords-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  const filePath = path.join(exportDir, fileName);
  const lines = ["노출수,키워드"];

  for (const row of rows) {
    lines.push(`${row.impressions},"${row.keywords.replace(/"/g, '""')}"`);
  }

  await fs.writeFile(filePath, `\ufeff${lines.join("\r\n")}`, "utf8");
  return `/exports/${encodeURIComponent(fileName)}`;
}

async function extractByMonths(url, year, months) {
  if (busy) throw new Error("이미 추출 중입니다. 잠시 뒤 다시 시도해 주세요.");
  busy = true;

  try {
    const periods = validPeriods(year, months);
    const currentPage = await page();
    await currentPage.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await waitForRendered(currentPage);

    if (looksLikeLogin(currentPage)) {
      return { loginRequired: true, rows: [], message: "Chrome에서 네이버 로그인을 완료한 뒤 다시 추출해 주세요." };
    }

    const raw = [];
    const errors = [];

    for (const period of periods) {
      const periodLabel = await applyDateRange(currentPage, period);
      const result = await readGroups(currentPage, periodLabel, url);
      raw.push(...result.raw);
      errors.push(...result.errors);
    }

    const rows = aggregateRows(raw);
    return {
      loginRequired: false,
      rows,
      csvUrl: rows.length ? await saveCsv(rows) : "",
      errors,
      message: rows.length ? "노출 키워드 추출이 완료되었습니다." : "추출된 노출 키워드가 없습니다.",
    };
  } finally {
    busy = false;
  }
}

async function openLogin(url) {
  const currentPage = await page();
  await currentPage.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await waitForRendered(currentPage);
  return { message: "Chrome 창이 열렸습니다. 네이버 로그인을 완료한 뒤 추출을 다시 눌러 주세요." };
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, "http://localhost");
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;

  if (pathname.startsWith("/exports/")) {
    const fileName = path.basename(decodeURIComponent(pathname.slice("/exports/".length)));
    const filePath = path.join(exportDir, fileName);
    const body = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[".csv"],
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Length": body.length,
    });
    res.end(body);
    return;
  }

  const normalized = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, normalized);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Content-Length": body.length,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/status") {
      sendJson(res, 200, {
        ok: true,
        app: "naver-place-keyword-extractor",
        profile: activeProfileDir,
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/open-login") {
      const body = await readJson(req);
      const url = validateNaverUrl(body.url);
      const result = await openLogin(url);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (req.method === "POST" && req.url === "/api/extract") {
      const body = await readJson(req);
      const url = validateNaverUrl(body.url);
      const result = await extractByMonths(url, body.year, body.months);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { ok: false, error: "지원하지 않는 요청입니다." });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: publicError(error) || "처리 중 문제가 생겼습니다." });
  }
});

function listen(port) {
  server
    .listen(port, "127.0.0.1", () => {
      console.log(`Naver Place Keyword Extractor: http://127.0.0.1:${port}`);
    })
    .on("error", (error) => {
      if (error.code === "EADDRINUSE" && port < startPort + 20) {
        listen(port + 1);
        return;
      }
      throw error;
    });
}

listen(startPort);
