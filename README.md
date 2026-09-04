# ai-guide

Turn Xiaohongshu travel notes into a TREK itinerary

![screenshot](./docs/screenshot.png)

## What it does

AI Guide turns a destination, Xiaohongshu note URL, or pasted travel note into a
mapped preview. Every place is resolved to WGS-84 coordinates by the plugin's
own Nominatim client (`server/geo/nominatim.js`) — no host RPC, no map API key,
no changes to TREK's core. After reviewing and deselecting days or places, the
user can create a new TREK trip. Keyword search is optional and degrades to the
form/link/paste flow when a Xiaohongshu session is unavailable.

## Screenshots

Show it in context. Commit a `docs/screenshot.png` — it's what the store card
shows. A 16:9 image (e.g. 1600×900) with your plugin centred and some margin
looks best (the card crops the edges).

## Permissions

| Permission | Why |
|---|---|
| `ai:invoke` | Extract named places from supplied notes and write bounded itinerary copy. |
| `db:own` | Store resumable per-user planning jobs and drafts. |
| `db:create:trips` | Create the confirmed result as a new trip. |
| `db:read:trips` | Read the days created with the new trip before assigning places. |
| `db:write:places` | Create only the evidence points selected in the preview. |
| `db:write:itinerary` | Assign created places to their previewed days. |
| `db:read:categories` | Read TREK's place categories for itinerary classification. |
| `db:meta` | Mark a created trip with its originating AI Guide job. |
| `hook:user-data` | Delete or export the plugin's own per-user job metadata. |
| `http:outbound:www.xiaohongshu.com` | Read public Xiaohongshu note pages. |
| `http:outbound:edith.xiaohongshu.com` | Try user-authorized session search and note details. |
| `http:outbound:xhslink.com` | Resolve Xiaohongshu short links without following outside the allowed hosts. |
| `http:outbound:nominatim.openstreetmap.org` | Resolve every candidate to WGS-84 coordinates via the plugin's own Nominatim client. |

## Setup

Enable the `llm_parsing` addon and configure TREK's AI provider. The plugin
resolves places with its own Nominatim client — no map API key and no changes
to TREK's core are required.

Optional keyword search uses each user's own secret `xhs_cookie`, entered under
Settings → Plugins. Paste the full web Cookie from `www.xiaohongshu.com` after
login; it must include `a1` and `web_session`. The Cookie never enters the iframe,
logs, AI prompts, drafts, or user-data exports. Public note URLs are read without
the Cookie. URL, pasted-text, and form-only planning work without it.

See [docs/xhs-open-source-review.md](./docs/xhs-open-source-review.md) for why
raw Cookie POSTs to `edith.xiaohongshu.com` are rate-limited, and which
open-source behaviours this plugin now follows.

## License

MIT
