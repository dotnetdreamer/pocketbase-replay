migrate((app) => {
  const names = ['replay_sourcemaps', 'replay_sourcemap_blocks', 'replay_sourcemap_sources'];
  for (const name of names) {
    let exists = false;
    try { app.findCollectionByNameOrId(name); exists = true; } catch (_) {}
    if (exists) throw new Error('Replay collection already exists: ' + name);
  }
  const locked = { type: 'base', listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null };
  const text = (name, max, required) => ({ name: name, type: 'text', max: max, required: !!required });
  const number = (name) => ({ name: name, type: 'number', min: 0, onlyInt: true });
  // One row per uploaded map: the generated file's path in the build, and what its upload held.
  const maps = new Collection(Object.assign({}, locked, {
    name: 'replay_sourcemaps', fields: [
      text('appVersion', 64, true), text('path', 1024, true), text('name', 1024, true),
      number('bytes'), number('segments'), number('blockCount'), number('sourceCount'), number('nameCount'), number('uploadedAt'),
    ], indexes: [
      'CREATE UNIQUE INDEX idx_replay_sourcemaps_path ON replay_sourcemaps (appVersion, path)',
      'CREATE INDEX idx_replay_sourcemaps_name ON replay_sourcemaps (appVersion, name)',
    ],
  }));
  app.save(maps);
  const map = () => ({ name: 'map', type: 'relation', collectionId: maps.id, required: true, maxSelect: 1, cascadeDelete: true });
  // About 256 mappings segments per block, keyed by the generated position of its first segment.
  app.save(new Collection(Object.assign({}, locked, {
    name: 'replay_sourcemap_blocks', fields: [map(), number('line'), number('col'), text('data', 2000000, true)],
    indexes: ['CREATE UNIQUE INDEX idx_replay_sourcemap_blocks_position ON replay_sourcemap_blocks (map, line, col)'],
  })));
  // Each original source's path, and its sourcesContent for code context.
  app.save(new Collection(Object.assign({}, locked, {
    name: 'replay_sourcemap_sources', fields: [map(), number('idx'), text('path', 1024), text('content', 2000000)],
    indexes: ['CREATE UNIQUE INDEX idx_replay_sourcemap_sources_index ON replay_sourcemap_sources (map, idx)'],
  })));
}, (app) => {
  for (const name of ['replay_sourcemap_sources', 'replay_sourcemap_blocks', 'replay_sourcemaps']) app.delete(app.findCollectionByNameOrId(name));
});
