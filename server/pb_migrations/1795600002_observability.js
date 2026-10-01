migrate((app) => {
  const names = ['replay_observability_sessions', 'replay_issues', 'replay_errors', 'replay_logs', 'replay_alerts'];
  for (const name of names) {
    let exists = false;
    try { app.findCollectionByNameOrId(name); exists = true; } catch (_) {}
    if (exists) throw new Error('Replay collection already exists: ' + name);
  }
  const locked = { type: 'base', listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null };
  const text = (name, max, required, hidden) => ({ name: name, type: 'text', max: max, required: !!required, hidden: !!hidden });
  const number = (name) => ({ name: name, type: 'number', min: 0, onlyInt: true });
  const identity = () => [text('accountId', 128), text('deviceId', 128, true), text('platform', 32, true), text('appVersion', 64), text('room', 128)];
  app.save(new Collection(Object.assign({}, locked, {
    name: 'replay_observability_sessions', fields: identity().concat([
      text('tokenHash', 64, true, true), text('ipHash', 64, true, true), number('issuedAt'), number('expiresAt'),
    ]), indexes: [
      'CREATE UNIQUE INDEX idx_replay_observability_token ON replay_observability_sessions (tokenHash)',
      'CREATE INDEX idx_replay_observability_device ON replay_observability_sessions (deviceId, issuedAt)',
      'CREATE INDEX idx_replay_observability_ip ON replay_observability_sessions (ipHash, issuedAt)',
      'CREATE INDEX idx_replay_observability_issued ON replay_observability_sessions (issuedAt)',
      'CREATE INDEX idx_replay_observability_account ON replay_observability_sessions (accountId)',
      'CREATE INDEX idx_replay_observability_expiry ON replay_observability_sessions (expiresAt)',
    ],
  })));
  const issues = new Collection(Object.assign({}, locked, {
    name: 'replay_issues', fields: [
      text('fingerprint', 64, true, true), text('title', 4226, true), text('name', 128, true), text('message', 4096, true),
      { name: 'status', type: 'select', values: ['open', 'resolved', 'ignored'], maxSelect: 1, required: true },
      { name: 'level', type: 'select', values: ['error', 'fatal'], maxSelect: 1, required: true },
      text('service', 128), number('occurrenceCount'), number('firstSeen'), number('lastSeen'), number('lastReceivedAt'), number('resolvedAt'),
    ], indexes: [
      'CREATE UNIQUE INDEX idx_replay_issues_fingerprint ON replay_issues (fingerprint)',
      'CREATE INDEX idx_replay_issues_last_seen ON replay_issues (lastSeen)',
      'CREATE INDEX idx_replay_issues_status ON replay_issues (status, lastSeen)',
      'CREATE INDEX idx_replay_issues_service ON replay_issues (service, lastSeen)',
    ],
  }));
  app.save(issues);
  const common = () => identity().concat([
    text('eventId', 64, true), text('payloadHash', 64, true, true), text('sessionId', 15), text('service', 128),
    number('timestamp'), number('receivedAt'), number('byteSize'), text('message', 4096, true), text('attributes', 8192, true),
  ]);
  const indexes = (name) => [
    'CREATE UNIQUE INDEX idx_' + name + '_dedupe ON ' + name + ' (deviceId, eventId)',
    'CREATE INDEX idx_' + name + '_timestamp ON ' + name + ' (timestamp)',
    'CREATE INDEX idx_' + name + '_retention ON ' + name + ' (receivedAt)',
    'CREATE INDEX idx_' + name + '_account ON ' + name + ' (accountId, timestamp)',
    'CREATE INDEX idx_' + name + '_device ON ' + name + ' (deviceId, timestamp)',
    'CREATE INDEX idx_' + name + '_session ON ' + name + ' (sessionId, timestamp)',
    'CREATE INDEX idx_' + name + '_service ON ' + name + ' (service, timestamp)',
  ];
  app.save(new Collection(Object.assign({}, locked, {
    name: 'replay_errors', fields: common().concat([
      { name: 'issue', type: 'relation', collectionId: issues.id, required: true, maxSelect: 1, cascadeDelete: true },
      { name: 'level', type: 'select', values: ['error', 'fatal'], maxSelect: 1, required: true },
      text('name', 128, true), text('stack', 8192), { name: 'handled', type: 'bool' },
    ]), indexes: indexes('replay_errors').concat(['CREATE INDEX idx_replay_errors_issue ON replay_errors (issue, timestamp)']),
  })));
  app.save(new Collection(Object.assign({}, locked, {
    name: 'replay_logs', fields: common().concat([
      { name: 'level', type: 'select', values: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'], maxSelect: 1, required: true },
    ]), indexes: indexes('replay_logs').concat(['CREATE INDEX idx_replay_logs_level ON replay_logs (level, timestamp)']),
  })));
  app.save(new Collection(Object.assign({}, locked, {
    name: 'replay_alerts', fields: [
      { name: 'issue', type: 'relation', collectionId: issues.id, required: true, maxSelect: 1, cascadeDelete: true },
      text('title', 4226, true), { name: 'kind', type: 'select', values: ['created', 'regressed'], maxSelect: 1, required: true },
      number('timestamp'), { name: 'acknowledged', type: 'bool' },
      // Webhook delivery: none when no webhook was set, pending until the cron sends it.
      { name: 'delivery', type: 'select', values: ['none', 'pending', 'sent', 'failed'], maxSelect: 1 }, number('deliveryAttempts'),
    ], indexes: [
      'CREATE INDEX idx_replay_alerts_timestamp ON replay_alerts (timestamp)',
      'CREATE INDEX idx_replay_alerts_issue ON replay_alerts (issue)',
      'CREATE INDEX idx_replay_alerts_delivery ON replay_alerts (delivery, timestamp)',
    ],
  })));
  try {
    const row = new Record(app.findCollectionByNameOrId('replay_settings'));
    row.set('key', 'observability');
    row.set('value', JSON.stringify({ errors_enabled: false, logs_enabled: false, alerts_enabled: true, errors_retention_days: 30, logs_retention_days: 14, daily_limit_mb: 64, alert_webhook_url: '' }));
    app.save(row);
  } catch (error) { console.warn('replay: observability defaults were not saved: ' + error); }
}, (app) => {
  for (const name of ['replay_alerts', 'replay_logs', 'replay_errors', 'replay_issues', 'replay_observability_sessions']) app.delete(app.findCollectionByNameOrId(name));
  try { app.delete(app.findFirstRecordByData('replay_settings', 'key', 'observability')); } catch (_) { /* Never saved, or already removed. */ }
});
