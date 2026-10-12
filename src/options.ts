import { INTENSITY_LEVELS, ITEM_CAP, THRESHOLD } from "./config";
import { clearItems, countItems, recentItems } from "./db";
import { DEFAULT_MODEL } from "./jev";
import type { JevResult, Message } from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const apiKey = $<HTMLInputElement>("apiKey");
const model = $<HTMLInputElement>("model");
const result = $<HTMLDivElement>("result");

async function load() {
  const stored = await chrome.storage.local.get(["apiKey", "model"]);
  apiKey.value = (stored.apiKey as string) ?? "";
  model.value = (stored.model as string) ?? "";
  await renderLog();
}

async function save() {
  await chrome.storage.local.set({ apiKey: apiKey.value.trim(), model: model.value.trim() });
}

const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

async function renderLog() {
  const count = await countItems();
  $("count").textContent =
    ITEM_CAP === null
      ? `${count} items labelled.`
      : `${count} of ${ITEM_CAP} smoke-test items labelled. Jev is not called once the cap is reached.`;

  const body = $<HTMLTableSectionElement>("log");
  body.replaceChildren();
  for (const { item, labels, bodyCut } of await recentItems(50)) {
    const row = body.insertRow();
    const tags = [
      labels.asksForProduct >= THRESHOLD ? "ASKING FOR PRODUCT" : "",
      labels.hasPain >= THRESHOLD ? "PAIN" : "",
    ].filter(Boolean);
    const level = INTENSITY_LEVELS[Math.round(labels.painIntensity)] ?? "";
    const cells = [
      `${item.kind} · r/${item.subreddit}`,
      short(item.title, 100),
      short(item.body, 200) + (bodyCut ? " [cut]" : ""),
      tags.join(" + ") || "—",
      labels.asksForProduct.toFixed(2),
      labels.hasPain.toFixed(2),
      `${labels.painIntensity.toFixed(1)} ${level}`,
    ];
    for (const text of cells) row.insertCell().textContent = text;
    if (tags.length) row.className = "hit";
  }
}

$("save").onclick = async () => {
  await save();
  result.textContent = "Saved.";
};

$("test").onclick = async () => {
  await save();
  result.textContent = "Calling Jev…";
  const res: JevResult = await chrome.runtime.sendMessage({ type: "test" } satisfies Message);
  if (!res.ok) {
    result.textContent = res.error === "no_key" ? "Enter an API key first." : `Failed: ${res.error}`;
    return;
  }
  result.textContent =
    `OK · ${res.model} · ${res.ms} ms · ${res.inputTokens} input tokens\n` +
    `Sample post labelled as: ${JSON.stringify(res.labels, null, 2)}`;
  if (!model.value.trim()) model.placeholder = `${DEFAULT_MODEL} (currently ${res.model})`;
};

$("clear").onclick = async () => {
  if (!confirm("Delete every stored item and label? They will be sent to Jev again when next seen.")) return;
  await clearItems();
  await renderLog();
};

chrome.runtime.onMessage.addListener((msg: Message) => {
  if (msg.type === "logged") void renderLog();
});

void load();
