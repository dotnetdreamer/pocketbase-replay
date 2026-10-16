import type { RecorderOptions } from 'pocketbase-replay';
import type { ScreenshotOptions } from './definitions.js';
import type { ShadowRoots } from './shadow-roots.js';

export interface ScreenRect { x: number; y: number; width: number; height: number }
export interface ScreenshotPlan { requestId: string; width: number; height: number; rects: ScreenRect[]; revision: string }
export interface InspectedScreen {
  width: number;
  height: number;
  rects: ScreenRect[];
  privateAreas: Map<Element, ScreenRect>;
  privateElements: Map<Element, Element>;
  revision: string;
}

const MAX_NODES = 10000;
const MAX_RECTS = 2000;
const CONTROLS = 'input,textarea,select,[contenteditable]:not([contenteditable="false"])';
const BLOCKED = 'canvas,iframe,video,audio,object,embed,[data-replay-block],.rr-block';
const hasImage = (style: CSSStyleDeclaration): boolean => [style.backgroundImage, style.listStyleImage, style.borderImageSource].some((value) => !!value && value !== 'none');

function finite(value: number): boolean { return Number.isFinite(value) && Math.abs(value) <= 1000000; }
function rectangle(value: DOMRect | ScreenRect): ScreenRect {
  const rect = { x: value.x, y: value.y, width: value.width, height: value.height };
  if (!Object.values(rect).every(finite) || rect.width < 0 || rect.height < 0) throw new Error('Invalid mask bounds');
  return rect;
}
function union(a: ScreenRect, b: ScreenRect): ScreenRect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
function hash(input: string): string {
  let value = 2166136261;
  for (let index = 0; index < input.length; index++) value = Math.imul(value ^ input.charCodeAt(index), 16777619);
  return (value >>> 0).toString(36);
}

/** No page HTML, control values, or accessibility labels leave this inspection. */
export function inspectScreen(win: Window, options: RecorderOptions, config: ScreenshotOptions, epoch: number, observeRoot?: (root: ShadowRoot) => void, roots?: ShadowRoots): InspectedScreen | null {
  try {
    const doc = win.document;
    if (doc.visibilityState !== 'visible' || !doc.documentElement) return null;
    const width = win.innerWidth, height = win.innerHeight;
    if (!finite(width) || !finite(height) || width <= 0 || height <= 0) return null;
    const viewport = win.visualViewport;
    if (viewport && (viewport.scale !== 1 || viewport.offsetLeft !== 0 || viewport.offsetTop !== 0 || Math.abs(viewport.width - width) > 1 || Math.abs(viewport.height - height) > 1)) return null;
    // A changing CSS frame cannot be compared reliably across the native capture boundary.
    if (typeof doc.getAnimations !== 'function' || doc.getAnimations().some((animation) => animation.playState === 'running' || animation.pending)) return null;
    const maskSelector = ['[data-replay-mask]', options.maskTextSelector].filter(Boolean).join(',');
    const blockSelector = [BLOCKED, options.blockSelector].filter(Boolean).join(',');
    // Validate first, including selectors that happen to match no elements.
    doc.querySelector(maskSelector); doc.querySelector(blockSelector);
    const words = options.sensitiveText?.() ?? [];
    if (!Array.isArray(words) || words.some((word) => typeof word !== 'string')) return null;
    const needles = words.filter(Boolean).map((word) => word.toLocaleLowerCase());
    const images = config.maskAllImages !== false || options.recordImages !== true;
    const rects: ScreenRect[] = [], privateAreas = new Map<Element, ScreenRect>(), privateElements = new Map<Element, Element>();
    const effects = new Map<Element, boolean>();
    const geometry: (number | string)[] = [epoch, width, height, win.scrollX, win.scrollY];
    let nodes = 0, textLength = 0;
    const textNodes: { node: Node; text: string; start: number; end: number }[] = [];
    const whole = { x: 0, y: 0, width, height };
    function add(rect: ScreenRect, owner?: Element) {
      if (rect.width === 0 || rect.height === 0) return;
      if (rects.length >= MAX_RECTS) throw new Error('Too many mask areas');
      rects.push(rect);
      if (owner) privateAreas.set(owner, privateAreas.has(owner) ? union(privateAreas.get(owner)!, rect) : rect);
    }
    function coverEffects(element: Element, owner: Element): void {
      if (effects.get(element) && privateAreas.get(owner) !== whole) {
        add(whole, owner);
        privateAreas.set(owner, whole);
      }
    }
    function textRects(node: Node, owner: Element): void {
      const range = doc.createRange(); range.selectNodeContents(node);
      try {
        const boxes = Array.from(range.getClientRects());
        if (!boxes.length && node.textContent) add(whole, owner);
        const style = node.parentElement ? win.getComputedStyle(node.parentElement) : undefined;
        // Layout boxes do not necessarily include italic glyph overhang or text strokes.
        const padding = Math.max(0, Number.parseFloat(style?.fontSize ?? '') || 0, Number.parseFloat(style?.getPropertyValue?.('-webkit-text-stroke-width') ?? '') || 0);
        for (const value of boxes) {
          const rect = rectangle(value);
          add(rectangle({ x: rect.x - padding, y: rect.y - padding, width: rect.width + padding * 2, height: rect.height + padding * 2 }), owner);
        }
      } finally { range.detach(); }
      if (node.parentElement) coverEffects(node.parentElement, owner);
    }
    function walk(node: Node, inherited?: Element, ancestorEffect = false): void {
      if (++nodes > MAX_NODES) throw new Error('Page is too large to inspect');
      if (node.nodeType === 3) {
        const text = node.textContent ?? '';
        if (needles.length) {
          if (textLength + text.length > 1000000) throw new Error('Too much text to inspect');
          textNodes.push({ node, text: text.toLocaleLowerCase(), start: textLength, end: textLength + text.length }); textLength += text.length;
        }
        if (inherited) {
          if (node.parentElement) privateElements.set(node.parentElement, inherited);
          textRects(node, inherited); if (ancestorEffect) add(whole, inherited);
        }
        else if (needles.length && needles.some((word) => text.toLocaleLowerCase().includes(word))) {
          const parent = node.parentElement;
          if (parent) { privateElements.set(parent, parent); textRects(node, parent); }
        }
        return;
      }
      if (node.nodeType !== 1) return;
      const element = node as Element;
      const style = win.getComputedStyle(element);
      // visibility can be overridden by descendants, unlike display:none.
      if (style.display === 'none') return;
      const reflection = style.getPropertyValue?.('-webkit-box-reflect');
      const effect = ancestorEffect || style.filter !== 'none' || style.textShadow !== 'none' || (!!reflection && reflection !== 'none');
      effects.set(element, effect);
      const bounds = rectangle(element.getBoundingClientRect());
      geometry.push(bounds.x, bounds.y, bounds.width, bounds.height, element.scrollLeft, element.scrollTop);
      let owner = inherited;
      if (!owner && (element.matches(CONTROLS) || element.matches(maskSelector) || element.matches(blockSelector) || (images && (element.matches('img,svg,image') || hasImage(style) || /(?:url|image-set)\(/i.test(style.content))))) owner = element;
      if (owner) {
        privateElements.set(element, owner); add(bounds, owner);
        // Filters and text shadows may paint beyond every DOM/Range rectangle.
        coverEffects(element, owner);
      }
      for (const pseudo of ['::before', '::after']) {
        const generated = win.getComputedStyle(element, pseudo);
        // Pseudo-elements have no DOM bounds. Cover the viewport rather than guess where their content paints.
        if (generated.display !== 'none' && ((generated.content && !['none', 'normal', '""', "''"].includes(generated.content)) || images && hasImage(generated))) { add(whole, element); privateElements.set(element, element); }
      }
      // Browser internals of form controls are covered by their host mask. A closed root the watch never saw cannot
      // be inspected: without the watch any custom element lacking an open root may hold one, and with it one
      // upgraded before the watch began. Either masks the viewport, including any overflowing content.
      const shadow = roots ? roots.of(element) : element.shadowRoot;
      if (!shadow && element.tagName.includes('-') && (!roots || roots.unseen(element))) {
        owner = owner ?? element; privateElements.set(element, owner); add(whole, owner);
      }
      for (const child of Array.from(element.childNodes)) walk(child, owner, effect);
      if (owner && element.tagName.toLowerCase() === 'slot') {
        // Assigned nodes paint inside a slot's shadow ancestry, including its masks and overflow.
        for (const child of (element as HTMLSlotElement).assignedNodes({ flatten: true })) walk(child, owner, effect);
      }
      if (shadow) {
        observeRoot?.(shadow);
        for (const child of Array.from(shadow.childNodes)) walk(child, owner, effect);
      }
    }
    walk(doc.documentElement);
    // Rich text may split a configured sensitive word across multiple spans/text nodes.
    if (needles.length) {
      const joined = textNodes.map((part) => part.text).join('');
      for (const needle of needles) {
        let at = joined.indexOf(needle), matches = 0;
        while (at >= 0) {
          if (++matches > MAX_RECTS) throw new Error('Too many sensitive text matches');
          for (const part of textNodes) if (part.start < at + needle.length && part.end > at) {
            const parent = part.node.parentElement;
            if (parent) { privateElements.set(parent, parent); textRects(part.node, parent); }
          }
          at = joined.indexOf(needle, at + needle.length);
        }
      }
    }
    const revision = `${epoch.toString(36)}:${hash(JSON.stringify([geometry, rects]))}`;
    return { width, height, rects, privateAreas, privateElements, revision };
  } catch { return null; }
}

export function privateArea(screen: InspectedScreen, element: Element | null, x: number, y: number): ScreenRect | undefined {
  if (element) {
    const owner = screen.privateElements.get(element);
    if (owner && screen.privateAreas.has(owner)) return screen.privateAreas.get(owner);
  }
  return Array.from(screen.privateAreas.values()).find((rect) => x >= rect.x && y >= rect.y && x <= rect.x + rect.width && y <= rect.y + rect.height);
}

/** The name comes only from visible text; aria-label and other attributes may contain masked values. */
export function visibleLabel(element: Element, screen: InspectedScreen): string {
  let output = '', count = 0;
  function walk(node: Node) {
    if (++count > 1000 || output.length >= 160) return;
    if (node.nodeType === 3) {
      const range = node.ownerDocument!.createRange(); range.selectNodeContents(node);
      try {
        if (Array.from(range.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0 && rect.x + rect.width > 0 && rect.y + rect.height > 0 && rect.x < screen.width && rect.y < screen.height)) output += node.textContent ?? '';
      } finally { range.detach(); }
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (screen.privateElements.has(el)) return;
    const style = el.ownerDocument.defaultView!.getComputedStyle(el);
    if (style.display === 'none' || style.visibility !== 'visible' || style.opacity === '0' || style.clipPath && style.clipPath !== 'none' || style.clip && style.clip !== 'auto') return;
    for (const child of Array.from(el.childNodes)) walk(child);
    if (el.shadowRoot) for (const child of Array.from(el.shadowRoot.childNodes)) walk(child);
  }
  walk(element);
  return output.replace(/\s+/g, ' ').trim().slice(0, 160);
}
