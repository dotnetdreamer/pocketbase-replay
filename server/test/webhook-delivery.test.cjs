const { test } = require('node:test');
const assert = require('node:assert/strict');
const observability = require('../pb_hooks/lib/observability.js');
const { fixture, exception } = require('./helpers/observability-fixture.cjs');

const discordURL = 'https://discord.com/api/webhooks/test/mock';

function queue(f, count, message = 'x'.repeat(330)) {
  const token = f.token();
  const events = Array.from({ length: count }, (_, index) => exception('notification-' + index, {
    service: 'notification-' + index,
    name: 'Issue-' + String.fromCharCode(65 + index),
    message,
    stack: '',
  }));
  for (let index = 0; index < events.length; index += 20) {
    assert.equal(observability.errors(f.event({ token, events: events.slice(index, index + 20) })).accepted, Math.min(20, events.length - index));
  }
  return f.records('replay_alerts', "delivery = 'pending'", 'timestamp,id');
}

function excerpt(title) { return title.slice(0, 300).replace(/[\uD800-\uDBFF]$/, ''); }

function assertMessages(webhooks, alerts, dashboard = 'https://replay.test/dash/replay') {
  for (const request of webhooks) {
    assert.deepEqual(Object.keys(request.body), ['content']);
    assert.ok(request.body.content.length <= 1900, request.body.content.length);
    if (dashboard) assert.ok(request.body.content.endsWith('\n' + dashboard));
    assert.doesNotMatch(request.body.content, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  }
  for (const alert of alerts) {
    const line = 'New issue: ' + excerpt(alert.getString('title'));
    assert.equal(webhooks.reduce((total, request) => total + request.body.content.split('\n').filter(value => value === line).length, 0), 1, alert.id);
  }
}

test('Discord delivers every complete alert in bounded messages and selects at most twenty alerts per sweep', () => {
  const f = fixture();
  try {
    f.enable({ alert_webhook_url: discordURL });
    const queued = queue(f, 25);
    observability.deliver(f.app, observability.config(f.app));
    assert.equal(f.records('replay_alerts', "delivery = 'sent'").length, 20);
    assert.equal(f.records('replay_alerts', "delivery = 'pending'").length, 5);
    assertMessages(f.webhooks, queued.slice(0, 20));
    const alreadySent = f.webhooks.length;
    observability.deliver(f.app, observability.config(f.app));
    assert.equal(f.records('replay_alerts', "delivery = 'sent'").length, 25);
    assertMessages(f.webhooks.slice(alreadySent), queued.slice(20));
  } finally { f.close(); }
});

test('a failed second Discord message retries only unsent alerts and charges attempts only for the failed message', () => {
  const f = fixture();
  try {
    f.enable({ alert_webhook_url: discordURL });
    const queued = queue(f, 20);
    const send = global.$http.send;
    let calls = 0;
    global.$http.send = request => {
      f.webhookAnswers(++calls === 2 ? 500 : 200);
      return send(request);
    };
    observability.deliver(f.app, observability.config(f.app));
    assert.equal(f.webhooks.length, 2);
    const sent = f.records('replay_alerts', "delivery = 'sent'");
    const pending = f.records('replay_alerts', "delivery = 'pending'");
    assert.equal(sent.length, 5);
    assert.equal(pending.length, 15);
    assert.equal(pending.filter(row => row.getInt('deliveryAttempts') === 1).length, 5);
    assert.equal(pending.filter(row => row.getInt('deliveryAttempts') === 0).length, 10);
    assertMessages(f.webhooks.slice(0, 1), sent);

    global.$http.send = send;
    f.webhookAnswers(200);
    const retryStart = f.webhooks.length;
    observability.deliver(f.app, observability.config(f.app));
    assert.equal(f.records('replay_alerts', "delivery = 'sent'").length, 20);
    assertMessages(f.webhooks.slice(retryStart), pending);
    assertMessages([f.webhooks[0], ...f.webhooks.slice(retryStart)], queued);
  } finally { f.close(); }
});

test('Discord preserves emoji at title boundaries and reserves room for the dashboard link', () => {
  const f = fixture();
  try {
    f.enable({ alert_webhook_url: discordURL });
    const dashboard = 'https://replay.test/' + 'path/'.repeat(280) + 'dash/replay';
    f.app.settings = () => ({ meta: { appURL: dashboard.slice(0, -'/dash/replay'.length) } });
    const queued = queue(f, 20, '🎲'.repeat(200));
    assert.match(queued[0].getString('title').slice(0, 300), /[\uD800-\uDBFF]$/);
    observability.deliver(f.app, observability.config(f.app));
    assert.equal(f.records('replay_alerts', "delivery = 'sent'").length, 20);
    assertMessages(f.webhooks, queued, dashboard);
  } finally { f.close(); }
});

test('an oversized dashboard URL is omitted from Discord messages without losing an alert', () => {
  const f = fixture();
  try {
    f.enable({ alert_webhook_url: discordURL });
    const address = 'https://replay.test/' + 'x'.repeat(1900);
    f.app.settings = () => ({ meta: { appURL: address } });
    const queued = queue(f, 20);
    observability.deliver(f.app, observability.config(f.app));
    assert.equal(f.records('replay_alerts', "delivery = 'sent'").length, 20);
    assertMessages(f.webhooks, queued, '');
    assert.ok(f.webhooks.every(request => !request.body.content.includes(address)));
    const before = f.webhooks.length;
    assert.deepEqual(observability.testAlert(f.event({ alert_webhook_url: discordURL })), { ok: true });
    assert.equal(f.webhooks.length, before + 1);
    assert.ok(f.webhooks.at(-1).body.content.length <= 1900);
    assert.match(f.webhooks.at(-1).body.content, /^Test alert: /);
  } finally { f.close(); }
});

test('slow Discord delivery leaves later messages queued before the next cron minute', () => {
  const f = fixture();
  const originalNow = Date.now;
  try {
    f.enable({ alert_webhook_url: discordURL });
    const dashboard = 'https://replay.test/' + 'path/'.repeat(280) + 'dash/replay';
    f.app.settings = () => ({ meta: { appURL: dashboard.slice(0, -'/dash/replay'.length) } });
    const queued = queue(f, 20);
    const send = global.$http.send;
    let elapsed = 0;
    Date.now = () => originalNow() + elapsed;
    global.$http.send = request => { elapsed += 3000; return send(request); };
    observability.deliver(f.app, observability.config(f.app));
    assert.equal(f.webhooks.length, 17);
    assert.equal(f.records('replay_alerts', "delivery = 'sent'").length, 17);
    const pending = f.records('replay_alerts', "delivery = 'pending'");
    assert.equal(pending.length, 3);
    assert.ok(pending.every(row => row.getInt('deliveryAttempts') === 0));
    assertMessages(f.webhooks, queued.slice(0, 17), dashboard);

    const before = f.webhooks.length;
    observability.deliver(f.app, observability.config(f.app));
    assert.equal(f.records('replay_alerts', "delivery = 'sent'").length, 20);
    assertMessages(f.webhooks.slice(before), pending, dashboard);
  } finally {
    Date.now = originalNow;
    f.close();
  }
});
