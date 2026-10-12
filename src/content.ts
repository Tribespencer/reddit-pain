import { INTENSITY_LEVELS, THRESHOLD } from "./config";
import { extractItem, ITEM_SELECTOR, itemIdOf, ownHeightOf, visibilityTargetOf } from "./extract";
import type { LabelResponse, Labels, Message } from "./types";

// After a failed Jev call, stop sending new items for this long.
const ERROR_PAUSE_MS = 10_000;
// The lock-on animation's total length; its class is removed afterwards so it cannot replay.
const ENTER_MS = 1600;

const labels = new Map<string, Labels>();
const requested = new Set<string>();
const observed = new WeakSet<Element>();
const frames = new WeakMap<Element, HTMLElement>();
// Visibility is watched on a comment's own text, so this maps the watched element to its item.
const itemOfTarget = new WeakMap<Element, Element>();
const onScreen = new Set<Element>();
let pausedUntil = 0;
let retryTimer = 0;
// Set once the background says the smoke-test cap is reached; lookups continue, quietly.
let capped = false;
// Set when the extension was reloaded under this page; nothing works until a refresh.
let disconnected = false;

const send = (msg: Message) => chrome.runtime.sendMessage(msg);

// A comment's box covers its own part only, not its replies.
function fitFrame(el: Element, frame: HTMLElement) {
  const height = ownHeightOf(el);
  if (height === null) frame.style.removeProperty("--rp-own-height");
  else frame.style.setProperty("--rp-own-height", `${Math.floor(height)}px`);
  frame.classList.toggle("rp-own", height !== null);
}

const sizes = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    const frame = frames.get(target);
    if (frame?.isConnected) fitFrame(target, frame);
  }
});

// The frame is an overlay box drawn around the item, as a child of the item's own element.
function frameOf(el: Element): HTMLElement {
  let frame = frames.get(el);
  if (!frame?.isConnected) {
    frame = document.createElement("div");
    frame.className = "rp-frame";
    el.append(frame);
    frames.set(el, frame);
    sizes.observe(el);
  }
  fitFrame(el, frame);
  return frame;
}

function clearFrame(el: Element) {
  frames.get(el)?.remove();
  frames.delete(el);
  sizes.unobserve(el);
}

function intensityText(score: number): string {
  const level = INTENSITY_LEVELS[Math.min(INTENSITY_LEVELS.length - 1, Math.max(0, Math.round(score)))];
  return `pain intensity: ${level} · ${score.toFixed(1)}/${INTENSITY_LEVELS.length - 1}`;
}

// `animate` plays the lock-on animation; it is skipped for labels that came from the store.
function render(el: Element, l: Labels, animate: boolean) {
  const asks = l.asksForProduct >= THRESHOLD;
  const pain = l.hasPain >= THRESHOLD;
  if (!asks && !pain) return clearFrame(el);

  const existing = frames.get(el);
  if (existing?.isConnected && existing.classList.contains("rp-labelled")) return;

  const frame = frameOf(el);
  frame.classList.remove("rp-scanning");
  frame.classList.add("rp-labelled");
  frame.dataset.kind = asks ? "asks" : "pain";

  const tags = document.createElement("div");
  tags.className = "rp-tags";
  const tag = (text: string, kind: string) => {
    const span = document.createElement("span");
    span.className = `rp-tag rp-tag-${kind}`;
    span.textContent = text;
    tags.append(span);
  };
  if (asks) tag("ASKING FOR PRODUCT", "asks");
  if (pain) tag("PAIN", "pain");

  const chip = document.createElement("div");
  chip.className = "rp-chip";
  chip.textContent = intensityText(l.painIntensity);
  frame.replaceChildren(tags, chip);

  if (animate) {
    frame.classList.add("rp-enter");
    setTimeout(() => frame.classList.remove("rp-enter"), ENTER_MS);
  }
}

// The on-page box appears only when something is wrong.
function showError(error: string) {
  let box = document.getElementById("rp-status");
  if (!box) {
    box = document.createElement("div");
    box.id = "rp-status";
    document.body.append(box);
  }
  box.replaceChildren();

  const title = document.createElement("b");
  title.textContent = "Reddit Pain";
  const line = document.createElement("div");
  line.className = "rp-err";
  box.append(title, line);

  if (error === "no_key") {
    line.textContent = "No TypeSafe API key set.";
    const button = document.createElement("button");
    button.textContent = "Open settings";
    button.onclick = () => send({ type: "openOptions" });
    box.append(button);
  } else {
    line.textContent = error;
  }
}

function clearError() {
  document.getElementById("rp-status")?.remove();
}

// Once the pause ends, items still on screen are tried again one at a time, so a problem
// that persists costs one failed call per pause.
function retryAfterPause() {
  clearTimeout(retryTimer);
  retryTimer = window.setTimeout(async () => {
    for (const el of [...onScreen]) {
      if (Date.now() < pausedUntil) return;
      if (el.isConnected) await onVisible(el);
    }
  }, pausedUntil - Date.now() + 50);
}

async function onVisible(el: Element) {
  if (disconnected) return;
  const item = extractItem(el);
  if (!item) return;

  const known = labels.get(item.id);
  if (known) return render(el, known, false);
  if (requested.has(item.id) || Date.now() < pausedUntil) return;

  requested.add(item.id);
  if (!capped) frameOf(el).classList.add("rp-scanning");

  let res: LabelResponse;
  try {
    res = await send({ type: "label", item });
  } catch {
    disconnected = true;
    res = { status: "error", error: "Extension was reloaded. Refresh this page." };
  }

  if (res.status === "error") {
    // Allow another try once the problem is fixed.
    requested.delete(item.id);
    pausedUntil = Date.now() + ERROR_PAUSE_MS;
    showError(res.error);
    clearFrame(el);
    if (!disconnected) retryAfterPause();
    return;
  }

  clearError();
  if (res.status === "capped") {
    capped = true;
    clearFrame(el);
    return;
  }

  labels.set(item.id, res.labels);
  // The same item can be on the page more than once, so render every element showing it.
  for (const other of document.querySelectorAll(ITEM_SELECTOR)) {
    if (itemIdOf(other) === item.id) render(other, res.labels, !res.cached);
  }
}

const visibility = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const el = itemOfTarget.get(entry.target);
    if (!el) continue;
    if (entry.isIntersecting) {
      onScreen.add(el);
      void onVisible(el);
    } else {
      onScreen.delete(el);
    }
  }
});

function scan() {
  for (const el of document.querySelectorAll(ITEM_SELECTOR)) {
    if (observed.has(el)) continue;
    const target = visibilityTargetOf(el);
    if (!target) continue;
    observed.add(el);
    itemOfTarget.set(target, el);
    visibility.observe(target);
  }
}

let scanQueued = false;
new MutationObserver(() => {
  if (scanQueued) return;
  scanQueued = true;
  requestAnimationFrame(() => {
    scanQueued = false;
    scan();
  });
}).observe(document.body, { childList: true, subtree: true });

scan();
