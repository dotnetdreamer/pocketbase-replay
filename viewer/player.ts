// Guards for rrweb-player 2.1.6 internals. Each is skipped when a later version renames what it patches.
interface Action { doAction: () => void; delay: number }
interface Timer {
  actions: Action[]; raf: number | true | null; timeOffset: number; lastTimestamp: number; speed: number;
  rafCheck: () => void;
}
interface Hoverable {
  nodeType: number;
  parentElement: Hoverable | null;
  classList?: { add: (name: string) => void };
  getRootNode?: () => Hoverable;
}
interface Root { nodeType: number; querySelectorAll?: (selector: string) => Iterable<{ classList: { remove: (name: string) => void } }> }
interface Internals {
  timer?: Timer;
  emitter?: { all?: Map<string, ((value: unknown) => void)[]> };
  iframe?: { contentDocument: Root | null };
  lastHoveredRootNode?: Root;
  getCastFn?: (event: unknown, isSync?: boolean) => () => void;
  hoverElements?: (node: Hoverable) => void;
  [method: string]: unknown;
}

const ELEMENT = 1;
const DOCUMENT = 9;
const FRAGMENT = 11;

// rrweb stops playback for good on the first throw from an event; these report it and carry on.
export function keepPlaying(replayer: unknown, report: (error: unknown) => void): void {
  const target = replayer as Internals;
  const guard = <T extends unknown[]>(run: (...args: T) => unknown) => function (this: unknown, ...args: T) {
    try { return run.apply(this, args); } catch (error) { report(error); return undefined; }
  };

  // Its frame loop runs each due event with no try/catch, so a throw left the rest unplayed.
  const timer = target.timer;
  if (timer && typeof timer.rafCheck === 'function' && Array.isArray(timer.actions)) {
    timer.rafCheck = function rafCheck(this: Timer) {
      const now = performance.now();
      this.timeOffset += (now - this.lastTimestamp) * this.speed;
      this.lastTimestamp = now;
      while (this.actions.length && this.timeOffset >= this.actions[0].delay) {
        const action = this.actions.shift()!;
        try { action.doAction(); } catch (error) { report(error); }
      }
      this.raf = this.actions.length ? requestAnimationFrame(this.rafCheck.bind(this)) : true;
    };
  }

  // A seek applies every earlier event at once, then flushes; a throw in either skipped the
  // rest of the seek and never restarted the timer.
  const getCastFn = target.getCastFn;
  if (typeof getCastFn === 'function') {
    target.getCastFn = (event, isSync) => guard(getCastFn(event, isSync)) as () => void;
  }
  const flush = target.emitter?.all?.get('flush');
  if (Array.isArray(flush)) flush.forEach((handler, index) => { flush[index] = guard(handler); });
  for (const name of ['applyIncremental', 'rebuildFullSnapshot', 'moveAndHover', 'applyStyleSheetMutation', 'applyAdoptedStyleSheet']) {
    const method = target[name];
    if (typeof method === 'function') target[name] = guard(method as (...args: unknown[]) => unknown);
  }

  // A tap can resolve to a text node or a removed one, whose root is the node itself; caching
  // it as the hover root made the next tap call querySelectorAll on it and throw.
  if (typeof target.hoverElements === 'function') {
    target.hoverElements = function hoverElements(this: Internals, node: Hoverable) {
      const root = this.lastHoveredRootNode ?? this.iframe?.contentDocument;
      if (typeof root?.querySelectorAll === 'function') {
        for (const hovered of root.querySelectorAll('.\\:hover')) hovered.classList.remove(':hover');
      }
      const element = node.nodeType === ELEMENT ? node : node.parentElement;
      const top = element?.getRootNode?.();
      this.lastHoveredRootNode = top && (top.nodeType === DOCUMENT || top.nodeType === FRAGMENT) ? top as Root : undefined;
      for (let current = element; current; current = current.parentElement) current.classList?.add(':hover');
    };
  }
}
