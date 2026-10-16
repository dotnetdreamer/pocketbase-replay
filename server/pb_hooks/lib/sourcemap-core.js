// Source maps: validation, a block index over the mappings, lookups, stack frames and code context.
// Pure functions, shared by the PocketBase hooks and the Node tests.
const replay = require('./replay-core.js');

const LIMITS = {
  bodyBytes: 32 * 1024 * 1024,
  pathChars: 1024,
  sources: 20000,
  sourceChars: 1024,
  names: 500000,
  nameChars: 256,
  segments: 4000000,
  contentChars: 2000000,
  blockSegments: 256,
  blockLines: 1024,
  blockMaxSegments: 2048,
  blockChars: 2000000,
  contextLines: 4,
  contextChars: 300,
  frames: 100,
};
const MAX_POSITION = 2147483647;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const CONTROLS = /[\x00-\x1f\x7f]/g;
const BASE64 = (function () {
  const table = [];
  for (let i = 0; i < 128; i++) table.push(-1);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < alphabet.length; i++) table[alphabet.charCodeAt(i)] = i;
  return table;
})();

function appVersion(value) {
  if (typeof value !== 'string' || !VERSION.test(value)) {
    replay.fail(400, 'Invalid appVersion: use 1 to 64 letters, digits, dots, underscores, plus signs or hyphens, starting with a letter or digit');
  }
  return value;
}

// The generated file's path inside the build folder, as the app's URLs end with it.
function filePath(value) {
  if (typeof value !== 'string' || !value || value.length > LIMITS.pathChars) {
    replay.fail(400, 'Invalid path: send the generated file\'s path relative to the build folder, up to 1024 characters');
  }
  if (value.charAt(0) === '/' || /[\x00-\x1f\x7f\\?#]/.test(value) || value.split('/').some(function (part) { return !part || part === '.' || part === '..'; })) {
    replay.fail(400, 'Invalid path: use a relative path such as assets/index-BHg5Ehe4.js, without a leading slash, "..", backslashes, ? or #');
  }
  if (!/\.[cm]?js$/.test(value)) replay.fail(400, 'Invalid path: name the generated .js, .mjs or .cjs file, not its .map file');
  return value;
}

function baseName(value) { return value.slice(value.lastIndexOf('/') + 1); }

function invalid(message) { replay.fail(400, 'Invalid source map: ' + message); }

function joinRoot(root, source) {
  if (!root || !source || /^[a-z][a-z0-9+.-]*:/i.test(source) || source.charAt(0) === '/') return source;
  return root.charAt(root.length - 1) === '/' ? root + source : root + '/' + source;
}

// A source longer than the limit keeps its first lines, so context still works near the top of the file.
function cutContent(value) {
  if (value.length <= LIMITS.contentChars) return value;
  const end = value.lastIndexOf('\n', LIMITS.contentChars - 1);
  return end < 0 ? '' : value.slice(0, end + 1);
}

// Validates a version 3 source map and keeps what lookups need. Index maps ("sections") are refused
// rather than flattened: each generated file is uploaded with its own map.
function parse(raw) {
  let map;
  try { map = JSON.parse(raw); } catch (_) { replay.fail(400, 'The body is not valid JSON. Send the contents of the .map file'); }
  if (!map || typeof map !== 'object' || Array.isArray(map)) replay.fail(400, 'Expected a source map object');
  if (map.sections !== undefined) replay.fail(400, 'Index source maps with "sections" are not supported. Upload the map of each generated file instead');
  if (map.version !== 3) replay.fail(400, 'Only version 3 source maps are supported');
  if (typeof map.mappings !== 'string') invalid('mappings must be a string');
  if (!Array.isArray(map.sources)) invalid('sources must be an array');
  if (map.sources.length > LIMITS.sources) replay.fail(413, 'Source map lists more than ' + LIMITS.sources + ' sources');
  if (map.names !== undefined && map.names !== null && !Array.isArray(map.names)) invalid('names must be an array');
  const names = Array.isArray(map.names) ? map.names : [];
  if (names.length > LIMITS.names) replay.fail(413, 'Source map lists more than ' + LIMITS.names + ' names');
  if (map.sourcesContent !== undefined && map.sourcesContent !== null && !Array.isArray(map.sourcesContent)) invalid('sourcesContent must be an array');
  const contents = Array.isArray(map.sourcesContent) ? map.sourcesContent : [];
  const root = typeof map.sourceRoot === 'string' ? map.sourceRoot : '';
  const sources = [];
  for (let i = 0; i < map.sources.length; i++) {
    const value = map.sources[i];
    if (value !== null && typeof value !== 'string') invalid('every source must be a string');
    sources.push(joinRoot(root, value || '').replace(CONTROLS, '').slice(0, LIMITS.sourceChars));
  }
  // Checked once for the whole list: real names are short identifiers without control characters.
  let cleanNames = names;
  for (let i = 0; i < names.length; i++) if (typeof names[i] !== 'string') invalid('every name must be a string');
  if (CONTROL.test(names.join('')) || names.some(function (name) { return name.length > LIMITS.nameChars; })) {
    cleanNames = names.map(function (name) { return name.replace(CONTROLS, '').slice(0, LIMITS.nameChars); });
  }
  const kept = [];
  let cut = 0;
  for (let i = 0; i < sources.length; i++) {
    const value = i < contents.length ? contents[i] : null;
    if (value !== null && value !== undefined && typeof value !== 'string') invalid('sourcesContent entries must be strings or null');
    const text = typeof value === 'string' ? cutContent(value) : '';
    if (typeof value === 'string' && text.length < value.length) cut++;
    kept.push(text);
  }
  return { mappings: map.mappings, sources: sources, names: cleanNames, contents: kept, contentsCut: cut };
}

// One segment's fields as [count, generated column, source, original line, original column, name], each
// relative to the previous segment. A value has at most seven base64 digits.
function segment(text) {
  const result = [0, 0, 0, 0, 0, 0];
  const length = text.length;
  let fields = 0;
  let pos = 0;
  while (pos < length) {
    if (fields === 5) invalid('a mappings segment has more than five fields');
    let value = 0;
    let scale = 1;
    let digit = 0;
    let digits = 0;
    do {
      if (pos >= length) invalid('a mappings value is cut short');
      const code = text.charCodeAt(pos++);
      digit = code < 128 ? BASE64[code] : -1;
      if (digit < 0) invalid('mappings contain the character ' + JSON.stringify(text.charAt(pos - 1)));
      if (++digits > 7) invalid('a mappings value is too large');
      value += (digit & 31) * scale;
      scale *= 32;
    } while (digit & 32);
    result[++fields] = value % 2 ? -(value - 1) / 2 : value / 2;
  }
  if (fields !== 1 && fields !== 4 && fields !== 5) invalid('a mappings segment has ' + fields + ' fields');
  result[0] = fields;
  return result;
}

// Walks the mappings once, checking every segment, and keeps one block per run of about 256 segments: the
// absolute decoder state before its first segment, its slice of the mappings, and the names it uses.
// A lookup then decodes one block. Blocks never split segments that share a generated position, and a
// long run of unmapped lines ends a block, so a slice stays small. The mappings are read in chunks of
// about 64 KB, split natively, so a one-line bundle or a run of empty lines never becomes one huge array.
// Decoded segment strings are memoized: PocketBase's JavaScript engine is far slower per character than
// V8, and the same segment text recurs often.
function index(mappings, sourceCount, names, options) {
  const settings = Object.assign({ segments: LIMITS.blockSegments, lines: LIMITS.blockLines, maxSegments: LIMITS.blockMaxSegments, total: LIMITS.segments, chunk: 65536 }, options || {});
  const nameCount = names.length;
  const seen = new Int32Array(nameCount || 1);
  const cache = new Map();
  const blocks = [];
  const length = mappings.length;
  let pos = 0;
  let line = 0;
  let col = 0;
  let source = 0;
  let oline = 0;
  let ocol = 0;
  let name = 0;
  let prevLine = -1;
  let prevCol = -1;
  let prevEnd = 0;
  let total = 0;
  let open = false;
  let block = 0;
  let blockStart = 0;
  let blockLine = 0;
  let blockCol = 0;
  let blockSize = 0;
  let base = null;
  let used = [];
  function close() {
    const pairs = [];
    for (const item of used) pairs.push(item, names[item]);
    const data = JSON.stringify([base[0], base[1], base[2], base[3], base[4], mappings.substring(blockStart, prevEnd), pairs]);
    if (data.length > LIMITS.blockChars) invalid('one block of segments is too large');
    blocks.push({ line: blockLine, col: blockCol, data: data });
  }
  while (pos < length) {
    // A chunk ends just after a separator, so no segment is cut; its first row continues the current line.
    // The separator is looked for in the last 64 characters only, since a valid segment is at most 35.
    let stop = length;
    if (length - pos > settings.chunk) {
      const from = Math.max(pos, pos + settings.chunk - 64);
      const tail = mappings.substring(from, pos + settings.chunk);
      const cut = Math.max(tail.lastIndexOf(';'), tail.lastIndexOf(','));
      if (cut < 0) invalid('a mappings segment is too long');
      stop = from + cut + 1;
    }
    const rows = mappings.substring(pos, stop).split(';');
    let offset = pos;
    for (let r = 0; r < rows.length; r++) {
      if (r > 0) { line++; col = 0; }
      const row = rows[r];
      if (row) {
        const parts = row.split(',');
        let start = offset;
        for (let i = 0; i < parts.length; i++) {
          const text = parts[i];
          const end = start + text.length;
          if (text) {
            let fields = cache.get(text);
            if (fields === undefined) {
              fields = segment(text);
              if (cache.size < 262144) cache.set(text, fields);
            }
            const next = col + fields[1];
            if (next < 0 || next > MAX_POSITION) invalid('a generated column is out of range');
            if (line === prevLine && next < prevCol) invalid('mappings must be sorted by generated column');
            if (!open || ((blockSize >= settings.segments || line - blockLine > settings.lines) && (line !== prevLine || next !== prevCol))) {
              if (open) close();
              open = true;
              block++;
              blockStart = start;
              blockLine = line;
              blockCol = next;
              blockSize = 0;
              base = [col, source, oline, ocol, name];
              used = [];
            }
            if (++blockSize > settings.maxSegments) invalid('too many segments share one generated position');
            col = next;
            if (fields[0] > 1) {
              source += fields[2];
              oline += fields[3];
              ocol += fields[4];
              if (source < 0 || source >= sourceCount) invalid('a segment points to a source that is not listed');
              if (oline < 0 || oline > MAX_POSITION || ocol < 0 || ocol > MAX_POSITION) invalid('an original position is out of range');
              if (fields[0] === 5) {
                name += fields[5];
                if (name < 0 || name >= nameCount) invalid('a segment points to a name that is not listed');
                if (seen[name] !== block) { seen[name] = block; used.push(name); }
              }
            }
            if (++total > settings.total) replay.fail(413, 'Source map has more than ' + settings.total + ' mappings segments');
            prevLine = line;
            prevCol = col;
            prevEnd = end;
          }
          start = end + 1;
        }
      }
      offset += row.length + 1;
    }
    pos = stop;
  }
  if (open) close();
  return { segments: total, blocks: blocks };
}

// The segment a source map consumer picks for a 0-based generated position, decoded from the block that
// holds it: the last segment at or before the column on that line and, of several at one column, the
// first. Null when there is none on the line or it has no source.
function find(block, line, column) {
  if (line < block.line) return null;
  const state = typeof block.data === 'string' ? JSON.parse(block.data) : block.data;
  const rows = state[5].split(';');
  let col = state[0];
  let source = state[1];
  let oline = state[2];
  let ocol = state[3];
  let name = state[4];
  let found = null;
  for (let r = 0; r < rows.length && block.line + r <= line; r++) {
    const current = block.line + r;
    if (r > 0) col = 0;
    const parts = rows[r] ? rows[r].split(',') : [];
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      const fields = segment(parts[i]);
      col += fields[1];
      if (fields[0] > 1) {
        source += fields[2];
        oline += fields[3];
        ocol += fields[4];
        if (fields[0] === 5) name += fields[5];
      }
      if (current !== line) continue;
      if (col > column) break;
      if (!found || col > found.col) found = { col: col, fields: fields[0], source: source, line: oline, column: ocol, name: fields[0] === 5 ? name : -1 };
    }
  }
  if (!found || found.fields < 4) return null;
  let text = null;
  const pairs = state[6];
  for (let i = 0; found.name >= 0 && i < pairs.length; i += 2) {
    if (pairs[i] === found.name) { text = pairs[i + 1]; break; }
  }
  return { source: found.source, line: found.line, column: found.column, name: text };
}

// One stack line as a frame: Chrome "at fn (url:1:2)" and "at url:1:2", Safari and Firefox "fn@url:1:2".
// Lines and columns stay 1-based, as engines print them. Anything else, such as the message, is null.
function parseFrame(raw) {
  const text = String(raw).trim();
  let fn = '';
  let file = '';
  let match = /^at (?:(.+?) \((.*)\)|(.+))$/.exec(text);
  if (match) { fn = match[1] || ''; file = match[2] || match[3] || ''; }
  // A colon before the @ is Chrome's "Name: message" first line, not a frame.
  else if ((match = /^([^@:]*)@(\S+|\[native code\])$/.exec(text))) { fn = match[1]; file = match[2]; }
  else return null;
  const position = /^(.*?):(\d+)(?::(\d+))?$/.exec(file);
  return {
    raw: text, function: fn, file: position ? position[1] : file,
    line: position ? Number(position[2]) : null, column: position && position[3] ? Number(position[3]) : null,
  };
}

function parseStack(stack) {
  const result = [];
  for (const raw of String(stack || '').split('\n')) {
    const frame = parseFrame(raw);
    if (frame) result.push(frame);
  }
  return result;
}

// The URL path a stored map path is matched against: no scheme, host, query or hash, so
// https://localhost/assets/a.js (Android) and capacitor://localhost/assets/a.js (iOS) both give assets/a.js.
function urlPath(file) {
  let value = String(file || '').replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/[?#].*$/, '');
  try { value = decodeURIComponent(value); } catch (_) { /* Kept as sent. */ }
  return value.replace(/^\/+/, '');
}

// The longest stored path the URL path ends with; failing that, the only map with the same file name.
function matchMap(path, maps) {
  let best = null;
  for (const map of maps) {
    if ((path === map.path || path.endsWith('/' + map.path)) && (!best || map.path.length > best.path.length)) best = map;
  }
  if (best) return best;
  const name = baseName(path);
  let found = null;
  for (const map of maps) {
    if (map.name !== name) continue;
    if (found) return null;
    found = map;
  }
  return found;
}

// Lines around a 1-based line, each cut to a readable length. `source` is a file's text, or its lines
// already split, which a caller showing several frames of one file splits once. Null when the source
// does not reach that line.
function context(source, line, radius, maxChars) {
  const around = radius === undefined ? LIMITS.contextLines : radius;
  const width = maxChars === undefined ? LIMITS.contextChars : maxChars;
  if (!source || !(line >= 1)) return null;
  const all = typeof source === 'string' ? source.split('\n') : source;
  if (line > all.length) return null;
  const start = Math.max(1, line - around);
  const lines = [];
  for (let current = start; current <= Math.min(all.length, line + around); current++) {
    let text = all[current - 1];
    if (text.charAt(text.length - 1) === '\r') text = text.slice(0, -1);
    // Do not split an emoji's surrogate pair at the limit.
    lines.push(text.length > width ? text.slice(0, width).replace(/[\uD800-\uDBFF]$/, '') + '…' : text);
  }
  return { start: start, lines: lines };
}

module.exports = {
  LIMITS: LIMITS, appVersion: appVersion, filePath: filePath, baseName: baseName, parse: parse, segment: segment, index: index, find: find,
  parseFrame: parseFrame, parseStack: parseStack, urlPath: urlPath, matchMap: matchMap, context: context,
};
