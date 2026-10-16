// Read-only access for AI agents over the Model Context Protocol, at one URL agents connect to with a key.
routerAdd('POST', '/api/replay/mcp', (e) => {
  return require(`${__hooks}/lib/mcp.js`).route(e);
}, $apis.bodyLimit(65536));

// Only POST is served: no event stream to open and no session to end.
routerAdd('GET', '/api/replay/mcp', (e) => {
  return require(`${__hooks}/lib/mcp.js`).route(e);
});

routerAdd('DELETE', '/api/replay/mcp', (e) => {
  return require(`${__hooks}/lib/mcp.js`).route(e);
});

routerAdd('GET', '/api/replay/mcp/keys', (e) => {
  return require(`${__hooks}/lib/mcp.js`).adminRoute(e, 'keys');
});

routerAdd('POST', '/api/replay/mcp/keys', (e) => {
  return require(`${__hooks}/lib/mcp.js`).adminRoute(e, 'createKey');
}, $apis.bodyLimit(16384));

routerAdd('DELETE', '/api/replay/mcp/keys/{id}', (e) => {
  return require(`${__hooks}/lib/mcp.js`).adminRoute(e, 'revokeKey');
});

routerAdd('GET', '/api/replay/mcp/audit', (e) => {
  return require(`${__hooks}/lib/mcp.js`).adminRoute(e, 'auditList');
});

cronAdd('pocketbase_replay_agents', '* * * * *', () => {
  require(`${__hooks}/lib/mcp.js`).sweep($app);
});
