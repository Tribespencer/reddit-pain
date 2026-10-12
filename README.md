# Reddit Pain

A Chrome extension that highlights Reddit posts and comments where someone is asking for a product or describing a problem a product could solve.

As you scroll reddit.com, each post and comment is labelled by TypeSafe's Jev model. Hits get a box drawn around them:

- **Green box, `ASKING FOR PRODUCT`**: the author is asking for a tool, app or service, asking for a recommendation, or asking whether something exists.
- **Amber box, `PAIN`**: the author describes a problem, frustration or unmet need that software could plausibly solve.
- **Pain intensity**, scored 0 to 3: mild annoyance, recurring problem, costing them real time or money, or urgent and actively looking for any fix.

Everything else is left untouched.

## You need your own API key

Reddit Pain does not come with a key. You need a TypeSafe API key with access to the Jev model, and **every labelled item is one API call billed to your key**. See [Cost](#cost) before a long scrolling session.

## Install

Requires Chrome 120 or newer and Node.js 18 or newer.

```bash
git clone <this repo's URL>
cd reddit-pain
npm install
npm run build
```

Then load it into Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `dist` folder.
4. Click the Reddit Pain toolbar icon to open its settings.
5. Paste your TypeSafe API key, click **Test Jev connection**, then **Save**.
6. Open or refresh a reddit.com tab and scroll.

To update, pull the latest code, run `npm run build` again, and click the reload button for Reddit Pain on `chrome://extensions`.

## What it sends and what it stores

Read this before installing. The extension works by sending what you read to a third party.

**Sent to `api.typesafe.ai`**, using your key, for each post and comment that scrolls into view on `www.reddit.com`:

- the subreddit name
- the post title (for a comment, the title of the post it sits under)
- the body text, cut to 6,000 characters

Usernames and links are not sent. Promoted posts and comments with no text are skipped. Each item is sent once; later sightings reuse the stored labels.

**Stored on your computer**, in the extension's own browser storage:

- your API key, in plain text in Chrome's extension storage
- every labelled item: its text, author username, permalink, labels, and the time you saw it

Nothing is sent anywhere other than `api.typesafe.ai`. There is no analytics, no tracking and no server run by this project. **Delete all stored items** on the settings page clears the item store, and removing the extension removes everything.

What TypeSafe does with the text it receives is governed by TypeSafe's own terms and privacy policy, not by this project.

## Cost

One API call is made for every post and every comment that appears on screen, hit or not. A long comment thread can mean hundreds of calls. There is no cap by default.

To set one, change `ITEM_CAP` in [src/config.ts](src/config.ts) from `null` to a number and rebuild. Once that many items are stored, no further calls are made until you delete the stored items.

The settings page shows the model, response time and input tokens for a test call, which is a quick way to estimate what a session will cost you.

## Settings you can change

All in [src/config.ts](src/config.ts); rebuild after editing.

| Setting | Default | What it does |
|---|---|---|
| `THRESHOLD` | `0.5` | Minimum score for a post to be highlighted. |
| `MAX_BODY_CHARS` | `6000` | Longest body sent to Jev. |
| `ITEM_CAP` | `null` | Stops calling Jev once this many items are stored. |
| `INTENSITY_LEVELS` | four levels | Wording for the pain intensity scale. |
| `QUESTIONS` | see file | The questions Jev is asked about each item. |

## Limits

- Works on `www.reddit.com` only, not `old.reddit.com` or the mobile apps.
- It reads Reddit's page markup, which Reddit can change at any time. If highlights stop appearing, the selectors in [src/extract.ts](src/extract.ts) are the place to look.
- Labels come from a model and will sometimes be wrong.

## Development

```bash
npm run typecheck
npx playwright install chromium
npm test
```

The tests load the built extension into Chromium against a local mock that stands in for both Reddit and the Jev API, so they use no real key and make no real calls. They need `openssl` on your PATH.

## Disclaimer

This is an independent project. It is not affiliated with, endorsed by or sponsored by Reddit, Inc. or TypeSafe. "Reddit" is a trademark of Reddit, Inc.

You are responsible for how you use it, including complying with Reddit's User Agreement and TypeSafe's terms, and for any charges on your API key. The software is provided as is, with no warranty; see the license.

## License

[MIT](LICENSE)
