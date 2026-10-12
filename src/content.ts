import { INTENSITY_LEVELS, INTENSITY_SHORT, RECORDING_MIN_PAIN_LEVEL, THRESHOLD } from "./config";
import { extractItem, ITEM_SELECTOR, itemIdOf, ownHeightOf, visibilityTargetOf } from "./extract";
import type { LabelResponse, Labels, Message } from "./types";

// After a failed Jev call, stop sending new items for this long.
const ERROR_PAUSE_MS = 10_000;
// The lock-on animation's total length; its class is removed afterwards so it cannot replay.
const ENTER_MS = 1600;
// Recording mode's longer lock-on, and the one scan sweep it plays before each verdict.
// Both match durations in content.css.
const RECORDING_ENTER_MS = 2000;
const SWEEP_MS = 600;
// How far into recording mode's lock-on the border and glow land.
const LOCK_LANDS_MS = 520;

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

// Recording mode, switched on the settings page: the same labels, drawn and timed for filming.
let recording = false;
// Items above the cue line, the part of the screen where recording mode plays its verdicts.
const inCue = new WeakSet<Element>();
// Items whose scan sweep is playing, and items whose verdict has been shown.
const sweeping = new WeakSet<Element>();
const staged = new WeakSet<Element>();
// Hits shown on this page so far, for the recording counter.
const counted = new Set<string>();
const totals = { asks: 0, pain: 0 };
type Tally = keyof typeof totals;

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

const levelOf = (score: number) => Math.min(INTENSITY_LEVELS.length - 1, Math.max(0, Math.round(score)));

function intensityText(score: number): string {
  return `pain intensity: ${INTENSITY_LEVELS[levelOf(score)]} · ${score.toFixed(1)}/${INTENSITY_LEVELS.length - 1}`;
}

// The counter exists only in recording mode. `bumped` names the totals that just went up.
function renderCounter(bumped: Tally[] = []) {
  let box = document.getElementById("rp-counter");
  if (!recording) return void box?.remove();
  if (!box) {
    box = document.createElement("div");
    box.id = "rp-counter";
    for (const [kind, text] of [["asks", "ASKING"], ["pain", "PAIN"]]) {
      const pill = document.createElement("span");
      pill.className = `rp-count rp-count-${kind}`;
      pill.dataset.kind = kind;
      pill.append(document.createElement("b"), text);
      box.append(pill);
    }
    document.body.append(box);
  }
  for (const pill of box.children as HTMLCollectionOf<HTMLElement>) {
    const kind = pill.dataset.kind as Tally;
    pill.querySelector("b")!.textContent = String(totals[kind]);
    if (!bumped.includes(kind)) continue;
    // Reading the width between the two class changes restarts the animation.
    pill.classList.remove("rp-bump");
    void pill.offsetWidth;
    pill.classList.add("rp-bump");
  }
}

function count(id: string, asks: boolean, pain: boolean) {
  if (counted.has(id)) return;
  counted.add(id);
  const bumped: Tally[] = [];
  if (asks) bumped.push("asks");
  if (pain) bumped.push("pain");
  for (const kind of bumped) totals[kind]++;
  renderCounter(bumped);
}

// Draws the box for a hit, or leaves a miss alone. `animate` plays the lock-on animation.
function verdict(el: Element, l: Labels, animate: boolean) {
  const level = levelOf(l.painIntensity);
  const asks = l.asksForProduct >= THRESHOLD;
  // Recording mode leaves the milder pains unboxed.
  const pain = l.hasPain >= THRESHOLD && (!recording || level >= RECORDING_MIN_PAIN_LEVEL);
  // Recording mode dims misses; a comment's own text is dimmed, not its replies.
  const dimmed = visibilityTargetOf(el);
  if (!asks && !pain) {
    clearFrame(el);
    if (recording) dimmed?.setAttribute("data-rp-miss", "");
    return;
  }
  dimmed?.removeAttribute("data-rp-miss");

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

  // The chip holds the wording and a meter; the stylesheet shows one or the other.
  const chip = document.createElement("div");
  chip.className = "rp-chip";
  chip.dataset.level = String(level);
  chip.dataset.label = INTENSITY_SHORT[level];
  const text = document.createElement("span");
  text.className = "rp-chip-text";
  text.textContent = intensityText(l.painIntensity);
  const meter = document.createElement("span");
  meter.className = "rp-meter";
  for (let i = 0; i < INTENSITY_LEVELS.length; i++) {
    const segment = document.createElement("i");
    if (i <= level) segment.className = "rp-on";
    meter.append(segment);
  }
  chip.append(text, meter);

  // Corner brackets, drawn in recording mode only.
  const corners = document.createElement("div");
  corners.className = "rp-corners";
  frame.replaceChildren(corners, tags, chip);

  if (animate) {
    frame.classList.add("rp-enter");
    setTimeout(() => frame.classList.remove("rp-enter"), recording ? RECORDING_ENTER_MS : ENTER_MS);
  }
  const id = itemIdOf(el);
  if (!id) return;
  // In recording mode the counter ticks as the box lands, not as the brackets set off.
  if (animate && recording) setTimeout(() => count(id, asks, pain), LOCK_LANDS_MS);
  else count(id, asks, pain);
}

// `animate` plays the lock-on animation; it is skipped for labels that came from the store.
// Recording mode ignores it: every item gets one scan sweep and then its verdict, held until
// the item is above the cue line, so stored labels replay on cue.
function render(el: Element, l: Labels, animate: boolean) {
  const existing = frames.get(el);
  if (existing?.isConnected && existing.classList.contains("rp-labelled")) return;

  if (!recording || staged.has(el)) return verdict(el, l, animate);
  if (sweeping.has(el)) return;
  if (!inCue.has(el)) return clearFrame(el);

  sweeping.add(el);
  frameOf(el).classList.add("rp-scanning");
  setTimeout(() => {
    sweeping.delete(el);
    staged.add(el);
    if (el.isConnected) verdict(el, l, true);
  }, SWEEP_MS);
}

// Applies the current mode to every item on the page whose labels are known.
function renderKnown() {
  for (const el of document.querySelectorAll(ITEM_SELECTOR)) {
    const known = labels.get(itemIdOf(el) ?? "");
    if (known) render(el, known, false);
  }
}

function setRecording(on: boolean) {
  recording = on;
  document.documentElement.classList.toggle("rp-recording", on);
  if (!on) for (const el of document.querySelectorAll("[data-rp-miss]")) el.removeAttribute("data-rp-miss");
  // The two modes box different items, so every box is redrawn and the count starts again.
  for (const el of document.querySelectorAll(ITEM_SELECTOR)) clearFrame(el);
  counted.clear();
  totals.asks = totals.pain = 0;
  renderCounter();
  renderKnown();
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
  // Recording mode plays its own sweep at the cue line instead.
  if (!capped && !recording) frameOf(el).classList.add("rp-scanning");

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

// The cue line sits 30% up from the bottom of the screen. Labels are still fetched as soon
// as an item is on screen, so they are ready by the time it gets here.
const cue = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const el = itemOfTarget.get(entry.target);
      if (!el) continue;
      if (!entry.isIntersecting) {
        inCue.delete(el);
        continue;
      }
      inCue.add(el);
      const known = labels.get(itemIdOf(el) ?? "");
      if (recording && known) render(el, known, false);
    }
  },
  { rootMargin: "0px 0px -30% 0px" },
);

function scan() {
  for (const el of document.querySelectorAll(ITEM_SELECTOR)) {
    if (observed.has(el)) continue;
    const target = visibilityTargetOf(el);
    if (!target) continue;
    observed.add(el);
    itemOfTarget.set(target, el);
    visibility.observe(target);
    cue.observe(target);
  }
}

let scanQueued = false;
const mutations = new MutationObserver(() => {
  if (scanQueued) return;
  scanQueued = true;
  requestAnimationFrame(() => {
    scanQueued = false;
    scan();
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.recording) setRecording(Boolean(changes.recording.newValue));
});

// The mode is read before the first scan, so no item is drawn the wrong way first.
async function start() {
  try {
    const stored = await chrome.storage.local.get("recording");
    if (stored.recording) setRecording(true);
  } catch {
    // The extension was reloaded under this page; the first label request reports it.
  }
  mutations.observe(document.body, { childList: true, subtree: true });
  scan();
}

void start();
