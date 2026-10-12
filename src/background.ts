import { ITEM_CAP, MAX_BODY_CHARS } from "./config";
import { countItems, getItem, putItem } from "./db";
import { DEFAULT_MODEL, labelWithJev } from "./jev";
import type { Item, JevResult, LabelResponse, Message } from "./types";

const SAMPLE = {
  subreddit: "smallbusiness",
  title: "Is there an app that tracks which invoices are overdue?",
  body: "I spend every Friday afternoon going through a spreadsheet to chase late payments. Is there anything that does this automatically? Happy to pay for it.",
};

async function settings() {
  const { apiKey = "", model = "" } = await chrome.storage.local.get(["apiKey", "model"]);
  return { apiKey: apiKey as string, model: (model as string) || DEFAULT_MODEL };
}

// Tells the settings page that the store changed. Fails when it is not open.
const notify = () => void chrome.runtime.sendMessage({ type: "logged" } satisfies Message).catch(() => {});

// Jev calls under way, by item id, so the same item seen in two tabs is still sent once.
const pending = new Map<string, Promise<LabelResponse>>();

async function label(item: Item): Promise<LabelResponse> {
  // An item is sent to Jev once; later sightings reuse the stored labels.
  const existing = await getItem(item.id);
  if (existing) return { status: "ok", labels: existing.labels, cached: true };

  const { apiKey, model } = await settings();
  if (!apiKey) return { status: "error", error: "no_key" };

  const stored = await countItems();
  const underWay = pending.get(item.id);
  if (underWay) return underWay;
  if (ITEM_CAP !== null && stored + pending.size >= ITEM_CAP) return { status: "capped" };

  const call = (async (): Promise<LabelResponse> => {
    const bodyCut = item.body.length > MAX_BODY_CHARS;
    const body = bodyCut ? item.body.slice(0, MAX_BODY_CHARS) : item.body;
    const result = await labelWithJev(apiKey, model, { subreddit: item.subreddit, title: item.title, body });
    if (!result.ok) return { status: "error", error: result.error };

    await putItem({
      id: item.id,
      labelledAt: item.seenAt,
      item: { ...item, body },
      bodyCut,
      labels: result.labels,
      model: result.model,
      inputTokens: result.inputTokens,
    });
    notify();
    return { status: "ok", labels: result.labels, cached: false };
  })();

  pending.set(item.id, call);
  try {
    return await call;
  } finally {
    pending.delete(item.id);
  }
}

async function test(): Promise<JevResult> {
  const { apiKey, model } = await settings();
  if (!apiKey) return { ok: false, error: "no_key" };
  return labelWithJev(apiKey, model, SAMPLE);
}

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  if (msg.type === "label") {
    label(msg.item).then(sendResponse, (error) =>
      sendResponse({ status: "error", error: String(error).slice(0, 200) } satisfies LabelResponse),
    );
    return true;
  }
  if (msg.type === "test") {
    test().then(sendResponse);
    return true;
  }
  if (msg.type === "openOptions") chrome.runtime.openOptionsPage();
  return false;
});

// Clicking the toolbar icon opens the settings page.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
