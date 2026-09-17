import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 2 });
for (const [lat, lon, zoom, name] of [
  [24.1380, 120.6860, 16, "dup-a"],
  [24.1740, 120.6340, 15, "dup-b"],
]) {
  await page.goto(`http://localhost:3000/?lat=${lat}&lon=${lon}&zoom=${zoom}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".route-item", { timeout: 60000 });
  await page.getByLabel("只顯示目前選擇路線").uncheck();
  await page.waitForFunction(() => /已顯示合併路網/.test(document.body.textContent ?? ""), null, { timeout: 240000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `/tmp/opencode/${name}.png` });
  console.log("saved", name);
}
await browser.close();
