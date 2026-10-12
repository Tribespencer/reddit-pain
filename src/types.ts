export type ItemKind = "post" | "comment";

// A post or comment as read from the page.
export interface Item {
  id: string;
  kind: ItemKind;
  subreddit: string;
  // For a comment, the title of the post it sits under.
  title: string;
  body: string;
  author: string;
  permalink: string;
  seenAt: string;
}

export interface Labels {
  asksForProduct: number;
  hasPain: number;
  // 0 to 3, fractional; see INTENSITY_LEVELS.
  painIntensity: number;
}

export interface JevState {
  subreddit: string;
  title: string;
  body: string;
}

export type JevResult =
  | { ok: true; labels: Labels; model: string; ms: number; inputTokens: number }
  | { ok: false; error: string };

// `cached` is true when the labels came from the local store rather than a Jev call.
// `capped` means the item is not stored and the smoke-test cap stops it being sent.
export type LabelResponse =
  | { status: "ok"; labels: Labels; cached: boolean }
  | { status: "capped" }
  | { status: "error"; error: string };

export type Message =
  | { type: "label"; item: Item }
  | { type: "test" }
  | { type: "openOptions" }
  | { type: "logged" };
