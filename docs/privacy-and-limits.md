# Privacy and limits

[Back to README](../README.md)

## What is recorded

DOM replay reconstructs the page from recorded events, so external assets must remain available

It is not a pixel video archive, and canvas areas remain blank

- All input values and contenteditable text are masked
- Canvas, iframes, video and audio are blocked. Nothing inside a blocked element is uploaded, including the page in a same-origin iframe and content added to a blocked element's shadow root
- The DOM recorder takes no screenshots. WebGL capture, microphone and network payloads are not recorded
- With **Record network requests** on in Recording settings, each `fetch` and `XMLHttpRequest` adds only its method, address without its query, status and timing, at most 100 a minute. Headers and bodies are never read, and requests to the replay API itself are skipped
- With **Record console messages** on, the recording also carries console output and uncaught errors, at most 100 a minute and 1,000 characters each. Text is redacted as for [diagnostics](observability.md#privacy-and-limits) and by `sensitiveText`, and errors show only their name and message. It is off by default because console output can contain private content. The separate [logs feature](observability.md) stores selected console levels on its own
- Page changes made through the browser history are noted by address without query or fragment, at most 50 a minute
- For an app that passes its PocketBase client, each call adds its collection, action, record ID, status, time, item counts, fixed standard PocketBase error messages and the names and codes of refused fields, at most 150 a minute. Arbitrary validation and hook messages are omitted because they can echo private values. Request and response field values, filter text and auth tokens are not recorded. The call's random ID, and the recording's ID while one is live, go to the app's own PocketBase in an `X-Replay-Request` header. Only when the latest replay configuration advertises `REPLAY_TRACE_REQUESTS=on`, the same IDs also go in a `__replayRequest` query marker to survive failures before the tracing hook. Clients pick up tracing changes at their next settings check. The dashboard's explanation of a call reads PocketBase's request log without its query string, IP address or user agent
- Text rendered outside an input needs a mask or block rule, set in the dashboard or passed to `startReplay`, or a `sensitiveText` list
- A rule the app cannot parse stops recording instead of leaving text unmasked
- Sensitive attributes and every `data-*` attribute outside a short safe list are removed by default, which can make some layouts replay slightly off. Apps can opt in fixed, finite UI states with [`preserveDataAttributes`](integration.md#optional-settings)
- URL query strings and navigation fragments are stripped. In activity route and network URLs, `sensitiveText` also redacts matching path text, including its percent-encoded form. Other private path segments still need app-specific handling; DOM masking does not sanitize diagnostic or network URLs

Review [privacy rules](configuration.md#privacy-rules) against your actual UI and watch a new recording after changing the UI or its rules

### Capacitor screenshot mode

The [Capacitor plugin](../plugins/capacitor/README.md#screenshot-replay) can record
masked screenshots of the native Android or iOS WebView. It is off by default;
the DOM recorder remains the default. Native views, system sheets and the
keyboard outside the WebView are excluded

Inputs and editable areas, `data-replay-mask` areas, configured mask and block
selectors, and visible text matching `sensitiveText` are painted over in native
code before images cross the bridge. Canvas, embedded pages and media are
blocked. Images and CSS background images are masked by default; allowing them
requires both `maskAllImages: false` and the dashboard's **Record images** switch

Privacy inspection must succeed before and after each capture. Unstable or
zoomed layouts skip frames, and no frame is taken while a CSS transition or
animation runs in the page or when it has more than 10,000 displayed elements
and text nodes. Painting effects that cannot be safely bounded can mask the
whole viewport. Explicitly mask other private content, and review recordings
after changing your UI. Private controls use a generic activity label and
positions at the centre of their mask

On iOS the snapshot covers the whole WebView, so a frame is taken only when the
page's viewport fills it, as with Capacitor's default `ios.contentInset` of
`never`. Content insets would move every mask, so no frames are taken with them

A closed shadow root cannot be found from outside its host, so on Android and
iOS the plugin watches `attachShadow` from the moment the app loads it, and
screenshot mode inspects each closed root it saw attached like an open one. The
watch only notes roots; pages behave as before. Import the plugin before the
app renders. A custom element already set up when the plugin loaded may hold a
closed root that nothing can see, so it masks the whole viewport. Angular
component hosts and Ionic components rendered after the import are inspected
like other elements

Some closed roots stay invisible: one attached before the plugin loaded to an
element that is not a custom element, one declared in the HTML with
`shadowrootmode="closed"`, and one attached by a library that kept its own
reference to `attachShadow` from before the plugin loaded. Mark such a host
with `data-replay-mask` and clip its content to that host (for example with
`overflow: hidden` or `contain: paint`), or leave screenshot mode off on that
screen. Private pixels inside an unmarked root of this kind are not
automatically recognised

PNG images are at most 1280 pixels on the longer side and 192 KiB each.
Captures default to a one-second interval, unchanged images are skipped, and
native pause/resume and the server's recording settings still apply. Frames
upload as they are taken, with client buffers sized for images as in Flutter
replay. In trigger mode the device keeps up to 6 MiB of frames: a minute or
more of a screen that changes now and then, less when large frames change every
second. The server's session limits and [per-IP upload allowance](#upload-volume)
still apply, and a screen that changes every second can send several MiB a
minute. Longer intervals and trigger mode help limit storage

### Flutter apps

The [Flutter plugin](../plugins/flutter/README.md) records the screen as images, so whatever is visible is recorded, apart from what it paints over on the device before a frame leaves it:

- Text fields, always, with the text selection magnifier, and any widget inside `ReplayMask`
- Text containing a `sensitiveText` word, and all text or all images when the app asks for it or the dashboard's mask rules include `*` or its block rules `img` or `*`. Other CSS rules apply only to web pages
- Platform views and textures, such as maps, web views and video, as plain grey boxes

Frames are PNG images of at most 1280 pixels on the longer side, taken at most once per second by default and only when the screen changed; when only part of it changed, only that area is sent. Masks follow painted descendants through transforms and overflow, so a page covered by another route is left alone. Sensitive text is checked against its visible spans, including visible overflow, rather than alternate accessibility text. Text drawn by a `CustomPainter` is not recognised as text and needs a `ReplayMask` covering its painted area; images drawn with `Ink` also need an explicit mask

A tap names a public control by its text or safe semantics label and never shows a text field's content. Controls inside one `ReplayMask` share a generic `*` target covering the outermost mask, and their tap, hover and drag positions are coarsened to its centre. A semantics label that includes masked descendants is replaced by individually redacted visible text. Network requests, console output, page changes and PocketBase calls are recorded under the rules above, with route names as page addresses

Frames are larger than DOM events: the Flutter client buffers up to 8 MiB before it starts again from a fresh frame, and in trigger mode keeps at most 6 MiB on the device. It has no exit beacon: leaving the screen uploads what is queued, and `stop()` drops what is left, so call `flush()` first

## Access and upload protection

The dashboard's **Security** settings control optional **Require API key**
and **Require a signed-in account** requirements. Both default off and apply to
replay, errors and logs. Each named key grants ingestion only, is stored as a
hash and can be revoked. Client keys are public and copyable; they do not prove
that a sender is your app. A verified-account requirement checks the existing
app token and refuses credentials admitted anonymously. See
[ingestion security](authentication.md#optional-ingestion-requirements)

Uploads use per-session credentials, gzip compression, sequence numbers and idempotent retries

All replay reads require a superuser, or an [AI agent](ai-agents.md) key a
superuser created, and client claims never authorize replay reads

Errors and logs use separate short-lived upload credentials. Linking an entry
to a recording requires that recording's upload credential and matching
account and device metadata. Error, log and alert reads also require a superuser
or an agent key with that scope

Agent keys only read issues, logs and recordings, each within the scopes it was
given, and every request is kept in an audit log for 30 days. Agents read
recordings as text: pages, element labels, form fields changed without their
values, calls, console output and errors, all from the masked recording. That
text is stored with the recording and deleted with it. Tool results go to the
agent's model provider, so give each key only the scopes it needs. See
[security and privacy](ai-agents.md#security-and-privacy)

Ingestion keys do not divide the server into projects or separate budgets.
Existing server rate and storage limits remain shared, and server-enforced
limits are needed even when a key is required

DOM masking rules do not apply to error messages or log attributes. Configure
`sensitiveText` and `beforeSend` for the diagnostics controller, and avoid
putting private messages or personal data in application logs. See
[diagnostics privacy](observability.md#privacy-and-limits)

## Client buffers and recovery

The client bounds its buffers and discards all queued history when recovery is necessary, then records a fresh snapshot

In [trigger mode](configuration.md#record-only-when-something-breaks) the recording stays in the page's memory, at most 2 MiB from the newest full snapshot at least a minute old, with a fresh snapshot every minute. It is sent only after a trigger and is otherwise discarded, including at page exit and when the account or device changes. A trigger may briefly let the upload queue hold that whole backlog

A single event over 1 MiB stops that recorder instance to protect the host app from oversized pages

### Failed uploads

| Response | Client behavior |
| --- | --- |
| No status, 408, 429 or 5xx | Keeps the chunk and retries after 5 seconds, doubling the delay to at most 5 minutes |
| 410 | Starts a new session |
| 413 | Takes a fresh snapshot |
| 401, 403 or 404 | Ends the session, and the next poll decides whether to start another |
| Any other 4xx, such as 400, 409 or 422 | Drops the queue and takes a fresh snapshot, and three in a row stop recording until the account or device changes |

A successful upload resets the retry delay

A successful `/config` poll resets it only when the last failure had no status, so a 429 or 5xx still waits its turn

### Flush and page exit

Chunks normally flush every 25 seconds

Native pause flushes through `CapacitorHttp` or the injected transport

At web page exit, the chunk still being compressed, pending batches and the buffer are packed into one chunk per room, up to 256 KB in all before compression, and sent with queued chunks by `sendBeacon` within a 60 KB budget

A chunk whose `keepalive` upload is already under way is not sent again

Abrupt process termination can lose a tail

## Session limits

| Limit | Maximum per session |
| --- | --- |
| Duration | Four hours |
| Chunks | 2,048 |
| Compressed data | 40 MiB |
| Declared raw data | 96 MiB |
| Events | 500,000 |

The server answers 410 past a limit, and the client then starts another session

The client also moves to a new session on its own before it would send chunk 2,048, dropping any chunks still queued

Chunk times may be up to 24 hours ahead of the server clock, so a phone whose clock is slow, or up to a day fast, still uploads

`/start` returns `expiresIn`, and the client times the session's four hours from it on its own clock

## Server rate and upload limits

Open **Rate limits** in **Security** to configure replay and error/log
limits separately. The values below are the replay defaults. Limits stay
enabled when API key and account requirements are off, and apply to all apps
and keys using this server. [Configuration](configuration.md#rate-limits)
lists all defaults and allowed ranges

Every per-IP limit uses the address PocketBase sees, so configure the server when it is [behind a reverse proxy](installation.md#behind-a-reverse-proxy)

Users behind the same IP share its allowance. Saved changes apply immediately
without resetting the usage already counted. Daily storage budgets are
separate from these request, session and per-IP byte limits

### Upload volume

By default, each client IP may upload 64 MiB of gzip data an hour

Past that, uploads get 429 `Replay upload budget reached`

Once 4,096 IPs have uploaded in an hour, new ones are not counted until the next hour, and `daily_limit_mb` still caps the total

### Requests

| Route | Default requests per IP per minute |
| --- | --- |
| `/config` | 120 |
| `/start` | 30 |
| `/chunks` | 240 |

The server answers 429 `Too many replay requests` past these limits

Once it counts 4,096 route-and-IP pairs in a minute, new pairs are not counted until the next minute

### New sessions

| Scope | Default new sessions per hour |
| --- | --- |
| Device | 12 |
| IP | 120 |
| Total | 3,000 |

### Counter windows and restarts

Request counters use fixed minute windows; per-IP byte counters use fixed
hour windows. These counters are held in server memory and reset when their
window changes or PocketBase restarts. Saving limits keeps the current
counters. New-session limits count stored sessions or credentials created
within the preceding hour, so their counts survive a restart

The per-IP maps remain bounded at 4,096 entries. Once a map is full, new
entries are not counted until its next window. PocketBase's own rate
limiter and the daily storage budgets still apply

## Browser compatibility

The client requires Chromium 91 or newer

No `structuredClone`, `randomUUID` or `CompressionStream` is required

Compression runs in a worker, except the page-exit tail, which is compressed synchronously
