// Base64 and gunzip for recording chunks, in plain JavaScript: PocketBase's engine (goja) has neither.
// Function calls cost far more in goja than in V8, so the decoding loops are inlined, and long copies use
// copyWithin and set, which goja runs natively. About twice as fast there as a general-purpose library.
const BASE64 = new Int16Array(256).fill(-1);
(function () {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < 64; i++) BASE64[alphabet.charCodeAt(i)] = i;
})();

// Standard base64 with padding, as clients upload chunks. One regular expression checks the alphabet,
// so the loop needs no checks of its own.
function base64(text) {
  const length = typeof text === 'string' ? text.length : -1;
  if (length < 0 || length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('Invalid base64');
  const pad = length && text.charCodeAt(length - 1) === 61 ? (text.charCodeAt(length - 2) === 61 ? 2 : 1) : 0;
  const out = new Uint8Array(length / 4 * 3 - pad);
  const full = pad ? length - 4 : length;
  let o = 0;
  for (let i = 0; i < full; i += 4) {
    const n = (BASE64[text.charCodeAt(i)] << 18) | (BASE64[text.charCodeAt(i + 1)] << 12) | (BASE64[text.charCodeAt(i + 2)] << 6) | BASE64[text.charCodeAt(i + 3)];
    out[o] = n >> 16; out[o + 1] = (n >> 8) & 255; out[o + 2] = n & 255;
    o += 3;
  }
  if (pad) {
    const n = (BASE64[text.charCodeAt(full)] << 18) | (BASE64[text.charCodeAt(full + 1)] << 12) | (pad === 1 ? BASE64[text.charCodeAt(full + 2)] << 6 : 0);
    out[o++] = n >> 16;
    if (pad === 1) out[o] = (n >> 8) & 255;
  }
  return out;
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
// Root table bits: codes up to this long decode in one lookup, longer ones through a small second table.
const ROOT_BITS = 10;

// A canonical Huffman code (RFC 1951 3.2.2) as a lookup table read from the low bits up. A root entry is
// symbol << 4 | length. A code longer than the root leads to a sub-table, and its root entry is then
// -(offset << 4 | sub-table bits). An entry of 0 is a code that does not exist.
function huffman(lengths, count) {
  const counts = new Int32Array(16);
  let max = 0;
  for (let i = 0; i < count; i++) {
    counts[lengths[i]]++;
    if (lengths[i] > max) max = lengths[i];
  }
  counts[0] = 0;
  const next = new Int32Array(16);
  let code = 0;
  let left = 1;
  for (let bits = 1; bits <= 15; bits++) {
    left = (left << 1) - counts[bits];
    if (left < 0) throw new Error('Invalid Huffman code');
    code = (code + counts[bits - 1]) << 1;
    next[bits] = code;
  }
  const root = Math.min(ROOT_BITS, Math.max(max, 1));
  const reversed = new Int32Array(count);
  const subBits = {};
  for (let i = 0; i < count; i++) {
    const length = lengths[i];
    if (!length) continue;
    // DEFLATE sends a Huffman code from its top bit, so the table is indexed by the code's reversed bits.
    let value = next[length]++;
    let bits = 0;
    for (let b = 0; b < length; b++) { bits = (bits << 1) | (value & 1); value >>= 1; }
    reversed[i] = bits;
    if (length > root) {
      const prefix = bits & ((1 << root) - 1);
      subBits[prefix] = Math.max(subBits[prefix] || 0, length - root);
    }
  }
  let size = 1 << root;
  const offsets = {};
  const prefixes = Object.keys(subBits);
  for (const prefix of prefixes) { offsets[prefix] = size; size += 1 << subBits[prefix]; }
  const table = new Int32Array(size);
  for (const prefix of prefixes) table[Number(prefix)] = -((offsets[prefix] << 4) | subBits[prefix]);
  for (let i = 0; i < count; i++) {
    const length = lengths[i];
    if (!length) continue;
    const bits = reversed[i];
    if (length <= root) {
      const entry = (i << 4) | length;
      for (let at = bits; at < (1 << root); at += 1 << length) table[at] = entry;
    } else {
      const prefix = bits & ((1 << root) - 1);
      const base = offsets[prefix];
      const entry = (i << 4) | (length - root);
      for (let at = bits >> root; at < (1 << subBits[prefix]); at += 1 << (length - root)) table[base + at] = entry;
    }
  }
  return { table: table, root: root };
}

let FIXED = null;
function fixedCodes() {
  if (FIXED) return FIXED;
  const lengths = new Uint8Array(288);
  for (let i = 0; i < 288; i++) lengths[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
  FIXED = { literal: huffman(lengths, 288), distance: huffman(new Uint8Array(30).fill(5), 30) };
  return FIXED;
}

// Inflates raw DEFLATE data starting at src[start] into out, which must be exactly the decompressed size.
// Reads past the end see zero bits; a stream that needs more than a few of them is truncated.
function inflate(src, start, out) {
  const end = src.length;
  const size = out.length;
  let pos = start;
  let bitbuf = 0;
  let bitcnt = 0;
  let o = 0;
  let last = 0;
  while (!last) {
    while (bitcnt < 3) {
      if (pos >= end) throw new Error('Truncated recording data');
      bitbuf |= src[pos++] << bitcnt; bitcnt += 8;
    }
    last = bitbuf & 1;
    const type = (bitbuf >> 1) & 3;
    bitbuf >>>= 3; bitcnt -= 3;
    if (type === 0) {
      // Whole bytes already read ahead go back to the input; the rest of the current byte is padding.
      pos -= bitcnt >> 3;
      bitbuf = 0; bitcnt = 0;
      if (pos + 4 > end) throw new Error('Truncated recording data');
      const length = src[pos] | (src[pos + 1] << 8);
      if ((length ^ 0xffff) !== (src[pos + 2] | (src[pos + 3] << 8))) throw new Error('Invalid recording data');
      pos += 4;
      if (pos + length > end || o + length > size) throw new Error('Invalid recording data');
      out.set(src.subarray(pos, pos + length), o);
      pos += length; o += length;
      continue;
    }
    let literal;
    let distance;
    if (type === 1) {
      const fixed = fixedCodes();
      literal = fixed.literal; distance = fixed.distance;
    } else if (type === 2) {
      while (bitcnt < 14) {
        if (pos >= end) throw new Error('Truncated recording data');
        bitbuf |= src[pos++] << bitcnt; bitcnt += 8;
      }
      const literals = (bitbuf & 31) + 257;
      const distances = ((bitbuf >> 5) & 31) + 1;
      const codes = ((bitbuf >> 10) & 15) + 4;
      bitbuf >>>= 14; bitcnt -= 14;
      if (literals > 286 || distances > 30) throw new Error('Invalid recording data');
      const codeLengths = new Uint8Array(19);
      for (let i = 0; i < codes; i++) {
        while (bitcnt < 3) {
          if (pos >= end) throw new Error('Truncated recording data');
          bitbuf |= src[pos++] << bitcnt; bitcnt += 8;
        }
        codeLengths[CODE_ORDER[i]] = bitbuf & 7;
        bitbuf >>>= 3; bitcnt -= 3;
      }
      const lengthCode = huffman(codeLengths, 19);
      const lengthTable = lengthCode.table;
      const lengthMask = (1 << lengthCode.root) - 1;
      const total = literals + distances;
      const lengths = new Uint8Array(total);
      for (let i = 0; i < total;) {
        if (pos > end + 4) throw new Error('Truncated recording data');
        while (bitcnt <= 24) { if (pos < end) bitbuf |= src[pos] << bitcnt; pos++; bitcnt += 8; }
        const entry = lengthTable[bitbuf & lengthMask];
        if (entry <= 0) throw new Error('Invalid recording data');
        bitbuf >>>= entry & 15; bitcnt -= entry & 15;
        const symbol = entry >> 4;
        if (symbol < 16) { lengths[i++] = symbol; continue; }
        let repeat;
        let value = 0;
        if (symbol === 16) {
          if (!i) throw new Error('Invalid recording data');
          value = lengths[i - 1];
          repeat = 3 + (bitbuf & 3); bitbuf >>>= 2; bitcnt -= 2;
        } else if (symbol === 17) { repeat = 3 + (bitbuf & 7); bitbuf >>>= 3; bitcnt -= 3; }
        else { repeat = 11 + (bitbuf & 127); bitbuf >>>= 7; bitcnt -= 7; }
        if (i + repeat > total) throw new Error('Invalid recording data');
        while (repeat--) lengths[i++] = value;
      }
      if (!lengths[256]) throw new Error('Invalid recording data');
      literal = huffman(lengths.subarray(0, literals), literals);
      distance = huffman(lengths.subarray(literals), distances);
    } else throw new Error('Invalid recording data');
    const literalTable = literal.table;
    const literalRoot = literal.root;
    const literalMask = (1 << literalRoot) - 1;
    const distanceTable = distance.table;
    const distanceRoot = distance.root;
    const distanceMask = (1 << distanceRoot) - 1;
    for (;;) {
      // A byte lands at bit 24 at most, so the buffer never holds more than 32 bits. 25 bits cover a length
      // code with its extra bits.
      if (bitcnt < 20) {
        if (pos > end + 4) throw new Error('Truncated recording data');
        while (bitcnt <= 24) { if (pos < end) bitbuf |= src[pos] << bitcnt; pos++; bitcnt += 8; }
      }
      let entry = literalTable[bitbuf & literalMask];
      if (entry < 0) {
        bitbuf >>>= literalRoot; bitcnt -= literalRoot;
        entry = literalTable[((-entry) >> 4) + (bitbuf & ((1 << ((-entry) & 15)) - 1))];
      }
      const used = entry & 15;
      if (!used) throw new Error('Invalid recording data');
      bitbuf >>>= used; bitcnt -= used;
      const symbol = entry >> 4;
      if (symbol < 256) {
        if (o >= size) throw new Error('Recording data is larger than its size');
        out[o++] = symbol;
        continue;
      }
      if (symbol === 256) break;
      if (symbol > 285) throw new Error('Invalid recording data');
      let length = LENGTH_BASE[symbol - 257];
      const lengthBits = LENGTH_EXTRA[symbol - 257];
      if (lengthBits) { length += bitbuf & ((1 << lengthBits) - 1); bitbuf >>>= lengthBits; bitcnt -= lengthBits; }
      if (bitcnt < 15) {
        if (pos > end + 4) throw new Error('Truncated recording data');
        while (bitcnt <= 24) { if (pos < end) bitbuf |= src[pos] << bitcnt; pos++; bitcnt += 8; }
      }
      let code = distanceTable[bitbuf & distanceMask];
      if (code < 0) {
        bitbuf >>>= distanceRoot; bitcnt -= distanceRoot;
        code = distanceTable[((-code) >> 4) + (bitbuf & ((1 << ((-code) & 15)) - 1))];
      }
      const codeUsed = code & 15;
      if (!codeUsed || (code >> 4) >= 30) throw new Error('Invalid recording data');
      bitbuf >>>= codeUsed; bitcnt -= codeUsed;
      let back = DISTANCE_BASE[code >> 4];
      const backBits = DISTANCE_EXTRA[code >> 4];
      if (backBits) {
        if (bitcnt < backBits) {
          if (pos > end + 4) throw new Error('Truncated recording data');
          while (bitcnt <= 24) { if (pos < end) bitbuf |= src[pos] << bitcnt; pos++; bitcnt += 8; }
        }
        back += bitbuf & ((1 << backBits) - 1); bitbuf >>>= backBits; bitcnt -= backBits;
      }
      if (back > o) throw new Error('Invalid recording data');
      if (o + length > size) throw new Error('Recording data is larger than its size');
      let from = o - back;
      if (length > 16) {
        // Native copies; an overlapping match repeats its pattern, which doubles with each pass.
        while (length > 0) {
          const step = Math.min(length, o - from);
          out.copyWithin(o, from, from + step);
          o += step; length -= step;
        }
      } else {
        while (length--) out[o++] = out[from++];
      }
    }
  }
  if (pos - (bitcnt >> 3) > end) throw new Error('Truncated recording data');
  return { written: o, next: pos - (bitcnt >> 3) };
}

// One gzip member (RFC 1952) whose decompressed size is known, as stored with each chunk. The size in the
// trailer must match it, as the dashboard player also checks; the CRC is not computed, which would double the time.
function gunzip(src, size) {
  if (!(src instanceof Uint8Array) || src.length < 18 || src[0] !== 31 || src[1] !== 139 || src[2] !== 8) throw new Error('Not gzip data');
  const flags = src[3];
  let at = 10;
  if (flags & 4) at += 2 + (src[10] | (src[11] << 8));
  if (flags & 8) { while (at < src.length && src[at]) at++; at++; }
  if (flags & 16) { while (at < src.length && src[at]) at++; at++; }
  if (flags & 2) at += 2;
  if (at >= src.length - 8) throw new Error('Truncated recording data');
  const stored = (src[src.length - 4] | (src[src.length - 3] << 8) | (src[src.length - 2] << 16) | (src[src.length - 1] << 24)) >>> 0;
  if (stored !== size) throw new Error('Recording size mismatch');
  const out = new Uint8Array(size);
  const result = inflate(src, at, out);
  if (result.written !== size || result.next > src.length - 8) throw new Error('Recording size mismatch');
  return out;
}

module.exports = { base64: base64, inflate: inflate, gunzip: gunzip };
