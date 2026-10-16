routerAdd('POST', '/api/replay/sourcemaps', (e) => {
  return require(`${__hooks}/lib/sourcemaps.js`).route(e, 'upload');
}, $apis.bodyLimit(33554432));

routerAdd('GET', '/api/replay/sourcemaps', (e) => {
  return require(`${__hooks}/lib/sourcemaps.js`).route(e, 'list');
});

routerAdd('DELETE', '/api/replay/sourcemaps', (e) => {
  return require(`${__hooks}/lib/sourcemaps.js`).route(e, 'remove');
});

routerAdd('GET', '/api/replay/errors/{id}/frames', (e) => {
  return require(`${__hooks}/lib/sourcemaps.js`).route(e, 'frames');
});
