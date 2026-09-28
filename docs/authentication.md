# Authentication and account deletion

[Back to README](../README.md)

## Verify accounts

When replay shares your app's PocketBase database, the recorder's `authToken` is verified locally

For a dedicated replay database, set this **server-only** environment variable on the replay server

```text
REPLAY_AUTH_URL=https://your-app.example.com/api/collections/users/auth-refresh
```

Only this configured endpoint receives the app token, and the client sends the token only when it also sends an account ID

- Account allowlists require a verified account ID
- Anonymous sessions work with percentage sampling
- Device, platform, version and room remain client claims and cannot establish an account's identity

### Selection and verification

The server first checks whether the claimed account or device would be selected, returning `enabled: false` from `/config` and `/start` without checking the token if it would not

Skipping verification here is safe because a false claim can only opt the client out

For selected clients, the server verifies the token and confirms that it belongs to the claimed account

A successful remote check is cached for 10 minutes using the token's SHA-256 as the key, with room for up to 1,000 tokens

When full, the cache replaces the entry closest to expiry

| Answer | When | What the client does |
| --- | --- | --- |
| 401 | The token is missing, refused or invalid, or belongs to another account | Stops recording |
| 503 `Account service unavailable` | `REPLAY_AUTH_URL` cannot be reached, takes over 3 seconds, or answers 429 or 5xx | Keeps its session and tries again at the next poll |

An app server restart can therefore pause verification without ending every running recording

## Delete an account's recordings

When replay shares your app's database, it erases associated recordings before a `users` record is deleted

Set `REPLAY_AUTH_COLLECTION` if your accounts use another collection name

With a separate app database, call the replay erasure route before completing account deletion

```text
POST /api/replay/forget
X-Replay-Erase-Key: YOUR_SERVER_ONLY_KEY
Content-Type: application/json

{"accountId":"ACCOUNT_ID"}
```

- Set `REPLAY_ERASE_KEY` to the same random secret of at least 32 characters on both servers
- Repeat the request until `remainingSessions` is zero
- Each request removes up to 200 of the account's oldest sessions and their chunks, and blocks new sessions for that account for 24 hours
- If erasure fails, fail or retry account deletion, or let the retention period remove the remaining recordings
- Keep this endpoint internal where possible

The dashboard's superuser API also supports `DELETE /api/replay/accounts/{id}` with the same batched response

Sessions recorded without an account are not linked to that account and expire according to retention settings

### Delete through the dashboard

With `REPLAY_ERASE_KEY` unset, the erasure route returns 503, so use the dashboard to delete recordings manually

- **Delete** on a session row removes that recording
- **Delete every recording of the account in the filter** removes all sessions for that account, in batches of 200 until none remain

Neither dashboard action blocks the account from being recorded again
