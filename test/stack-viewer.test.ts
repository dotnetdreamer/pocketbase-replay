import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { test } from 'node:test';
import type { ErrorOccurrence } from '../viewer/observability';

// viewer/stack.ts imports its stylesheet for esbuild; Node has no loader for CSS.
const loaders = nodeModule as unknown as {
  registerHooks?: (hooks: { load: (url: string, context: unknown, next: (url: string, context: unknown) => unknown) => unknown }) => void;
  register: (specifier: string, parent: string) => void;
};
if (loaders.registerHooks) {
  loaders.registerHooks({ load: (url, context, next) => url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context) });
} else {
  loaders.register(`data:text/javascript,${encodeURIComponent(
    'export async function load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); }')}`, import.meta.url);
}

async function drain(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve(); }

// Just enough of the DOM for the stack view and the source map list.
class FakeElement {
  children: FakeElement[] = [];
  textContent = ''; hidden = false; className = ''; disabled = false; type = ''; title = ''; open = false;
  dataset: Record<string, string> = {};
  readonly classList = {
    add: (name: string) => { if (!this.className.split(' ').includes(name)) this.className = `${this.className} ${name}`.trim(); },
    remove: (name: string) => { this.className = this.className.split(' ').filter((item) => item && item !== name).join(' '); },
  };
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, (() => void)[]>();
  constructor(readonly tagName: string) {}
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  append(...nodes: (FakeElement | string)[]) { for (const node of nodes) if (typeof node !== 'string') this.children.push(node); }
  replaceChildren(...nodes: FakeElement[]) { this.children = []; this.append(...nodes); }
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  dispatch(type: string) { for (const listener of this.listeners.get(type) ?? []) listener(); }
  all(): FakeElement[] { return this.children.flatMap((child) => [child, ...child.all()]); }
  querySelectorAll(selector: string): FakeElement[] {
    return this.all().filter((node) => selector === 'button' ? node.tagName === 'BUTTON' : selector === '[data-stack-view]' && !!node.dataset.stackView);
  }
}

function fakeDom() {
  const elements = new Map<string, FakeElement>();
  const add = (id: string, tag: string) => { const node = new FakeElement(tag.toUpperCase()); elements.set(id, node); return node; };
  for (const [id, tag] of [['occurrence-stack', 'pre'], ['occurrence-frames', 'div'], ['stack-state', 'p'], ['observability-settings-dialog', 'dialog'],
    ['sourcemaps', 'ul'], ['sourcemaps-state', 'p'], ['open-observability-settings', 'button']]) add(id, tag);
  const toggle = add('stack-view', 'div');
  for (const view of ['original', 'minified']) {
    const button = new FakeElement('BUTTON');
    button.dataset.stackView = view;
    toggle.append(button);
  }
  const globals = globalThis as unknown as { document?: unknown; confirm?: unknown };
  globals.document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
    createTextNode: (text: string) => text,
  };
  globals.confirm = () => true;
  return { byId: (id: string) => elements.get(id)! };
}

const stack = 'TypeError: boom\n    at e (https://localhost/assets/index-AAAA1111.js:1:104)';
const frame = { raw: 'at e (https://localhost/assets/index-AAAA1111.js:1:104)', function: 'e', file: 'https://localhost/assets/index-AAAA1111.js', line: 1, column: 104 };
const resolved = {
  id: 'error-one', appVersion: '1.0', sourceMaps: 1, mapped: 1,
  frames: [{ ...frame, mapped: { source: '../src/board.ts', line: 3, column: 39, name: 'toUpperCase' }, context: { start: 3, lines: ['  return cells.map(cell => cell.value.toUpperCase());'] } }],
};
const unresolved = { id: 'error-one', appVersion: '1.0', sourceMaps: 0, mapped: 0, frames: [frame] };
const entry = (id: string, appVersion: string) => ({ id, appVersion, stack } as ErrorOccurrence);

test('deleting a version\'s source maps re-resolves the open stack, even when the dialog closed meanwhile', async () => {
  const dom = fakeDom();
  let deleted = false;
  let finishDelete = () => {};
  const calls: string[] = [];
  const request = async (path: string, _body?: unknown, method = 'GET') => {
    calls.push(`${method} ${path}`);
    if (path.endsWith('/frames')) return deleted ? unresolved : resolved;
    if (method === 'DELETE') { await new Promise<void>((resolve) => { finishDelete = resolve; }); deleted = true; return { ok: true, deletedFiles: 1 }; }
    return { items: deleted ? [] : [{ appVersion: '1.0', files: 1, bytes: 2048, uploadedAt: 1 }] };
  };
  const { installSourceMaps } = await import('../viewer/stack');
  const maps = installSourceMaps(request);
  maps.showStack(entry('error-one', '1.0'));
  await drain();
  assert.equal(dom.byId('stack-view').hidden, false);
  assert.equal(dom.byId('occurrence-frames').hidden, false);
  assert.equal(dom.byId('occurrence-stack').hidden, true);
  dom.byId('open-observability-settings').dispatch('click');
  await drain();
  dom.byId('sourcemaps').querySelectorAll('button')[0].dispatch('click');
  await drain();
  dom.byId('observability-settings-dialog').dispatch('close');
  finishDelete();
  await drain();
  assert.ok(calls.includes('DELETE /api/replay/sourcemaps?appVersion=1.0'));
  assert.equal(calls.filter((call) => call.endsWith('/frames')).length, 2);
  assert.equal(dom.byId('stack-view').hidden, true);
  assert.equal(dom.byId('occurrence-frames').hidden, true);
  assert.equal(dom.byId('occurrence-stack').hidden, false);
  assert.equal(dom.byId('occurrence-stack').textContent, stack);
  assert.match(dom.byId('stack-state').textContent, /No source maps uploaded for version 1\.0/);

  // Deleting another version leaves an open stack of this one alone.
  deleted = false;
  maps.showStack(entry('error-two', '2.0'));
  await drain();
  dom.byId('open-observability-settings').dispatch('click');
  await drain();
  const before = calls.filter((call) => call.endsWith('/frames')).length;
  dom.byId('sourcemaps').querySelectorAll('button')[0].dispatch('click');
  await drain();
  finishDelete();
  await drain();
  assert.equal(calls.filter((call) => call.endsWith('/frames')).length, before);
});
