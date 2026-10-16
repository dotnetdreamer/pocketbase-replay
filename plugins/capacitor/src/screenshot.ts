import type { RecorderAdapter, RecorderOptions, ReplayEvent } from 'pocketbase-replay';
import type { ScreenshotOptions } from './definitions.js';
import type { NativeReplayPlugin } from './native.js';
import { inspectScreen, privateArea, visibleLabel } from './screenshot-privacy.js';
import type { InspectedScreen, ScreenRect } from './screenshot-privacy.js';
import { watchShadowRoots } from './shadow-roots.js';

export type ScreenshotBridge = Pick<NativeReplayPlugin, 'captureScreenshot'>;
const PROBE = '__pocketbaseReplayScreenshot';
const PNG_PREFIX = 'data:image/png;base64,iVBORw0KGgo';
const MAX_IMAGE_LENGTH = 262166;
const px = (value: number): string => `${Math.round(value * 100) / 100}px`;
const element = (id: number, tagName: string, attributes: Record<string, string>, childNodes: unknown[] = []) => ({ type: 2, id, tagName, attributes, childNodes });
const boundsStyle = (rect: ScreenRect): string => `position:absolute;left:${px(rect.x)};top:${px(rect.y)};width:${px(rect.width)};height:${px(rect.height)}`;
const mutation = (timestamp: number, adds: unknown[] = [], removes: unknown[] = [], attributes: unknown[] = []): ReplayEvent => ({ type: 3, timestamp, data: { source: 0, texts: [], adds, removes, attributes } });

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value))) : fallback;
}
function href(win: Window, options: RecorderOptions): string {
  try {
    const value = new URL(win.location.href);
    value.search = ''; value.hash = ''; value.username = ''; value.password = '';
    const words = options.sensitiveText?.() ?? [];
    let path: string; try { path = decodeURIComponent(value.pathname); } catch { path = '/*'; }
    for (const word of words) if (word) path = path.replace(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '*');
    value.pathname = path.split('/').map((part) => encodeURIComponent(part)).join('/');
    return value.toString();
  } catch { return 'about:blank'; }
}

function fullSnapshot(timestamp: number, screen: InspectedScreen, image: string, url: string): ReplayEvent[] {
  const size = `width:${px(screen.width)};height:${px(screen.height)}`;
  const layer = `position:absolute;left:0;top:0;${size};pointer-events:none;overflow:hidden`;
  return [
    { type: 4, timestamp, data: { href: url, width: Math.round(screen.width), height: Math.round(screen.height) } },
    { type: 2, timestamp, data: { initialOffset: { top: 0, left: 0 }, node: { type: 0, id: 1, childNodes: [
      { type: 1, id: 2, name: 'html', publicId: '', systemId: '' },
      element(3, 'html', { style: 'margin:0;padding:0;background:#000' }, [
        element(4, 'head', {}),
        element(5, 'body', { style: `margin:0;padding:0;position:relative;overflow:hidden;background:#000;${size}` }, [
          element(6, 'img', { src: image, alt: '', style: `position:absolute;left:0;top:0;display:block;${size}` }),
          element(7, 'div', { style: layer }),
          element(8, 'div', { style: `${layer};opacity:0` }),
        ]),
      ]),
    ] } } },
  ];
}

/** Native pixels are masked before crossing the bridge; the normal replay transport/player can then reuse rrweb's image nodes. */
export function createScreenshotRecorder(native: ScreenshotBridge, configuration: ScreenshotOptions = {}): RecorderAdapter {
  const config = { ...configuration };
  const interval = bounded(config.intervalMs, 1000, 500, 60000);
  const maxDimension = bounded(config.maxDimension, 1280, 256, 1280);
  let stopCurrent: (() => void) | undefined;
  let requestSnapshot: (() => void) | undefined;
  return {
    imageSnapshots: true,
    start(emit, options) {
      stopCurrent?.();
      const win = globalThis.window;
      if (!win?.document || typeof native.captureScreenshot !== 'function' || Object.prototype.hasOwnProperty.call(win, PROBE)) return undefined;
      // Without sight of closed shadow roots, private content inside them could reach an image.
      const roots = watchShadowRoots(win);
      if (!roots) return undefined;
      const browser = win as Window & typeof globalThis;
      let stopped = false, epoch = 0, request = '', busy = false, forceFull = true, ready = false, queued = false;
      let lastImage = '', lastHref = '', width = 0, height = 0, timestamp = 0, nextId = 9, tapId: number | undefined;
      let lastMoveAt = 0, lastMove = '';
      let timer: ReturnType<typeof setTimeout> | undefined;
      const now = (): number => timestamp = Math.max(Date.now(), timestamp + 1);
      const observer = new browser.MutationObserver(() => { epoch++; });
      const observedRoots = new WeakSet<Node>();
      const observe = (root: Node): void => {
        if (!observedRoots.has(root)) {
          observedRoots.add(root);
          observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
        }
      };
      observe(win.document);
      const inspect = (): InspectedScreen | null => {
        if (observer.takeRecords().length) epoch++;
        return inspectScreen(win, options, config, epoch, observe, roots);
      };
      const probe = (id: unknown): string | null => {
        if (stopped || !request || id !== request) return null;
        const screen = inspect();
        return screen ? JSON.stringify({ requestId: request, width: screen.width, height: screen.height, rects: screen.rects, revision: screen.revision }) : null;
      };
      Object.defineProperty(win, PROBE, { configurable: true, enumerable: false, value: probe });
      const changed = (): void => { epoch++; };
      // A new shadow root changes what paints without a mutation the observer sees.
      const unwatch = roots.listen(changed);
      win.addEventListener('resize', changed);
      win.addEventListener('scroll', changed, true);
      const run = async (): Promise<void> => {
        if (stopped || busy) return;
        busy = true;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        const full = forceFull;
        forceFull = false;
        try {
          const before = inspect();
          if (!before) { forceFull ||= full; return; }
          // A request ID grants access only while this one native capture is outstanding.
          const random = new Uint8Array(10); browser.crypto.getRandomValues(random);
          request = Array.from(random, (value) => value.toString(16).padStart(2, '0')).join('');
          const id = request;
          const captured = await native.captureScreenshot({ requestId: id, maxDimension });
          if (stopped || request !== id) return;
          const after = inspect();
          if (!after || before.revision !== after.revision || typeof captured?.data !== 'string' || !captured.data.startsWith(PNG_PREFIX) || captured.data.length > MAX_IMAGE_LENGTH || !Number.isFinite(captured.width) || !Number.isFinite(captured.height) || captured.width < 1 || captured.height < 1 || captured.width > 20000 || captured.height > 20000 || captured.width !== after.width || captured.height !== after.height) { forceFull ||= full; return; }
          const url = href(win, options);
          if (full || !ready || width !== after.width || height !== after.height || url !== lastHref) {
            nextId = 9; tapId = undefined; ready = true; width = after.width; height = after.height;
            for (const event of fullSnapshot(now(), after, captured.data, url)) emit(event);
          } else if (captured.data !== lastImage) emit(mutation(now(), [], [], [{ id: 6, attributes: { src: captured.data } }]));
          lastImage = captured.data; lastHref = url;
        } catch { forceFull ||= full; /* Unsupported captures, unstable layouts and bridge errors are retried later. */ }
        finally {
          request = ''; busy = false;
          if (!stopped) timer = setTimeout(() => { void run(); }, queued ? 0 : interval);
          queued = false;
        }
      };
      const interaction = (event: Event): void => {
        // Pseudo-classes can move private pixels without a DOM mutation.
        epoch++;
        if (stopped || !ready) return;
        try {
          const pointer = event as MouseEvent;
          if (event.type === 'pointermove') {
            // A drag moves every frame and each inspection walks the whole page, so moves are sampled first.
            const time = Date.now();
            if (time - lastMoveAt < 100) return;
            lastMoveAt = time;
          }
          const screen = inspect();
          if (!screen) return;
          const path = event.composedPath();
          const target = path.find((node) => node instanceof browser.Element) as Element | undefined;
          const area = privateArea(screen, target ?? null, pointer.clientX, pointer.clientY);
          const x = area ? area.x + area.width / 2 : pointer.clientX, y = area ? area.y + area.height / 2 : pointer.clientY;
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;
          if (event.type === 'pointermove') {
            const position = `${x},${y}`;
            if (position === lastMove) return;
            lastMove = position;
            emit({ type: 3, timestamp: now(), data: { source: 1, positions: [{ x, y, id: 6, timeOffset: 0 }] } });
            return;
          }
          let id = 6;
          if (event.type === 'click' && target) {
            const control = target.closest('button,a,[role="button"],input,select,textarea') ?? target;
            const rect = area ?? { x: control.getBoundingClientRect().x, y: control.getBoundingClientRect().y, width: control.getBoundingClientRect().width, height: control.getBoundingClientRect().height };
            const tag = area ? 'div' : ['button', 'a', 'input', 'select', 'textarea'].includes(control.tagName.toLowerCase()) ? control.tagName.toLowerCase() : 'div';
            const text = area ? '*' : visibleLabel(control, screen);
            id = nextId++;
            const children = text ? [{ type: 3, id: nextId++, textContent: text }] : [];
            emit(mutation(now(), [{ parentId: 8, nextId: null, node: element(id, tag, { style: boundsStyle(rect) }, children) }], tapId === undefined ? [] : [{ parentId: 8, id: tapId }]));
            tapId = id;
          }
          emit({ type: 3, timestamp: now(), data: { source: 2, type: event.type === 'click' ? 2 : event.type === 'pointerdown' ? 1 : 0, id, x, y } });
        } catch { /* A failed privacy inspection suppresses activity too. */ }
      };
      // Pointer positions have the same private-area coarsening as taps; input/key values are never observed.
      for (const type of ['click', 'pointerdown', 'pointerup', 'pointermove']) win.document.addEventListener(type, interaction, true);
      const stateEvents = ['pointerover', 'pointerout', 'focusin', 'focusout', 'load', 'transitionrun', 'transitionend', 'transitioncancel', 'animationstart', 'animationend', 'animationcancel'];
      for (const type of stateEvents) win.document.addEventListener(type, changed, true);
      requestSnapshot = () => { if (!stopped) { forceFull = true; if (busy) queued = true; else void run(); } };
      const stop = (): void => {
        if (stopped) return;
        stopped = true; ready = false; request = '';
        if (timer !== undefined) clearTimeout(timer);
        observer.disconnect();
        win.removeEventListener('resize', changed); win.removeEventListener('scroll', changed, true);
        for (const type of ['click', 'pointerdown', 'pointerup', 'pointermove']) win.document.removeEventListener(type, interaction, true);
        for (const type of stateEvents) win.document.removeEventListener(type, changed, true);
        if ((win as unknown as Record<string, unknown>)[PROBE] === probe) delete (win as unknown as Record<string, unknown>)[PROBE];
        unwatch();
        if (stopCurrent === stop) { stopCurrent = undefined; requestSnapshot = undefined; }
      };
      stopCurrent = stop;
      void run();
      return stop;
    },
    snapshot() { requestSnapshot?.(); },
  };
}
