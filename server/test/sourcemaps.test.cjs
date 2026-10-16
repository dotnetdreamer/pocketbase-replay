const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../pb_hooks/lib/sourcemap-core.js');
const observabilityCore = require('../pb_hooks/lib/observability-core.js');
const observability = require('../pb_hooks/lib/observability.js');
const sourcemaps = require('../pb_hooks/lib/sourcemaps.js');
const { fixture, exception, now } = require('./helpers/observability-fixture.cjs');

const hash = value => createHash('sha256').update(value).digest('hex');
const KEY = 'k'.repeat(40);
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// An encoder and a whole-map decoder written independently of the code under test.
function vlq(value) {
  let rest = value < 0 ? -value * 2 + 1 : value * 2;
  let out = '';
  do {
    let digit = rest % 32;
    rest = Math.floor(rest / 32);
    if (rest) digit += 32;
    out += BASE64[digit];
  } while (rest);
  return out;
}

// lines: an array per generated line of absolute segments [col], [col, source, line, column] or [..., name].
function encode(lines) {
  let source = 0; let line = 0; let column = 0; let name = 0;
  return lines.map(segments => {
    let col = 0;
    return segments.map(segment => {
      let out = vlq(segment[0] - col);
      col = segment[0];
      if (segment.length > 1) {
        out += vlq(segment[1] - source) + vlq(segment[2] - line) + vlq(segment[3] - column);
        [, source, line, column] = segment;
        if (segment.length > 4) { out += vlq(segment[4] - name); name = segment[4]; }
      }
      return out;
    }).join(',');
  }).join(';');
}

function decodeAll(mappings) {
  const segments = [];
  let source = 0; let line = 0; let column = 0; let name = 0;
  mappings.split(';').forEach((text, generatedLine) => {
    let col = 0;
    for (const part of text.split(',')) {
      if (!part) continue;
      const values = [];
      let value = 0; let shift = 0;
      for (const char of part) {
        const digit = BASE64.indexOf(char);
        value += (digit & 31) * 2 ** shift;
        shift += 5;
        if (!(digit & 32)) { values.push(value % 2 ? -(value - 1) / 2 : value / 2); value = 0; shift = 0; }
      }
      col += values[0];
      const segment = { line: generatedLine, col, fields: values.length };
      if (values.length > 1) {
        source += values[1]; line += values[2]; column += values[3];
        Object.assign(segment, { source, original: line, column });
        if (values.length > 4) { name += values[4]; segment.name = name; }
      }
      segments.push(segment);
    }
  });
  return segments;
}

// What a source map consumer returns: the last segment at or before the column on that line, the first of several at one column.
function reference(segments, names, line, column) {
  let best = null;
  for (const segment of segments) if (segment.line === line && segment.col <= column && (!best || segment.col > best.col)) best = segment;
  if (!best || best.fields < 4) return null;
  return { source: best.source, line: best.original, column: best.column, name: best.name === undefined ? null : names[best.name] };
}

// The latest block starting at or before the position, as the SQL lookup selects it.
function lookup(blocks, line, column) {
  let found = null;
  for (const block of blocks) if (block.line < line || (block.line === line && block.col <= column)) found = block;
  return found ? core.find(found, line, column) : null;
}

function random(seed) {
  let state = seed;
  return limit => { state = (state * 1103515245 + 12345) % 2147483648; return state % limit; };
}

function randomMap(seed, options) {
  const next = random(seed);
  const lines = [];
  for (let line = 0; line < options.lines; line++) {
    if (next(100) < options.empty) { lines.push([]); continue; }
    if (options.gap && next(100) < 3) for (let gap = 0; gap < options.gap; gap++) lines.push([]);
    const segments = [];
    let col = next(4);
    const count = 1 + next(options.perLine);
    for (let i = 0; i < count; i++) {
      // Some segments repeat the previous column: consumers pick the first of them.
      if (!segments.length || next(100) >= 15) col += 1 + next(40);
      const kind = next(10);
      if (kind === 0) segments.push([col]);
      else if (kind < 5) segments.push([col, next(options.sources), next(500), next(120)]);
      else segments.push([col, next(options.sources), next(500), next(120), next(options.names)]);
    }
    lines.push(segments);
  }
  const names = Array.from({ length: options.names }, (_, i) => 'name' + i);
  return { mappings: encode(lines), names, sources: options.sources };
}

function sourceMap(lines, extra) {
  return JSON.stringify(Object.assign({ version: 3, file: 'index.js', sources: ['../src/board.ts', '../src/game.ts'], names: ['renderBoard', 'loadGame', 'start'], mappings: encode(lines) }, extra || {}));
}

// The fixture plus the source map migration, as an install that has every part.
function withSourcemaps(env) {
  const f = fixture();
  let up;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pb_migrations/1795600004_sourcemaps.js'), 'utf8'), {
    migrate: value => { up = value; }, Collection: function (value) { Object.assign(this, value); }, Record: global.Record, console,
  });
  up(f.app);
  global.$security.randomStringWithAlphabet = (length, alphabet) => Array.from(randomBytes(length), byte => alphabet[byte % alphabet.length]).join('');
  global.$os = { getenv: name => (env || { REPLAY_SOURCEMAP_KEY: KEY })[name] || '' };
  return f;
}

function call(f, options) {
  const settings = Object.assign({ body: '', query: {}, headers: {}, id: '', superuser: false }, options);
  return {
    app: f.app, auth: settings.auth, hasSuperuserAuth: () => settings.superuser, realIP: () => '127.0.0.1',
    request: {
      body: settings.body, contentLength: Buffer.byteLength(settings.body),
      header: { get: name => settings.headers[name.toLowerCase()] || '' },
      pathValue: () => settings.id, url: { query: () => ({ get: key => settings.query[key] || '' }) },
    },
  };
}

function upload(f, body, query, headers) {
  return sourcemaps.upload(call(f, { body, query: Object.assign({ appVersion: '1.0', path: 'assets/index-AAAA1111.js' }, query), headers: headers || { 'x-replay-sourcemap-key': KEY } }));
}

test('VLQ values decode with sign, continuation and range checks', () => {
  assert.deepEqual(core.segment('A'), [1, 0, 0, 0, 0, 0]);
  assert.deepEqual(core.segment('AAAA'), [4, 0, 0, 0, 0, 0]);
  assert.deepEqual(core.segment('CDEF'), [4, 1, -1, 2, -2, 0]);
  assert.deepEqual(core.segment('gBhBAAC'), [5, 16, -16, 0, 0, 1]);
  for (const value of [0, 1, -1, 15, 16, -16, 31, 32, 1000, -1000, 123456, 2147483647, -2147483647]) {
    assert.deepEqual(core.segment(vlq(value)), [1, value, 0, 0, 0, 0], String(value));
  }
  assert.equal(Object.is(core.segment('B')[1], -0) || core.segment('B')[1] === 0, true);
  for (const bad of ['AA', 'AAA', 'AAAAAA', 'g', 'A!AA', 'ggggggggB', 'Aé']) assert.throws(() => core.segment(bad), { status: 400 }, bad);
});

test('block lookups match a whole-map decoder at every segment, block edge, gap and line end', () => {
  const cases = [
    { seed: 1, lines: 1, perLine: 900, empty: 0, sources: 3, names: 20 },
    { seed: 2, lines: 60, perLine: 30, empty: 20, sources: 5, names: 40 },
    { seed: 3, lines: 400, perLine: 4, empty: 50, sources: 2, names: 5, gap: 1500 },
    { seed: 4, lines: 30, perLine: 80, empty: 10, sources: 9, names: 300 },
  ];
  for (const options of cases) {
    const map = randomMap(options.seed, options);
    const segments = decodeAll(map.mappings);
    // Small chunks put chunk edges between segments, after line breaks and inside runs of empty lines.
    for (const settings of [undefined, { segments: 3, lines: 2 }, { segments: 1, lines: 0 }, { segments: 17, lines: 40 }, { chunk: 40 }, { segments: 5, lines: 3, chunk: 67 }]) {
      const built = core.index(map.mappings, map.sources, map.names, settings);
      assert.equal(built.segments, segments.length);
      // Starts strictly increase, so one block holds every segment of a generated position.
      for (let i = 1; i < built.blocks.length; i++) {
        const a = built.blocks[i - 1]; const b = built.blocks[i];
        assert.ok(a.line < b.line || (a.line === b.line && a.col < b.col), 'block order');
      }
      const positions = new Set();
      for (const segment of segments) for (const delta of [-1, 0, 1, 7]) positions.add(segment.line + ':' + Math.max(0, segment.col + delta));
      for (let line = 0; line <= (segments.length ? segments[segments.length - 1].line + 1 : 1); line += Math.max(1, Math.floor(options.lines / 50))) {
        positions.add(line + ':0'); positions.add(line + ':100000');
      }
      for (const block of built.blocks) { positions.add(block.line + ':' + block.col); positions.add(block.line + ':' + Math.max(0, block.col - 1)); }
      for (const position of positions) {
        const [line, column] = position.split(':').map(Number);
        assert.deepEqual(lookup(built.blocks, line, column), reference(segments, map.names, line, column), JSON.stringify({ options, settings, line, column }));
      }
    }
  }
});

test('blocks hold about 256 segments, end at long unmapped gaps, and carry only the names they use', () => {
  const lines = [Array.from({ length: 1000 }, (_, i) => [i * 3, 0, i, 0, i % 7])];
  for (let i = 0; i < 2000; i++) lines.push([]);
  lines.push([[0, 1, 5, 5, 3]]);
  const map = encode(lines);
  const names = Array.from({ length: 7 }, (_, i) => 'n' + i);
  const built = core.index(map, 2, names);
  assert.deepEqual(built.blocks.map(block => [block.line, block.col]), [[0, 0], [0, 768], [0, 1536], [0, 2304], [2001, 0]]);
  for (const block of built.blocks) {
    const data = JSON.parse(block.data);
    assert.ok(!data[5].includes(';'), 'a gap is not stored inside a block');
    assert.ok(data[6].length <= names.length * 2);
  }
  assert.deepEqual(JSON.parse(built.blocks[4].data)[6], [3, 'n3']);
  assert.deepEqual(lookup(built.blocks, 2001, 9), { source: 1, line: 5, column: 5, name: 'n3' });
  assert.equal(lookup(built.blocks, 1000, 0), null);
  // Segments sharing one position stay in one block even past the target size.
  const same = encode([Array.from({ length: 300 }, () => [5, 0, 1, 1])]);
  assert.equal(core.index(same, 1, []).blocks.length, 1);
  assert.throws(() => core.index(same, 1, [], { maxSegments: 299 }), { status: 400, message: /share one generated position/ });
  assert.deepEqual(core.index('', 0, []), { segments: 0, blocks: [] });
  assert.deepEqual(core.index(';;;', 0, []), { segments: 0, blocks: [] });
});

test('invalid mappings are refused with the reason', () => {
  const cases = [
    ['EAAA,DAAA', /sorted/], ['D', /out of range/], ['ACAA', /source that is not listed/], ['AAAAC', /name that is not listed/],
    ['AADA', /original position/], ['AA', /2 fields/], ['A$', /character/], ['AAAAAAA', /more than five/],
  ];
  for (const [mappings, message] of cases) assert.throws(() => core.index(mappings, 1, ['x']), { status: 400, message }, mappings);
  assert.throws(() => core.index('A,C,E,G', 1, [], { total: 3 }), { status: 413, message: /more than 3 mappings segments/ });
  assert.throws(() => core.index('A'.repeat(70000), 1, []), { status: 400, message: /segment is too long/ });
  // A long run of empty lines is read in chunks, not split into one array.
  const gap = core.index(';'.repeat(200000) + 'CAAA', 1, [], { chunk: 1000 });
  assert.deepEqual(gap.blocks.map(block => [block.line, block.col]), [[200000, 1]]);
  assert.deepEqual(lookup(gap.blocks, 200000, 3), { source: 0, line: 0, column: 0, name: null });
});

test('source maps are parsed, bounded and cleaned before indexing', () => {
  const parsed = core.parse(JSON.stringify({ version: 3, sourceRoot: 'webpack://app/', sources: ['./src/a.ts', null, '/abs/b.ts', 'webpack://other/c.ts'], names: ['ok'], mappings: 'AAAA', sourcesContent: ['a\nb', null] }));
  assert.deepEqual(parsed.sources, ['webpack://app/./src/a.ts', '', '/abs/b.ts', 'webpack://other/c.ts']);
  assert.deepEqual(parsed.contents, ['a\nb', '', '', '']);
  const cleaned = core.parse(JSON.stringify({ version: 3, sources: ['a\u0000.ts'], names: ['bad\nname', 'x'.repeat(300)], mappings: '' }));
  assert.deepEqual(cleaned.sources, ['a.ts']);
  assert.equal(cleaned.names[0], 'badname');
  assert.equal(cleaned.names[1].length, 256);
  const long = 'line\n'.repeat(500000);
  const cut = core.parse(JSON.stringify({ version: 3, sources: ['big.js'], names: [], mappings: '', sourcesContent: [long] }));
  assert.ok(cut.contents[0].length <= core.LIMITS.contentChars && cut.contents[0].endsWith('\n'));
  assert.equal(cut.contentsCut, 1);
  const refused = [
    ['not json', 400, /not valid JSON/], ['[]', 400, /source map object/], [JSON.stringify({ version: 2, sources: [], mappings: '' }), 400, /version 3/],
    [JSON.stringify({ version: 3, sections: [] }), 400, /sections/], [JSON.stringify({ version: 3, sources: [], mappings: 1 }), 400, /mappings/],
    [JSON.stringify({ version: 3, sources: 'a', mappings: '' }), 400, /sources/], [JSON.stringify({ version: 3, sources: [1], mappings: '' }), 400, /source must be a string/],
    [JSON.stringify({ version: 3, sources: [], names: [1], mappings: '' }), 400, /name must be a string/],
    [JSON.stringify({ version: 3, sources: ['a'], sourcesContent: [1], mappings: '' }), 400, /sourcesContent/],
    [JSON.stringify({ version: 3, sources: Array(20001).fill('a'), mappings: '' }), 413, /20000 sources/],
  ];
  for (const [raw, status, message] of refused) assert.throws(() => core.parse(raw), { status, message }, raw.slice(0, 40));
});

test('app versions and generated paths are checked before anything is read', () => {
  for (const value of ['1.4.0', 'v2', '2026.10.15+build.7', 'a_b-c']) assert.equal(core.appVersion(value), value);
  for (const value of ['', '.1', '-1', '1.0 beta', 'x'.repeat(65), '1/2', undefined]) assert.throws(() => core.appVersion(value), { status: 400 }, String(value));
  for (const value of ['assets/index-BHg5Ehe4.js', 'main.mjs', 'chunks/a.b.cjs']) assert.equal(core.filePath(value), value);
  for (const value of ['', '/assets/a.js', '../a.js', 'assets/../a.js', 'a//b.js', './a.js', 'a\\b.js', 'a.js?x', 'a.js#x', 'a\u0001.js', 'a.js.map', 'a.css', 'x'.repeat(1022) + '.js']) {
    assert.throws(() => core.filePath(value), { status: 400 }, value);
  }
});

test('frames parse from Chrome, Safari, Firefox and Capacitor stacks with 1-based positions', () => {
  const stack = [
    'TypeError: Cannot read properties of undefined (reading \'value\')',
    '    at renderBoard (https://app.example.com/assets/index-BHg5Ehe4.js:1:23423)',
    '    at https://localhost/assets/index-BHg5Ehe4.js:1:99',
    '    at async loadGame (http://localhost:5173/assets/main.js:10:5)',
    '    at Array.forEach (<anonymous>)',
    'renderBoard@capacitor://localhost/assets/index-Qx81_a-Z.js:1:2001',
    '@capacitor://localhost/assets/index-Qx81_a-Z.js:1:5',
    'forEach@[native code]',
    'loadGame/<@https://app.example.com/assets/index.js:3:4',
    'Error: a@b failed',
  ].join('\n');
  assert.deepEqual(core.parseStack(stack).map(frame => [frame.function, frame.file, frame.line, frame.column]), [
    ['renderBoard', 'https://app.example.com/assets/index-BHg5Ehe4.js', 1, 23423],
    ['', 'https://localhost/assets/index-BHg5Ehe4.js', 1, 99],
    ['async loadGame', 'http://localhost:5173/assets/main.js', 10, 5],
    ['Array.forEach', '<anonymous>', null, null],
    ['renderBoard', 'capacitor://localhost/assets/index-Qx81_a-Z.js', 1, 2001],
    ['', 'capacitor://localhost/assets/index-Qx81_a-Z.js', 1, 5],
    ['forEach', '[native code]', null, null],
    ['loadGame/<', 'https://app.example.com/assets/index.js', 3, 4],
  ]);
  assert.equal(core.parseFrame('    at x (https://h/a.js:7:8)').raw, 'at x (https://h/a.js:7:8)');
  // Grouping reads the same top frames, with their addresses and positions.
  assert.deepEqual(observabilityCore.stackFrames(stack).map(frame => [frame.key, frame.url, frame.line, frame.column]), [
    ['renderBoard@/assets/index.js', 'https://app.example.com/assets/index-BHg5Ehe4.js', 1, 23423],
    ['?@/assets/index.js', 'https://localhost/assets/index-BHg5Ehe4.js', 1, 99],
    ['loadGame@/assets/main.js', 'http://localhost:5173/assets/main.js', 10, 5],
    ['renderBoard@/assets/index.js', 'capacitor://localhost/assets/index-Qx81_a-Z.js', 1, 2001],
    ['?@/assets/index.js', 'capacitor://localhost/assets/index-Qx81_a-Z.js', 1, 5],
  ]);
});

test('frame addresses match stored paths by longest suffix, then by a unique file name', () => {
  assert.equal(core.urlPath('https://localhost/assets/index.js?v=1#top'), 'assets/index.js');
  assert.equal(core.urlPath('capacitor://localhost/assets/index.js'), 'assets/index.js');
  assert.equal(core.urlPath('file:///android_asset/public/assets/index.js'), 'android_asset/public/assets/index.js');
  assert.equal(core.urlPath('https://h/assets/my%20file.js'), 'assets/my file.js');
  assert.equal(core.urlPath('https://h/assets/bad%zz.js'), 'assets/bad%zz.js');
  const maps = [{ id: 'a', path: 'index.js', name: 'index.js' }, { id: 'b', path: 'assets/index.js', name: 'index.js' }, { id: 'c', path: 'chunks/vendor.js', name: 'vendor.js' }];
  assert.equal(core.matchMap('app/assets/index.js', maps).id, 'b');
  assert.equal(core.matchMap('index.js', maps).id, 'a');
  assert.equal(core.matchMap('cdn/vendor.js', maps).id, 'c');
  assert.equal(core.matchMap('other/assets/zindex.js', maps), null);
  assert.equal(core.matchMap('x/y/index.js', [maps[1], { id: 'd', path: 'legacy/index.js', name: 'index.js' }]), null);
  assert.equal(core.matchMap('x/y/index.js', [maps[1]]).id, 'b');
});

test('code context keeps four lines on each side, cut to 300 characters', () => {
  const content = Array.from({ length: 20 }, (_, i) => 'line ' + (i + 1)).join('\r\n');
  assert.deepEqual(core.context(content, 10), { start: 6, lines: ['line 6', 'line 7', 'line 8', 'line 9', 'line 10', 'line 11', 'line 12', 'line 13', 'line 14'] });
  assert.deepEqual(core.context(content, 2), { start: 1, lines: ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6'] });
  assert.deepEqual(core.context(content, 20).lines.slice(-1), ['line 20']);
  assert.deepEqual(core.context(content.split('\n'), 10), core.context(content, 10));
  assert.equal(core.context(content, 21), null);
  assert.equal(core.context('', 1), null);
  const long = core.context('x'.repeat(299) + '😀' + 'y'.repeat(100), 1).lines[0];
  assert.equal(long, 'x'.repeat(299) + '…');
});

test('fingerprints change only when a top frame maps, and then ignore releases and line numbers', () => {
  const minified = 'TypeError: m\n    at Ze (https://localhost/assets/index-AAAAAAAA.js:1:100)\n    at Qt (https://localhost/assets/index-AAAAAAAA.js:1:900)';
  const value = { service: 'game', name: 'TypeError', message: 'Board 7 failed', stack: minified };
  const legacy = hash(JSON.stringify(['game', 'TypeError', ['?@/assets/index.js', '?@/assets/index.js'], 'Board # failed']));
  assert.equal(observabilityCore.fingerprint(value, hash), legacy);
  for (const mapped of [undefined, [], [null, null], [{ source: '' }, { name: 'x' }], 'nope']) assert.equal(observabilityCore.fingerprint(value, hash, mapped), legacy);
  const mapped = [{ source: '../src/board.ts', name: 'renderBoard' }, { source: 'webpack://app/./src/game.ts', name: 'loadGame' }];
  const expected = hash(JSON.stringify(['game', 'TypeError', ['renderBoard@src/board.ts', 'loadGame@app/src/game.ts'], '']));
  assert.equal(observabilityCore.fingerprint(value, hash, mapped), expected);
  // Another release: other hash, names and positions, the same original frames and a different message.
  const next = { ...value, message: 'Board 9 exploded', stack: minified.replace(/AAAAAAAA/g, 'BBBBBBBB').replace('Ze', 'Xa').replace(':1:100', ':1:4321') };
  assert.equal(observabilityCore.fingerprint(next, hash, [{ source: '../../src/board.ts', name: 'renderBoard' }, { source: 'webpack://app/src/game.ts', name: 'loadGame' }]), expected);
  // A mapped frame without a name counts as unnamed, so the message still decides.
  const unnamed = observabilityCore.fingerprint(value, hash, [{ source: 'src/board.ts', name: null }, null]);
  assert.equal(unnamed, hash(JSON.stringify(['game', 'TypeError', ['?@src/board.ts', '?@/assets/index.js'], 'Board # failed'])));
  for (const [input, key] of [['webpack:///./src/a.ts', 'src/a.ts'], ['../../src/main.ts?v=3', 'src/main.ts'], ['src/App.vue?vue&type=script&lang.ts', 'src/App.vue'], ['.\\src\\x.ts', 'src/x.ts'], ['src/../lib/y.ts', 'lib/y.ts']]) {
    assert.equal(observabilityCore.sourceKey(input), key, input);
  }
});

test('migration keeps source map collections private, indexed, and removable', () => {
  const f = withSourcemaps();
  try {
    for (const name of ['replay_sourcemaps', 'replay_sourcemap_blocks', 'replay_sourcemap_sources']) {
      const collection = f.collections.get(name);
      for (const key of ['listRule', 'viewRule', 'createRule', 'updateRule', 'deleteRule']) assert.equal(collection[key], null, name + ' ' + key);
      for (const field of collection.fields) if (field.type === 'text') assert.ok(field.max > 0, name + '.' + field.name + ' has an explicit max');
    }
    const indexes = f.database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name LIKE 'replay_sourcemap%'").all().map(row => row.sql).join('\n');
    assert.match(indexes, /UNIQUE INDEX \w+ ON replay_sourcemaps \(appVersion, path\)/);
    assert.match(indexes, /INDEX \w+ ON replay_sourcemaps \(appVersion, name\)/);
    assert.match(indexes, /INDEX \w+ ON replay_sourcemap_blocks \(map, line, col\)/);
    const plan = f.database.prepare('EXPLAIN QUERY PLAN SELECT line, col, data FROM replay_sourcemap_blocks WHERE map = ? AND (line, col) <= (?, ?) ORDER BY line DESC, col DESC LIMIT 1').all('m', 1, 2);
    assert.match(plan.map(row => row.detail).join(' '), /USING INDEX idx_replay_sourcemap_blocks_position/);
    let up; let down;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pb_migrations/1795600004_sourcemaps.js'), 'utf8'), {
      migrate: (a, b) => { up = a; down = b; }, Collection: function (value) { Object.assign(this, value); }, console,
    });
    assert.throws(() => up(f.app), /already exists: replay_sourcemaps/);
    down(f.app);
    assert.equal(f.collections.has('replay_sourcemaps') || f.collections.has('replay_sourcemap_blocks') || f.collections.has('replay_sourcemap_sources'), false);
  } finally { f.close(); }
});

test('hook wiring loads the library per route and allows 32 MiB uploads', () => {
  const routes = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pb_hooks/715_sourcemaps.pb.js'), 'utf8'), {
    routerAdd: (method, route, handler, limit) => routes.push({ method, route, handler, limit }), $apis: { bodyLimit: value => value },
  });
  assert.deepEqual(routes.map(route => route.method + ' ' + route.route), [
    'POST /api/replay/sourcemaps', 'GET /api/replay/sourcemaps', 'DELETE /api/replay/sourcemaps', 'GET /api/replay/errors/{id}/frames',
  ]);
  assert.equal(routes[0].limit, 32 * 1024 * 1024);
  for (const route of routes) assert.match(route.handler.toString(), /require\(`\$\{__hooks\}\/lib\/sourcemaps\.js`\)/);
});

test('uploads need a superuser or the configured key, compared in constant time', () => {
  const body = sourceMap([[[0, 0, 0, 0]]]);
  const f = withSourcemaps();
  try {
    assert.throws(() => upload(f, body, {}, {}), { status: 401, message: /x-replay-sourcemap-key/ });
    assert.throws(() => sourcemaps.upload(call(f, { body, auth: { id: 'user' }, query: { appVersion: '1.0', path: 'a.js' } })), { status: 403 });
    assert.throws(() => upload(f, body, {}, { 'x-replay-sourcemap-key': 'wrong' }), { status: 401, message: 'Invalid source map key' });
    assert.throws(() => upload(f, body, {}, { 'x-replay-sourcemap-key': KEY + 'x'.repeat(600) }), { status: 401 });
    assert.equal(upload(f, body).ok, true);
    assert.equal(sourcemaps.upload(call(f, { body, superuser: true, query: { appVersion: '1.0', path: 'b.js' } })).ok, true);
    for (const secret of ['', 'short']) {
      global.$os = { getenv: name => (name === 'REPLAY_SOURCEMAP_KEY' ? secret : '') };
      assert.throws(() => upload(f, body, { path: 'c.js' }, { 'x-replay-sourcemap-key': secret || KEY }), { status: 503, message: /REPLAY_SOURCEMAP_KEY/ });
      assert.equal(sourcemaps.upload(call(f, { body, superuser: true, query: { appVersion: '1.0', path: 'c.js' } })).ok, true);
    }
    for (const name of ['list', 'frames']) {
      assert.throws(() => sourcemaps[name](call(f, { headers: { 'x-replay-sourcemap-key': KEY } })), { status: 401 }, name);
      assert.throws(() => sourcemaps[name](call(f, { auth: { id: 'user' } })), { status: 403 }, name);
    }
  } finally { f.close(); }
});

test('upload validates its query and body and reports what it stored', () => {
  const f = withSourcemaps();
  try {
    const body = sourceMap([[[0, 0, 0, 0, 0], [10, 1, 4, 2, 1]], [], [[3, 0, 9, 0]]], { sourcesContent: ['export function renderBoard() {}', null] });
    const result = upload(f, body);
    assert.deepEqual({ ...result, ms: 0, storeMs: 0 }, {
      ok: true, appVersion: '1.0', path: 'assets/index-AAAA1111.js', name: 'index-AAAA1111.js', bytes: Buffer.byteLength(body), segments: 3, blocks: 1,
      sources: 2, sourcesWithContent: 1, sourcesCut: 0, names: 3, replaced: false, ms: 0, storeMs: 0,
    });
    assert.throws(() => upload(f, body, { appVersion: '1.0 beta' }), { status: 400, message: /appVersion/ });
    assert.throws(() => upload(f, body, { path: '/assets/a.js' }), { status: 400, message: /path/ });
    assert.throws(() => upload(f, body, { path: 'assets/a.js.map' }), { status: 400, message: /\.map/ });
    assert.throws(() => upload(f, ''), { status: 400, message: /empty/ });
    assert.throws(() => upload(f, JSON.stringify({ version: 3, sections: [{ offset: { line: 0, column: 0 }, map: {} }] })), { status: 400, message: /sections/ });
    assert.throws(() => upload(f, sourceMap([[[5, 7, 0, 0]]])), { status: 400, message: /source that is not listed/ });
    assert.equal(f.records('replay_sourcemaps').length, 1);
  } finally { f.close(); }
});

test('uploading a version and path again replaces its map in one transaction', () => {
  const f = withSourcemaps();
  try {
    upload(f, sourceMap([Array.from({ length: 600 }, (_, i) => [i * 2, 0, i, 0])]));
    assert.equal(f.records('replay_sourcemap_blocks').length, 3);
    const second = upload(f, sourceMap([[[0, 1, 50, 0, 2]]], { sources: ['../src/new.ts', '../src/other.ts'] }));
    assert.equal(second.replaced, true);
    assert.equal(f.records('replay_sourcemaps').length, 1);
    assert.equal(f.records('replay_sourcemap_blocks').length, 1);
    assert.deepEqual(f.records('replay_sourcemap_sources', '', 'idx').map(row => row.getString('path')), ['../src/new.ts', '../src/other.ts']);
    // A failed commit keeps the map that was there.
    const transaction = f.app.runInTransaction;
    f.app.runInTransaction = callback => transaction(tx => { callback(tx); throw new Error('Injected commit failure'); });
    assert.throws(() => upload(f, sourceMap([[[0, 0, 1, 1]]])), /Injected commit failure/);
    f.app.runInTransaction = transaction;
    assert.deepEqual(f.records('replay_sourcemap_sources', '', 'idx').map(row => row.getString('path')), ['../src/new.ts', '../src/other.ts']);
    const found = sourcemaps.resolver(f.app, '1.0').resolve('https://localhost/assets/index-AAAA1111.js', 1, 1);
    assert.deepEqual({ source: found.source, line: found.line, column: found.column, name: found.name }, { source: '../src/other.ts', line: 50, column: 0, name: 'start' });
  } finally { f.close(); }
});

test('versions list with file counts, bytes and upload time, and delete only their own maps', () => {
  const f = withSourcemaps();
  try {
    const small = sourceMap([[[0, 0, 0, 0]]]);
    upload(f, small, { appVersion: '1.0', path: 'assets/a.js' });
    upload(f, small, { appVersion: '1.0', path: 'assets/b.js' });
    upload(f, small, { appVersion: '2.0', path: 'assets/a.js' });
    const listed = sourcemaps.list(call(f, { superuser: true }));
    assert.deepEqual(listed.items.map(item => [item.appVersion, item.files, item.bytes]).sort(), [['1.0', 2, Buffer.byteLength(small) * 2], ['2.0', 1, Buffer.byteLength(small)]]);
    assert.ok(listed.items.every(item => item.uploadedAt >= now));
    assert.deepEqual(sourcemaps.list(call(f, { superuser: true, query: { appVersion: '1.0' } })).items.map(item => item.path), ['assets/a.js', 'assets/b.js']);
    assert.throws(() => sourcemaps.remove(call(f, { query: { appVersion: '1.0' } })), { status: 401 });
    assert.throws(() => sourcemaps.remove(call(f, { superuser: true, query: { appVersion: '../1' } })), { status: 400 });
    assert.deepEqual(sourcemaps.remove(call(f, { query: { appVersion: '1.0' }, headers: { 'x-replay-sourcemap-key': KEY } })), { ok: true, appVersion: '1.0', deletedFiles: 2 });
    assert.deepEqual(sourcemaps.list(call(f, { superuser: true })).items.map(item => item.appVersion), ['2.0']);
    assert.equal(f.records('replay_sourcemap_blocks').length, 1);
    assert.equal(f.records('replay_sourcemap_sources').length, 2);
    assert.deepEqual(sourcemaps.remove(call(f, { superuser: true, query: { appVersion: '2.0' } })).deletedFiles, 1);
    assert.equal(f.records('replay_sourcemap_blocks').length + f.records('replay_sourcemap_sources').length, 0);
  } finally { f.close(); }
});

// Two builds of one app, 1.0 and 1.1, minified differently. Line 1 of each is its whole bundle.
function builds() {
  const content = ['export function renderBoard(board) {', '  const cells = board.cells;', '  return cells.map(cell => cell.value.toUpperCase());', '}', '', 'export function loadGame(id) {', '  return renderBoard(fetchBoard(id));', '}'].join('\n');
  const game = ['import { loadGame } from "./board";', 'export function start() {', '  loadGame(location.hash);', '}'].join('\n');
  const map = (offset) => JSON.stringify({
    version: 3, sources: ['../../src/board.ts', '../../src/game.ts'], names: ['toUpperCase', 'renderBoard', 'loadGame'], sourcesContent: [content, game],
    // Generated columns 0-based: the throw site, the call to renderBoard, the call to loadGame.
    mappings: encode([[[offset, 0, 2, 38, 0], [offset + 40, 0, 6, 9, 1], [offset + 90, 1, 2, 2, 2], [offset + 120]]]),
  });
  const stack = (hashName, offset, message) => [
    'TypeError: ' + message,
    `    at e (https://localhost/assets/index-${hashName}.js:1:${offset + 1 + 3})`,
    '    at Array.map (<anonymous>)',
    `    at Ab (https://localhost/assets/index-${hashName}.js:1:${offset + 41})`,
    `    at Cd (https://localhost/assets/index-${hashName}.js:1:${offset + 95})`,
  ].join('\n');
  return { map, stack };
}

test('the frames route returns original positions and code for a stored occurrence', () => {
  const f = withSourcemaps();
  try {
    const { map, stack } = builds();
    upload(f, map(100), { appVersion: '1.0', path: 'assets/index-AAAA1111.js' });
    f.enable();
    const token = f.token();
    observability.errors(f.event({ token, events: [exception('mapped', { stack: stack('AAAA1111', 100, 'Cannot read properties of undefined (reading \'toUpperCase\')') })] }));
    const id = f.records('replay_errors')[0].id;
    assert.throws(() => sourcemaps.frames(call(f, { id })), { status: 401 });
    assert.throws(() => sourcemaps.frames(call(f, { id: 'missing', superuser: true })), { status: 404 });
    const result = sourcemaps.frames(call(f, { id, superuser: true }));
    assert.equal(result.appVersion, '1.0');
    assert.equal(result.sourceMaps, 1);
    assert.equal(result.mapped, 3);
    assert.deepEqual(result.frames.map(frame => frame.mapped || null), [
      { source: '../../src/board.ts', line: 3, column: 39, name: 'toUpperCase' }, null,
      { source: '../../src/board.ts', line: 7, column: 10, name: 'renderBoard' },
      { source: '../../src/game.ts', line: 3, column: 3, name: 'loadGame' },
    ]);
    assert.deepEqual(result.frames[0].context, { start: 1, lines: ['export function renderBoard(board) {', '  const cells = board.cells;', '  return cells.map(cell => cell.value.toUpperCase());', '}', '', 'export function loadGame(id) {', '  return renderBoard(fetchBoard(id));'] });
    assert.deepEqual([result.frames[0].function, result.frames[0].line, result.frames[0].column], ['e', 1, 104]);
    assert.deepEqual(result.frames[1], { raw: 'at Array.map (<anonymous>)', function: 'Array.map', file: '<anonymous>', line: null, column: null });
    // Another version has no maps, and an install without the migration still answers.
    const other = observability.publicConfig(f.event({ ...f.metadata, deviceId: 'other', appVersion: '9.9' })).token;
    observability.errors(f.event({ token: other, events: [exception('unmapped', { stack: stack('AAAA1111', 100, 'x') })] }));
    const unmapped = sourcemaps.frames(call(f, { id: f.records('replay_errors', "eventId = 'unmapped'")[0].id, superuser: true }));
    assert.deepEqual([unmapped.sourceMaps, unmapped.mapped, unmapped.frames.length], [0, 0, 4]);
  } finally { f.close(); }
  const plain = fixture();
  try {
    plain.enable();
    observability.errors(plain.event({ token: plain.token(), events: [exception('plain')] }));
    const result = sourcemaps.frames(call(plain, { id: plain.records('replay_errors')[0].id, superuser: true }));
    assert.deepEqual([result.sourceMaps, result.mapped, result.frames[0].function], [0, 0, 'render']);
    assert.throws(() => sourcemaps.list(call(plain, { superuser: true })), { status: 503, message: /1795600004_sourcemaps/ });
  } finally { plain.close(); }
});

test('ingest groups mapped errors by original frames across releases and splits distinct sites with one message', () => {
  const f = withSourcemaps();
  try {
    const { map, stack } = builds();
    upload(f, map(100), { appVersion: '1.0', path: 'assets/index-AAAA1111.js' });
    upload(f, map(5000), { appVersion: '1.1', path: 'assets/index-BBBB2222.js' });
    f.enable();
    const oldRelease = f.token();
    const newRelease = observability.publicConfig(f.event({ ...f.metadata, deviceId: 'device-2', appVersion: '1.1' })).token;
    // Messages that differ beyond the numbers normalization removes join once frames are mapped.
    observability.errors(f.event({ token: oldRelease, events: [exception('old', { stack: stack('AAAA1111', 100, 'Board alpha failed'), message: 'Board alpha failed' })] }));
    observability.errors(f.event({ token: newRelease, events: [exception('new', { stack: stack('BBBB2222', 5000, 'Board beta failed'), message: 'Board beta failed' })] }));
    let issues = f.records('replay_issues');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].getInt('occurrenceCount'), 2);
    // The stored stack keeps what the device sent.
    assert.match(f.records('replay_errors', "eventId = 'new'")[0].getString('stack'), /index-BBBB2222\.js:1:5004/);
    // One message thrown from another original site is another issue.
    const elsewhere = stack('AAAA1111', 100, 'Board alpha failed').replace(':1:104)', ':1:191)');
    observability.errors(f.event({ token: oldRelease, events: [exception('elsewhere', { stack: elsewhere, message: 'Board alpha failed' })] }));
    issues = f.records('replay_issues');
    assert.equal(issues.length, 2);
    // A version without maps groups exactly as before.
    const unmapped = observability.publicConfig(f.event({ ...f.metadata, deviceId: 'device-3', appVersion: '3.0' })).token;
    const legacy = exception('legacy', { stack: stack('CCCC3333', 100, 'Board gamma failed'), message: 'Board gamma failed' });
    observability.errors(f.event({ token: unmapped, events: [legacy] }));
    const expected = observabilityCore.fingerprint(observabilityCore.event(legacy, 'error', Date.now()), hash);
    assert.equal(f.records('replay_issues', 'fingerprint = {:fingerprint}', '', 1, 0, { fingerprint: expected }).length, 1);
  } finally { f.close(); }
});

test('ingest keeps working when map rows cannot be read', () => {
  const f = withSourcemaps();
  try {
    const { map, stack } = builds();
    upload(f, map(100), { appVersion: '1.0', path: 'assets/index-AAAA1111.js' });
    f.database.prepare("UPDATE replay_sourcemap_blocks SET data = 'not json'").run();
    f.enable();
    const event = exception('broken', { stack: stack('AAAA1111', 100, 'Board alpha failed'), message: 'Board alpha failed' });
    assert.equal(observability.errors(f.event({ token: f.token(), events: [event] })).accepted, 1);
    const expected = observabilityCore.fingerprint(observabilityCore.event(event, 'error', Date.now()), hash);
    assert.equal(f.records('replay_issues')[0].getString('fingerprint'), expected);
  } finally { f.close(); }
});

test('an entry keeps the build it was captured in when a newer build renews the shared credential', () => {
  const f = withSourcemaps();
  try {
    const { map, stack } = builds();
    upload(f, map(100), { appVersion: '1.0', path: 'assets/index-AAAA1111.js' });
    upload(f, map(5000), { appVersion: '1.1', path: 'assets/index-BBBB2222.js' });
    f.enable();
    const token = f.token();
    const oldBuild = id => exception(id, { appVersion: '1.0', stack: stack('AAAA1111', 100, 'Board alpha failed'), message: 'Board alpha failed' });
    observability.errors(f.event({ token, events: [oldBuild('before')] }));
    // A newer build on the same device renews the credential with its own version while older entries are still queued.
    assert.equal(observability.publicConfig(f.event({ ...f.metadata, appVersion: '1.1', token })).token, token);
    observability.errors(f.event({ token, events: [oldBuild('queued')] }));
    const queued = f.records('replay_errors', "eventId = 'queued'")[0];
    assert.equal(queued.getString('appVersion'), '1.0');
    assert.equal(sourcemaps.frames(call(f, { id: queued.id, superuser: true })).mapped, 3);
    assert.equal(f.records('replay_issues').length, 1);
    assert.equal(f.records('replay_issues')[0].getInt('occurrenceCount'), 2);
    // An older client sends no version; its entry takes the credential's, as before.
    observability.errors(f.event({ token, events: [exception('legacy', { stack: stack('BBBB2222', 5000, 'Board alpha failed'), message: 'Board alpha failed' })] }));
    assert.equal(f.records('replay_errors', "eventId = 'legacy'")[0].getString('appVersion'), '1.1');
    assert.equal(f.records('replay_issues').length, 1);
    // A retry of an entry sent without a version still counts as a duplicate.
    const retry = observability.errors(f.event({ token, events: [exception('legacy', { stack: stack('BBBB2222', 5000, 'Board alpha failed'), message: 'Board alpha failed' })] }));
    assert.deepEqual([retry.accepted, retry.duplicates, retry.conflicts], [0, 1, 0]);
    // A build that has no version says so with an empty one, which stays empty instead of taking the credential's.
    const unversioned = exception('unversioned', { appVersion: '', stack: stack('BBBB2222', 5000, 'Board alpha failed'), message: 'Board alpha failed' });
    assert.equal(observabilityCore.event(unversioned, 'error', Date.now()).appVersion, '');
    observability.errors(f.event({ token, events: [unversioned] }));
    const stored = f.records('replay_errors', "eventId = 'unversioned'")[0];
    assert.equal(stored.getString('appVersion'), '');
    assert.deepEqual([sourcemaps.frames(call(f, { id: stored.id, superuser: true })).sourceMaps, sourcemaps.frames(call(f, { id: stored.id, superuser: true })).mapped], [0, 0]);
    const again = observability.errors(f.event({ token, events: [unversioned] }));
    assert.deepEqual([again.accepted, again.duplicates, again.conflicts], [0, 1, 0]);
  } finally { f.close(); }
});
