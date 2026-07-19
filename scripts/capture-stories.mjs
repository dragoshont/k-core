import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.STORYBOOK_URL ?? "http://127.0.0.1:6006";
const outputDir = "artifacts/screenshots";
const stories = [
  { id: "pages--search", name: "search-iphone", width: 390, height: 844 },
  { id: "pages--unlock", name: "unlock-iphone", width: 390, height: 844 },
  { id: "pages--delivery-preflight-page", name: "preflight-iphone", width: 390, height: 844 },
  { id: "pages--operation-detail", name: "operation-iphone", width: 390, height: 844 },
  { id: "pages--profile", name: "profile-iphone", width: 390, height: 844 },
  { id: "pages--search", name: "search-320", width: 320, height: 568 },
  { id: "pages--profile", name: "profile-zoom-200", width: 390, height: 844, zoom: 2 },
  { id: "pages--search-e-reader", name: "search-ereader", width: 600, height: 800 },
  { id: "pages--operation-detail-e-reader", name: "operation-ereader", width: 600, height: 800 },
  { id: "catalog--item-detail-with-metadata", name: "metadata-provider-320", width: 320, height: 568 },
  { id: "profile--accounts-connected", name: "accounts-connected-iphone", width: 390, height: 844 },
  { id: "profile--account-disconnect-review-story", name: "account-disconnect-zoom-200", width: 390, height: 844, zoom: 2 },
  { id: "delivery--one-drive-ready", name: "onedrive-preflight-iphone", width: 390, height: 844 },
  { id: "operations--gmail-submitted", name: "gmail-submitted-iphone", width: 390, height: 844 },
  { id: "operations--one-drive-saved", name: "onedrive-saved-iphone", width: 390, height: 844 },
  { id: "operations--one-drive-unknown", name: "onedrive-unknown-320", width: 320, height: 568 },
];
const pageStoryIds = [
  "pages--unlock", "pages--setup", "pages--search", "pages--book-detail-page",
  "pages--delivery-preflight-page", "pages--recent-authentication",
  "pages--activity-empty", "pages--activity-list-page", "pages--operation-detail",
  "pages--profile", "pages--search-e-reader", "pages--operation-detail-e-reader",
];

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch();
try {
  for (const story of stories) {
    const page = await browser.newPage({ viewport: { width: story.width, height: story.height }, deviceScaleFactor: 1 });
    const consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.goto(`${baseUrl}/iframe.html?id=${story.id}&viewMode=story`, { waitUntil: "networkidle" });
    await page.locator("#storybook-root").waitFor({ state: "visible" });
    if (story.zoom) await page.evaluate((zoom) => { document.documentElement.style.zoom = String(zoom); }, story.zoom);
    await page.screenshot({ path: `${outputDir}/${story.name}.png`, fullPage: true });
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    if (bodyWidth > story.width + 1) throw new Error(`${story.id} overflows horizontally: ${bodyWidth}px > ${story.width}px`);
    if (consoleErrors.length) throw new Error(`${story.id} console errors:\n${consoleErrors.join("\n")}`);
    await page.close();
    console.log(`Captured ${story.name}.png (${story.width}x${story.height}${story.zoom ? ` at ${story.zoom * 100}% zoom` : ""})`);
  }
  const titlePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  for (const storyId of pageStoryIds) {
    await titlePage.goto(`${baseUrl}/iframe.html?id=${storyId}&viewMode=story`, { waitUntil: "networkidle" });
    const title = await titlePage.title();
    if (!title.endsWith(" · k") || title.startsWith("Storybook")) throw new Error(`${storyId} has no descriptive document title: ${title}`);
  }
  await titlePage.close();
  console.log(`Verified descriptive document titles for ${pageStoryIds.length} page compositions`);
} finally {
  await browser.close();
}