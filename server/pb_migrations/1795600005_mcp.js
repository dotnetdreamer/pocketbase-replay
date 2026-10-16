migrate((app) => {
  const names = ['replay_activity', 'replay_activity_state', 'replay_mcp_keys', 'replay_mcp_audit'];
  for (const name of names) {
    let exists = false;
    try { app.findCollectionByNameOrId(name); exists = true; } catch (_) {}
    if (exists) throw new Error('Replay collection already exists: ' + name);
  }
  const locked = { type: 'base', listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null };
  const text = (name, max, required, hidden) => ({ name: name, type: 'text', max: max, required: !!required, hidden: !!hidden });
  const number = (name) => ({ name: name, type: 'number', min: 0, onlyInt: true });
  const sessions = app.findCollectionByNameOrId('replay_sessions');
  const session = () => ({ name: 'session', type: 'relation', collectionId: sessions.id, required: true, maxSelect: 1, cascadeDelete: true });
  // What happened in each recorded chunk, read once from its events so agents can search and read recordings
  // as text. Derived from the masked recording and deleted with it.
  app.save(new Collection(Object.assign({}, locked, {
    name: 'replay_activity', fields: [
      session(), number('seq'), number('startedAt'), number('endedAt'), text('items', 2000000, true), number('count'), number('errors'),
    ], indexes: [
      'CREATE UNIQUE INDEX idx_replay_activity_chunk ON replay_activity (session, seq)',
      'CREATE INDEX idx_replay_activity_time ON replay_activity (session, startedAt)',
    ],
  })));
  // How far each recording has been read, where to go on, and a summary for listing recordings.
  app.save(new Collection(Object.assign({}, locked, {
    name: 'replay_activity_state', fields: [
      session(), number('seq'), number('chunks'), text('status', 16, true), text('checkpoint', 16000000), text('summary', 20000),
      text('error', 500), number('updatedAt'),
    ], indexes: [
      'CREATE UNIQUE INDEX idx_replay_activity_state_session ON replay_activity_state (session)',
      'CREATE INDEX idx_replay_activity_state_status ON replay_activity_state (status, updatedAt)',
    ],
  })));
  // Read-only keys for AI agents. Only a hash of each key is stored.
  app.save(new Collection(Object.assign({}, locked, {
    name: 'replay_mcp_keys', fields: [
      text('label', 64, true), text('prefix', 24, true), text('hash', 64, true, true), text('scopes', 64, true),
      number('createdAt'), number('expiresAt'), number('lastUsedAt'), text('lastClient', 128), text('createdBy', 128),
    ], indexes: [
      'CREATE UNIQUE INDEX idx_replay_mcp_keys_hash ON replay_mcp_keys (hash)',
      'CREATE INDEX idx_replay_mcp_keys_created ON replay_mcp_keys (createdAt)',
    ],
  })));
  // Each agent request: which key, which tool and arguments, and how it ended. Account and device IDs and search
  // text in the arguments are not kept.
  app.save(new Collection(Object.assign({}, locked, {
    name: 'replay_mcp_audit', fields: [
      text('key', 15), text('keyLabel', 64), text('client', 128), text('method', 64, true), text('name', 128), text('arguments', 2048),
      text('status', 16, true), text('error', 500), number('durationMs'), number('resultChars'), number('timestamp'),
    ], indexes: [
      'CREATE INDEX idx_replay_mcp_audit_time ON replay_mcp_audit (timestamp)',
      'CREATE INDEX idx_replay_mcp_audit_key ON replay_mcp_audit (key, timestamp)',
    ],
  })));
}, (app) => {
  for (const name of ['replay_mcp_audit', 'replay_mcp_keys', 'replay_activity_state', 'replay_activity']) app.delete(app.findCollectionByNameOrId(name));
});
