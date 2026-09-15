/**
 * Opens Foundry in headless Chromium, joins Kingmaker as GM if possible,
 * and waits for Hermes relay connection.
 */
import { chromium } from "playwright";

const FOUNDRY_URL = process.env.FOUNDRY_URL || "http://127.0.0.1:30000";
const RELAY_STATUS = process.env.RELAY_STATUS || "http://127.0.0.1:9998/status";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 120000);

async function waitForRelay() {
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    const res = await fetch(RELAY_STATUS);
    const data = await res.json();
    if (data.foundry_connected) return data;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Timed out waiting for Foundry relay connection");
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

page.on("console", (msg) => {
  if (msg.text().includes("hermes-bridge")) console.log("[browser]", msg.text());
});

console.log("Opening", FOUNDRY_URL);
await page.goto(FOUNDRY_URL, { waitUntil: "networkidle", timeout: 60000 });

// Setup / login flows vary; try common paths.
const joinBtn = page.locator('button:has-text("Join Game Session"), a:has-text("Join Game Session")');
if (await joinBtn.count()) {
  await joinBtn.first().click();
  await page.waitForTimeout(2000);
}

const world = page.locator('a:has-text("Kingmaker"), .world-name:has-text("kingmaker")');
if (await world.count()) {
  await world.first().click();
  await page.waitForTimeout(3000);
}

const launch = page.locator('button:has-text("Launch World"), button:has-text("Join World")');
if (await launch.count()) {
  await launch.first().click();
}

console.log("Waiting for relay connection...");
const status = await waitForRelay();
console.log("Relay connected:", JSON.stringify(status, null, 2));

await browser.close();
