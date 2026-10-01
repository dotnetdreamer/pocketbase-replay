const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, exception } = require('./helpers/observability-fixture.cjs');
const observability = require('../pb_hooks/lib/observability.js');

test('explicit grouping keys join different platforms, releases, stacks and exception names', () => {
  const f = fixture();
  try {
    f.enable();
    const first = observability.publicConfig(f.event({ ...f.metadata, platform: 'android', appVersion: 'old' })).token;
    const second = observability.publicConfig(f.event({ ...f.metadata, deviceId: 'ios-device', platform: 'ios', appVersion: 'new' })).token;
    observability.errors(f.event({ token: first, events: [exception('android-group', { attributes: { groupingKey: 'checkout-payment' } })] }));
    observability.errors(f.event({ token: second, events: [exception('ios-group', {
      name: 'PaymentException', message: 'Different translated text', stack: 'payment@capacitor://localhost/assets/changed-file.js:77:1', attributes: { groupingKey: 'checkout-payment' },
    })] }));
    const issues = f.records('replay_issues');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].getInt('occurrenceCount'), 2);
    assert.equal(f.records('replay_errors').every(row => JSON.parse(row.getString('attributes')).groupingKey === 'checkout-payment'), true);
    observability.errors(f.event({ token: second, events: [exception('different-key', { attributes: { groupingKey: 'checkout-network' } })] }));
    observability.errors(f.event({ token: second, events: [exception('different-service', { service: 'backend', attributes: { groupingKey: 'checkout-payment' } })] }));
    assert.equal(f.records('replay_issues').length, 3);
  } finally { f.close(); }
});

test('blank grouping keys keep automatic grouping and older arbitrary attributes remain accepted', () => {
  const f = fixture();
  try {
    f.enable();
    const token = f.token();
    observability.errors(f.event({ token, events: [exception('automatic'), exception('empty-key', { attributes: { groupingKey: '  ' } })] }));
    assert.equal(f.records('replay_issues').length, 1);
    for (const [index, groupingKey] of [42, {}, 'x'.repeat(129)].entries()) {
      assert.equal(observability.errors(f.event({ token, events: [exception('legacy-' + index, { attributes: { groupingKey } })] })).accepted, 1);
    }
    const stored = f.records('replay_errors');
    assert.equal(stored.length, 5);
    assert.equal(JSON.parse(stored.find(row => row.getString('eventId') === 'legacy-0').getString('attributes')).groupingKey, 42);
    assert.deepEqual(JSON.parse(stored.find(row => row.getString('eventId') === 'legacy-1').getString('attributes')).groupingKey, {});
    assert.equal(JSON.parse(stored.find(row => row.getString('eventId') === 'legacy-2').getString('attributes')).groupingKey.length, 128);
  } finally { f.close(); }
});
