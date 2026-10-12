import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One local HTTPS server stands in for both www.reddit.com and api.typesafe.ai. The test
// browser is started with resolver rules that send both hosts here.

export interface JevCall {
  subreddit: string;
  title: string;
  body: string;
}

export interface Mock {
  port: number;
  // Requests Jev answered.
  calls: JevCall[];
  // Every label request received, including ones answered with a failure.
  attempts: number;
  // When non-zero, Jev answers every request with this HTTP status.
  failWith: number;
  close(): Promise<void>;
}

// Answers by a phrase in the title or body: [asks_for_product, has_pain, pain_intensity].
// Anything else gets a clear negative.
const ANSWERS: [string, number, number, number][] = [
  ["overdue invoices", 0.93, 0.21, 0.8],
  ["Stripe payouts", 0.1, 0.88, 2.2],
  ["time zones", 0.9, 0.85, 2.7],
  ["Borderline", 0.5, 0.1, 0.2],
  ["Curious what everyone uses", 0.8, 0.3, 1.0],
  ["spreadsheet and it is a mess", 0.12, 0.9, 1.9],
  ["tool that does this automatically", 0.91, 0.2, 0.6],
  ["slightly annoying", 0.1, 0.9, 0.6],
  ["small gripe", 0.9, 0.8, 1.2],
];
const NEGATIVE = [0.04, 0.06, 0.1];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

// Markup below follows what was read from reddit.com on 2026-10-02 with tools/probe-reddit.js.
// The layout inside a comment's <details> is partly assumed (see the comments page).

function feedPost(id: string, title: string, body: string, context = "SubredditFeed") {
  return `<article>
  <shreddit-post class="block relative" id="t3_${id}" post-title="${esc(title)}" author="user_${id}"
      subreddit-name="test" subreddit-prefixed-name="r/test" permalink="/r/test/comments/${id}/slug/"
      post-type="text" score="1" comment-count="0" view-context="${context}">
    <a slot="full-post-link" class="absolute inset-0" href="/r/test/comments/${id}/slug/">${esc(title)}</a>
    <span slot="credit-bar">r/test · user_${id}</span>
    <a slot="title" id="post-title-t3_${id}">${esc(title)}</a>
    <shreddit-post-text-body slot="text-body"><div class="md" id="t3_${id}-post-rtjson-content" property="schema:articleBody"><p>${esc(body)}</p></div></shreddit-post-text-body>
  </shreddit-post>
</article>`;
}

const AD = `<shreddit-ad-post class="promotedlink block relative" promoted id="t3_ad" post-id="t3_ad"
    post-title="Cash back season" author="BigBank" subreddit-name="u_BigBank" permalink="/user/BigBank/comments/ad/slug/" post-type="video">
  <div slot="credit-bar">BigBank · Promoted</div>
  <div slot="title">Cash back season</div>
</shreddit-ad-post>`;

function feedPage(context: string) {
  const posts = [
    feedPost("ask", "Is there an app that tracks overdue invoices?", "Looking for a recommendation, happy to pay.", context),
    AD,
    feedPost("pain", "Reconciling Stripe payouts by hand every month", "It eats two days each month and I keep making mistakes.", context),
    feedPost("both", "Scheduling tool that handles time zones?", "Our calendar keeps double-booking clients and we lose deals. Does anything fix this?", context),
    feedPost("neg", "Hit 1,000 followers today", "Just wanted to share the milestone.", context),
    feedPost("edge", "Borderline post", "A post that scores exactly at the threshold.", context),
    feedPost("long", "Long story about my week", "word ".repeat(1400), context),
  ];
  return page(`<shreddit-feed>${posts.join("\n")}</shreddit-feed>`);
}

function manyPage() {
  const posts = Array.from({ length: 25 }, (_, i) => feedPost(`many${i}`, `Ordinary post number ${i}`, "Nothing to see."));
  return page(`<shreddit-feed>${posts.join("\n")}</shreddit-feed>`);
}

// Two pains below recording mode's bar: one on its own, one in a post that also asks for a product.
function mildPage() {
  const posts = [
    feedPost("mild", "The export button is slightly annoying", "It is two clicks instead of one."),
    feedPost("askmild", "Any app for this small gripe?", "Renaming files one at a time gets old."),
  ];
  return page(`<shreddit-feed>${posts.join("\n")}</shreddit-feed>`);
}

function comment(id: string, depth: number, text: string | null, replies = "", parent = "") {
  const own =
    text === null
      ? `<div class="md">Comment removed by moderator</div>`
      : `<div slot="comment" id="t1_${id}-comment-rtjson-content" class="md"><div id="t1_${id}-post-rtjson-content"><p>${esc(text)}</p></div></div>`;
  return `<shreddit-comment class="relative" thingid="t1_${id}" author="user_${id}" depth="${depth}" postid="t3_pdp"
    permalink="/r/test/comments/pdp/comment/${id}/" slot-config="light" ${parent ? `slot="children-t1_${parent}-0" parentid="t1_${parent}"` : ""}>
  <details open class="relative">
    <summary>user_${id} · 2h ago</summary>
    <div>
      ${own}
      <div class="actions">▲ 3 ▼ Reply</div>
      <div id="comment-children">${replies}</div>
    </div>
  </details>
</shreddit-comment>`;
}

function commentsPage() {
  // On a post page the post is not inside an <article> and is position: static.
  const post = `<shreddit-post class="block" id="t3_pdp" post-title="How do you all track client feedback?" author="user_pdp"
    subreddit-name="test" subreddit-prefixed-name="r/test" permalink="/r/test/comments/pdp/slug/" post-type="text"
    score="20" comment-count="4" view-context="CommentsPage">
  <div slot="credit-bar" id="pdp-credit-bar">r/test · user_pdp</div>
  <h1 slot="title" id="post-title-t3_pdp">How do you all track client feedback?</h1>
  <shreddit-post-text-body slot="text-body"><div class="md" id="t3_pdp-post-rtjson-content" property="schema:articleBody"><p>Curious what everyone uses.</p></div></shreddit-post-text-body>
</shreddit-post>`;
  const replies = comment("c2", 1, "Same here, good luck.", "", "c1") + comment("c3", 1, null, "", "c1");
  const tree = `<shreddit-comment-tree id="comment-tree"><section>
${comment("c1", 0, "I paste everything into a spreadsheet and it is a mess, it costs me hours every week.", replies)}
${comment("c4", 0, "Does anyone know a tool that does this automatically?")}
</section></shreddit-comment-tree>`;
  return page(post + tree);
}

function page(main: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>mock reddit</title>
<style>
  body { margin: 0; font: 14px/1.4 sans-serif; }
  main { width: 732px; margin: 0 auto; padding: 16px 0; }
  article { margin: 12px 0; }
  shreddit-post, shreddit-ad-post, shreddit-comment, shreddit-post-text-body, shreddit-feed, shreddit-comment-tree { display: block; }
  shreddit-post, shreddit-ad-post { padding: 8px 16px; }
  shreddit-post-text-body { max-height: 120px; overflow: hidden; }
  shreddit-comment { margin: 12px 0; }
  #comment-children { margin-left: 32px; }
  .relative { position: relative; }
  .absolute { position: absolute; }
  .inset-0 { inset: 0; opacity: 0; }
  p { margin: 4px 0; }
</style>
<script>
  // Posts render through an open shadow root with named slots and a top-level default slot.
  class MockPost extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot) return;
      this.attachShadow({ mode: "open" }).innerHTML =
        '<slot name="full-post-link"></slot><slot name="credit-bar"></slot>' +
        '<div><div><slot name="title"></slot></div></div>' +
        '<slot name="text-body"></slot><slot></slot><div>▲ 1 ▼ · 0 comments</div>';
    }
  }
  customElements.define("shreddit-post", MockPost);
  customElements.define("shreddit-ad-post", class extends MockPost {});
</script>
</head>
<body><main id="main-content">${main}</main></body>
</html>`;
}

const PAGES: Record<string, () => string> = {
  "/": () => feedPage("AggregateFeed"),
  "/r/test/": () => feedPage("SubredditFeed"),
  "/r/many/": manyPage,
  "/r/mild/": mildPage,
  "/r/test/comments/pdp/slug/": commentsPage,
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

async function jev(mock: Mock, req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST" || req.url !== "/v1/systemone") return json(res, 404, { error: "not found" });
  const raw = await readBody(req);
  mock.attempts++;
  if (mock.failWith) return json(res, mock.failWith, { error: "mock failure" });
  if (req.headers.authorization !== "Bearer test-key") return json(res, 403, { error: "forbidden" });

  // Reject anything the real API would: the model name, and question types that are not lowercase.
  const body = JSON.parse(raw);
  const q = body.questions ?? {};
  const wellFormed =
    body.model === "jev-latest" &&
    q.asks_for_product?.type === "noul" &&
    q.has_pain?.type === "noul" &&
    q.pain_intensity?.type === "score" &&
    Array.isArray(q.pain_intensity.criteria) &&
    q.pain_intensity.criteria.length === 4 &&
    typeof body.state?.subreddit === "string" &&
    typeof body.state?.title === "string" &&
    typeof body.state?.body === "string";
  if (!wellFormed) return json(res, 422, { error: "bad body" });

  mock.calls.push(body.state);
  const text = `${body.state.title}\n${body.state.body}`;
  const [, asks, pain, intensity] = ANSWERS.find(([phrase]) => text.includes(phrase)) ?? ["", ...NEGATIVE];
  json(res, 200, {
    model: "jev-mock-1.0.0",
    answers: {
      asks_for_product: { noul: asks },
      has_pain: { noul: pain },
      pain_intensity: { score: intensity, probabilities: [0.25, 0.25, 0.25, 0.25], confidence: 0.5 },
    },
    usage: { input_tokens: 120 },
  });
}

export async function startMock(): Promise<Mock> {
  const dir = mkdtempSync(join(tmpdir(), "rp-cert-"));
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "2", "-subj", "/CN=www.reddit.com"],
    { stdio: "ignore" },
  );

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const host = (req.headers.host ?? "").split(":")[0];
    if (host === "api.typesafe.ai") return void jev(mock, req, res);
    const html = PAGES[(req.url ?? "/").split("?")[0]];
    if (!html) return void res.writeHead(404).end("not found");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html());
  };
  const server = createTlsServer(
    { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
    handler,
  ) as ReturnType<typeof createServer>;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const mock: Mock = {
    port: (server.address() as AddressInfo).port,
    calls: [],
    attempts: 0,
    failWith: 0,
    close: () =>
      new Promise((resolve) => {
        rmSync(dir, { recursive: true, force: true });
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return mock;
}
