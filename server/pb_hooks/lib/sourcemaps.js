const base = require('./replay-core.js');
const core = require('./sourcemap-core.js');

// Rows per INSERT statement, and the source text one statement carries before the next one starts.
const BATCH_ROWS = 100;
const BATCH_CHARS = 4000000;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function admin(e) {
  if (!e.hasSuperuserAuth()) base.fail(e.auth ? 403 : 401, 'Superuser authentication required');
}

// Uploads and deletions also accept REPLAY_SOURCEMAP_KEY, so a build job needs no superuser password.
function authorize(e) {
  if (e.hasSuperuserAuth()) return;
  const supplied = e.request.header.get('x-replay-sourcemap-key') || '';
  if (!supplied) base.fail(e.auth ? 403 : 401, 'Superuser authentication or an x-replay-sourcemap-key header is required');
  const expected = $os.getenv('REPLAY_SOURCEMAP_KEY') || '';
  if (expected.length < 32 || expected.length > 512) {
    base.fail(503, 'Source map keys are not configured. Set REPLAY_SOURCEMAP_KEY to 32 to 512 characters on the server, or sign in as a superuser');
  }
  if (supplied.length > 512 || !$security.equal($security.sha256(supplied), $security.sha256(expected))) base.fail(401, 'Invalid source map key');
}

// Source maps are their own installable part. Without their migration, frames are simply not resolved.
function installed(app) {
  try { app.findCollectionByNameOrId('replay_sourcemaps'); return true; } catch (_) { return false; }
}

function storage(app) {
  if (!installed(app)) base.fail(503, 'Source map storage is missing. Install pb_migrations/1795600004_sourcemaps.js and restart PocketBase');
}

function rows(app, sql, params, shape) {
  const result = arrayOf(new DynamicModel(shape));
  app.db().newQuery(sql).bind(params || {}).all(result);
  return result;
}

function count(app, where, params) {
  const result = rows(app, 'SELECT COUNT(*) AS total FROM replay_sourcemaps WHERE ' + where, params, { total: 0 });
  return result.length ? Number(result[0].total) : 0;
}

// Blocks and sources go in with plain multi-row INSERTs: thousands of record saves would take seconds.
function insert(tx, table, columns, values) {
  let at = 0;
  while (at < values.length) {
    const params = {};
    const groups = [];
    let chars = 0;
    while (at < values.length && groups.length < BATCH_ROWS && (!groups.length || chars < BATCH_CHARS)) {
      const marks = [];
      for (let c = 0; c < columns.length; c++) {
        const key = 'v' + groups.length + '_' + c;
        params[key] = values[at][c];
        if (typeof values[at][c] === 'string') chars += values[at][c].length;
        marks.push('{:' + key + '}');
      }
      groups.push('(' + marks.join(', ') + ')');
      at++;
    }
    tx.db().newQuery('INSERT INTO ' + table + ' (' + columns.join(', ') + ') VALUES ' + groups.join(', ')).bind(params).execute();
  }
}

function removeMaps(tx, where, params) {
  const selected = 'SELECT id FROM replay_sourcemaps WHERE ' + where;
  tx.db().newQuery('DELETE FROM replay_sourcemap_blocks WHERE map IN (' + selected + ')').bind(params).execute();
  tx.db().newQuery('DELETE FROM replay_sourcemap_sources WHERE map IN (' + selected + ')').bind(params).execute();
  tx.db().newQuery('DELETE FROM replay_sourcemaps WHERE ' + where).bind(params).execute();
}

function newId() { return $security.randomStringWithAlphabet(15, ID_ALPHABET); }

// The body is the raw source map. It is decoded before the transaction, so the write lock is held only
// while rows are replaced; uploading the same version and path again swaps the old map in that transaction.
function upload(e) {
  authorize(e);
  storage(e.app);
  const started = Date.now();
  const query = e.request.url.query();
  const appVersion = core.appVersion(query.get('appVersion'));
  const path = core.filePath(query.get('path'));
  let raw;
  try { raw = readerToString(e.request.body, core.LIMITS.bodyBytes + 1); } catch (error) {
    base.fail(/too large/i.test(String(error)) ? 413 : 400, /too large/i.test(String(error)) ? 'Source map is larger than 32 MiB' : 'Unreadable body');
  }
  if (!raw) base.fail(400, 'The body is empty. Send the contents of the .map file');
  if (raw.length > core.LIMITS.bodyBytes) base.fail(413, 'Source map is larger than 32 MiB');
  const length = Number(e.request.contentLength);
  const bytes = length > 0 ? length : raw.length;
  const map = core.parse(raw);
  raw = null;
  const built = core.index(map.mappings, map.sources.length, map.names);
  const decoded = Date.now();
  let replaced = false;
  let withContent = 0;
  for (const text of map.contents) if (text) withContent++;
  e.app.runInTransaction(function (tx) {
    const old = rows(tx, 'SELECT id FROM replay_sourcemaps WHERE appVersion = {:appVersion} AND path = {:path}', { appVersion: appVersion, path: path }, { id: '' });
    if (old.length) {
      removeMaps(tx, 'id = {:id}', { id: old[0].id });
      replaced = true;
    }
    const record = new Record(tx.findCollectionByNameOrId('replay_sourcemaps'));
    record.set('appVersion', appVersion);
    record.set('path', path);
    record.set('name', core.baseName(path));
    record.set('bytes', bytes);
    record.set('segments', built.segments);
    record.set('blockCount', built.blocks.length);
    record.set('sourceCount', map.sources.length);
    record.set('nameCount', map.names.length);
    record.set('uploadedAt', Date.now());
    tx.save(record);
    insert(tx, 'replay_sourcemap_blocks', ['id', 'map', 'line', 'col', 'data'], built.blocks.map(function (block) {
      return [newId(), record.id, block.line, block.col, block.data];
    }));
    insert(tx, 'replay_sourcemap_sources', ['id', 'map', 'idx', 'path', 'content'], map.sources.map(function (source, index) {
      return [newId(), record.id, index, source, map.contents[index]];
    }));
  });
  const finished = Date.now();
  return {
    ok: true, appVersion: appVersion, path: path, name: core.baseName(path), bytes: bytes, segments: built.segments, blocks: built.blocks.length,
    sources: map.sources.length, sourcesWithContent: withContent, sourcesCut: map.contentsCut, names: map.names.length, replaced: replaced,
    ms: finished - started, storeMs: finished - decoded,
  };
}

// Uploaded versions, newest first; with ?appVersion=, the files of that version.
function list(e) {
  admin(e);
  storage(e.app);
  const requested = e.request.url.query().get('appVersion');
  if (requested) {
    const appVersion = core.appVersion(requested);
    const files = rows(e.app, 'SELECT path, name, bytes, segments, sourceCount, uploadedAt FROM replay_sourcemaps WHERE appVersion = {:appVersion} ORDER BY path LIMIT 5000',
      { appVersion: appVersion }, { path: '', name: '', bytes: -0, segments: -0, sourceCount: -0, uploadedAt: -0 });
    const items = [];
    for (let i = 0; i < files.length; i++) {
      items.push({ path: files[i].path, name: files[i].name, bytes: Number(files[i].bytes), segments: Number(files[i].segments), sources: Number(files[i].sourceCount), uploadedAt: Number(files[i].uploadedAt) });
    }
    return { appVersion: appVersion, items: items };
  }
  const versions = rows(e.app, 'SELECT appVersion, COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes, MAX(uploadedAt) AS uploadedAt FROM replay_sourcemaps GROUP BY appVersion ORDER BY MAX(uploadedAt) DESC, appVersion LIMIT 1000',
    {}, { appVersion: '', files: 0, bytes: -0, uploadedAt: -0 });
  const items = [];
  for (let i = 0; i < versions.length; i++) {
    items.push({ appVersion: versions[i].appVersion, files: Number(versions[i].files), bytes: Number(versions[i].bytes), uploadedAt: Number(versions[i].uploadedAt) });
  }
  return { items: items };
}

function remove(e) {
  authorize(e);
  storage(e.app);
  const appVersion = core.appVersion(e.request.url.query().get('appVersion'));
  let files = 0;
  e.app.runInTransaction(function (tx) {
    files = count(tx, 'appVersion = {:appVersion}', { appVersion: appVersion });
    removeMaps(tx, 'appVersion = {:appVersion}', { appVersion: appVersion });
  });
  return { ok: true, appVersion: appVersion, deletedFiles: files };
}

// Resolves frames against the maps of one app version, caching what it reads for one request: a batch
// of errors, or one stack, often repeats the same frames.
function resolver(app, appVersion) {
  let maps = null;
  const positions = {};
  const paths = {};
  const texts = {};
  function available() {
    if (maps) return maps;
    maps = [];
    try { core.appVersion(appVersion); } catch (_) { return maps; }
    const found = rows(app, 'SELECT id, path, name FROM replay_sourcemaps WHERE appVersion = {:appVersion} LIMIT 5000', { appVersion: appVersion }, { id: '', path: '', name: '' });
    for (let i = 0; i < found.length; i++) maps.push({ id: found[i].id, path: found[i].path, name: found[i].name });
    return maps;
  }
  function sourcePath(map, index) {
    const key = map + ':' + index;
    if (!Object.prototype.hasOwnProperty.call(paths, key)) {
      const found = rows(app, 'SELECT path FROM replay_sourcemap_sources WHERE map = {:map} AND idx = {:idx} LIMIT 1', { map: map, idx: index }, { path: '' });
      paths[key] = found.length ? found[0].path : null;
    }
    return paths[key];
  }
  // A source's text, split into lines once: the frames of one stack often share a file.
  function sourceLines(map, index) {
    const key = map + ':' + index;
    if (!Object.prototype.hasOwnProperty.call(texts, key)) {
      const found = rows(app, 'SELECT content FROM replay_sourcemap_sources WHERE map = {:map} AND idx = {:idx} LIMIT 1', { map: map, idx: index }, { content: '' });
      texts[key] = found.length && found[0].content ? found[0].content.split('\n') : null;
    }
    return texts[key];
  }
  // Takes the 1-based line and column a stack prints; the result holds 0-based original positions.
  function resolve(file, line, column) {
    if (!(line >= 1) || !(column >= 1)) return null;
    const list = available();
    if (!list.length) return null;
    const map = core.matchMap(core.urlPath(file), list);
    if (!map) return null;
    const key = map.id + ':' + line + ':' + column;
    if (Object.prototype.hasOwnProperty.call(positions, key)) return positions[key];
    let result = null;
    try {
      const block = rows(app, 'SELECT line, col, data FROM replay_sourcemap_blocks WHERE map = {:map} AND (line, col) <= ({:line}, {:col}) ORDER BY line DESC, col DESC LIMIT 1',
        { map: map.id, line: line - 1, col: column - 1 }, { line: 0, col: 0, data: '' });
      const found = block.length ? core.find({ line: Number(block[0].line), col: Number(block[0].col), data: block[0].data }, line - 1, column - 1) : null;
      const path = found ? sourcePath(map.id, found.source) : null;
      if (path) result = { map: map.id, file: map.path, sourceIndex: found.source, source: path, line: found.line, column: found.column, name: found.name };
    } catch (_) {
      // A row that cannot be decoded leaves the frame as it was sent.
      result = null;
    }
    positions[key] = result;
    return result;
  }
  // Grouping input for the top frames of one error: { source, name } or null for each, in order. Any
  // failure leaves the error to group as it would without maps, rather than refusing its batch.
  function top(frames) {
    try {
      return frames.map(function (frame) {
        const found = resolve(frame.url, frame.line, frame.column);
        return found ? { source: found.source, name: found.name } : null;
      });
    } catch (_) { return undefined; }
  }
  return { resolve: resolve, top: top, lines: sourceLines, count: function () { return available().length; } };
}

// One stored occurrence's frames, with original positions and code where its version has maps.
function frames(e) {
  admin(e);
  const id = base.text(e.request.pathValue('id'), 'id', 15, true);
  let row;
  try { row = e.app.findRecordById('replay_errors', id); } catch (_) { base.fail(404, 'Not found'); }
  const appVersion = row.getString('appVersion');
  const lookup = installed(e.app) ? resolver(e.app, appVersion) : null;
  let mapped = 0;
  const items = core.parseStack(row.getString('stack')).map(function (frame, index) {
    const item = { raw: frame.raw, function: frame.function, file: frame.file, line: frame.line, column: frame.column };
    const found = lookup && index < core.LIMITS.frames ? lookup.resolve(frame.file, frame.line, frame.column) : null;
    if (!found) return item;
    mapped++;
    item.mapped = { source: found.source, line: found.line + 1, column: found.column + 1, name: found.name };
    const context = core.context(lookup.lines(found.map, found.sourceIndex), found.line + 1);
    if (context) item.context = context;
    return item;
  });
  return { id: row.id, appVersion: appVersion, sourceMaps: lookup ? lookup.count() : 0, mapped: mapped, frames: items };
}

function route(e, name) {
  e.response.header().set('Cache-Control', 'no-store');
  e.response.header().set('X-Content-Type-Options', 'nosniff');
  try { return e.json(200, module.exports[name](e)); } catch (error) {
    if (error && error.status) return e.json(error.status, { message: error.message });
    throw error;
  }
}

module.exports = { upload: upload, list: list, remove: remove, frames: frames, resolver: resolver, installed: installed, route: route };
