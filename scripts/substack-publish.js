/**
 * substack-publish.js — Playwright automation for Substack newsletter posts
 *
 * Reuses saved session cookies when available (SUBSTACK_COOKIES env var).
 * Falls back to email+password login if cookies are expired.
 * Saves updated cookies to ./substack-cookies.json for the next run.
 */

import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIES_FILE = join(__dirname, 'substack-cookies.json');

const SUBSTACK_EMAIL = process.env.SUBSTACK_EMAIL;
const SUBSTACK_PASSWORD = process.env.SUBSTACK_PASSWORD;
const SUBSTACK_URL = process.env.SUBSTACK_URL; // e.g. aidigitalcrew.substack.com
const SUBSTACK_COOKIES = process.env.SUBSTACK_COOKIES; // JSON string of saved cookies

/**
 * Load cookies from env (preferred) or local file (dev fallback).
 */
function loadCookies() {
  if (SUBSTACK_COOKIES && SUBSTACK_COOKIES.trim().startsWith('[')) {
    try {
      return JSON.parse(SUBSTACK_COOKIES);
    } catch {
      console.warn('Failed to parse SUBSTACK_COOKIES env var');
    }
  }
  if (existsSync(COOKIES_FILE)) {
    try {
      return JSON.parse(readFileSync(COOKIES_FILE, 'utf8'));
    } catch {
      console.warn('Failed to read local cookies file');
    }
  }
  return null;
}

/**
 * Persist cookies to a local file (GitHub Actions artifact on failure, or
 * piped back to the secret via the workflow).
 */
function saveCookies(cookies) {
  writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
  console.log(`Saved ${cookies.length} cookies to ${COOKIES_FILE}`);
}

/**
 * Check if we are logged in by looking for the "New post" button or user avatar.
 */
async function isLoggedIn(page) {
  try {
    await page.goto('https://substack.com', { waitUntil: 'networkidle', timeout: 20000 });
    // If the "Sign in" button is absent, we are logged in
    const signInBtn = page.locator('a:has-text("Sign in"), button:has-text("Sign in")');
    const count = await signInBtn.count();
    return count === 0;
  } catch {
    return false;
  }
}

/**
 * Login with email + password.
 */
async function loginWithCredentials(page) {
  if (!SUBSTACK_EMAIL || !SUBSTACK_PASSWORD) {
    throw new Error('SUBSTACK_EMAIL and SUBSTACK_PASSWORD are required when cookies are expired');
  }
  console.log('Logging in with credentials...');
  await page.goto('https://substack.com/sign-in', { waitUntil: 'domcontentloaded', timeout: 60000 });

  await page.fill('input[name="email"], input[type="email"]', SUBSTACK_EMAIL);
  await page.click('button[type="submit"], button:has-text("Continue")');

  // Wait for password field (Substack uses a two-step login)
  await page.waitForSelector('input[type="password"]', { timeout: 15000 });
  await page.fill('input[type="password"]', SUBSTACK_PASSWORD);
  await page.click('button[type="submit"], button:has-text("Sign in")');

  // Wait for navigation after login
  await page.waitForURL(url => !url.includes('sign-in'), { timeout: 20000 });
  console.log('Login successful');
}

/**
 * Build the post body as plain text for Substack's Tiptap editor.
 * Pastes content via keyboard to avoid clipboard API restrictions.
 */
function buildPostBody(writeup, quickStart, repoUrl, repoFullName) {
  const steps = quickStart.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return [
    writeup,
    '',
    '--- Quick Start ---',
    '',
    steps,
    '',
    `View on GitHub: ${repoUrl}`,
    '',
    '—',
    'Auto-discovered by AI Digital Crew • aidigitalcrew.com',
  ].join('\n');
}

/**
 * Main export: publish one "Project of the Day" post.
 */
export async function publishToSubstack({ repoMeta, writeup, quickStart }) {
  if (!SUBSTACK_URL) {
    console.warn('SUBSTACK_URL not set — skipping Substack publish');
    return;
  }

  const pub = SUBSTACK_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const newPostUrl = `https://${pub}/publish/post`;
  const title = `🤖 Project of the Day: ${repoMeta.name}`;
  const body = buildPostBody(writeup, quickStart, repoMeta.html_url, repoMeta.full_name);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  try {
    // Try to restore session from saved cookies
    const savedCookies = loadCookies();
    if (savedCookies) {
      console.log(`Restoring ${savedCookies.length} saved cookies`);
      await context.addCookies(savedCookies);
    }

    const page = await context.newPage();

    // Check login status; fall back to credential login if needed
    const loggedIn = await isLoggedIn(page);
    if (!loggedIn) {
      await loginWithCredentials(page);
    } else {
      console.log('Session restored from cookies');
    }

    // Navigate to new post editor
    console.log(`Navigating to ${newPostUrl}`);
    await page.goto(newPostUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Fill title
    const titleSel = '[data-testid="post-title-input"], h1.post-title, [placeholder*="Title"]';
    await page.waitForSelector(titleSel, { timeout: 15000 });
    await page.click(titleSel);
    await page.keyboard.type(title, { delay: 20 });

    // Fill body via Tiptap editor
    const editorSel = '.tiptap, [contenteditable="true"].ProseMirror, div[contenteditable="true"]';
    await page.waitForSelector(editorSel, { timeout: 15000 });
    await page.click(editorSel);

    // Use clipboard paste for reliable Tiptap insertion
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(text => navigator.clipboard.writeText(text), body);
    await page.keyboard.press('Control+v');

    // Give the editor a moment to process the paste
    await page.waitForTimeout(1500);

    // Take a screenshot before publishing (useful for debugging)
    await page.screenshot({ path: join(__dirname, 'pre-publish.png') });

    // Click Publish
    console.log('Clicking Publish...');
    const publishBtn = page.locator('button:has-text("Publish"), button:has-text("Publish post")');
    await publishBtn.first().click();

    // Confirm "Publish & email" in the modal that appears
    const confirmBtn = page.locator(
      'button:has-text("Publish & email"), button:has-text("Publish now")'
    );
    await confirmBtn.first().waitFor({ timeout: 10000 });
    await confirmBtn.first().click();

    console.log('Post published successfully');
    await page.waitForTimeout(2000);

    // Save updated cookies for next run
    const updatedCookies = await context.cookies();
    saveCookies(updatedCookies);
  } catch (err) {
    // Capture failure screenshot
    try {
      const page = context.pages()[0];
      if (page) {
        await page.screenshot({ path: join(__dirname, 'failure.png') });
        console.error('Screenshot saved to failure.png');
      }
    } catch {}
    throw err;
  } finally {
    await browser.close();
  }
}
