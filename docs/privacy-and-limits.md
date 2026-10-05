# Privacy and limits

[Back to README](../README.md)

## What is recorded

DOM replay reconstructs the page from recorded events, so external assets must remain available

It is not a pixel video archive, and canvas areas remain blank

- All input values and contenteditable text are masked
- Canvas, iframes, video and audio are blocked
- No screenshots, WebGL capture, microphone or network payload recording is enabled
- Replay does not record console output. The separate [logs feature](observability.md) can collect selected console levels when explicitly enabled
- Text rendered outside an input needs a mask or block rule, set in the dashboard or passed to `startReplay`, or a `sensitiveText` list
- A rule the app cannot parse stops recording instead of leaving text unmasked
- Sensitive attributes and every `data-*` attribute outside a short safe list are removed by default, which can make some layouts replay slightly off. Apps can opt in fixed, finite UI states with [`preserveDataAttributes`](integration.md#optional-settings)
- URL query strings and navigation fragments are stripped, but secrets embedded in URL path segments still need a blocking rule

Review [privacy rules](configuration.md#privacy-rules) against your actual UI and watch a new recording after changing the UI or its rules

## Access and upload protection

The dashboard's **Upload security** controls optional **Require API key**
and **Require a signed-in account** requirements. Both default off and apply to
replay, errors and logs. Each named key grants ingestion only, is stored as a
hash and can be revoked. Client keys are public and copyable; they do not prove
that a sender is your app. A verified-account requirement checks the existing
app token and refuses credentials admitted anonymously. See
[ingestion security](authentication.md#optional-ingestion-requirements)

Uploads use per-session credentials, gzip compression, sequence numbers and idempotent retries

All replay reads require a superuser, and client claims never authorize replay reads

Errors and logs use separate short-lived upload credentials. Linking an entry
to a recording requires that recording's upload credential and matching
account and device metadata. Error, log and alert reads also require a superuser

Ingestion keys do not divide the server into projects or separate budgets.
Existing server rate and storage limits remain shared, and server-enforced
limits are needed even when a key is required

DOM masking rules do not apply to error messages or log attributes. Configure
`sensitiveText` and `beforeSend` for the diagnostics controller, and avoid
putting private messages or personal data in application logs. See
[diagnostics privacy](observability.md#privacy-and-limits)

## Client buffers and recovery

The client bounds its buffers and discards all queued history when recovery is necessary, then records a fresh snapshot

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

Open **Rate limits** in **Upload security** to configure replay and error/log
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
