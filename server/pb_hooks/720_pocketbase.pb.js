// With REPLAY_TRACE_REQUESTS=on, traced SDK calls get their ID in PocketBase's request log from a tiny hook on each
// short API action. Off unless set, since the hooks cost every record API request some microseconds, used or not.
// Not a router middleware, which would hold a pooled JavaScript VM for as long as each realtime stream stays open,
// and never the realtime stream or file downloads either, for the same reason.
// New clients also send an opt-in URL marker, which the log reader can resolve even if a user hook runs first.
if (/^(?:on|true|1|yes)$/i.test(($os.getenv('REPLAY_TRACE_REQUESTS') || '').trim())) {
  const trace = (e) => {
    try {
      // These events hide e.request from JavaScript (PocketBase 0.39.9); their embedded request event has it.
      const link = (e.requestEvent || e).request.header.get('X-Replay-Request');
      // Even a cached require() costs about 13 µs, so each pooled VM keeps the library after its first traced call.
      if (link) (globalThis.__pocketbaseReplay || (globalThis.__pocketbaseReplay = require(`${__hooks}/lib/pocketbase.js`))).link(e, link);
    } catch (_) { /* Tracing never stops a request. */ }
    return e.next();
  };
  for (const name of [
    'onRecordsListRequest', 'onRecordViewRequest', 'onRecordCreateRequest', 'onRecordUpdateRequest', 'onRecordDeleteRequest',
    'onRecordAuthWithPasswordRequest', 'onRecordAuthWithOAuth2Request', 'onRecordAuthWithOTPRequest', 'onRecordAuthRefreshRequest',
    'onRecordRequestOTPRequest', 'onRecordRequestPasswordResetRequest', 'onRecordConfirmPasswordResetRequest', 'onRecordRequestVerificationRequest',
    'onRecordConfirmVerificationRequest', 'onRecordRequestEmailChangeRequest', 'onRecordConfirmEmailChangeRequest',
    'onBatchRequest', 'onRealtimeSubscribeRequest', 'onFileTokenRequest',
  ]) {
    // A PocketBase version without one of these hooks still loads the rest.
    if (typeof globalThis[name] === 'function') globalThis[name](trace);
  }
}

routerAdd('GET', '/api/replay/link', (e) => {
  return require(`${__hooks}/lib/pocketbase.js`).route(e, 'probe');
});

routerAdd('POST', '/api/replay/requests', (e) => {
  return require(`${__hooks}/lib/pocketbase.js`).route(e, 'explain');
}, $apis.bodyLimit(65536));
