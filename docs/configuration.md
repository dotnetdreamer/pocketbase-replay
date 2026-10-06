# Settings and playback

[Back to README](../README.md)

## Security settings

Open **Security** in the dashboard to manage named ingestion keys
and the independent **Require API key** and **Require a signed-in account**
switches. Both default off and apply to replay, errors and logs

Create a key, configure the SDK's optional `apiKey` and update all senders
before enabling the key requirement. Verified accounts use the existing
`accountId` and `authToken` metadata and local or remote account verification

Each key can be revoked separately. Keys allow submission only; viewing data
and managing security always require a superuser. Key names do not provide
separate projects or storage budgets

See [ingestion security and its management API](authentication.md#optional-ingestion-requirements)
for setup, rotation and the limits of public client keys

### Rate limits

In **Security**, expand **Rate limits** to adjust replay and error/log
limits separately. Use **Save limits** to apply them. **Use default limits**
fills the form with the defaults below; it changes the server only after you
save. Saving limits does not save changes to the API key or account switches

Limits are always enabled, including when both security switches are off.
Values must be positive whole numbers. Saved changes apply to the next
request and keep the usage already counted. Raising a limit can allow more
traffic in the current window; lowering it can refuse further requests with
429 until usage drops below the new limit

| API field | Replay default | Errors and logs default | Allowed values |
| --- | --- | --- | --- |
| `config_requests_per_ip_minute` | `120` | `120` | 1 to 1000000 |
| `start_requests_per_ip_minute` | `30` | Not used | 1 to 1000000 |
| `upload_requests_per_ip_minute` | `240` | `120` | 1 to 1000000 |
| `upload_mb_per_ip_hour` | `64` MiB | `8` MiB | 1 to 1048576 MiB |
| `sessions_per_device_hour` | `12` | `30` | 1 to 1000000 |
| `sessions_per_ip_hour` | `120` | `120` | 1 to 1000000 |
| `sessions_per_hour` | `3000` | `20000` | 1 to 1000000 |

The replay request limits apply separately to `/config`, `/start` and
`/chunks`. For errors and logs, the upload request limit applies separately
to `/errors` and `/logs`, while both share the per-IP byte allowance. Session
limits count new recordings or diagnostic credentials; renewing a diagnostic
credential does not count as another session

Apps and users behind one IP share its limits, including people on the same
office or home network. Configure [trusted proxy headers](installation.md#behind-a-reverse-proxy)
so PocketBase sees the client address. The controls say MB; each unit means
1024 × 1024 bytes, or 1 MiB

The errors and logs values are the same settings shown under **Rate limits**
in **Diagnostics** settings. Saving in either panel updates those values.
Daily storage budgets, retention, sampling and privacy rules are separate
and stay unchanged when limits are saved

### Limits API

Superusers can read and save limits with `GET` and
`POST /api/replay/security/limits`. Both return
`{ replay: { ... }, observability: { ... } }` using the fields above. The
`observability` group omits `start_requests_per_ip_minute`

POST accepts either group, with some or all of its fields. Omitted fields
retain their current values; unknown groups or fields are rejected. For
example, to change only the replay upload request limit:

```json
{ "replay": { "upload_requests_per_ip_minute": 120 } }
```

Without saved limits the server uses the defaults above. No rate-limit
environment overrides are used. See [counter windows and limits](privacy-and-limits.md#server-rate-and-upload-limits)
for restart behavior and the bounded per-IP counters

## Diagnostics settings

Errors and logs have independent switches in the dashboard's **Diagnostics**
settings. Each has its own retention period, and they share a daily storage
budget. Open **Rate limits** here or in **Security** to adjust the same
new-credential, request and IP upload limits.
These switches do not change replay sampling

See [errors and logs](observability.md) for the settings table and client options

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
| `record_images` | `true` records images the app builds as `data:` URLs | `false` |

Rows store values as JSON text, so a selector row holds a JSON string such as `".chat-message, [class*=\"name\"]"`

The migration does not seed the `daily_limit_mb`, `mask_selector`, `block_selector` or `record_images` rows, so the server uses the initial values above until those settings are saved

Open clients check settings every 45 seconds

Uploads also check the current recording gate, so turning recording off refuses new chunks immediately

When several apps share one server, `REPLAY_APP_VERSION_PREFIX` can limit recording to clients whose `appVersion` begins with that value. The usual mode and percentage still apply. The prefix is checked at config, session start and upload; changing it stops uploads from existing sessions that no longer match. Leave it unset to admit every app. Because the client supplies `appVersion`, this is a recording selector, not an authentication rule

To include a second app while the primary prefix remains in place, set both `REPLAY_EXTRA_APP_VERSION_PREFIX` and `REPLAY_EXTRA_PLATFORM`. A client is selected when its `appVersion` matches the primary prefix, or when it matches the extra prefix **and** its `platform` equals the extra platform. Both values are checked again against the stored session on upload. Leaving either extra value unset preserves the primary-prefix behavior. When the primary prefix is unset, all apps remain eligible, as before. These values are recording selectors, not authentication rules

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

### Images built by the app

The app strips every `data:` URL from a recording by default, so pictures an app draws for itself, such as generated avatars or a photo held in memory, play back empty

Tick **Include images created in the app** under **Recording settings** to keep `data:` URLs for AVIF, GIF, JPEG, PNG, SVG and WebP images, in `src` attributes and CSS `url()` values

An image over 128 KB of URL text is still stripped, because a full snapshot is one event and an event over 1 MB stops the recording

`blob:` URLs are never recorded, because they point into the recording device's memory

Images loaded from ordinary `https` URLs are recorded with or without this setting, without their query string

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

Sessions are listed on the left, newest first, and the list loads 30 more as it is scrolled. The chosen recording plays on the right

Playback includes rrweb's timeline, speed and pause controls

Missing or unreadable chunks are marked as gaps, and playback waits for a complete DOM snapshot after each gap

A chunk whose sequence number has already been played is skipped

A session continues while its app is in the background, so it can hold hours with nothing recorded. Each stretch over 10 seconds with nothing recorded plays as 1 second, a mark on the timeline shows where, and the time on the device clock is shown under the player

An event the player cannot apply is skipped and counted under the recording's details, instead of stopping playback
