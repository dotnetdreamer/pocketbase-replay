import type { ReplayEvent } from './types';

const URL_ATTRIBUTES = /^(?:href|src|action|formaction|poster|xlink:href)$/i;
const PRIVATE_ATTRIBUTES = /(?:password|secret|token|authorization|cookie|email|phone)/i;
const SAFE_DATA_ATTRIBUTES = /^(?:data-state|data-side|data-align|data-orientation|data-disabled|data-replay-block|data-replay-mask)$/;
const STATIC_ASSET = /^\/(?:assets|fonts|icons)\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:avif|gif|ico|jpe?g|png|svg|webp|woff2?|ttf|otf)$/i;

const PACKAGED_ORIGINS = ['https://localhost', 'capacitor://localhost', 'capacitor-electron://-'];
const ASSET_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export interface ReplayAssetOptions { assetBaseUrl?: string; assetOrigin?: string }

let originSeen: string | undefined;
let originPackaged = false;

function packagedOrigin(value: string): boolean {
  if (value === originSeen) return originPackaged;
  let origin = value;
  // An opaque origin arrives as the page URL; its scheme and host still name the app.
  if (PACKAGED_ORIGINS.indexOf(origin) < 0) {
    try { const url = new URL(value); origin = `${url.protocol}//${url.host}`; } catch { origin = ''; }
  }
  originSeen = value;
  originPackaged = PACKAGED_ORIGINS.indexOf(origin) >= 0;
  return originPackaged;
}

// Other computers cannot load a packaged app's local files, so they come from the archive for this build.
export function packagedAssetBase(endpoint: string, assetOrigin: string | undefined, appVersion: string | undefined): string | undefined {
  if (!endpoint || !assetOrigin || !appVersion || !ASSET_VERSION.test(appVersion) || !packagedOrigin(assetOrigin)) return undefined;
  return `${endpoint}/replay-assets/${appVersion}/`;
}

export function cleanUrl(value: string, assets: ReplayAssetOptions = {}): string {
  value = value.trim();
  if (/^#[A-Za-z0-9_:.-]+$/.test(value)) return value;
  if (/^(?:data:|blob:|javascript:)/i.test(value)) return '';
  const noQuery = value.split(/[?#]/, 1)[0];
  const cleaned = noQuery.replace(/(https?:\/\/)[^/@]+@/gi, '$1').replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, '[masked]');
  if (assets.assetBaseUrl && assets.assetOrigin) {
    try {
      const origin = new URL(assets.assetOrigin);
      const source = new URL(cleaned, origin);
      const base = new URL(cleanUrl(assets.assetBaseUrl));
      if (source.protocol === origin.protocol && source.host === origin.host &&
          STATIC_ASSET.test(source.pathname) && /^https?:$/.test(base.protocol)) {
        base.pathname = base.pathname.replace(/\/?$/, '/');
        return cleanUrl(new URL(source.pathname.slice(1), base).href);
      }
    } catch { /* An invalid asset mapping leaves the sanitized URL unchanged. */ }
  }
  return cleaned;
}

function cleanCss(value: string, assets: ReplayAssetOptions): string {
  return value
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_match, _quote: string, url: string) => `url("${cleanUrl(url, assets)}")`)
    .replace(/(@import\s+)(['"])(.*?)\2/gi, (_match, prefix: string, quote: string, url: string) => `${prefix}${quote}${cleanUrl(url, assets)}${quote}`);
}

function cleanStyle(value: Record<string, unknown>, assets: ReplayAssetOptions): void {
  for (const property of Object.keys(value)) {
    const declaration = value[property];
    if (typeof declaration === 'string') value[property] = cleanCss(declaration, assets);
    else if (Array.isArray(declaration) && typeof declaration[0] === 'string') declaration[0] = cleanCss(declaration[0], assets);
  }
}

function cleanAttributes(attributes: Record<string, unknown>, assets: ReplayAssetOptions, tagName?: string): void {
  for (const key of Object.keys(attributes)) {
    const value = attributes[key];
    if (PRIVATE_ATTRIBUTES.test(key) || /^on/i.test(key) ||
        (key.startsWith('data-') && !SAFE_DATA_ATTRIBUTES.test(key)) ||
        key === 'srcdoc' || key === 'srcset' || key === 'nonce' || key === 'title' || key === 'alt' || key === 'aria-label' ||
        (tagName === 'meta' && key === 'content')) {
      delete attributes[key];
    } else if (key === 'value') {
      attributes[key] = value == null ? value : '*';
    } else if (typeof value === 'string' && URL_ATTRIBUTES.test(key)) {
      attributes[key] = cleanUrl(value, assets);
    } else if (typeof value === 'string' && (key === 'style' || key === '_cssText')) {
      attributes[key] = cleanCss(value, assets);
    } else if (key === 'style' && value && typeof value === 'object' && !Array.isArray(value)) {
      cleanStyle(value as Record<string, unknown>, assets);
    }
  }
}

let privateKey: string | undefined;
let privateCopy: string[] | undefined;
let privateAny: RegExp | null = null;
let privatePatterns: RegExp[] = [];

function usePrivateText(sensitiveText: string[]): void {
  // Compared by value: a host may change its array in place.
  const last = privateCopy;
  if (last && sensitiveText.length === last.length && sensitiveText.every((value, index) => value === last[index])) return;
  privateCopy = sensitiveText.slice();
  const values = sensitiveText.filter((value) => typeof value === 'string' && value.length >= 2);
  const key = JSON.stringify(values);
  if (key === privateKey) return;
  const escaped = values.sort((left, right) => right.length - left.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  privateAny = escaped.length ? new RegExp(escaped.join('|'), 'i') : null;
  privatePatterns = escaped.map((value) => new RegExp(value, 'gi'));
  privateKey = key;
}

function mask(value: string): string {
  // The alternation only detects a hit: replacing with it would mask overlapping names differently.
  if (!privateAny || !privateAny.test(value)) return value;
  for (const pattern of privatePatterns) value = value.replace(pattern, '*');
  return value;
}

export function serializeEvent(event: ReplayEvent, sensitiveText: string[] = [], assets: ReplayAssetOptions = {}): string {
  usePrivateText(sensitiveText);
  // rrweb owns the DOM; this pass only changes its detached event objects.
  const cssEvent = event.type === 3 && typeof event.data.source === 'number' && [8, 13, 15].includes(event.data.source);
  const stack: { item: unknown; css: boolean }[] = [{ item: event, css: cssEvent }];
  while (stack.length) {
    const { item, css } = stack.pop()!;
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item)) {
      for (const child of item) stack.push({ item: child, css });
      continue;
    }
    const object = item as Record<string, unknown>;
    if (object.attributes && !Array.isArray(object.attributes)) {
      cleanAttributes(object.attributes as Record<string, unknown>, assets, String(object.tagName ?? ''));
    }
    for (const key of Object.keys(object)) {
      if (key === 'href' && typeof object[key] === 'string') object[key] = cleanUrl(object[key] as string, assets);
      else if ((key === 'cssText' || (css && (key === 'rule' || key === 'replace' || key === 'replaceSync'))) && typeof object[key] === 'string') object[key] = cleanCss(object[key] as string, assets);
      else if ((key === 'textContent' || key === 'text' || key === 'value') && typeof object[key] === 'string') {
        object[key] = css ? cleanCss(object[key] as string, assets) : mask(object[key] as string);
      } else if (key !== 'attributes' || Array.isArray(object[key])) {
        stack.push({ item: object[key], css: css || object.tagName === 'style' });
      }
    }
  }
  if (event.type === 3 && event.data.source === 5) event.data.text = '*';
  return JSON.stringify(event);
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}
