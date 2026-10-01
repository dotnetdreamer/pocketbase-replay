import type { ObservabilityAttributes } from './observability-types';

const PRIVATE_KEY = /password|passwd|secret|token|authorization|cookie|email|phone|credit.?card|api.?key/i;
const MAX_STRING = 2000;

export function redactText(value: string, sensitiveText: string[] = [], limit = MAX_STRING): string {
  value = value.slice(0, Math.max(limit * 2, 8000));
  value = value.replace(/(?:https?|wss?):\/\/[^\s<>"')]+/gi, (match) => {
    try {
      const url = new URL(match);
      url.username = ''; url.password = ''; url.search = ''; url.hash = '';
      return url.toString();
    } catch { return '[redacted URL]'; }
  });
  value = value.replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted]')
    .replace(/\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,24}\b/gi, '[redacted]')
    .replace(/\b(password|passwd|secret|token|authorization|cookie|api[_-]?key)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[redacted]');
  for (const secret of sensitiveText.slice(0, 100)) {
    if (typeof secret !== 'string' || secret.length < 2) continue;
    value = value.replace(new RegExp(secret.slice(0, 2000).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[redacted]');
  }
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, limit);
}

export function redactLabel(value: string, sensitiveText: string[] = [], limit = 128): string {
  return redactText(value, sensitiveText, limit).replace(/[\x00-\x1f\x7f]/g, '');
}

export function safeValue(input: unknown, sensitiveText: string[] = []): unknown {
  const seen = new Set<object>();
  let budget = 100;
  function visit(value: unknown, depth: number): unknown {
    if (--budget < 0) return '[truncated]';
    if (typeof value === 'string') return redactText(value, sensitiveText, 1024);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value === 'bigint') return String(value).slice(0, 1024);
    if (typeof value !== 'object') return `[${typeof value}]`;
    if (seen.has(value)) return '[circular]';
    if (depth >= 4) return '[truncated]';
    seen.add(value);
    try {
      if (typeof Node !== 'undefined' && value instanceof Node) return '[DOM node]';
      if (Array.isArray(value)) {
        const descriptors = Object.getOwnPropertyDescriptors(value), output: unknown[] = [];
        for (let i = 0; i < Math.min(value.length, 20); i++) {
          const descriptor = descriptors[String(i)];
          output.push(!descriptor ? null : 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[getter]');
        }
        return output;
      }
      const output: Record<string, unknown> = Object.create(null);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const key of Object.keys(descriptors).slice(0, 20)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        const descriptor = descriptors[key];
        const cleanKey = redactLabel(key, sensitiveText, 64);
        if (!cleanKey) continue;
        output[cleanKey] = PRIVATE_KEY.test(key) ? '[redacted]'
          : 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[getter]';
      }
      return output;
    } catch { return '[unserializable]'; }
  }
  return visit(input, 0);
}

export function safeAttributes(value: unknown, sensitiveText: string[]): ObservabilityAttributes | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const output = safeValue(value, sensitiveText);
  if (!output || typeof output !== 'object' || Array.isArray(output)) return undefined;
  const attributes = output as ObservabilityAttributes;
  const encoder = new TextEncoder();
  const keys = Object.keys(attributes);
  while (encoder.encode(JSON.stringify(attributes)).byteLength > 4096 && keys.length) {
    delete attributes[keys.pop()!];
  }
  return attributes;
}

// Read the ordinary way, unlike attributes: V8 defines an error's stack as a getter, and DOMException
// its name and message, so skipping getters loses all three. A getter that throws leaves the field out.
function errorProperty(error: unknown, key: 'name' | 'message' | 'stack'): unknown {
  if (!error || typeof error !== 'object') return undefined;
  try { return (error as Record<string, unknown>)[key]; } catch { return undefined; }
}

export function describeException(error: unknown, sensitiveText: string[]): { name: string; message: string; stack?: string } {
  const rawName = errorProperty(error, 'name');
  const rawMessage = errorProperty(error, 'message');
  const rawStack = errorProperty(error, 'stack');
  return {
    name: redactLabel(typeof rawName === 'string' ? rawName : 'Error', sensitiveText, 128),
    message: redactText(typeof rawMessage === 'string' ? rawMessage : typeof error === 'string' ? error
      : JSON.stringify(safeValue(error, sensitiveText)) ?? 'Unknown error', sensitiveText),
    ...(typeof rawStack === 'string' ? { stack: redactText(rawStack, sensitiveText, 8000) } : {}),
  };
}
