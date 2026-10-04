routerAdd('GET', '/api/replay/security', (e) => {
  return require(`${__hooks}/lib/ingestion-security.js`).route(e, 'getSettings');
});

routerAdd('POST', '/api/replay/security', (e) => {
  return require(`${__hooks}/lib/ingestion-security.js`).route(e, 'saveSettings');
}, $apis.bodyLimit(16384));

routerAdd('POST', '/api/replay/security/keys', (e) => {
  return require(`${__hooks}/lib/ingestion-security.js`).route(e, 'createKey');
}, $apis.bodyLimit(16384));

routerAdd('DELETE', '/api/replay/security/keys/{id}', (e) => {
  return require(`${__hooks}/lib/ingestion-security.js`).route(e, 'revokeKey');
});

routerAdd('GET', '/api/replay/security/limits', (e) => {
  return require(`${__hooks}/lib/ingestion-limits.js`).route(e, 'getSettings');
});

routerAdd('POST', '/api/replay/security/limits', (e) => {
  return require(`${__hooks}/lib/ingestion-limits.js`).route(e, 'saveSettings');
}, $apis.bodyLimit(16384));
