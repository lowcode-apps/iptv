# IPTV Web Player

A browser player for the channels in this repository — browse by country or
category, search, favourite, and play without opening VLC.

Everything lives inside `web/`. No file tracked by `iptv-org/iptv` upstream is
modified, so `git merge upstream/master` stays conflict-free.

```
web/
├── public/              # deployed as-is
│   ├── index.html
│   ├── app.js           # browsing, search, player, source fallback
│   ├── app.css
│   ├── _headers         # cache + security headers for Pages
│   └── data/            # generated, gitignored
├── functions/
│   └── proxy.js         # Cloudflare Pages Function, served at /proxy
└── scripts/
    └── build-index.mjs  # builds public/data from ../streams + iptv-org API
```

## Why a proxy is needed

A plain static page cannot reach every stream in this repo. Measured against a
120-source sample of the generated index:

| Blocker | Share | Fixable without a server? |
| --- | --- | --- |
| `http://`-only source | 27% | No — an `https://` page refuses to load it |
| Needs `User-Agent` / `Referer` | 8% | No — both are forbidden headers in browser `fetch` |
| Origin sends no CORS header | ~0% | No |
| Origin unreachable / offline | 13% | Nothing fixes a dead stream |
| Reachable, CORS-friendly `https://` | 52% | **Yes** — plays with no proxy at all |

CORS turned out to be a non-issue: every reachable `https://` source in the
sample already sent `Access-Control-Allow-Origin`. The real blockers are
mixed content and the forbidden headers, which is what `/proxy` exists for.

Because about half of all sources play directly, the player tries a **direct
connection first** and only falls back to the proxy when that fails. That keeps
proxy traffic — and your Cloudflare request count — to what actually needs it.
The ladder for every channel is: direct → proxy → the channel's next source.

## Local development

```bash
cd web
npm run build      # generate public/data from ../streams (needs network once)
npm run dev        # wrangler pages dev — serves the site *and* /proxy
```

`npm run dev` runs the real Workers runtime, so the proxy behaves exactly as it
will in production. A plain static server (`npm run serve`) works too, but
`/proxy` will 404 and only the directly-playable sources will work.

The build caches the iptv-org API payloads (~15 MB) in `web/.cache/` for six
hours. Delete that directory to force a refresh.

## Deploy to Cloudflare Pages

### Via the dashboard (recommended — rebuilds on every push)

Workers & Pages → Create → Pages → connect this fork, then:

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Production branch | `master` |
| Root directory | `web` |
| Build command | `npm run build` |
| Build output directory | `public` |

`functions/proxy.js` is picked up automatically and served at `/proxy` on the
same origin, so there is no second deploy and no cross-origin hop.

Two things make that configuration work, both already committed:

- **`web/.node-version`** pins Node 22. The build calls global `fetch`, which
  needs Node 18 or newer, and Pages' default is not guaranteed to be recent
  enough. (Setting a `NODE_VERSION` environment variable does the same job.)
- **`web/wrangler.toml`** declares `pages_build_output_dir = "public"`, so the
  output directory is version-controlled rather than only living in the
  dashboard. Its `name` must match the Pages project name — rename the project
  or the file together, not one of them.

Root directory `web` does not shrink the checkout: Pages clones the whole repo
and only changes the working directory, so `build-index.mjs` can still read
`../streams`.

Every push rebuilds the index, so syncing the fork with upstream is enough to
pick up new channels:

```bash
git fetch upstream && git merge upstream/master && git push
```

### Via the CLI

```bash
cd web
npx wrangler login
npm run deploy     # builds, then wrangler pages deploy public
```

## Limits worth knowing

**Request budget.** The Workers free plan allows 100,000 requests/day. A single
viewer on a proxied stream with 6-second segments uses roughly 1,200
requests/hour (segments plus manifest refreshes), so the free tier covers on the
order of 80 single-stream viewing hours per day. "Try direct connection first"
is on by default precisely to keep most playback off the proxy entirely.

**Cloudflare's terms.** Cloudflare's Service-Specific Terms restrict serving a
disproportionate amount of non-HTML content — video included — through the CDN
on free plans. Personal use is fine; a widely shared deployment that proxies
video continuously is not what the free plan is for. Use Workers Paid if this
grows beyond personal use.

**The proxy is open by design.** It will fetch any public http/https URL for
anyone who can reach it. It blocks loopback, private, link-local and CGNAT
targets, but it cannot stop a hostname that *resolves* to a private address,
because Workers cannot resolve DNS before fetching. Don't treat it as a hardened
service — if you share the URL, put Cloudflare Access in front of it.

**Stream availability.** These are public streams that go offline without
notice; roughly 13% of sources in the sample were already dead. The player
marks failed sources, strikes them through, and moves to the next one
automatically.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `/` | Focus search |
| `Esc` | Close player or settings |
| `f` | Fullscreen |
| `m` | Mute |
| `n` | Next source for this channel |

## Settings

Stored per-browser in `localStorage`:

- **Stream proxy URL** — `/proxy` by default. Clear it to play only what works
  without a server (useful if you deploy the static files somewhere else).
- **Try direct connection first** — on by default; see above.
- **Show adult channels** — off by default; filters channels flagged `is_nsfw`
  in the iptv-org database.
- **Auto-advance on failure** — on by default; walks the channel's other sources.

## Data

`build-index.mjs` parses `../streams/*.m3u` from this fork and joins it against
the [iptv-org API](https://github.com/iptv-org/api) for names, logos, countries
and categories. Current build: **13,434 channels / 18,456 sources / 181
countries**. Output is sharded so the first paint stays small — 3 KB gzipped for
the country and category index, 30–160 KB per country, 147 KB for the global
search index (loaded on first search).

`public/data/` is gitignored and rebuilt on every deploy.

## Legal

This player only renders playlists already present in this repository. It hosts
no streams and changes nothing about their licensing — see the upstream
[README](../README.md#legal).
