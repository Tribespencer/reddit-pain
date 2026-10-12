// Paste this into the DevTools console on a reddit.com page. It reads the page's
// structure (nothing is sent anywhere) and copies a JSON report to the clipboard.
// Run it on three pages: the home feed, a subreddit page, and a post page with comments.
// Scroll a little first so a promoted post has had a chance to load.
(() => {
  const cut = (s, n = 70) => {
    s = String(s ?? "").replace(/\s+/g, " ").trim();
    return s.length > n ? `${s.slice(0, n)}…` : s;
  };
  const attrs = (el) => Object.fromEntries([...el.attributes].map((a) => [a.name, cut(a.value, 50)]));
  const style = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      display: s.display,
      position: s.position,
      overflow: s.overflow,
      contain: s.contain,
      size: `${Math.round(r.width)}x${Math.round(r.height)}`,
    };
  };
  const chain = (el, n = 6) => {
    const out = [];
    for (let p = el.parentElement; p && out.length < n; p = p.parentElement) {
      out.push(p.tagName.toLowerCase() + (p.id ? `#${cut(p.id, 30)}` : ""));
    }
    return out;
  };
  // Direct children in the light DOM: these are what a content script can read and style.
  const lightChildren = (el) =>
    [...el.children].slice(0, 25).map((c) => ({
      tag: c.tagName.toLowerCase(),
      slot: c.getAttribute("slot"),
      id: cut(c.id, 40) || undefined,
      class: cut(c.className, 50) || undefined,
      textLength: (c.textContent ?? "").trim().length,
      size: `${Math.round(c.getBoundingClientRect().width)}x${Math.round(c.getBoundingClientRect().height)}`,
    }));
  const shadow = (el) => {
    const root = el.shadowRoot;
    if (!root) return null;
    return {
      mode: root.mode,
      slots: [...root.querySelectorAll("slot")].map((s) => s.name || "(default)"),
      topLevel: [...root.children].slice(0, 12).map((c) => c.tagName.toLowerCase()),
      // For each slot, its ancestors inside the shadow tree with their CSS position, innermost first.
      slotAncestors: Object.fromEntries(
        [...root.querySelectorAll("slot")].map((s) => {
          const out = [];
          for (let p = s.parentElement; p; p = p.parentElement) {
            const cs = getComputedStyle(p);
            out.push(`${p.tagName.toLowerCase()}:${cs.position}${cs.overflow !== "visible" ? `:${cs.overflow}` : ""}`);
          }
          return [s.name || "(default)", out.join(" < ")];
        }),
      ),
      textLengthOutsideSlots: (root.textContent ?? "").trim().length,
    };
  };
  // Where the readable text sits, tried several ways.
  const textCandidates = (el, selectors) =>
    Object.fromEntries(
      selectors.map((sel) => {
        const hit = [...el.querySelectorAll(sel)].find((n) => n.closest(el.tagName) === el);
        return [sel, hit ? { tag: hit.tagName.toLowerCase(), slot: hit.getAttribute("slot"), id: cut(hit.id, 40), textLength: (hit.textContent ?? "").trim().length, sample: cut(hit.textContent, 60) } : null];
      }),
    );
  const describe = (el, selectors) => ({
    attrs: attrs(el),
    style: style(el),
    parents: chain(el),
    shadow: shadow(el),
    lightChildren: lightChildren(el),
    text: textCandidates(el, selectors),
    nestedSameTag: el.querySelectorAll(el.tagName).length,
  });

  const customTags = {};
  for (const el of document.querySelectorAll("*")) {
    const tag = el.tagName.toLowerCase();
    if (tag.includes("-")) customTags[tag] = (customTags[tag] ?? 0) + 1;
  }

  const POST_TEXT = ['[slot="text-body"]', '[slot="title"]', '[property="schema:articleBody"]', ".md", 'a[slot="full-post-link"]', "h1", '[id$="-post-rtjson-content"]'];
  const COMMENT_TEXT = ['[slot="comment"]', ".md", '[id$="-comment-rtjson-content"]', '[id$="-post-rtjson-content"]'];

  const posts = [...document.querySelectorAll("shreddit-post")];
  const comments = [...document.querySelectorAll("shreddit-comment")];
  // Anything that looks like an ad, by tag or attribute name.
  const adLike = [...document.querySelectorAll("*")].filter((el) => {
    const tag = el.tagName.toLowerCase();
    if (/(^|-)ad(-|$)|promot/.test(tag)) return true;
    return tag.startsWith("shreddit-") && [...el.attributes].some((a) => /promot|(^|-)ad(-|$)|is-blank/.test(a.name));
  });

  const report = {
    path: location.pathname.replace(/\/comments\/\w+\/[^/]*/, "/comments/ID/SLUG"),
    host: location.host,
    customTags: Object.fromEntries(Object.entries(customTags).sort((a, b) => b[1] - a[1]).slice(0, 60)),
    counts: { posts: posts.length, comments: comments.length, adLike: adLike.length, articles: document.querySelectorAll("article").length },
    posts: posts.slice(0, 3).map((el) => describe(el, POST_TEXT)),
    // One text post if the first three had no body, since body placement is the open question.
    postWithBody: (() => {
      const el = posts.find((p) => p.querySelector('[slot="text-body"]'));
      return el ? describe(el, POST_TEXT) : null;
    })(),
    comments: comments.slice(0, 3).map((el) => describe(el, COMMENT_TEXT)),
    adLike: adLike.slice(0, 4).map((el) => ({ tag: el.tagName.toLowerCase(), ...describe(el, POST_TEXT) })),
    fallback: posts.length
      ? undefined
      : { testids: [...new Set([...document.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid")))].slice(0, 40) },
  };

  const json = JSON.stringify(report);
  copy(json);
  console.log(`Reddit Pain probe: ${json.length} characters copied to the clipboard.`, report);
})();
