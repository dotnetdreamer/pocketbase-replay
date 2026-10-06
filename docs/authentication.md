# Upload security, authentication and account deletion

[Back to README](../README.md)

Error and log ingestion uses the same account verification as replay. Account
deletion also erases related errors and logs and updates affected issue
summaries. Alerts disappear when an issue has no remaining occurrences; shared
issues retain alerts with updated titles. See [errors and logs](observability.md)

## Optional ingestion requirements

Open **Security** in the dashboard to configure two independent
requirements, shared by replay, errors and logs:

| Setting | Default | Effect |
| --- | --- | --- |
| **Require API key** | Off | Config, session creation and uploads must carry a valid ingestion key |
| **Require a signed-in account** | Off | New sessions need a verified account; uploads from credentials admitted anonymously are refused |

With both switches off, existing integrations continue to work without an API
key or a signed-in account. When both are on, each client needs both. Sampling
and the feature switches still decide what is collected

The **Rate limits** section in this panel controls replay and error/log
traffic separately. These protections apply even when both switches are off.
Use **Save limits** to apply changes; **Use default limits** fills the form
without changing the server until you save. Limits and security switches
save separately. See [rate limits](configuration.md#rate-limits)

Create a named key before enabling **Require API key**. The raw key is shown
once; copy it into the client configuration and deploy that change to every
sender before enabling the requirement. You can create several keys, for
example one per app or environment, and revoke them independently. The server
stores hashes, and later key lists show metadata only. It refuses to revoke
the last key while the requirement is on; disable the requirement first if
you need to remove every key

```ts
const apiKey = 'YOUR_INGESTION_KEY';

const replay = startReplay({ endpoint, apiKey, metadata });
const diagnostics = startObservability({
  endpoint, apiKey, metadata, errors: true, logs: true, replay,
});
```

`apiKey` is optional on both client controllers and on the Capacitor plugin's
`start` and `startObservability`. Empty values are omitted. The SDK sends it
in JSON bodies, including page-exit beacons, so custom transports must preserve
the body. Custom senders must include `apiKey` on replay `/config`, `/start`
and `/chunks`, diagnostics `/observability/config`, and `/errors` and `/logs`

Keys authorize ingestion only. They cannot read recordings, errors or logs,
change settings, delete data or create other keys. Dashboard and management
routes always require a PocketBase superuser. Key names do not create tenants:
apps using different keys still share this server's existing storage and rate
limits

A key in a browser bundle or installed app is public and copyable. It provides
a revocable admission requirement, not proof that a request came from your
app. To require a signed-in user, enable **Require a signed-in account** and
configure the account verification below. When this is enabled, existing
anonymous upload credentials stop working; the SDK can request new credentials
after sign-in and `refresh()`

### Management API

These routes require superuser authentication:

| Route | Request and response |
| --- | --- |
| `GET /api/replay/security` | Returns `{ requireApiKey, requireAccount, keys }`; `keys` contains metadata only |
| `POST /api/replay/security` | Saves `{ requireApiKey, requireAccount }` |
| `POST /api/replay/security/keys` | Accepts `{ label }`; returns `{ key, apiKey }`, with the raw `apiKey` shown only on creation |
| `DELETE /api/replay/security/keys/{id}` | Revokes the key |
| `GET /api/replay/security/limits` | Returns `{ replay, observability }` with the current rate limits |
| `POST /api/replay/security/limits` | Saves supplied groups and fields, preserving omitted values and unrelated settings |

The [limits API](configuration.md#limits-api) lists fields, defaults and
validation rules. Saving limits does not reset current usage counters

### How other providers handle client keys

[PostHog separates its public project token from private API credentials](https://posthog.com/docs/api).
[Sentry uses a public DSN for SDK submission](https://docs.sentry.io/concepts/key-terms/dsn-explainer/),
while [reading replays requires scoped authentication](https://docs.sentry.io/api/replays/retrieve-a-replay-instance/).
[Datadog documents its client token as visible and ingestion-only](https://docs.datadoghq.com/data_security/real_user_monitoring/),
and describes an authenticated proxy that checks a signed-in user before
forwarding telemetry

PocketBase Replay uses the same separation between ingestion and read access.
Server-enforced rate, payload and storage limits remain necessary with a key.
Client-side sampling and browser CORS rules do not authenticate senders

## Verify accounts

When replay shares your app's PocketBase database, the recorder's `authToken` is verified locally

For a dedicated replay database, set this **server-only** environment variable on the replay server

```text
REPLAY_AUTH_URL=https://your-app.example.com/api/collections/users/auth-refresh
```

Only this configured endpoint receives the app token, and the client sends the token only when it also sends an account ID

- Account allowlists require a verified account ID
- Anonymous sessions work with percentage sampling while **Require a signed-in account** is off
- Device, platform, version and room remain client claims and cannot establish an account's identity

### Selection and verification

When **Require a signed-in account** is off, the server first checks whether the
claimed account or device would be selected. It returns `enabled: false` from
`/config` and `/start` without checking the account token for an unselected
client. A false claim can only opt that client out. For a selected client
that supplies an account ID, the server verifies the token and confirms that
it belongs to the claimed account

When **Require a signed-in account** is on, the server verifies the account
before checking selection. Anonymous clients cannot use config requests to
probe the recording settings. The API key requirement, when enabled, is
checked before selection in either case

A successful remote check is cached for 10 minutes using the token's SHA-256 as the key, with room for up to 1,000 tokens

When full, the cache replaces the entry closest to expiry

| Answer | When | What the client does |
| --- | --- | --- |
| 401 | The token is missing, refused or invalid, or belongs to another account | Stops recording |
| 503 `Account service unavailable` | `REPLAY_AUTH_URL` cannot be reached, takes over 3 seconds, or answers 429 or 5xx | Keeps its session and tries again at the next poll |

An app server restart can therefore pause verification without ending every running recording

## Delete an account's recordings, errors and logs

When replay shares your app's database, it erases associated recordings, errors
and logs before a `users` record is deleted

Set `REPLAY_AUTH_COLLECTION` if your accounts use another collection name

With a separate app database, call the replay erasure route before completing account deletion

```text
POST /api/replay/forget
X-Replay-Erase-Key: YOUR_SERVER_ONLY_KEY
Content-Type: application/json

{"accountId":"ACCOUNT_ID"}
```

- Set `REPLAY_ERASE_KEY` to the same random secret of at least 32 characters on both servers
- Repeat the request until `remainingSessions`, `remainingErrors` and
  `remainingLogs` are all zero. Older servers omit the diagnostic counts
- Each request removes up to 200 sessions and their chunks, 1,000 errors and
  1,000 logs. It blocks new recording and diagnostic sessions for that account
  for 24 hours
- If erasure fails, fail or retry account deletion, or let the retention period remove the remaining recordings
- Keep this endpoint internal where possible

The dashboard's superuser API also supports `DELETE /api/replay/accounts/{id}` with the same batched response

Sessions recorded without an account are not linked to that account and expire according to retention settings

### Delete through the dashboard

With `REPLAY_ERASE_KEY` unset, the erasure route returns 503, so use the dashboard to delete recordings manually

- **Delete** on a session row removes that recording. Errors and logs linked to
  it stay, without the link
- The account deletion action removes its recordings, errors and logs, in
  batches until none remain

Neither dashboard action blocks the account from being recorded again
