import type { ReplayEvent } from './types';

interface SerializedNode { id?: unknown; type?: unknown; attributes?: unknown }
interface Add { parentId?: unknown; node?: unknown }
interface Target { id?: unknown }
interface Removal { parentId?: unknown }
interface Range { start?: unknown; end?: unknown }

// rrweb leaves a blocked element as an empty placeholder sized by these attributes.
function placeholder(node: SerializedNode): boolean {
  return node.type === 2 && !!node.attributes && typeof node.attributes === 'object' && 'rr_width' in node.attributes;
}

/**
 * Whether a node is a blocked element or lies inside one, in its own document or beyond the shadow roots and
 * same-origin iframes around it. A node rrweb cannot find, or one outside the recorded document, counts as blocked.
 */
export function insideBlocked(node: Node | null | undefined, selector: string, top: Document): boolean {
  try {
    for (let current = node; current;) {
      const element = current.nodeType === 1 ? current as Element : current.parentElement;
      if (element?.closest(selector)) return true;
      const root: Node & { host?: Element; defaultView?: Window | null } = (element ?? current).getRootNode();
      if (root === top) return false;
      // A shadow root goes on at its host, and an iframe's document at the iframe.
      current = root.host ?? root.defaultView?.frameElement;
    }
  } catch { /* A node that cannot be read counts as blocked. */ }
  return true;
}

/**
 * rrweb decides whether an element is blocked when it first records it, and some of what it records later still
 * comes from inside blocked content: a same-origin iframe's document, a blocked element's shadow root and the
 * stylesheets adopted there, and the existing content of an element blocked after it was first recorded. This asks
 * `blocked`, which looks at the page as it is now, about every node an event names, and drops what lies inside.
 */
export function blockedContentFilter(blocked: (id: number) => boolean): (event: ReplayEvent) => ReplayEvent | null {
  // Stylesheets adopted inside blocked content. rrweb numbers them afresh with each full snapshot, after its meta event.
  let styles = new Set<number>();

  return (event) => {
    if (event.type === 4) { styles = new Set(); return event; }
    if (event.type !== 3) return event;
    // Within one event the page has not changed, so each node is looked up once.
    const known = new Map<number, boolean>();
    const hidden = (id: unknown): boolean => {
      if (typeof id !== 'number') return true;
      let value = known.get(id);
      if (value === undefined) known.set(id, value = blocked(id));
      return value;
    };
    const data = event.data;
    if (data.source === 0) return mutation(event, hidden, known);
    // A blocked element's shadow root and a blocked iframe's document adopt stylesheets that later change by number.
    if (data.source === 15 && hidden(data.id)) {
      if (Array.isArray(data.styleIds)) for (const id of data.styleIds) if (typeof id === 'number') styles.add(id);
      return null;
    }
    if (typeof data.styleId === 'number' && styles.has(data.styleId)) return null;
    // Scrolls, inputs, clicks, media and style changes name their node.
    if (data.id !== undefined && hidden(data.id)) return null;
    // Pointer moves and text selections may cover several nodes.
    if (Array.isArray(data.positions)) {
      const positions = data.positions.filter((item) => !hidden((item as Target).id));
      if (positions.length === data.positions.length) return event;
      return positions.length ? { ...event, data: { ...data, positions } } : null;
    }
    if (Array.isArray(data.ranges)) {
      const ranges = data.ranges.filter((item) => !hidden((item as Range).start) && !hidden((item as Range).end));
      if (ranges.length === data.ranges.length) return event;
      return ranges.length ? { ...event, data: { ...data, ranges } } : null;
    }
    return event;
  };
}

function mutation(event: ReplayEvent, hidden: (id: unknown) => boolean, known: Map<number, boolean>): ReplayEvent | null {
  const data = event.data;
  const list = (key: string) => Array.isArray(data[key]) ? data[key] as unknown[] : [];
  const adds = list('adds').filter((item) => {
    const add = item as Add;
    const node = (add.node ?? {}) as SerializedNode;
    const beneath = data.isAttachIframe === true || hidden(add.parentId);
    // rrweb adds parents before their children, so what follows beneath this node is decided by it.
    if (typeof node.id === 'number') known.set(node.id, beneath || placeholder(node));
    return !beneath;
  });
  const texts = list('texts').filter((item) => !hidden((item as Target).id));
  const attributes = list('attributes').filter((item) => !hidden((item as Target).id));
  // A removed node has already left the page, so where it was decides.
  const removes = list('removes').filter((item) => !hidden((item as Removal).parentId));
  if (adds.length === list('adds').length && texts.length === list('texts').length &&
      attributes.length === list('attributes').length && removes.length === list('removes').length) return event;
  if (!adds.length && !texts.length && !attributes.length && !removes.length) return null;
  return { ...event, data: { ...data, adds, texts, attributes, removes } };
}
