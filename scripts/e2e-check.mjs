/**
 * 端到端檢查（Phase 2〜6）
 *
 * 前置：npm run dev 需先啟動（預設 http://localhost:3000）
 * 執行：node scripts/e2e-check.mjs
 *
 * 驗證內容：
 *   1. 地圖與路線清單載入（Leaflet + OSM + TDX）
 *   2. 選擇 300 路去程後顯示官方 Shape 與站牌
 *   3. 標記部分區間後：同路線同時有紅（未走過）與綠（已走過）
 *   4. 切換到 301 路（同樣行經台灣大道）：重疊路段自動顯示綠色
 *   5. 重新整理後搭乘紀錄仍存在（IndexedDB）
 */

import { chromium } from "playwright";

const BASE = process.env.TCBUS_BASE_URL ?? "http://localhost:3000";
const SHOT_DIR = process.env.SHOT_DIR ?? "/tmp/opencode";

function log(step, message) {
  console.log(`[${step}] ${message}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`檢查失敗：${message}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const consoleErrors = [];
page.on("pageerror", (error) => consoleErrors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});

const countPaths = (color) =>
  page.evaluate(
    (hex) =>
      [...document.querySelectorAll("path")].filter(
        (path) => (path.getAttribute("stroke") ?? "").toLowerCase() === hex,
      ).length,
    color,
  );

try {
  // ---------- 1. 載入頁面 ----------
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".route-item", { timeout: 60_000 });
  const routeItems = await page.locator(".route-item").count();
  log("1", `頁面載入，路線清單 ${routeItems} 筆`);
  assert(routeItems > 600, `路線清單應一次顯示全部（扣掉黃X 後實際 ${routeItems} 筆）`);
  await page.waitForSelector(".leaflet-container", { timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelectorAll(".leaflet-tile").length > 0,
    null,
    { timeout: 30_000 },
  );
  // 初始視角應在台中（縮放 11〜13），不是全世界
  const initialZoom = await page.evaluate(() => {
    const tile = document.querySelector(".leaflet-tile");
    const match = tile?.getAttribute("src")?.match(/\/(\d+)\/\d+\/\d+\.png/);
    return match ? Number(match[1]) : null;
  });
  log("1", `Leaflet 地圖已建立，初始縮放 z=${initialZoom}`);
  assert(
    initialZoom !== null && initialZoom >= 10 && initialZoom <= 14,
    `初始視角應在台中地區（z=10〜14），實際 z=${initialZoom}`,
  );

  // ---------- 2. 選擇 300 路去程 ----------
  await page.fill(".search-input", "300");
  await page.waitForTimeout(300);
  const route300 = page
    .locator(".route-item", { hasText: "靜宜大學－臺中車站" })
    .filter({ hasText: "去程" })
    .first();
  await route300.click();

  await page.waitForFunction(
    () => {
      const selects = document.querySelectorAll(".panel select");
      return selects.length >= 2 && selects[0].options.length > 5;
    },
    null,
    { timeout: 120_000 },
  );
  const stopCount = await page.evaluate(
    () => document.querySelectorAll(".panel select")[0].options.length,
  );
  const redBefore = await countPaths("#dc2626");
  const greenBefore = await countPaths("#16a34a");
  log("2", `300 路載入：站牌 ${stopCount} 站、紅色線段 ${redBefore}、綠色線段 ${greenBefore}`);
  assert(stopCount > 5, "應載入站牌");
  assert(redBefore > 0, "初始應顯示紅色（尚未走過）線段");
  assert(greenBefore === 0, "初始不應有綠色線段");
  await page.screenshot({ path: `${SHOT_DIR}/e2e-1-route300.png` });

  // 點擊路線線段應顯示路線名稱
  await page.evaluate(() => {
    const path = [...document.querySelectorAll("path")].find(
      (element) => (element.getAttribute("stroke") ?? "").toLowerCase() === "#dc2626",
    );
    path?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  });
  await page.waitForSelector(".leaflet-popup-content", { timeout: 10_000 });
  const popupText = await page.locator(".leaflet-popup-content").first().textContent();
  log("2", `點擊線段彈出：${popupText?.trim()}`);
  assert(popupText?.includes("300"), "點擊路線應顯示路線名稱");
  await page.keyboard.press("Escape");

  // ---------- 3. 標記部分區間 ----------
  const selects = page.locator(".panel select");
  await selects.nth(0).selectOption({ index: 0 });
  await selects.nth(1).selectOption({ index: 2 });
  await page.waitForTimeout(200);

  const sliceText = await page
    .locator(".panel p", { hasText: "選取區間" })
    .first()
    .textContent();
  await page.getByRole("button", { name: "標記這段已搭乘" }).click();
  await page.waitForSelector(".message.success", { timeout: 30_000 });
  await page.waitForTimeout(1000);

  const redAfter = await countPaths("#dc2626");
  const greenAfter = await countPaths("#16a34a");
  log(
    "3",
    `標記前 3 站後：紅色 ${redAfter}、綠色 ${greenAfter}（${sliceText?.trim() ?? ""}）`,
  );
  assert(greenAfter > 0, "標記後應出現綠色線段");
  assert(redAfter > 0, "同路線未走過部分應保持紅色");
  const recordCount = await page.locator(".record-list li").count();
  assert(recordCount === 1, `搭乘紀錄應為 1 筆，實際 ${recordCount}`);
  await page.screenshot({ path: `${SHOT_DIR}/e2e-2-partial.png` });

  // ---------- 4. 不同路線的重疊路段 ----------
  await page.fill(".search-input", "301");
  await page.waitForTimeout(300);
  const route301 = page
    .locator(".route-item", { hasText: "靜宜大學－新光里" })
    .filter({ hasText: "去程" })
    .first();
  await route301.click();
  await page.waitForFunction(
    () => {
      const headings = [...document.querySelectorAll(".panel-section h2")];
      const selects = document.querySelectorAll(".panel select");
      return (
        headings.some((heading) => heading.textContent?.includes("301")) &&
        selects.length >= 2 &&
        selects[0].options.length > 5
      );
    },
    null,
    { timeout: 120_000 },
  );
  await page.waitForTimeout(1200);

  const green301 = await countPaths("#16a34a");
  const red301 = await countPaths("#dc2626");
  log("4", `切換到 301 路：綠色 ${green301}、紅色 ${red301}（未標記 301）`);
  assert(green301 > 0, "301 與 300 重疊的路段應自動顯示綠色");
  await page.screenshot({ path: `${SHOT_DIR}/e2e-3-overlap.png` });

  // ---------- 5. 重新整理後資料仍在 ----------
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".record-list li", { timeout: 60_000 });
  const recordsAfterReload = await page.locator(".record-list li").count();
  log("5", `重新整理後搭乘紀錄 ${recordsAfterReload} 筆（IndexedDB 持久化）`);
  assert(recordsAfterReload === 1, "重新整理後紀錄應保留");

  // ---------- 6. 匯出個人資料 ----------
  const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
  await page.getByRole("button", { name: "匯出個人資料 JSON" }).click();
  const download = await downloadPromise;
  const exportPath = `${SHOT_DIR}/${download.suggestedFilename()}`;
  await download.saveAs(exportPath);
  log("6", `已匯出 ${download.suggestedFilename()}`);

  // ---------- 7. 清除所有個人紀錄 ----------
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "清除所有個人紀錄" }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".record-list li").length === 0,
    null,
    { timeout: 15_000 },
  );
  log("7", "已清除所有搭乘紀錄");

  // ---------- 8. 匯入個人資料 ----------
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('input[type="file"]').setInputFiles(exportPath);
  await page.waitForFunction(
    () => document.querySelectorAll(".record-list li").length === 1,
    null,
    { timeout: 15_000 },
  );
  log("8", "已匯入 1 筆搭乘紀錄");

  // ---------- 9. 匯入後地圖再次顯示已走過路段 ----------
  await page.fill(".search-input", "300");
  await page.waitForTimeout(300);
  await page
    .locator(".route-item", { hasText: "靜宜大學－臺中車站" })
    .filter({ hasText: "去程" })
    .first()
    .click();
  await page.waitForFunction(
    () => {
      const selects = document.querySelectorAll(".panel select");
      return selects.length >= 2 && selects[0].options.length > 5;
    },
    null,
    { timeout: 120_000 },
  );
  await page.waitForTimeout(1000);
  const greenAfterImport = await countPaths("#16a34a");
  log("9", `匯入後重選 300 路：綠色線段 ${greenAfterImport}`);
  assert(greenAfterImport > 0, "匯入後應恢復已走過路段");

  // ---------- 10. 全部路線總覽（取消「只顯示目前選擇路線」） ----------
  await page.getByLabel("只顯示目前選擇路線").uncheck();
  await page.waitForSelector(".map-overlay", { timeout: 30_000 }).catch(() => {});
  await page.waitForFunction(
    () => /已顯示合併路網（涵蓋 \d+ 條路線）/.test(document.body.textContent ?? ""),
    null,
    { timeout: 240_000 },
  );
  const readNetworkCount = async () => {
    const text = await page
      .locator(".panel p", { hasText: "已顯示合併路網" })
      .first()
      .textContent();
    return Number(text?.match(/涵蓋 (\d+) 條路線/)?.[1] ?? 0);
  };

  const outboundCount = await readNetworkCount();
  const canvasCount = await page.evaluate(
    () => document.querySelectorAll(".leaflet-overlay-pane canvas").length,
  );
  log("10", `合併路網（去程）：涵蓋 ${outboundCount} 條路線；Canvas 圖層 ${canvasCount}`);
  assert(canvasCount > 0, "路網應使用 Canvas 渲染");
  assert(
    outboundCount > 300 && outboundCount < 500,
    `去程涵蓋路線數應介於 300〜500，實際 ${outboundCount}`,
  );
  await page.screenshot({ path: `${SHOT_DIR}/e2e-4-all-routes.png` });

  // 點擊路網應顯示行經路線
  let networkPopupText = null;
  for (const position of [{ x: 900, y: 450 }, { x: 750, y: 500 }, { x: 1050, y: 380 }]) {
    await page.mouse.click(position.x, position.y);
    await page.waitForTimeout(600);
    const popup = page.locator(".leaflet-popup-content").first();
    if (await popup.count()) {
      networkPopupText = await popup.textContent();
      break;
    }
  }
  log("10", `點擊路網彈出：${networkPopupText?.trim().replace(/\s+/g, " ").slice(0, 60) ?? "(未命中)"}`);
  assert(
    networkPopupText?.includes("行經路線") || networkPopupText?.includes("路段"),
    "點擊路網應顯示路段與行經路線",
  );
  await page.keyboard.press("Escape");

  // 方向切換：返程
  const dirSection = page.locator(".panel-section", { hasText: "全部路線方向" });
  await dirSection.getByRole("button", { name: "返程" }).click();
  await page.waitForFunction(
    () => {
      const buttons = [...document.querySelectorAll(".panel-section button")];
      return buttons.some(
        (button) => button.textContent?.trim() === "返程" && button.className.includes("active"),
      );
    },
    null,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(2500);
  const inboundCount = await readNetworkCount();
  log("10", `合併路網（返程）：涵蓋 ${inboundCount} 條路線`);
  assert(inboundCount > 300 && inboundCount < 500, `返程路線數異常：${inboundCount}`);

  // 顯示黃X：清單筆數應增加
  await page.fill(".search-input", "");
  await page.waitForFunction(() => document.querySelectorAll(".route-item").length > 600, null, {
    timeout: 15_000,
  });
  const beforeHuang = await page.locator(".route-item").count();
  await page.getByLabel("顯示黃X 小黃公車").check();
  await page.waitForFunction(
    (previous) => document.querySelectorAll(".route-item").length > previous,
    beforeHuang,
    { timeout: 15_000 },
  );
  const afterHuang = await page.locator(".route-item").count();
  log("10", `顯示黃X：路線清單 ${beforeHuang} → ${afterHuang} 筆`);
  assert(afterHuang > beforeHuang, "勾選顯示黃X 後清單應變多");
  await page.getByLabel("顯示黃X 小黃公車").uncheck();

  // 業者篩選：清單筆數應減少
  const beforeOperator = await page.locator(".route-item").count();
  const operatorSelect = page.locator(".panel-section", { hasText: "公車業者" }).locator("select");
  const operatorOptions = await operatorSelect.locator("option").count();
  await operatorSelect.selectOption({ index: 1 });
  await page.waitForFunction(
    (previous) => document.querySelectorAll(".route-item").length < previous,
    beforeOperator,
    { timeout: 15_000 },
  );
  const afterOperator = await page.locator(".route-item").count();
  log("10", `業者篩選：${operatorOptions - 1} 家可選；清單 ${beforeOperator} → ${afterOperator} 筆`);
  assert(afterOperator < beforeOperator, "選擇業者後清單應變少");
  await operatorSelect.selectOption({ index: 0 });

  // 全部路線 + 隱藏已走過路段
  await page.getByLabel("隱藏已走過路段").check();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOT_DIR}/e2e-5-all-unexplored.png` });

  // 切回單一路線模式
  await page.getByLabel("隱藏已走過路段").uncheck();
  await page.getByLabel("只顯示目前選擇路線").check();
  await page.waitForTimeout(500);

  // ---------- 11. 左側選單收合 ----------
  await page.getByRole("button", { name: "‹ 收起選單" }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".panel").length === 0,
    null,
    { timeout: 10_000 },
  );
  log("11", "已收起左側選單");
  await page.getByRole("button", { name: "☰ 顯示選單" }).click();
  await page.waitForSelector(".panel", { timeout: 10_000 });
  log("11", "已展開左側選單");

  // ---------- 錯誤檢查 ----------
  const meaningfulErrors = consoleErrors.filter(
    (text) =>
      !text.includes("tile.openstreetmap.org") &&
      !text.includes("net::ERR") &&
      !text.includes("Failed to load resource"),
  );
  if (meaningfulErrors.length > 0) {
    console.error("瀏覽器 console 錯誤：");
    for (const error of meaningfulErrors) console.error("  -", error);
    process.exitCode = 1;
  } else {
    log("✓", "瀏覽器無 JavaScript 錯誤");
  }

  console.log("\n端到端檢查全部通過");
} catch (error) {
  console.error("\n端到端檢查失敗：", error.message);
  await page.screenshot({ path: `${SHOT_DIR}/e2e-failure.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
