routerAdd('POST', '/api/replay/observability/config', (e) => {
  return require(`${__hooks}/lib/observability.js`).route(e, 'publicConfig');
}, $apis.bodyLimit(16384));

routerAdd('GET', '/api/replay/observability/settings', (e) => {
  return require(`${__hooks}/lib/observability.js`).route(e, 'getSettings');
});

routerAdd('POST', '/api/replay/observability/settings', (e) => {
  return require(`${__hooks}/lib/observability.js`).route(e, 'saveSettings');
}, $apis.bodyLimit(16384));

routerAdd('POST', '/api/replay/errors', (e) => {
  return require(`${__hooks}/lib/observability.js`).route(e, 'errors');
}, $apis.bodyLimit(65536));

routerAdd('POST', '/api/replay/logs', (e) => {
  return require(`${__hooks}/lib/observability.js`).route(e, 'logsUpload');
}, $apis.bodyLimit(65536));

routerAdd('GET', '/api/replay/issues', (e) => {
  return require(`${__hooks}/lib/observability.js`).route(e, 'issues');
});

routerAdd('GET', '/api/replay/issues/{id}', (e) => {
  return require(`${__hooks}/lib/observability.js`).route(e, 'issue');
});

routerAdd('POST', '/api/replay/issues/{id}', (e) => {
  return require(`${__hooks}/lib/observability.js`).route(e, 'updateIssue');
}, $apis.bodyLimit(2048));

routerAdd('DELETE', '/api/replay/issues/{id}', (e) => {
  return require(`${__hooks}/lib/observability.js`).route(e, 'removeIssue');
});

routerAdd('GET', '/api/replay/logs', (e) => {
  return require(`${__hooks}/lib/observability.js`).route(e, 'logs');
});

routerAdd('GET', '/api/replay/logs/volume', (e) => {
  return require(`${__hooks}/lib/observability.js`).route(e, 'volume');
});

routerAdd('GET', '/api/replay/logs/{id}', (e) => {
  return require(`${__hooks}/lib/observability.js`).route(e, 'log');
});

routerAdd('DELETE', '/api/replay/logs/{id}', (e) => {
  return require(`${__hooks}/lib/observability.js`).route(e, 'removeLog');
});

routerAdd('GET', '/api/replay/alerts', (e) => {
  return require(`${__hooks}/lib/observability.js`).route(e, 'alerts');
});

routerAdd('POST', '/api/replay/alerts/test', (e) => {
  return require(`${__hooks}/lib/observability.js`).route(e, 'testAlert');
}, $apis.bodyLimit(4096));

routerAdd('POST', '/api/replay/alerts/{id}/acknowledge', (e) => {
  return require(`${__hooks}/lib/observability.js`).route(e, 'acknowledge');
}, $apis.bodyLimit(2048));

routerAdd('DELETE', '/api/replay/alerts/{id}', (e) => {
  return require(`${__hooks}/lib/observability.js`).route(e, 'removeAlert');
});

cronAdd('pocketbase_replay_observability_retention', '* * * * *', () => {
  require(`${__hooks}/lib/observability.js`).sweep($app);
});
