onBootstrap((e) => {
  e.next();
  // A throw here would stop PocketBase from starting.
  try {
    const replay = require(`${__hooks}/lib/replay.js`);
    replay.trustProxy(e.app);
  } catch (error) {
    console.warn('replay: trusted proxy setup failed: ' + error);
  }
});

routerAdd('POST', '/api/replay/config', (e) => {
  const replay = require(`${__hooks}/lib/replay.js`);
  return replay.route(e, 'publicConfig');
}, $apis.bodyLimit(16384));

routerAdd('POST', '/api/replay/start', (e) => {
  const replay = require(`${__hooks}/lib/replay.js`);
  return replay.route(e, 'start');
}, $apis.bodyLimit(16384));

routerAdd('POST', '/api/replay/chunks', (e) => {
  const replay = require(`${__hooks}/lib/replay.js`);
  return replay.route(e, 'upload');
}, $apis.bodyLimit(524288));

routerAdd('GET', '/api/replay/settings', (e) => {
  const replay = require(`${__hooks}/lib/replay.js`);
  return replay.route(e, 'getSettings');
});

routerAdd('POST', '/api/replay/settings', (e) => {
  const replay = require(`${__hooks}/lib/replay.js`);
  return replay.route(e, 'saveSettings');
}, $apis.bodyLimit(300000));

routerAdd('GET', '/api/replay/sessions', (e) => {
  const replay = require(`${__hooks}/lib/replay.js`);
  return replay.route(e, 'sessions');
});

routerAdd('GET', '/api/replay/sessions/{id}/chunks', (e) => {
  const replay = require(`${__hooks}/lib/replay.js`);
  return replay.route(e, 'chunks');
});

routerAdd('DELETE', '/api/replay/sessions/{id}', (e) => {
  const replay = require(`${__hooks}/lib/replay.js`);
  return replay.route(e, 'remove');
});

routerAdd('DELETE', '/api/replay/accounts/{id}', (e) => {
  const replay = require(`${__hooks}/lib/replay.js`);
  return replay.route(e, 'eraseAccount');
});

routerAdd('POST', '/api/replay/forget', (e) => {
  const replay = require(`${__hooks}/lib/replay.js`);
  return replay.route(e, 'forget');
}, $apis.bodyLimit(2048));

onRecordDelete((e) => {
  const replay = require(`${__hooks}/lib/replay.js`);
  return replay.deleteLocalAccount(e);
}, $os.getenv('REPLAY_AUTH_COLLECTION') || 'users');

routerAdd('GET', '/dash/replay', (e) => {
  const replay = require(`${__hooks}/lib/replay.js`);
  return replay.asset(e, 'index.html');
});

routerAdd('GET', '/dash/replay/{asset}', (e) => {
  const replay = require(`${__hooks}/lib/replay.js`);
  return replay.asset(e, e.request.pathValue('asset'));
});

cronAdd('pocketbase_replay_retention', '* * * * *', () => {
  const replay = require(`${__hooks}/lib/replay.js`);
  replay.sweep($app);
});
