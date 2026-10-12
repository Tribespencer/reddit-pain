import type { Item } from "./types";

// Everything that depends on reddit.com's markup lives in this file.
// Checked against the live site on 2026-10-02 (a subreddit feed and a post page):
// - A post is <shreddit-post id="t3_…"> with post-title, author, subreddit-name and permalink
//   attributes. Its body is a light-DOM child, <shreddit-post-text-body slot="text-body">.
// - A promoted post is a different element, <shreddit-ad-post promoted>.
// - A comment is <shreddit-comment thingid="t1_…"> with author, postid and permalink
//   attributes and no shadow root. Its text is <div slot="comment">, and its replies are
//   nested <shreddit-comment> elements inside its own #comment-children.
export const ITEM_SELECTOR = "shreddit-post, shreddit-comment";

const isComment = (el: Element) => el.localName === "shreddit-comment";

export function itemIdOf(el: Element): string | null {
  return el.getAttribute(isComment(el) ? "thingid" : "id") || null;
}

// A comment element also contains its replies, so `selector` is matched against its own part only.
function ownPart(comment: Element, selector: string): Element | null {
  for (const el of comment.querySelectorAll(selector)) {
    if (el.closest("shreddit-comment") === comment) return el;
  }
  return null;
}

const commentTextOf = (comment: Element) => ownPart(comment, '[slot="comment"]');

const clean = (text: string) =>
  text
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();

function postBody(post: Element): string {
  const slot = post.querySelector(':scope > [slot="text-body"]');
  return clean((slot?.querySelector(".md") ?? slot)?.textContent ?? "");
}

// The element whose visibility counts as the item being on screen. For a comment this is
// its own text, because the comment element stays on screen as long as any reply does.
// Null for comments with no text (deleted or removed).
export function visibilityTargetOf(el: Element): Element | null {
  return isComment(el) ? commentTextOf(el) : el;
}

// Height of a comment's own part, above its replies. Null when the box should cover the
// whole element: posts, and comments whose replies are not rendered.
export function ownHeightOf(el: Element): number | null {
  if (!isComment(el)) return null;
  const replies = ownPart(el, "#comment-children");
  if (!replies || replies.getClientRects().length === 0) return null;
  const height = replies.getBoundingClientRect().top - el.getBoundingClientRect().top;
  return height > 0 ? height : null;
}

// Returns null for anything that should not be labelled: promoted posts, and comments with no text.
export function extractItem(el: Element): Item | null {
  const id = itemIdOf(el);
  if (!id) return null;
  const author = el.getAttribute("author") ?? "";
  const permalink = el.getAttribute("permalink") ?? "";
  const seenAt = new Date().toISOString();

  if (isComment(el)) {
    const body = clean(commentTextOf(el)?.textContent ?? "");
    if (!body) return null;
    const post = document.getElementById(el.getAttribute("postid") ?? "");
    return {
      id,
      kind: "comment",
      subreddit: post?.getAttribute("subreddit-name") ?? permalink.match(/^\/r\/([^/]+)/)?.[1] ?? "",
      title: post?.getAttribute("post-title") ?? "",
      body,
      author,
      permalink,
      seenAt,
    };
  }

  if (el.hasAttribute("promoted")) return null;
  const title = el.getAttribute("post-title") ?? "";
  if (!title) return null;
  return {
    id,
    kind: "post",
    subreddit: el.getAttribute("subreddit-name") ?? "",
    title,
    body: postBody(el),
    author,
    permalink,
    seenAt,
  };
}
