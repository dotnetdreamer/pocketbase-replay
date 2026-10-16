import './stack.css';
import type { ErrorOccurrence } from './observability';

type AdminRequest = (path: string, body?: unknown, method?: string) => Promise<any>;

export interface StackFrame {
  raw: string; function: string; file: string; line: number | null; column: number | null;
  // 1-based, like the stack the device sent.
  mapped?: { source: string; line: number; column: number; name: string | null };
  context?: { start: number; lines: string[] };
}
export interface ResolvedStack { id: string; appVersion: string; sourceMaps: number; mapped: number; frames: StackFrame[] }
export interface SourceMapVersion { appVersion: string; files: number; bytes: number; uploadedAt: number }
type StackView = 'original' | 'minified';

// A minifier's one- and two-letter names say nothing, so the identifier from the source map is shown instead.
export function frameName(frame: StackFrame): string {
  const own = frame.function;
  const bare = own.replace(/^(?:async |new )+/, '').replace(/^.*\./, '');
  if (bare.length > 2 && !/^<?anonymous>?$/.test(bare)) return own;
  return frame.mapped?.name || own || '<anonymous>';
}

// The source path without a bundler scheme such as webpack:// or the ../ that leads out of the build folder.
export function sourceLabel(source: string): string {
  const parts: string[] = [];
  for (const part of source.replace(/\\/g, '/').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  return parts.join('/') || source;
}

// The message lines above the first frame.
export function stackHeader(stack: string, frames: StackFrame[]): string {
  const lines = stack.split('\n');
  const first = frames.length ? lines.findIndex((line) => line.trim() === frames[0].raw) : -1;
  return (first < 0 ? lines.slice(0, 1) : lines.slice(0, first)).join('\n').trim();
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function element<K extends keyof HTMLElementTagNameMap>(name: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function codeContext(frame: StackFrame): HTMLPreElement {
  const mapped = frame.mapped!;
  const context = frame.context!;
  const pre = element('pre', 'stack-context');
  pre.setAttribute('aria-label', `Code around ${sourceLabel(mapped.source)} line ${mapped.line}`);
  const code = element('code');
  context.lines.forEach((text, index) => {
    const number = context.start + index;
    const current = number === mapped.line;
    const row = element(current ? 'mark' : 'span', 'stack-line');
    if (current) row.append(element('span', 'stack-sr', 'Error line '));
    row.append(element('span', 'stack-number', String(number)), document.createTextNode(text || ' '));
    code.append(row);
  });
  pre.append(code);
  return pre;
}

function frameItem(frame: StackFrame, open: boolean): HTMLLIElement {
  const item = element('li', 'stack-frame');
  const head = element(frame.context ? 'summary' : 'div', 'stack-head');
  if (frame.mapped) {
    const location = `${sourceLabel(frame.mapped.source)}:${frame.mapped.line}:${frame.mapped.column}`;
    const where = element('span', 'stack-location', location);
    where.title = `${frame.mapped.source} (minified ${frame.file}:${frame.line}:${frame.column})`;
    head.append(element('code', 'stack-function', frameName(frame)), where);
  } else {
    item.classList.add('unmapped');
    const position = frame.line === null ? '' : `:${frame.line}${frame.column === null ? '' : `:${frame.column}`}`;
    head.append(element('code', 'stack-function', frame.function || '<anonymous>'), element('span', 'stack-location', frame.file + position));
  }
  if (!frame.context) {
    item.append(head);
    return item;
  }
  const details = element('details');
  details.open = open;
  details.append(head, codeContext(frame));
  item.append(details);
  return item;
}

// Original frames for error stacks whose version has source maps, and the source map list in Diagnostics settings.
export function installSourceMaps(request: AdminRequest): { showStack(entry: ErrorOccurrence): void; clearStack(): void } {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const raw = $<HTMLPreElement>('occurrence-stack');
  const original = $('occurrence-frames');
  const toggle = $('stack-view');
  const state = $('stack-state');
  const dialog = $<HTMLDialogElement>('observability-settings-dialog');
  const list = $<HTMLUListElement>('sourcemaps');
  const listState = $('sourcemaps-state');
  let view: StackView = 'original';
  let shown: ErrorOccurrence | undefined;
  let stackGeneration = 0;
  let listGeneration = 0;
  let busy = false;

  function setView(next: StackView): void {
    view = next;
    const mapped = !toggle.hidden;
    original.hidden = !mapped || view !== 'original';
    raw.hidden = mapped && view === 'original';
    toggle.querySelectorAll<HTMLButtonElement>('[data-stack-view]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.stackView === view));
    });
  }

  function clearStack(): void {
    stackGeneration++;
    shown = undefined;
    original.replaceChildren();
    toggle.hidden = true;
    state.textContent = '';
    raw.textContent = '';
    setView(view);
  }

  function render(result: ResolvedStack, stack: string): void {
    const header = stackHeader(stack, result.frames);
    const frames = element('ol', 'stack-frames');
    let opened = false;
    for (const frame of result.frames) {
      frames.append(frameItem(frame, !!frame.context && !opened));
      if (frame.context) opened = true;
    }
    original.replaceChildren(...(header ? [element('p', 'stack-message', header)] : []), frames);
    toggle.hidden = false;
    setView(view);
  }

  // The stack as sent shows at once and stays when nothing maps or the request fails.
  function showStack(entry: ErrorOccurrence): void {
    clearStack();
    shown = entry;
    const current = stackGeneration;
    raw.textContent = entry.stack || 'No stack trace supplied';
    if (!entry.stack || !entry.id) return;
    request(`/api/replay/errors/${encodeURIComponent(entry.id)}/frames`).then((result: ResolvedStack) => {
      if (current !== stackGeneration) return;
      if (result.mapped > 0) render(result, entry.stack);
      else if (!result.sourceMaps && entry.appVersion && result.frames.some((frame) => frame.line !== null)) {
        state.textContent = `No source maps uploaded for version ${entry.appVersion}. Upload them to see original code`;
      }
    }).catch(() => { /* An older server or a failed request leaves the stack as sent. */ });
  }

  toggle.querySelectorAll<HTMLButtonElement>('[data-stack-view]').forEach((button) => {
    button.addEventListener('click', () => setView(button.dataset.stackView as StackView));
  });

  function setBusy(value: boolean): void {
    busy = value;
    list.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = value; });
  }

  function showVersions(items: SourceMapVersion[], message: string): void {
    listState.classList.remove('error');
    listState.textContent = message || (items.length ? '' : 'No source maps uploaded yet');
    list.replaceChildren(...items.map((item) => {
      const row = element('li');
      const info = element('div');
      info.append(element('strong', '', item.appVersion), element('small', '',
        `${item.files} file${item.files === 1 ? '' : 's'} · ${formatBytes(item.bytes)} · uploaded ${new Date(item.uploadedAt).toLocaleString()}`));
      const remove = element('button', 'danger', 'Delete');
      remove.type = 'button';
      remove.disabled = busy;
      remove.setAttribute('aria-label', `Delete the source maps for version ${item.appVersion}`);
      remove.addEventListener('click', () => { void removeVersion(item.appVersion); });
      row.append(info, remove);
      return row;
    }));
  }

  // A newer load, or closing the dialog, makes an older answer stale.
  function loadVersions(message = ''): Promise<void> {
    const current = ++listGeneration;
    list.replaceChildren();
    listState.classList.remove('error');
    listState.textContent = 'Loading source maps...';
    return request('/api/replay/sourcemaps').then((result: { items: SourceMapVersion[] }) => {
      if (current === listGeneration) showVersions(result.items, message);
    }).catch((error: unknown) => {
      if (current !== listGeneration) return;
      listState.textContent = error instanceof Error ? error.message : 'Could not load source maps';
      listState.classList.add('error');
    });
  }

  async function removeVersion(version: string): Promise<void> {
    if (busy || !confirm(`Delete the source maps for version ${version}? Its errors will show minified stacks again.`)) return;
    const current = listGeneration;
    setBusy(true);
    try {
      await request(`/api/replay/sourcemaps?appVersion=${encodeURIComponent(version)}`, undefined, 'DELETE');
    } catch (error) {
      if (current !== listGeneration) return;
      setBusy(false);
      listState.textContent = error instanceof Error ? error.message : 'Could not delete the source maps';
      listState.classList.add('error');
      return;
    }
    // The open occurrence may have been resolved through the maps just deleted, even if the dialog closed meanwhile.
    if (shown && shown.appVersion === version) showStack(shown);
    if (current !== listGeneration) return;
    busy = false;
    await loadVersions(`Deleted the source maps for version ${version}`);
  }

  $('open-observability-settings').addEventListener('click', () => { void loadVersions(); });
  dialog.addEventListener('close', () => {
    listGeneration++;
    busy = false;
    list.replaceChildren();
    listState.textContent = '';
  });
  return { showStack, clearStack };
}
