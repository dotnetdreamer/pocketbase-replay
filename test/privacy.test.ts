import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanUrl, serializeEvent } from '../src/privacy';
import type { ReplayEvent } from '../src/types';

const css = '.private-preview { color: red; background:url("https://assets.test/image.png?token=SECRET#private"); filter:url(#glow) }';
const sanitized = '.private-preview { color: red; background:url("https://assets.test/image.png"); filter:url("#glow") }';
const encode = (data: ReplayEvent['data']) => JSON.parse(serializeEvent({ type: 3, timestamp: 1, data }, ['red']));

test('stylesheet rule additions and replacements scrub URLs and keep CSS selectors', () => {
  const result = encode({ source: 8, id: 42, adds: [{ rule: css, index: 0 }], replace: css, replaceSync: css });
  assert.equal(result.data.adds[0].rule, sanitized);
  assert.equal(result.data.replace, sanitized);
  assert.equal(result.data.replaceSync, sanitized);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|token=|#private/);
});

test('CSS declaration values scrub URLs without replacing the priority', () => {
  const result = encode({ source: 13, id: 42, index: [0], set: { property: 'background-image', value: 'url(/image.png?token=SECRET)', priority: 'important' } });
  assert.equal(result.data.set.value, 'url("/image.png")');
  assert.equal(result.data.set.priority, 'important');
  const removed = encode({ source: 13, id: 42, index: [0], set: { property: '--custom', value: null, priority: '' } });
  assert.equal(removed.data.set.value, null);
});

test('object-form style mutations scrub strings and priority tuples, preserving removals', () => {
  const result = encode({ source: 0, attributes: [{ id: 42, attributes: { style: {
    'background-image': 'url(https://assets.test/image.png?token=SECRET)',
    cursor: ['url(/cursor.png?token=SECRET), auto', 'important'],
    filter: 'url(#glow)', color: 'red', width: false,
  } } }] });
  assert.deepEqual(result.data.attributes[0].attributes.style, {
    'background-image': 'url("https://assets.test/image.png")',
    cursor: ['url("/cursor.png"), auto', 'important'],
    filter: 'url("#glow")', color: 'red', width: false,
  });
});

test('quoted stylesheet imports scrub query credentials and preserve media conditions', () => {
  const result = encode({ source: 8, id: 42, adds: [
    { rule: '@import "https://user:password@assets.test/theme.css?token=SECRET" screen and (min-width: 1px);', index: 0 },
    { rule: "@import '/theme.css?token=SECRET#private' layer(theme);", index: 1 },
  ] });
  assert.equal(result.data.adds[0].rule, '@import "https://assets.test/theme.css" screen and (min-width: 1px);');
  assert.equal(result.data.adds[1].rule, "@import '/theme.css' layer(theme);");
  assert.doesNotMatch(JSON.stringify(result), /SECRET|password|token=|#private/);
});

test('adopted stylesheet rules and snapshot CSS use the same sanitizer', () => {
  const adopted = encode({ source: 15, id: 42, styleIds: [1], styles: [{ styleId: 1, rules: [{ rule: css, index: 0 }] }] });
  assert.equal(adopted.data.styles[0].rules[0].rule, sanitized);
  const snapshot = JSON.parse(serializeEvent({ type: 2, timestamp: 1, data: { node: {
    tagName: 'style', childNodes: [{ type: 3, textContent: '@import "/theme.css?token=SECRET"; ' + css }],
  } } }));
  assert.equal(snapshot.data.node.childNodes[0].textContent, '@import "/theme.css"; ' + sanitized);
  assert.equal(cleanUrl('#glow:R1:'), '#glow:R1:');
});

const assets = { assetBaseUrl: 'https://replay.test/replay-assets/1.4.32/', assetOrigin: 'https://localhost' };

test('asset mapping rewrites only same-origin static image and font paths', () => {
  assert.equal(cleanUrl('https://localhost/assets/scene-a1.png?token=SECRET#private', assets), 'https://replay.test/replay-assets/1.4.32/assets/scene-a1.png');
  assert.equal(cleanUrl('/fonts/baloo-latin.woff2', assets), 'https://replay.test/replay-assets/1.4.32/fonts/baloo-latin.woff2');
  assert.equal(cleanUrl('/icons/menu.svg', assets), 'https://replay.test/replay-assets/1.4.32/icons/menu.svg');
  assert.equal(cleanUrl('https://cdn.test/assets/scene.png?token=SECRET', assets), 'https://cdn.test/assets/scene.png');
  assert.equal(cleanUrl('https://localhost/game?room=SECRET', assets), 'https://localhost/game');
  assert.equal(cleanUrl('/assets/app.js?token=SECRET', assets), '/assets/app.js');
  assert.equal(cleanUrl('/api/user/avatar.png?token=SECRET', assets), '/api/user/avatar.png');
  assert.equal(cleanUrl('/assets/../private.png?token=SECRET', assets), '/assets/../private.png');
  assert.equal(cleanUrl('data:image/png;base64,SECRET', assets), '');
  assert.equal(cleanUrl('#glow', assets), '#glow');
});

test('asset mapping sanitizes the archive URL and supports custom native origins', () => {
  assert.equal(cleanUrl('/assets/icon.png', { ...assets, assetBaseUrl: 'https://user:password@replay.test/archive/?token=SECRET' }), 'https://replay.test/archive/assets/icon.png');
  assert.equal(cleanUrl('capacitor://localhost/assets/icon.png', { ...assets, assetOrigin: 'capacitor://localhost' }), 'https://replay.test/replay-assets/1.4.32/assets/icon.png');
  assert.equal(cleanUrl('capacitor://elsewhere/assets/icon.png', { ...assets, assetOrigin: 'capacitor://localhost' }), 'capacitor://elsewhere/assets/icon.png');
  assert.equal(cleanUrl('/assets/icon.png?token=SECRET', { ...assets, assetBaseUrl: 'javascript:alert(1)' }), '/assets/icon.png');
  assert.equal(cleanUrl('/assets/icon.png?token=SECRET', { ...assets, assetOrigin: 'not a URL' }), '/assets/icon.png');
});

test('asset mapping applies consistently to DOM URLs, stylesheet CSS, and style mutations', () => {
  const result = JSON.parse(serializeEvent({ type: 3, timestamp: 1, data: { source: 0, attributes: [
    { id: 42, attributes: { src: 'https://localhost/assets/scene.png?token=SECRET', href: 'https://localhost/game?room=SECRET', style: { background: ['url(/assets/scene.png?token=SECRET)', 'important'] } } },
  ] } }, [], assets));
  assert.equal(result.data.attributes[0].attributes.src, 'https://replay.test/replay-assets/1.4.32/assets/scene.png');
  assert.equal(result.data.attributes[0].attributes.href, 'https://localhost/game');
  assert.deepEqual(result.data.attributes[0].attributes.style.background, ['url("https://replay.test/replay-assets/1.4.32/assets/scene.png")', 'important']);
  const style = JSON.parse(serializeEvent({ type: 3, timestamp: 1, data: { source: 8, adds: [{ rule: '@font-face { src:url(https://localhost/fonts/baloo.woff2?token=SECRET) }' }] } }, [], assets));
  assert.equal(style.data.adds[0].rule, '@font-face { src:url("https://replay.test/replay-assets/1.4.32/fonts/baloo.woff2") }');
});

function maskedTextBefore(value: string, sensitiveText: string[]): string {
  for (const pattern of sensitiveText.filter((text) => typeof text === 'string' && text.length >= 2)
    .sort((left, right) => right.length - left.length)
    .map((text) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'))) value = value.replace(pattern, '*');
  return value;
}

test('cached private-text patterns mask exactly like per-event patterns', () => {
  const lists = [
    ['Sam', 'Amir', 'Ali', 'Alice'], ['Amir', 'Sam'], ['a.b', 'A+B', '(z)', 'x', '$1', '*star'],
    ['Ann', 'Anna', 'nna', 'ANNA'], [], ['Sam', 'Amir', 'Ali', 'Alice'],
  ];
  const pieces = ['Sam', 'amir', 'ALI', 'ce', 'a.b', 'axb', 'a+b', '(z)', '$1', '*star', 'Anna', 'nn', ' ', 'x'];
  let seed = 7;
  const random = (limit: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % limit; };
  for (let round = 0; round < 600; round++) {
    const list = lists[round % lists.length];
    let value = '';
    for (let i = random(6); i >= 0; i--) value += pieces[random(pieces.length)];
    const result = JSON.parse(serializeEvent({ type: 3, timestamp: 1, data: { source: 0, texts: [{ id: 1, value }] } }, list));
    assert.equal(result.data.texts[0].value, maskedTextBefore(value, list), JSON.stringify({ value, list }));
  }
  assert.equal(encode({ source: 0, texts: [{ id: 1, value: 'Samir' }] }).data.texts[0].value, 'Samir');
  const overlap = JSON.parse(serializeEvent({ type: 3, timestamp: 1, data: { source: 0, texts: [{ id: 1, value: 'Samir' }] } }, ['Sam', 'Amir']));
  assert.equal(overlap.data.texts[0].value, 'S*');
});

test('data: images are blanked unless the record_images setting is on, and stay capped', () => {
  const avatar = 'data:image/svg+xml;base64,PHN2Zy8+';
  const photo = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
  assert.equal(cleanUrl(avatar), '');
  assert.equal(cleanUrl(avatar, { images: false }), '');
  assert.equal(cleanUrl(avatar, { images: true }), avatar);
  assert.equal(cleanUrl(photo, { images: true }), photo);
  assert.equal(cleanUrl('data:image/png;base64,' + 'A'.repeat(128 * 1024), { images: true }), '');
  for (const value of ['data:text/html,<script>1</script>', 'data:application/pdf;base64,AAAA', 'blob:https://app.test/1', 'javascript:alert(1)']) {
    assert.equal(cleanUrl(value, { images: true }), '', value);
  }
  const off = JSON.parse(serializeEvent({ type: 2, timestamp: 1, data: { node: { tagName: 'img', attributes: { src: avatar } } } }));
  assert.equal(off.data.node.attributes.src, '');
  const on = JSON.parse(serializeEvent({ type: 2, timestamp: 1, data: { node: { tagName: 'img', attributes: { src: avatar, style: `background:url("${avatar}")` } } } }, [], { images: true }));
  assert.equal(on.data.node.attributes.src, avatar);
  assert.equal(on.data.node.attributes.style, `background:url("${avatar}")`);
});
