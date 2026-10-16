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
| `record_network` | `true` records each request's method, address without its query, status and timing | `false` |
| `record_console` | `true` records console messages and uncaught errors, redacted | `false` |
| `record_pocketbase` | `true` records the calls of a PocketBase client an app passes to `startReplay`, never their values. See [PocketBase calls](integration.md#pocketbase-calls) | `true` |
| `upload_mode` | `session` uploads whole sessions; `trigger` keeps the recording on the device and uploads it only [when something breaks](#record-only-when-something-breaks) | `session` |

Rows store values as JSON text, so a selector row holds a JSON string such as `".chat-message, [class*=\"name\"]"`

The migration does not seed the `daily_limit_mb`, `mask_selector`, `block_selector`, `record_images`, `record_network`, `record_console`, `record_pocketbase` or `upload_mode` rows, so the server uses the initial values above until those settings are saved

Open clients check settings every 45 seconds

Uploads also check the current recording gate, so turning recording off refuses new chunks immediately

When several apps share one server, `REPLAY_APP_VERSION_PREFIX` can limit recording to clients whose `appVersion` begins with that value. The usual mode and percentage still apply. The prefix is checked at config, session start and upload; changing it stops uploads from existing sessions that no longer match. Leave it unset to admit every app. Because the client supplies `appVersion`, this is a recording selector, not an authentication rule

To include a second app while the primary prefix remains in place, set both `REPLAY_EXTRA_APP_VERSION_PREFIX` and `REPLAY_EXTRA_PLATFORM`. A client is selected when its `appVersion` matches the primary prefix, or when it matches the extra prefix **and** its `platform` equals the extra platform. Both values are checked again against the stored session on upload. Leaving either extra value unset preserves the primary-prefix behavior. When the primary prefix is unset, all apps remain eligible, as before. These values are recording selectors, not authentication rules

Every minute, a sweep deletes expired sessions 20 at a time for up to about 5 seconds

### Record only when something breaks

With `upload_mode` set to `trigger`, chosen as **Only when something breaks** under **Recording settings**, a selected device records as usual but keeps the recording in memory and uploads nothing. A trigger uploads what it kept and records live for one more minute:

- An uncaught error or unhandled promise rejection in the page, unless the app passes `triggerOnError: false`
- An error captured by `startObservability` when its `replay` option is the recorder and `beforeSend` keeps the error
- The app calling `replay.trigger(reason)`, for example from a **Report a problem** button. See [triggers](integration.md#triggers-and-bug-reports)

The device keeps from the newest full screen snapshot that is at least a minute old, so an upload starts one to two minutes before the trigger and always opens with a complete screen. It takes a fresh snapshot every minute for this and keeps at most 2 MiB of recording, starting again from a new snapshot when one part alone would exceed that. An uncaught error or a `trigger()` call during the live minute extends it

A server session starts only with the first trigger, so the hourly session limits and the daily storage budget count only devices where something happened. The session list shows the first trigger's reason, and the recording marks every trigger on its timeline. A later trigger after the live minute uploads into the same session while it lasts, with a gap on its timeline. A session lasts four hours: once it has ended or has less than 30 seconds left, for example after the device slept, the device goes on recording and keeping, and the next trigger starts a new session

Nothing is sent at page exit unless a trigger is live, and signing in or out discards what the device kept. Clients that predate trigger mode do not record at all while it is on, rather than upload whole sessions, and a whole-session recording still running when the mode is turned on is refused at its next upload. Sampling still decides which devices record, so `percentage` at 100 keeps a recording on every device and uploads only the ones that break

Errors captured while the device is only keeping its recording wait up to 10 seconds for the triggered session, so their **Watch replay** link opens the recording around them

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

A [Flutter app](../plugins/flutter/README.md#privacy) has no DOM for selectors to match. It reads two rules: `*` among the mask rules masks all its text, and `img` among the block rules all its images; `*` among the block rules does both. Text fields and `ReplayMask` areas are always masked there, and **Include images created in the app** does not apply, since a Flutter frame is an image of the whole screen

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

### Activity panel

Below the player, the activity panel lists the recording's clicks and page changes and, when recorded, its PocketBase calls, network requests and console messages, together with the session's stored errors and logs, up to the newest 1,000 of each with a note when there are more. Filter by kind, or choose **Errors** for errors, console errors and failed requests. Selecting a row moves playback there, and the row for the current moment is highlighted while the recording plays

A click names the element as it was at that moment, such as `button "Pay now"`, with masked text shown as `*`. Errors, failed requests and triggers are also marked on the timeline, at most 100 marks, with marks close together combined. A recording with more than 2,000 rows shows the rows around the current moment

Network requests and console messages need **Record network requests** and **Record console messages** under **Recording settings**. Both are off by default and apply to recordings made after the change

Calls of a [PocketBase client the app passes in](integration.md#pocketbase-calls) are listed under **PocketBase**, named by collection and action, such as `orders.create`, with their status, item count and refused fields. Failed calls are marked on the timeline. Selecting one opens its details under the row: what the app saw and, when the replay server is the app's own PocketBase, the server's side, such as the API rule that refused it or the hook error behind it

The explanations come from the collection's current rules, a current lookup of the record and, with `REPLAY_TRACE_REQUESTS=on`, PocketBase's request log. Inferences are marked as likely, and rules may have changed since the recording. Refused fields show names and codes; arbitrary validation messages are omitted. See [PocketBase calls](integration.md#pocketbase-calls) for the opt-in request-log marker and tracing overhead
