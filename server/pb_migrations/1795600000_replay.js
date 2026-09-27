migrate((app) => {
  // Fail on a namespace collision instead of changing another package's data.
  for (const name of ['replay_settings', 'replay_sessions', 'replay_chunks']) {
    let exists = false;
    try { app.findCollectionByNameOrId(name); exists = true; } catch (_) {}
    if (exists) throw new Error('Replay collection already exists: ' + name);
  }
  const settings = new Collection({
    name: 'replay_settings', type: 'base',
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { name: 'key', type: 'text', required: true, max: 64 },
      { name: 'value', type: 'text', required: true, max: 300000 },
    ],
    indexes: ['CREATE UNIQUE INDEX idx_replay_settings_key ON replay_settings (key)'],
  });
  app.save(settings);
  const sessions = new Collection({
    name: 'replay_sessions', type: 'base',
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { name: 'deviceId', type: 'text', required: true, max: 128 },
      { name: 'accountId', type: 'text', max: 128 },
      { name: 'platform', type: 'text', required: true, max: 32 },
      { name: 'appVersion', type: 'text', max: 64 },
      { name: 'room', type: 'text', max: 128 },
      { name: 'rooms', type: 'text', max: 32768 },
      { name: 'tokenHash', type: 'text', required: true, max: 64, hidden: true },
      { name: 'ipHash', type: 'text', required: true, max: 64, hidden: true },
      { name: 'startedAt', type: 'number', required: true, min: 1, onlyInt: true },
      { name: 'endedAt', type: 'number', min: 0, onlyInt: true },
      { name: 'lastSeenAt', type: 'number', min: 0, onlyInt: true },
      { name: 'expiresAt', type: 'number', required: true, min: 1, onlyInt: true },
      { name: 'compressedBytes', type: 'number', min: 0, onlyInt: true },
      { name: 'rawBytes', type: 'number', min: 0, onlyInt: true },
      { name: 'chunkCount', type: 'number', min: 0, onlyInt: true },
      { name: 'eventCount', type: 'number', min: 0, onlyInt: true },
      { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
    ],
    indexes: [
      'CREATE INDEX idx_replay_sessions_started ON replay_sessions (startedAt)',
      'CREATE INDEX idx_replay_sessions_account ON replay_sessions (accountId, startedAt)',
      'CREATE INDEX idx_replay_sessions_device ON replay_sessions (deviceId, startedAt)',
      'CREATE INDEX idx_replay_sessions_ip ON replay_sessions (ipHash, startedAt)',
    ],
  });
  app.save(sessions);
  app.save(new Collection({
    name: 'replay_chunks', type: 'base',
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { name: 'session', type: 'relation', collectionId: sessions.id, required: true, maxSelect: 1, cascadeDelete: true },
      { name: 'seq', type: 'number', min: 0, max: 2047, onlyInt: true },
      { name: 'startedAt', type: 'number', required: true, min: 1, onlyInt: true },
      { name: 'endedAt', type: 'number', required: true, min: 1, onlyInt: true },
      { name: 'room', type: 'text', max: 128 },
      { name: 'encoding', type: 'text', required: true, max: 32 },
      { name: 'data', type: 'text', required: true, max: 524288 },
      { name: 'rawBytes', type: 'number', required: true, min: 2, max: 2097152, onlyInt: true },
      { name: 'compressedBytes', type: 'number', required: true, min: 20, max: 393216, onlyInt: true },
      { name: 'eventCount', type: 'number', required: true, min: 1, max: 50000, onlyInt: true },
      { name: 'hasSnapshot', type: 'bool' },
      { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
    ],
    indexes: ['CREATE UNIQUE INDEX idx_replay_chunks_session_seq ON replay_chunks (session, seq)'],
  }));
  const defaults = { mode: 'off', percentage: 0, account_ids: [], retention_days: 14 };
  for (const key of Object.keys(defaults)) {
    const row = new Record(settings);
    row.set('key', key);
    row.set('value', JSON.stringify(defaults[key]));
    try { app.save(row); } catch (error) { console.warn('replay: could not seed ' + key + ': ' + error); }
  }
}, (app) => {
  for (const name of ['replay_chunks', 'replay_sessions', 'replay_settings']) app.delete(app.findCollectionByNameOrId(name));
});
