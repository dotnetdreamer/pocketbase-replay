// What happened in a recording, read from its rrweb events: pages, clicks named by their element, form fields
// changed, PocketBase calls, network requests, console output and triggers. The same rules as the dashboard's
// activity panel (viewer/devtools.ts), written for PocketBase's engine, plus form fields, which the panel leaves
// out. Recorded text is already masked; field values are never read. Pure functions, shared with the Node tests.

const LIMITS = {
  labelText: 40, labelNodes: 200, titleChars: 1000, urlChars: 2048, nodeText: 200, nodes: 100000, hintChars: 60,
  inputMergeMs: 30000,
};
const CONSOLE_LEVELS = { debug: 'Debug', info: 'Info', log: 'Log', warn: 'Warning', error: 'Error' };
const FAILURES = { error: 'Failed', abort: 'Cancelled', timeout: 'Timed out' };
const INTERACTIVE_TAGS = ['a', 'button', 'label', 'summary', 'select', 'option', 'input', 'textarea'];
const INTERACTIVE_ROLES = ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch', 'option'];
const TEXTLESS_TAGS = ['script', 'style', 'noscript', 'template', 'head'];
const FIELD_TAGS = ['input', 'textarea', 'select'];
// PocketBase's fixed answers, the only messages a call keeps: a custom message can echo submitted values.
const STANDARD_ERRORS = [
  'Failed to create record.', 'Failed to update record.', 'Failed to delete record.',
  "The requested resource wasn't found.", 'Only superusers can perform this action.',
  'Something went wrong while processing your request.', 'Failed to authenticate.', 'Missing or invalid authentication.',
];
const POCKETBASE_TEXT = /^[A-Za-z0-9_.,:@()+\- ]{1,200}$/;
const IDENTIFIER = /^[A-Za-z0-9_.-]{1,64}$/;
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const CALL_ACTIONS = ['list', 'view', 'create', 'update', 'delete', 'batch', 'realtime', 'file-token', 'impersonate', 'auth-methods',
  'auth-refresh', 'auth-with-password', 'auth-with-oauth2', 'auth-with-otp', 'request-otp', 'request-password-reset', 'confirm-password-reset',
  'request-verification', 'confirm-verification', 'request-email-change', 'confirm-email-change'];

function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function text(value, limit) { return typeof value === 'string' ? value.slice(0, limit === undefined ? LIMITS.titleChars : limit) : ''; }
function oneLine(value) { return value.replace(/\s+/g, ' ').trim(); }
function clip(value, limit) {
  const line = oneLine(value);
  return line.length > limit ? line.slice(0, limit - 1).trimEnd() + '…' : line;
}
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined; }
function severityOf(level) { return level === 'error' || level === 'fatal' ? 'error' : level === 'warn' ? 'warn' : 'info'; }
function standardErrorMessage(value) {
  return typeof value === 'string' && STANDARD_ERRORS.indexOf(value.trim()) >= 0 ? value.trim() : undefined;
}

function durationText(ms) {
  if (ms < 1000) return ms + ' ms';
  return ms < 60000 ? (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s' : Math.round(ms / 60000) + ' min';
}

function originOf(url) { const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(url); return match ? match[0] : ''; }

// Same-origin requests and pages show their path; others keep their host.
function shortUrl(url, origin) {
  if (origin && url.startsWith(origin) && (url.length === origin.length || url[origin.length] === '/')) return url.slice(origin.length) || '/';
  return url.replace(/^https?:\/\//i, '');
}

// The recorded page as linked nodes, kept current through mutations so a click is named by its element at
// that moment. Only what a label needs is kept, and each change costs constant time. save() and load() carry it
// from one indexing run to the next, as a list of nodes in document order.
function createDom() {
  let nodes = new Map();
  // Set when part of the recording is missing: mutations no longer line up until the next full snapshot.
  let stale = false;
  let full = false;

  function setAttributes(node, value, partial) {
    const attributes = record(value);
    if (!attributes) return;
    const read = function (key, current) {
      if (!(key in attributes)) return partial ? current : '';
      return typeof attributes[key] === 'string' ? attributes[key].trim() : '';
    };
    node.idName = read('id', node.idName).slice(0, 64);
    node.className = read('class', node.className).split(/\s+/, 1)[0].slice(0, 64);
    node.role = read('role', node.role).toLowerCase().slice(0, 32);
    if (FIELD_TAGS.indexOf(node.tag) >= 0) {
      // A form field is named by what the page shows next to it, never by its value.
      node.kind = read('type', node.kind).toLowerCase().slice(0, 20);
      const hint = read('aria-label', '') || read('placeholder', '') || read('name', '');
      if (hint || !partial) node.hint = oneLine(hint).slice(0, LIMITS.hintChars);
    }
  }

  function make(id, type, tag) {
    return { id: id, type: type, tag: tag, idName: '', className: '', role: '', text: '', kind: '', hint: '', parent: undefined, first: undefined, last: undefined, previous: undefined, next: undefined };
  }

  function unlink(node) {
    const parent = node.parent;
    if (!parent) return;
    if (node.previous) node.previous.next = node.next; else parent.first = node.next;
    if (node.next) node.next.previous = node.previous; else parent.last = node.previous;
    node.parent = node.previous = node.next = undefined;
  }

  function link(node, parent, before) {
    node.parent = parent;
    if (before && before.parent === parent) {
      node.previous = before.previous;
      node.next = before;
      if (before.previous) before.previous.next = node; else parent.first = node;
      before.previous = node;
    } else {
      node.previous = parent.last;
      node.next = undefined;
      if (parent.last) parent.last.next = node; else parent.first = node;
      parent.last = node;
    }
  }

  // A removed node takes its descendants out of the page, as the replayer's mirror does.
  function forget(root) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (nodes.get(node.id) === node) nodes.delete(node.id);
      for (let child = node.first; child; child = child.next) stack.push(child);
    }
  }

  function add(serialized, parent, before) {
    const stack = [[serialized, parent]];
    let root = true;
    while (stack.length) {
      const pair = stack.pop();
      const value = record(pair[0]);
      const owner = pair[1];
      if (!value || !Number.isInteger(value.id)) { root = false; continue; }
      const existing = nodes.get(value.id);
      if (existing) { unlink(existing); forget(existing); }
      // A page too large to follow leaves its clicks unnamed rather than holding the server's memory.
      if (nodes.size >= LIMITS.nodes) { full = true; root = false; continue; }
      const node = make(value.id, Number(value.type), text(value.tagName, 32).toLowerCase());
      node.text = text(value.textContent, LIMITS.nodeText);
      if (node.type === 2) setAttributes(node, value.attributes, false);
      nodes.set(node.id, node);
      if (owner) link(node, owner, root ? before : undefined);
      root = false;
      const children = value.childNodes;
      if (Array.isArray(children)) for (let index = children.length - 1; index >= 0; index--) stack.push([children[index], node]);
    }
  }

  function list(value) {
    return Array.isArray(value) ? value.filter(function (item) { return !!record(item); }) : [];
  }

  // Applied in the order rrweb's replayer applies them.
  function mutate(data) {
    if (stale) return;
    for (const item of list(data.removes)) {
      const node = nodes.get(Number(item.id));
      if (node) { unlink(node); forget(node); }
    }
    for (const item of list(data.adds)) {
      const before = item.nextId === null || item.nextId === undefined ? undefined : nodes.get(Number(item.nextId));
      add(item.node, nodes.get(Number(item.parentId)), before);
    }
    for (const item of list(data.texts)) {
      const node = nodes.get(Number(item.id));
      if (node) node.text = text(item.value, LIMITS.nodeText);
    }
    for (const item of list(data.attributes)) {
      const node = nodes.get(Number(item.id));
      if (node && node.type === 2) setAttributes(node, item.attributes, true);
    }
  }

  function interactive(node) {
    return node.type === 2 && (INTERACTIVE_TAGS.indexOf(node.tag) >= 0 || INTERACTIVE_ROLES.indexOf(node.role) >= 0);
  }

  // Descendant text in page order, within a node and a length budget. Recorded text is already masked.
  function textOf(root) {
    let value = '';
    let visited = 0;
    let node = root.first;
    while (node && visited++ < LIMITS.labelNodes && value.length <= LIMITS.labelText) {
      if (node.type === 3) {
        const piece = oneLine(node.text.slice(0, 200));
        if (piece) value = value ? value + ' ' + piece : piece;
      }
      if (node.type === 2 && node.first && TEXTLESS_TAGS.indexOf(node.tag) < 0) { node = node.first; continue; }
      while (node && node !== root && !node.next) node = node.parent;
      node = node && node !== root ? node.next : undefined;
    }
    return value.length > LIMITS.labelText ? value.slice(0, LIMITS.labelText).trimEnd() + '…' : value;
  }

  function nameOf(node) {
    return (node.tag || 'element') + (node.idName ? '#' + node.idName : node.className ? '.' + node.className : '');
  }

  function element(id) {
    if (stale) return undefined;
    let node = nodes.get(Number(id));
    if (node && node.type !== 2) node = node.parent;
    return node && node.type === 2 ? node : undefined;
  }

  function label(id) {
    let node = element(id);
    if (!node) return '';
    // A tap on an icon or a span inside a control names the control.
    if (!interactive(node)) {
      for (let ancestor = node.parent, depth = 0; ancestor && depth < 4; ancestor = ancestor.parent, depth++) {
        if (interactive(ancestor)) { node = ancestor; break; }
      }
    }
    const content = textOf(node);
    return content ? nameOf(node) + ' "' + content + '"' : nameOf(node);
  }

  // A form field as its tag, type and visible name, such as input[type=email] "Email address".
  function field(id) {
    const node = element(id);
    if (!node) return null;
    const type = node.tag === 'input' && node.kind && node.kind !== 'text' ? '[type=' + node.kind + ']' : '';
    return { name: nameOf(node) + type + (node.hint ? ' "' + node.hint + '"' : ''), kind: node.tag === 'input' ? node.kind || 'text' : node.tag };
  }

  // Nodes in document order, each as [id, type, tag, id attribute, first class, role, text, parent id, field type, hint].
  function save() {
    const out = [];
    const seen = new Set();
    function walk(start) {
      const stack = [start];
      while (stack.length) {
        const node = stack.pop();
        if (seen.has(node.id) || nodes.get(node.id) !== node) continue;
        seen.add(node.id);
        out.push([node.id, node.type, node.tag, node.idName, node.className, node.role, node.text, node.parent ? node.parent.id : -1, node.kind, node.hint]);
        const children = [];
        for (let child = node.first; child; child = child.next) children.push(child);
        for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
      }
    }
    nodes.forEach(function (node) { if (!node.parent || nodes.get(node.parent.id) !== node.parent) walk(node); });
    nodes.forEach(function (node) { if (!seen.has(node.id)) walk(node); });
    return { nodes: out, stale: stale, full: full };
  }

  function load(value) {
    nodes = new Map();
    const saved = record(value) || {};
    stale = saved.stale === true;
    full = saved.full === true;
    for (const item of Array.isArray(saved.nodes) ? saved.nodes : []) {
      if (!Array.isArray(item) || !Number.isInteger(item[0])) continue;
      const node = make(item[0], Number(item[1]), String(item[2] || ''));
      node.idName = String(item[3] || '');
      node.className = String(item[4] || '');
      node.role = String(item[5] || '');
      node.text = String(item[6] || '');
      node.kind = String(item[8] || '');
      node.hint = String(item[9] || '');
      const parent = item[7] >= 0 ? nodes.get(item[7]) : undefined;
      nodes.set(node.id, node);
      if (parent) link(node, parent);
    }
  }

  return {
    reset: function (tree) { nodes = new Map(); stale = false; full = false; add(tree); },
    mutate: mutate, label: label, field: field, save: save, load: load,
    gap: function () { stale = true; },
    size: function () { return nodes.size; },
  };
}

function networkActivity(payload, timestamp, origin) {
  const method = text(payload.method, 16).toUpperCase() || 'GET';
  const url = text(payload.url, LIMITS.urlChars);
  const status = finite(payload.status) && payload.status > 0 ? Math.round(payload.status) : 0;
  const duration = finite(payload.duration) && payload.duration >= 0 ? Math.round(payload.duration) : undefined;
  const failed = typeof payload.failed === 'string' && Object.prototype.hasOwnProperty.call(FAILURES, payload.failed) ? payload.failed : undefined;
  const outcome = status ? String(status) : failed ? FAILURES[failed] : 'No response';
  const item = {
    kind: 'network', timestamp: timestamp, title: method + ' ' + (shortUrl(url, origin) || '(no URL)'),
    detail: duration === undefined ? outcome : outcome + ' · ' + durationText(duration),
    severity: !status || status >= 400 ? 'error' : 'info', status: status,
  };
  if (duration !== undefined) item.duration = duration;
  if (failed) item.failed = failed;
  return item;
}

function count(value) {
  return finite(value) && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function callName(call) {
  if (call.collection && call.action) return call.collection + '.' + call.action + (call.record ? ' ' + call.record : '');
  if (call.action === 'batch') return 'Batch';
  if (call.action === 'realtime') return 'Realtime subscription';
  if (call.action === 'file-token') return 'File token';
  return call.method + ' ' + call.path;
}

function callShape(value) {
  const item = record(value) || {};
  const collection = text(item.collection, 100);
  const action = text(item.action, 40);
  const name = text(item.record, 128);
  const shape = { method: text(item.method, 10).toUpperCase().replace(/[^A-Z]/g, '') || 'GET', path: text(item.path, 300) || '/' };
  if (NAME.test(collection)) shape.collection = collection;
  if (CALL_ACTIONS.indexOf(action) >= 0) shape.action = action;
  if (NAME.test(name)) shape.record = name;
  return shape;
}

function itemsText(call) {
  if (call.items === undefined) return '';
  const noun = call.items === 1 && (call.total === undefined || call.total === 1) ? 'item' : 'items';
  return call.total === undefined ? call.items + ' ' + noun : call.items + ' of ' + call.total + ' ' + noun;
}

function pocketbaseActivity(payload, timestamp) {
  const call = callShape(payload);
  const status = count(payload.status) === undefined ? 0 : count(payload.status);
  const duration = count(payload.duration);
  const failed = payload.failed === 'abort' || payload.failed === 'error' ? payload.failed : undefined;
  const query = record(payload.query);
  // Field names and codes are identifiers, as the client records them; anything else could be text written for an agent.
  const invalid = (Array.isArray(payload.invalid) ? payload.invalid : []).slice(0, 20).map(record)
    .filter(function (item) { return !!item && typeof item.field === 'string' && typeof item.code === 'string' && IDENTIFIER.test(item.field) && IDENTIFIER.test(item.code); })
    .map(function (item) { return { field: item.field, code: item.code }; });
  call.request = /^[a-z0-9]{20}$/.test(text(payload.request, 20)) ? text(payload.request, 20) : '';
  call.status = status;
  if (duration !== undefined) call.duration = duration;
  if (failed) call.failed = failed;
  call.linked = payload.linked === true;
  call.server = payload.server === true;
  if (count(payload.items) !== undefined) call.items = count(payload.items);
  if (count(payload.total) !== undefined) call.total = count(payload.total);
  if (query) {
    const shown = {};
    if (query.filter === true) shown.filter = true;
    if (query.skipTotal === true) shown.skipTotal = true;
    if (query.unreadable === true) shown.unreadable = true;
    for (const key of ['sort', 'expand', 'fields']) if (typeof query[key] === 'string' && POCKETBASE_TEXT.test(query[key])) shown[key] = query[key];
    call.query = shown;
  }
  const message = standardErrorMessage(payload.message);
  if (message) call.message = message;
  if (invalid.length) call.invalid = invalid;
  if (Array.isArray(payload.batch)) {
    call.batch = payload.batch.slice(0, 50).map(function (item) {
      const shape = callShape(item);
      const answered = count((record(item) || {}).status);
      shape.status = answered === undefined ? 0 : answered;
      return shape;
    });
  }
  if (Array.isArray(payload.topics)) call.topics = payload.topics.filter(function (topic) { return typeof topic === 'string' && NAME.test(topic); }).slice(0, 20);
  const outcome = status ? String(status) : failed === 'abort' ? 'Cancelled' : failed ? 'Failed' : 'No response';
  const parts = [outcome];
  if (call.batch && call.batch.length) parts.push(call.batch.length + ' request' + (call.batch.length === 1 ? '' : 's'));
  if (call.topics && call.topics.length) parts.push(call.topics.join(', '));
  if (itemsText(call)) parts.push(itemsText(call));
  if (call.invalid) parts.push('Invalid: ' + call.invalid.map(function (item) { return item.field; }).join(', '));
  if (duration !== undefined) parts.push(durationText(duration));
  const item = {
    kind: 'pocketbase', timestamp: timestamp, title: callName(call), detail: parts.join(' · '),
    severity: status >= 400 || failed === 'error' || (!status && !failed) ? 'error' : failed === 'abort' ? 'warn' : 'info',
    status: status,
  };
  if (duration !== undefined) item.duration = duration;
  if (failed) item.failed = failed;
  item.pocketbase = call;
  return item;
}

function consoleActivity(payload, timestamp) {
  const level = typeof payload.level === 'string' && Object.prototype.hasOwnProperty.call(CONSOLE_LEVELS, payload.level) ? payload.level : 'log';
  const uncaught = payload.uncaught === true;
  const item = {
    kind: 'console', timestamp: timestamp, title: text(payload.text) || '(empty message)',
    detail: uncaught ? 'Uncaught error' : CONSOLE_LEVELS[level], severity: uncaught ? 'error' : severityOf(level),
    level: uncaught ? 'error' : level,
  };
  if (uncaught) item.uncaught = true;
  return item;
}

// Reads a recording's events in order, one chunk at a time, and hands back the activity of each. Its state can
// be saved between chunks, so a long recording can be read across several runs.
function createCollector(saved) {
  const dom = createDom();
  let origin = '';
  let page = '';
  // The form field last changed, so typing into it is one entry rather than one per key.
  let input = null;
  const state = record(saved);
  if (state) {
    dom.load(state.dom);
    origin = typeof state.origin === 'string' ? state.origin : '';
    page = typeof state.page === 'string' ? state.page : '';
    input = record(state.input) && Number.isInteger(state.input.id) ? { id: state.input.id, at: Number(state.input.at) || 0 } : null;
  }
  let items = [];
  let lastIndex = -1;

  function push(item) {
    items.push(item);
    lastIndex = items.length - 1;
    if (item.kind !== 'input') input = null;
  }

  function visit(url, timestamp) {
    if (!url || url === page) return;
    page = url;
    push({ kind: 'navigation', timestamp: timestamp, title: shortUrl(url, origin), severity: 'info' });
  }

  // Only that a field changed: whether a box is checked, or which option was picked, is a value too.
  function changed(data, timestamp) {
    const id = Number(data.id);
    if (!Number.isInteger(id)) return;
    const field = dom.field(id);
    const detail = field && field.kind === 'select' ? 'Option selected' : 'Changed';
    // Typing produces one event per change; they stay one entry while nothing else happens in between.
    if (input && input.id === id && timestamp - input.at <= LIMITS.inputMergeMs && lastIndex >= 0 && items[lastIndex].kind === 'input') {
      input.at = timestamp;
      return;
    }
    push({ kind: 'input', timestamp: timestamp, title: field ? field.name : 'Unknown field', detail: detail, severity: 'info' });
    input = { id: id, at: timestamp };
  }

  function add(event) {
    try {
      const data = record(event && event.data);
      if (!data || !finite(event.timestamp)) return;
      if (event.type === 2) dom.reset(data.node);
      else if (event.type === 3 && data.source === 0) dom.mutate(data);
      else if (event.type === 3 && data.source === 2 && (data.type === 2 || data.type === 4)) {
        const item = { kind: 'click', timestamp: event.timestamp, title: dom.label(data.id) || 'Unknown element' };
        if (data.type === 4) item.detail = 'Double click';
        item.severity = 'info';
        push(item);
      } else if (event.type === 3 && data.source === 5) changed(data, event.timestamp);
      else if (event.type === 4) {
        // Each meta event names the page a full snapshot was taken on, which also gives the first page.
        const href = text(data.href, LIMITS.urlChars);
        if (href) { origin = originOf(href); visit(href, event.timestamp); }
      } else if (event.type === 5 && typeof data.tag === 'string') {
        const payload = record(data.payload) || {};
        if (data.tag === 'pbr/network') push(networkActivity(payload, event.timestamp, origin));
        else if (data.tag === 'pbr/pocketbase') push(pocketbaseActivity(payload, event.timestamp));
        else if (data.tag === 'pbr/console') push(consoleActivity(payload, event.timestamp));
        else if (data.tag === 'pbr/navigation') visit(text(payload.url, LIMITS.urlChars), event.timestamp);
        else if (data.tag === 'pbr/trigger') {
          const reason = clip(text(payload.reason, 200), 120);
          push({ kind: 'trigger', timestamp: event.timestamp, title: reason ? 'Recording triggered (' + reason + ')' : 'Recording triggered', severity: 'info' });
        }
      }
    } catch (_) { /* A malformed event is left out. */ }
  }

  return {
    add: add,
    // Part of the recording is missing, so clicks stay unnamed until the next full snapshot.
    gap: function () { dom.gap(); input = null; },
    // The activity since the last call.
    take: function () { const result = items; items = []; lastIndex = -1; return result; },
    save: function () { return { v: 1, dom: dom.save(), origin: origin, page: page, input: input }; },
    nodes: function () { return dom.size(); },
  };
}

function collect(events) {
  const collector = createCollector();
  for (const event of events) collector.add(event);
  return collector.take();
}

// Calls the replay server can explain, as the dashboard picks them: failed, empty or slow calls sent to this server.
function explainable(activities, limit) {
  const asked = [];
  const max = limit === undefined ? 200 : limit;
  for (const item of activities) {
    const call = item.pocketbase;
    if (!call || !call.server || !call.request) continue;
    const empty = call.action === 'list' && call.items === 0;
    if (!(call.status >= 400 || (call.linked && !call.status && call.failed !== 'abort') || empty || (call.duration || 0) >= 1000)) continue;
    const request = { request: call.request, method: call.method, path: call.path, status: call.status };
    if (call.items !== undefined) request.items = call.items;
    if (call.status >= 400) {
      if (call.message) request.message = call.message;
      request.fields = call.invalid ? call.invalid.length : 0;
    }
    asked.push(request);
    if (asked.length >= max) break;
  }
  return asked;
}

const LOG_LEVELS = { trace: 'Trace', debug: 'Debug', info: 'Info', warn: 'Warning', error: 'Error', fatal: 'Fatal' };
// A diagnostics entry this close to the same recorded console line is that line stored twice.
const DUPLICATE_MS = 2000;

// Stored errors and logs as activity, in the dashboard's words. Each entry keeps its ID for the agent to look up.
function diagnosticActivity(errors, logs) {
  const items = [];
  for (const entry of Array.isArray(errors) ? errors : []) {
    if (!record(entry) || !finite(entry.timestamp)) continue;
    const name = clip(text(entry.name, 128), 128) || 'Error';
    const message = text(entry.message);
    const level = text(entry.level, 16).toLowerCase() || 'error';
    const uncaught = entry.handled === false;
    const item = {
      kind: 'error', timestamp: entry.timestamp, title: message ? name + ': ' + message : name,
      detail: (uncaught ? 'Unhandled' : 'Handled') + (level === 'fatal' ? ' fatal' : '') + ' error',
      // An error is never shown as plain information, whatever its stored level.
      severity: severityOf(level) === 'info' ? 'error' : severityOf(level), level: level,
    };
    if (uncaught) item.uncaught = true;
    if (typeof entry.id === 'string') item.id = entry.id;
    if (typeof entry.issueId === 'string') item.issueId = entry.issueId;
    if (text(entry.service, 128)) item.service = clip(text(entry.service, 128), 64);
    items.push(item);
  }
  for (const entry of Array.isArray(logs) ? logs : []) {
    if (!record(entry) || !finite(entry.timestamp)) continue;
    const level = text(entry.level, 16).toLowerCase() || 'info';
    const item = {
      kind: 'log', timestamp: entry.timestamp, title: text(entry.message) || '(empty log)',
      detail: (LOG_LEVELS[level] || level) + ' log', severity: severityOf(level), level: level,
    };
    if (typeof entry.id === 'string') item.id = entry.id;
    if (text(entry.service, 128)) item.service = clip(text(entry.service, 128), 64);
    items.push(item);
  }
  // Errors and logs arrive each in time order; merged, they keep it.
  const errorItems = items.filter(function (item) { return item.kind === 'error'; });
  const logItems = items.filter(function (item) { return item.kind === 'log'; });
  const byTime = function (left, right) { return left.timestamp - right.timestamp; };
  return merge(stable(errorItems, byTime), stable(logItems, byTime));
}

// A sort that keeps equal items in their order, whatever the engine's own sort does.
function stable(list, compare) {
  return list.map(function (item, index) { return [item, index]; })
    .sort(function (left, right) { return compare(left[0], right[0]) || left[1] - right[1]; })
    .map(function (pair) { return pair[0]; });
}

function duplicateKeys(item) {
  const line = function (value) { return oneLine(value).slice(0, 200); };
  if (item.kind === 'console' && item.uncaught) {
    const message = line(item.title.replace(/^Uncaught (?:\(in promise\) )?/, ''));
    return ['uncaught\n' + message, 'uncaught\nError: ' + message];
  }
  if (item.kind === 'console' || item.kind === 'log') return ['log\n' + item.severity + '\n' + line(item.title)];
  // Only an unhandled error can be the copy of an uncaught one the recorder saw.
  if (item.kind === 'error' && item.uncaught) return ['uncaught\n' + line(item.title)];
  return [];
}

// The diagnostics client can capture the same console output and uncaught errors the recorder did; each recorded
// line hides at most one stored copy of itself, and the stored error is kept, since it carries the issue and stack.
function mergeActivity(recorded, diagnostics) {
  const lines = new Map();
  const hidden = new Set();
  recorded.forEach(function (item, index) {
    if (item.kind !== 'console') return;
    for (const key of duplicateKeys(item)) {
      const times = lines.get(key);
      if (times) times.push([item.timestamp, index]); else lines.set(key, [[item.timestamp, index]]);
    }
  });
  const kept = diagnostics.filter(function (item) {
    const key = duplicateKeys(item)[0];
    const times = key ? lines.get(key) : undefined;
    const index = times ? times.findIndex(function (time) { return Math.abs(time[0] - item.timestamp) <= DUPLICATE_MS; }) : -1;
    if (index < 0) return true;
    // A stored error says more than the console line it copies: the issue, the stack and whether it was handled.
    if (item.kind === 'error') { hidden.add(times[index][1]); times.splice(index, 1); return true; }
    times.splice(index, 1);
    return false;
  });
  return merge(recorded.filter(function (item, index) { return !hidden.has(index); }), kept);
}

// Two lists each in time order, as one: at equal times the recorded entry comes first.
function merge(left, right) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (j >= right.length || (i < left.length && left[i].timestamp <= right[j].timestamp)) out.push(left[i++]);
    else out.push(right[j++]);
  }
  return out;
}

module.exports = {
  LIMITS: LIMITS, createDom: createDom, createCollector: createCollector, collect: collect, explainable: explainable,
  diagnosticActivity: diagnosticActivity, mergeActivity: mergeActivity, merge: merge, durationText: durationText, shortUrl: shortUrl,
  standardErrorMessage: standardErrorMessage, callName: callName, clip: clip, oneLine: oneLine,
};
