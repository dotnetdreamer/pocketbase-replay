/** Shadow roots as screenshot privacy sees them. A closed root cannot be found from outside its host, so the watch
 * notes each one as it is attached; screenshot mode then inspects it like an open root. */
export interface ShadowRoots {
  /** The element's open shadow root, or its closed one when it was attached while watched. */
  of(element: Element): ShadowRoot | null;
  /** A custom element upgraded before the watch began may hold a closed root that nothing can find. */
  unseen(element: Element): boolean;
  /** Calls back whenever a shadow root is attached, until the returned function is called. */
  listen(callback: () => void): () => void;
}

interface Watch { closed: WeakMap<Element, ShadowRoot>; unseen: WeakSet<Element>; listeners: Set<() => void> }

const MAX_SCANNED = 100000;
// One watch per Element prototype: it stays for the page's lifetime, so every later recorder can rely on it.
const watches = new WeakMap<object, Watch>();

function scan(win: Window & typeof globalThis, unseen: WeakSet<Element>): boolean {
  let count = 0;
  const visit = (root: Document | ShadowRoot): boolean => {
    for (const element of Array.from(root.querySelectorAll('*'))) {
      if (++count > MAX_SCANNED) return false;
      if (element.tagName.includes('-') && !element.shadowRoot && win.customElements?.get(element.localName)) unseen.add(element);
      if (element.shadowRoot && !visit(element.shadowRoot)) return false;
    }
    return true;
  };
  return visit(win.document);
}

/** Starts watching shadow roots in this window, or returns the running watch. Null when attachShadow cannot be
 * observed, in which case screenshot mode does not record. The hook only notes closed roots; the page sees the
 * same behavior and the same roots. */
export function watchShadowRoots(win: Window): ShadowRoots | null {
  try {
    const browser = win as Window & typeof globalThis;
    const prototype = browser.Element.prototype;
    let watch = watches.get(prototype);
    if (!watch) {
      const original = prototype.attachShadow;
      if (typeof original !== 'function') return null;
      const created: Watch = { closed: new WeakMap(), unseen: new WeakSet(), listeners: new Set() };
      if (!scan(browser, created.unseen)) return null;
      Object.defineProperty(prototype, 'attachShadow', {
        configurable: true, writable: true,
        value: function attachShadow(this: Element, init: ShadowRootInit): ShadowRoot {
          const root = original.call(this, init);
          if (root.mode === 'closed') created.closed.set(this, root);
          for (const listener of created.listeners) {
            try { listener(); } catch { /* Recording must not break the page. */ }
          }
          return root;
        },
      });
      watches.set(prototype, watch = created);
    }
    const current = watch;
    return {
      of: (element) => element.shadowRoot ?? current.closed.get(element) ?? null,
      unseen: (element) => current.unseen.has(element),
      listen: (callback) => { current.listeners.add(callback); return () => { current.listeners.delete(callback); }; },
    };
  } catch { return null; }
}
