# Settings and playback

[Back to README](../README.md)

## Recording settings

The dashboard edits rows in `replay_settings`

| Key | Values | Initial value |
| --- | --- | --- |
| `mode` | `off`, `percentage`, `accounts` | `off` |
| `percentage` | 0 to 100, stable sampling by account or device | `0` |
| `account_ids` | JSON array of account IDs | `[]` |
| `retention_days` | 1 to 365 days | `14` |
| `daily_limit_mb` | 1 to 1048576 MB of gzip data a day | `1024` |
| `mask_selector` | CSS selector list whose text is recorded as `*` | `''` |
| `block_selector` | CSS selector list whose elements are replaced by empty boxes | `''` |

Rows store values as JSON text, so a selector row holds a JSON string such as `".chat-message, [class*=\"name\"]"`

The migration does not seed the `daily_limit_mb`, `mask_selector` or `block_selector` rows, so the server uses the initial values above until those settings are saved

Open clients check settings every 45 seconds

Uploads also check the current recording gate, so turning recording off refuses new chunks immediately

Every minute, a sweep deletes expired sessions 20 at a time for up to about 5 seconds

### Storage budget

`daily_limit_mb` caps the gzip bytes of sessions started in the last 24 hours

Once the limit is reached, uploads receive 429 `Replay storage budget reached` until older sessions leave that window

Chunks are stored as base64 text, which is a third larger than the bytes counted by the limit

At the defaults of 1024 MB a day and 14 days of retention, plan for about 14 GiB of recordings and about 19 GiB of disk

## Privacy rules

Edit `mask_selector` and `block_selector` under **Recording settings** in the dashboard using ordinary CSS selector lists

- Separate rules with commas because a line break alone is a descendant combinator in CSS
- Rules live on the replay server and can change without an app release
- Each selector list can hold up to 20,000 characters
- Control characters other than tabs and line breaks are refused

When `/config` and `/start` answer `enabled: true`, they send these settings to the app as `maskTextSelector` and `blockSelector`

The app combines them with its built-in rules for inputs, `[contenteditable]`, `[data-replay-mask]`, canvas, media, iframes and `[data-replay-block]`, plus any `maskTextSelector` or `blockSelector` passed to `startReplay`

### Apply rule changes

Changes apply to future recording

An open app picks up the rules at its next settings check, within about a minute, then restarts its recorder so the next full snapshot uses them

Stored recordings keep the rules they were recorded with

Before recording, the app checks every server and app rule with the page's own CSS parser

If any rule cannot be parsed, the app records nothing and checks again at the next poll

A running recording that receives an invalid rule stops, keeps what it has already recorded, and resumes once the rule is fixed

The dashboard refuses to save selectors its browser cannot parse

An older app WebView can still reject syntax accepted by a newer desktop browser, such as `:has()` before Chromium 105

Watch a new recording after each change

## Filter and play sessions

Filter sessions by account, device, a date range in the viewer's local time, or any room visited during the session

The room filter matches a complete room code without regard to letter case

Playback includes rrweb's timeline, speed and pause controls

Missing or unreadable chunks are marked as gaps, and playback waits for a complete DOM snapshot after each gap

A chunk whose sequence number has already been played is skipped
