const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { base64, gunzip } = require('../pb_hooks/lib/gzip.js');

// A small deterministic generator, so a failure always reproduces.
function random(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
}

function bytes(length, seed) {
  const next = random(seed);
  return Buffer.from(Array.from({ length }, () => Math.floor(next() * 256)));
}

function recording(events, seed) {
  const next = random(seed);
  const items = [{ type: 4, timestamp: 1, data: { href: 'https://app.test/checkout', width: 390, height: 844 } }];
  for (let i = 0; i < events; i++) {
    items.push(next() < 0.5
      ? { type: 3, timestamp: 2 + i, data: { source: 1, positions: [{ x: Math.floor(next() * 400), y: Math.floor(next() * 800), id: i, timeOffset: -10 }] } }
      : { type: 3, timestamp: 2 + i, data: { source: 0, texts: [{ id: i, value: 'Total ' + (next() * 1000).toFixed(2) }], attributes: [], removes: [], adds: [] } });
  }
  return Buffer.from(JSON.stringify(items));
}

const inputs = [
  ['two bytes', Buffer.from('[]')],
  ['one byte of random data', bytes(1, 1)],
  ['random data across stored-block limits', bytes(70000, 2)],
  ['zeros', Buffer.alloc(150000)],
  ['long overlapping runs', Buffer.from('a'.repeat(1000) + 'b'.repeat(258 * 3) + 'abcabcabc'.repeat(3000))],
  ['a recording', recording(3000, 3)],
  ['an image frame', Buffer.from(JSON.stringify([{ type: 2, timestamp: 1, data: { node: { attributes: { src: 'data:image/png;base64,' + bytes(60000, 4).toString('base64') } } } }]))],
  ['text outside ASCII', Buffer.from('héllo wörld — 日本語 🎉 '.repeat(2000))],
];

const decode = (gz, size) => Buffer.from(gunzip(base64(Buffer.from(gz).toString('base64')), size));

test('inflates exactly what zlib wrote, at every level and strategy', () => {
  const { Z_FILTERED, Z_HUFFMAN_ONLY, Z_RLE, Z_FIXED } = zlib.constants;
  for (const [name, raw] of inputs) {
    const variants = [];
    for (let level = 0; level <= 9; level++) variants.push([`level ${level}`, { level }]);
    for (const strategy of [Z_FILTERED, Z_HUFFMAN_ONLY, Z_RLE, Z_FIXED]) variants.push([`strategy ${strategy}`, { strategy }]);
    variants.push(['a 512-byte window', { windowBits: 9, memLevel: 1 }]);
    for (const [variant, options] of variants) assert.ok(decode(zlib.gzipSync(raw, options), raw.length).equals(raw), `${name}, ${variant}`);
  }
});

test('reads optional gzip header fields', () => {
  const raw = recording(50, 5);
  const plain = zlib.gzipSync(raw);
  // FEXTRA, FNAME, FCOMMENT and FHCRC, spliced into a stream zlib wrote.
  const header = Buffer.concat([
    Buffer.from([31, 139, 8, 4 | 8 | 16 | 2]), plain.subarray(4, 10),
    Buffer.from([3, 0, 1, 2, 3]), Buffer.from('chunk.json\0'), Buffer.from('a comment\0'), Buffer.from([0, 0]),
  ]);
  assert.ok(decode(Buffer.concat([header, plain.subarray(10)]), raw.length).equals(raw));
});

test('refuses truncated data, a wrong size and data that is not gzip', () => {
  const raw = recording(500, 6);
  const good = zlib.gzipSync(raw);
  for (const size of [0, 10, 17, 18, good.length - 9, good.length - 1]) {
    assert.throws(() => decode(good.subarray(0, size), raw.length), undefined, `${size} bytes`);
  }
  assert.throws(() => decode(good, raw.length + 1), /size mismatch/);
  assert.throws(() => decode(zlib.deflateRawSync(raw), raw.length), /Not gzip/);
  assert.throws(() => base64('H4sI*'), /Invalid base64/);
  assert.throws(() => base64('H4s'), /Invalid base64/);
});

test('never hangs or reads past its output on damaged data', () => {
  const raw = recording(800, 7);
  const good = zlib.gzipSync(raw);
  const next = random(8);
  for (let i = 0; i < 1500; i++) {
    const bad = Buffer.from(good);
    const at = 10 + Math.floor(next() * (bad.length - 18));
    bad[at] ^= 1 << Math.floor(next() * 8);
    let out;
    try { out = decode(bad, raw.length); } catch { continue; }
    // A changed bit can still give the right number of bytes; parsing those as JSON then usually fails.
    assert.equal(out.length, raw.length);
  }
});

test('decodes base64 with and without padding', () => {
  for (const text of ['', 'a', 'ab', 'abc', 'abcd', 'héllo']) {
    assert.equal(Buffer.from(base64(Buffer.from(text).toString('base64'))).toString(), text);
  }
});
