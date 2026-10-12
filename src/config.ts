// Everything worth tuning lives here: the highlight threshold, the wording sent to Jev, and the caps.

// A noul answer at or above this draws the highlight.
export const THRESHOLD = 0.5;

// Longest body sent to Jev. Longer bodies are cut and the stored record notes it.
export const MAX_BODY_CHARS = 6000;

// Jev is not called once this many items are stored. Null means no cap; the smoke test used 20.
export const ITEM_CAP: number | null = null;

// Levels for the pain_intensity score, lowest first. The score runs from 0 to the last index.
export const INTENSITY_LEVELS = [
  "mild annoyance",
  "recurring problem",
  "costing them real time or money",
  "urgent, actively looking for any fix",
];

// One-word names for the same levels, shown beside the meter in recording mode.
export const INTENSITY_SHORT = ["MILD", "RECURRING", "COSTLY", "URGENT"];

// Sent with state { subreddit, title, body }. For a comment, `title` is the post's title
// and `body` is the comment.
export const QUESTIONS = {
  asks_for_product: {
    type: "noul",
    instructions:
      "Is the author asking for a tool, app, product or service, asking for a recommendation, or asking whether something exists that does a job?",
  },
  has_pain: {
    type: "noul",
    instructions:
      "Is the author describing a problem, frustration or unmet need they personally have that a software product, app or service could plausibly solve?",
  },
  pain_intensity: {
    type: "score",
    instructions: "How intense is the problem, frustration or unmet need the author describes?",
    criteria: INTENSITY_LEVELS,
  },
};
