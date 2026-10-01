const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const observability = require('../../pb_hooks/lib/observability.js');
const hash = value => createHash('sha256').update(value).digest('hex');
const now = Date.now();

function fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  const collections = new Map();
  const store = new Map();
  let sequence = 0;
  let tokens = 0;
  let depth = 0;
  class Row {
    constructor(collection, data) { this.collection = collection; this.data = data || {}; this.id = this.data.id || ''; }
    set(key, value) { this.data[key] = value; }
    getString(key) { return this.data[key] === undefined ? '' : String(this.data[key]); }
    getFloat(key) { return Number(this.data[key]) || 0; }
    getInt(key) { return this.getFloat(key); }
    getBool(key) { return !!this.data[key]; }
  }
  function statement(sql, params) {
    const prepared = database.prepare(sql.replace(/\{:(\w+)\}/g, '$$$1'));
    const bound = {};
    for (const [key, value] of Object.entries(params || {})) if (sql.includes('{:' + key + '}')) bound[key] = typeof value === 'boolean' ? Number(value) : value;
    return { prepared, bound };
  }
  function query(sql, params, all) {
    const { prepared, bound } = statement(sql, params);
    return all ? prepared.all(bound) : prepared.get(bound);
  }
  function records(name, where, sort, limit, offset, params) {
    const order = sort ? ' ORDER BY ' + sort.split(',').map(value => value.startsWith('-') ? value.slice(1) + ' DESC' : value + ' ASC').join(',') : '';
    return query('SELECT * FROM ' + name + ' WHERE ' + (where || '1=1').replace(/&&/g, ' AND ').replace(/\|\|/g, ' OR ') + order + ' LIMIT ' + (limit || 10000) + ' OFFSET ' + (offset || 0), params, true)
      .map(data => new Row(collections.get(name), data));
  }
  const app = {
    store: () => ({ get: key => store.get(key), set: (key, value) => store.set(key, value) }),
    findCollectionByNameOrId: name => { if (!collections.has(name)) throw new Error('Missing collection ' + name); return collections.get(name); },
    findRecordsByFilter: records,
    findRecordById: (name, id) => { const rows = records(name, 'id = {:id}', '', 1, 0, { id }); if (!rows.length) throw new Error('Not found'); return rows[0]; },
    findFirstRecordByData: (name, key, value) => { const rows = records(name, key + ' = {:value}', '', 1, 0, { value }); if (!rows.length) throw new Error('Not found'); return rows[0]; },
    findAuthRecordByToken: token => { if (token !== 'alice-token') throw new Error('Invalid auth'); return { id: 'alice', isSuperuser: () => false, getBool: () => false }; },
    runInTransaction: fn => {
      if (depth) return fn(app);
      database.exec('BEGIN'); depth++;
      try { const result = fn(app); database.exec('COMMIT'); return result; } catch (error) { database.exec('ROLLBACK'); throw error; } finally { depth--; }
    },
    save: item => {
      if (item.fields) {
        item.id = item.name;
        const fields = item.fields.map(field => {
          const relation = field.type === 'relation' ? ' REFERENCES ' + field.collectionId + '(id)' + (field.cascadeDelete ? ' ON DELETE CASCADE' : '') : '';
          return field.name + ' ' + (['number', 'bool'].includes(field.type) ? 'INTEGER DEFAULT 0' : 'TEXT DEFAULT \'\'') + relation;
        });
        database.exec('CREATE TABLE ' + item.name + '(id TEXT PRIMARY KEY,' + fields.join(',') + ')');
        for (const index of item.indexes || []) database.exec(index);
        collections.set(item.name, item);
        return;
      }
      if (!item.id) item.id = String(++sequence).padStart(15, '0');
      item.data.id = item.id;
      const validFields = new Set(item.collection.fields.map(field => field.name).concat('id'));
      const entries = Object.entries(item.data).filter(([key]) => validFields.has(key));
      const fields = entries.map(([key]) => key);
      database.prepare('INSERT INTO ' + item.collection.name + '(' + fields.join(',') + ') VALUES (' + fields.map(() => '?').join(',') + ') ON CONFLICT(id) DO UPDATE SET ' + fields.map(key => key + '=excluded.' + key).join(','))
        .run(...entries.map(([, value]) => typeof value === 'boolean' ? Number(value) : value));
    },
    delete: item => {
      if (item.fields) { database.exec('DROP TABLE ' + item.name); collections.delete(item.name); return; }
      database.prepare('DELETE FROM ' + item.collection.name + ' WHERE id=?').run(item.id);
    },
    db: () => ({ newQuery: sql => {
      const bound = params => ({
        one: result => Object.assign(result, query(sql, params)),
        all: rows => { for (const data of query(sql, params, true)) rows.push(Object.assign(new global.DynamicModel({}), data)); },
        execute: () => { const { prepared, bound: values } = statement(sql, params); return prepared.run(values); },
      });
      return Object.assign(bound({}), { bind: bound });
    } }),
    settings: () => ({ meta: { appURL: 'https://replay.test/' } }),
    recordQuery: name => {
      let predicate = { sql: '1=1', params: {} }; let order; let limit; let offset;
      const result = {
        andWhere: value => { predicate = value; return result; },
        orderBy: (...values) => { order = values.join(','); return result; },
        limit: value => { limit = value; return result; },
        offset: value => { offset = value; return result; },
        all: destination => {
          for (const data of query('SELECT * FROM ' + name + ' WHERE ' + predicate.sql + ' ORDER BY ' + order + ' LIMIT ' + limit + ' OFFSET ' + offset, predicate.params, true)) destination.push(new Row(collections.get(name), data));
        },
      };
      return result;
    },
  };
  global.Record = Row;
  global.DynamicModel = function (value) { Object.assign(this, value); };
  global.arrayOf = () => [];
  global.$dbx = { exp: (sql, params) => ({ sql, params }) };
  global.$security = { sha256: hash, equal: (a, b) => a === b, randomString: length => String(++tokens).padStart(length, 'r') };
  global.$os = { getenv: () => '' };
  global.readerToString = value => value;
  const webhooks = [];
  let webhookStatus = 200;
  global.$http = { send: request => { webhooks.push({ ...request, body: JSON.parse(request.body) }); if (webhookStatus instanceof Error) throw webhookStatus; return { statusCode: webhookStatus }; } };
  function migrate(file) {
    let up;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../pb_migrations', file), 'utf8'), {
      migrate: value => { up = value; }, Collection: function (value) { Object.assign(this, value); }, Record: Row, console,
    });
    up(app);
  }
  migrate('1795600000_replay.js');
  migrate('1795600002_observability.js');
  const event = (body, queryValues, id, authenticated = true) => ({
    app, hasSuperuserAuth: () => authenticated, realIP: () => '127.0.0.1',
    request: { body: JSON.stringify(body || {}), pathValue: () => id || '', url: { query: () => ({ get: key => (queryValues || {})[key] || '' }) } },
  });
  const metadata = { deviceId: 'device', accountId: 'alice', authToken: 'alice-token', platform: 'web', appVersion: '1.0' };
  function enable(value) { return observability.saveSettings(event({ errors_enabled: true, logs_enabled: true, ...value })); }
  function token() { return observability.publicConfig(event(metadata)).token; }
  return {
    app, event, metadata, enable, token, database, collections, records, store, webhooks,
    clearDailyBudget: () => database.prepare('DELETE FROM replay_settings WHERE key = ?').run('observability:daily-bytes'),
    dailyBudget: () => {
      const rows = records('replay_settings', "key = 'observability:daily-bytes'", '', 1);
      return rows.length ? JSON.parse(rows[0].getString('value')) : null;
    },
    webhookAnswers: value => { webhookStatus = value; }, close: () => database.close(),
  };
}

function exception(id, patch) {
  return { id, timestamp: now, type: 'TypeError', message: 'Cannot load item 42', stack: 'TypeError: Cannot load item 42\n    at render (https://app.test/app.js:12:2)', service: 'client', ...patch };
}

module.exports = { fixture, exception, now };
