import { chromium, expect, test as base, type BrowserContext, type Locator, type Page, type Worker } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ITEM_CAP, MAX_BODY_CHARS } from "../src/config";
import { startMock, type Mock } from "./mock";

declare const chrome: any;

const DIST = join(import.meta.dirname, "..", "dist");
const REDDIT = "https://www.reddit.com";

// Loads the built extension into a fresh browser profile, with www.reddit.com and
// api.typesafe.ai both resolved to the local mock server.
const test = base.extend<{ apiKey: string; recording: boolean; mock: Mock; context: BrowserContext; worker: Worker; page: Page }>({
  apiKey: ["test-key", { option: true }],
  recording: [false, { option: true }],
  mock: async ({}, use) => {
    const mock = await startMock();
    await use(mock);
    await mock.close();
  },
  context: async ({ mock }, use) => {
    const profile = mkdtempSync(join(tmpdir(), "rp-profile-"));
    const context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      viewport: { width: 1280, height: 4000 },
      args: [
        `--disable-extensions-except=${DIST}`,
        `--load-extension=${DIST}`,
        `--host-resolver-rules=MAP www.reddit.com 127.0.0.1:${mock.port}, MAP api.typesafe.ai 127.0.0.1:${mock.port}`,
        "--ignore-certificate-errors",
      ],
    });
    await use(context);
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  },
  worker: async ({ context }, use) => {
    await use(context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker")));
  },
  page: async ({ context, worker, apiKey, recording }, use) => {
    if (apiKey) await worker.evaluate((key) => chrome.storage.local.set({ apiKey: key }), apiKey);
    if (recording) await worker.evaluate(() => chrome.storage.local.set({ recording: true }));
    await use(await context.newPage());
  },
});

const postFrame = (page: Page, id: string) => page.locator(`#t3_${id} > .rp-frame.rp-labelled`);
const commentFrame = (page: Page, id: string) => page.locator(`shreddit-comment[thingid="t1_${id}"] > .rp-frame.rp-labelled`);
const tagsOf = (frame: Locator) => frame.locator(".rp-tag").allTextContents();

// Waits until every request has been answered and no item is still showing the scan line.
async function settled(page: Page, mock: Mock, calls: number) {
  await expect.poll(() => mock.calls.length).toBe(calls);
  await expect(page.locator(".rp-scanning")).toHaveCount(0);
}

for (const [name, path] of [["home feed", "/"], ["subreddit page", "/r/test/"]]) {
  test(`${name}: highlights positives, leaves negatives alone, skips promoted posts`, async ({ page, mock, context, worker }) => {
    await page.goto(REDDIT + path);
    await settled(page, mock, 6);

    expect(await tagsOf(postFrame(page, "ask"))).toEqual(["ASKING FOR PRODUCT"]);
    expect(await tagsOf(postFrame(page, "pain"))).toEqual(["PAIN"]);
    expect(await tagsOf(postFrame(page, "both"))).toEqual(["ASKING FOR PRODUCT", "PAIN"]);
    // A noul of exactly 0.5 counts.
    expect(await tagsOf(postFrame(page, "edge"))).toEqual(["ASKING FOR PRODUCT"]);
    await expect(postFrame(page, "pain").locator(".rp-chip")).toHaveText("pain intensity: costing them real time or money · 2.2/3");

    // Negative answers leave no trace on the page.
    await expect(page.locator("#t3_neg .rp-frame")).toHaveCount(0);
    await expect(page.locator("#t3_long .rp-frame")).toHaveCount(0);
    await expect(page.locator("#rp-status")).toHaveCount(0);

    // The promoted post was neither sent nor boxed.
    expect(mock.calls.map((c) => c.title)).not.toContain("Cash back season");
    await expect(page.locator("shreddit-ad-post .rp-frame")).toHaveCount(0);

    // Once the lock-on animation is over, the box covers the post exactly and does not take clicks.
    await expect(page.locator(".rp-enter")).toHaveCount(0);
    const post = (await page.locator("#t3_ask").boundingBox())!;
    const box = (await postFrame(page, "ask").boundingBox())!;
    for (const side of ["x", "y", "width", "height"] as const) expect(box[side]).toBeCloseTo(post[side], 0);
    expect(await postFrame(page, "ask").evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");

    // Each call carries the subreddit, title and body; a long body is cut and the record says so.
    expect(mock.calls.find((c) => c.title.includes("overdue invoices"))).toEqual({
      subreddit: "test",
      title: "Is there an app that tracks overdue invoices?",
      body: "Looking for a recommendation, happy to pay.",
    });
    expect(mock.calls.find((c) => c.title === "Long story about my week")!.body).toHaveLength(MAX_BODY_CHARS);
    const options = await context.newPage();
    await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
    await expect(options.locator("#log tr", { hasText: "Long story about my week" })).toContainText("[cut]");
    await expect(options.locator("#log tr")).toHaveCount(6);
  });
}

test("reload reuses stored labels: no second Jev call, no second lock-on animation", async ({ page, mock }) => {
  await page.goto(`${REDDIT}/r/test/`);
  // The lock-on animation plays on first labelling, then its class is removed.
  await expect(postFrame(page, "ask")).toHaveClass(/rp-enter/);
  await settled(page, mock, 6);
  await expect(postFrame(page, "ask")).not.toHaveClass(/rp-enter/);

  await page.reload();
  await expect(postFrame(page, "ask")).toBeVisible();
  await expect(postFrame(page, "both")).toBeVisible();
  await expect(page.locator(".rp-scanning")).toHaveCount(0);
  await expect(page.locator(".rp-enter")).toHaveCount(0);
  await expect(page.locator("#t3_neg .rp-frame")).toHaveCount(0);
  expect(mock.attempts).toBe(6);
});

test("post page: labels the post and each comment's own text", async ({ page, mock }) => {
  await page.goto(`${REDDIT}/r/test/comments/pdp/slug/`);
  // The post, and comments c1, c2 and c4. The removed comment c3 has no text and is not sent.
  await settled(page, mock, 4);

  expect(await tagsOf(postFrame(page, "pdp"))).toEqual(["ASKING FOR PRODUCT"]);
  expect(await tagsOf(commentFrame(page, "c1"))).toEqual(["PAIN"]);
  expect(await tagsOf(commentFrame(page, "c4"))).toEqual(["ASKING FOR PRODUCT"]);
  await expect(page.locator('shreddit-comment[thingid="t1_c2"] > .rp-frame')).toHaveCount(0);
  await expect(page.locator('shreddit-comment[thingid="t1_c3"] > .rp-frame')).toHaveCount(0);

  // A comment is sent with its post's title and subreddit, and only its own text.
  expect(mock.calls.find((c) => c.body.includes("spreadsheet"))).toEqual({
    subreddit: "test",
    title: "How do you all track client feedback?",
    body: "I paste everything into a spreadsheet and it is a mess, it costs me hours every week.",
  });

  // The post is position: static on this page; the box still covers it exactly.
  await expect(page.locator(".rp-enter")).toHaveCount(0);
  const post = (await page.locator("#t3_pdp").boundingBox())!;
  const postBox = (await postFrame(page, "pdp").boundingBox())!;
  for (const side of ["x", "y", "width", "height"] as const) expect(postBox[side]).toBeCloseTo(post[side], 0);

  // The box around c1 stops above its replies.
  const c1 = (await page.locator('shreddit-comment[thingid="t1_c1"]').boundingBox())!;
  const c2 = (await page.locator('shreddit-comment[thingid="t1_c2"]').boundingBox())!;
  const box = (await commentFrame(page, "c1").boundingBox())!;
  expect(box.y).toBeCloseTo(c1.y - 6, 0);
  expect(box.y + box.height).toBeLessThanOrEqual(c2.y);
  expect(box.height).toBeLessThan(c1.height);
});

test("failed Jev call: error box, a pause, then recovery", async ({ page, mock }) => {
  test.setTimeout(60_000);
  mock.failWith = 529;
  await page.goto(`${REDDIT}/r/test/`);

  await expect(page.locator("#rp-status")).toContainText("Jev is overloaded (HTTP 529)");
  await expect(page.locator(".rp-frame")).toHaveCount(0);
  expect(mock.calls).toHaveLength(0);

  // Nothing is sent during the pause.
  const attempts = mock.attempts;
  await page.waitForTimeout(3000);
  expect(mock.attempts).toBe(attempts);

  // Once Jev works again the items on screen are labelled and the box goes away.
  mock.failWith = 0;
  await expect(postFrame(page, "ask")).toBeVisible({ timeout: 20_000 });
  await settled(page, mock, 6);
  await expect(page.locator("#rp-status")).toHaveCount(0);
});

test.describe("without an API key", () => {
  test.use({ apiKey: "" });
  test("shows the error box and calls nothing", async ({ page, mock }) => {
    await page.goto(`${REDDIT}/r/test/`);
    await expect(page.locator("#rp-status")).toContainText("No TypeSafe API key set.");
    await expect(page.locator("#rp-status button")).toHaveText("Open settings");
    expect(mock.attempts).toBe(0);
  });
});

test("smoke-test cap: Jev is not called for more items than the cap", async ({ page, mock }) => {
  test.skip(ITEM_CAP === null, "the cap is removed");
  await page.goto(`${REDDIT}/r/many/`);
  await settled(page, mock, ITEM_CAP!);
  await page.waitForTimeout(1500);
  expect(mock.attempts).toBe(ITEM_CAP);
  await expect(page.locator("#rp-status")).toHaveCount(0);
});

test.describe("recording mode", () => {
  test.use({ recording: true });

  test("counts hits, dims misses, and draws the meter and corner brackets", async ({ page, mock }) => {
    await page.goto(`${REDDIT}/r/test/`);
    await settled(page, mock, 6);
    await expect(page.locator("html")).toHaveClass(/rp-recording/);

    // Three posts ask for a product and two describe a pain; one post does both.
    await expect(postFrame(page, "edge")).toBeVisible();
    await expect(page.locator("#rp-counter .rp-count-asks b")).toHaveText("3");
    await expect(page.locator("#rp-counter .rp-count-pain b")).toHaveText("2");

    // Misses and the promoted post are dimmed; hits are not. The promoted post is still not sent.
    await expect(page.locator("#t3_neg")).toHaveCSS("opacity", "0.3");
    await expect(page.locator("#t3_long")).toHaveCSS("opacity", "0.3");
    await expect(page.locator("#t3_ask")).toHaveCSS("opacity", "1");
    await expect(page.locator("shreddit-ad-post")).toHaveCSS("opacity", "0.3");
    expect(mock.calls.map((c) => c.title)).not.toContain("Cash back season");

    // The counter sits inside the 56px header strip.
    const counter = (await page.locator("#rp-counter").boundingBox())!;
    expect(counter.y).toBeGreaterThanOrEqual(0);
    expect(counter.y + counter.height).toBeLessThanOrEqual(56);

    // An intensity of 2.2 is the third level of four, and 2.7 rounds up to the top one.
    const chip = postFrame(page, "pain").locator(".rp-chip");
    await expect(chip).toHaveAttribute("data-label", "COSTLY");
    await expect(chip.locator(".rp-meter i.rp-on")).toHaveCount(3);
    await expect(chip.locator(".rp-meter")).toBeVisible();
    await expect(chip.locator(".rp-chip-text")).toBeHidden();
    await expect(postFrame(page, "both").locator(".rp-chip")).toHaveAttribute("data-label", "URGENT");
    await expect(postFrame(page, "both").locator(".rp-meter i.rp-on")).toHaveCount(4);

    await expect(postFrame(page, "ask").locator(".rp-corners")).toBeVisible();
    expect(await postFrame(page, "ask").evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("4px");
  });

  test("reload replays the scan and lock-on for stored labels, with no second Jev call", async ({ page, mock }) => {
    await page.goto(`${REDDIT}/r/test/`);
    await settled(page, mock, 6);
    await expect(postFrame(page, "ask")).toBeVisible();
    await expect(page.locator(".rp-enter")).toHaveCount(0);

    await page.reload();
    await expect(page.locator("#t3_ask > .rp-frame.rp-scanning")).toHaveCount(1);
    await expect(postFrame(page, "ask")).toHaveClass(/rp-enter/);
    await expect(page.locator("#rp-counter .rp-count-asks b")).toHaveText("3");
    await expect(page.locator(".rp-enter")).toHaveCount(0);
    expect(mock.attempts).toBe(6);
  });

  test("holds a verdict until the item is above the cue line", async ({ page, mock }) => {
    await page.setViewportSize({ width: 1280, height: 300 });
    await page.goto(`${REDDIT}/r/test/`);
    const both = page.locator("#t3_both");

    // Only its top edge is on screen: it is sent to Jev, but nothing is drawn yet.
    await both.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - window.innerHeight + 20));
    await expect.poll(() => mock.calls.some((c) => c.title.includes("time zones"))).toBe(true);
    await page.waitForTimeout(1500);
    await expect(page.locator("#t3_both > .rp-frame")).toHaveCount(0);
    await expect(page.locator("#rp-counter .rp-count-pain b")).not.toHaveText("2");

    await both.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 40));
    await expect(postFrame(page, "both")).toBeVisible();
  });

  test("boxes a pain only when it is costly or urgent", async ({ page, mock, worker }) => {
    await page.goto(`${REDDIT}/r/mild/`);
    await settled(page, mock, 2);

    // A mild pain on its own is a miss. Beside a product ask, only the ask is tagged and counted.
    await expect(postFrame(page, "askmild")).toBeVisible();
    expect(await tagsOf(postFrame(page, "askmild"))).toEqual(["ASKING FOR PRODUCT"]);
    await expect(page.locator("#t3_mild > .rp-frame")).toHaveCount(0);
    await expect(page.locator("#t3_mild")).toHaveCSS("opacity", "0.3");
    await expect(page.locator("#rp-counter .rp-count-asks b")).toHaveText("1");
    await expect(page.locator("#rp-counter .rp-count-pain b")).toHaveText("0");

    // Everyday mode boxes both pains.
    await worker.evaluate(() => chrome.storage.local.set({ recording: false }));
    await expect(postFrame(page, "mild")).toBeVisible();
    expect(await tagsOf(postFrame(page, "mild"))).toEqual(["PAIN"]);
    expect(await tagsOf(postFrame(page, "askmild"))).toEqual(["ASKING FOR PRODUCT", "PAIN"]);
    await expect(page.locator("#t3_mild")).toHaveCSS("opacity", "1");

    // Back in recording mode the mild pain is unboxed again and the count starts over.
    await worker.evaluate(() => chrome.storage.local.set({ recording: true }));
    await expect(page.locator("#t3_mild")).toHaveCSS("opacity", "0.3");
    await expect(page.locator("#t3_mild > .rp-frame")).toHaveCount(0);
    expect(await tagsOf(postFrame(page, "askmild"))).toEqual(["ASKING FOR PRODUCT"]);
    await expect(page.locator("#rp-counter .rp-count-asks b")).toHaveText("1");
    await expect(page.locator("#rp-counter .rp-count-pain b")).toHaveText("0");
    expect(mock.attempts).toBe(2);
  });

  test("turning it off on the settings page restores the everyday look", async ({ page, mock, context, worker }) => {
    await page.goto(`${REDDIT}/r/test/`);
    await settled(page, mock, 6);
    await expect(page.locator("#t3_neg")).toHaveCSS("opacity", "0.3");

    const options = await context.newPage();
    await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
    await expect(options.locator("#recording")).toBeChecked();
    await options.locator("#recording").uncheck();

    await expect(page.locator("html")).not.toHaveClass(/rp-recording/);
    await expect(page.locator("#rp-counter")).toHaveCount(0);
    await expect(page.locator("[data-rp-miss]")).toHaveCount(0);
    await expect(page.locator("#t3_neg")).toHaveCSS("opacity", "1");
    await expect(postFrame(page, "pain").locator(".rp-chip")).toHaveText("pain intensity: costing them real time or money · 2.2/3");
    await expect(postFrame(page, "pain").locator(".rp-meter")).toBeHidden();
  });
});
