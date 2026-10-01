import type { AutomaticCapture, LogLevel, ObservabilityOptions } from './observability-types';

interface Observer { listener: (capture: AutomaticCapture) => void; errors: boolean; levels: Set<LogLevel> }
interface ConsolePatch {
  owner: Console;
  method: 'debug' | 'info' | 'log' | 'warn' | 'error';
  original: (...args: unknown[]) => void;
  wrapper: (...args: unknown[]) => void;
  deactivate: () => void;
}
const observers = new Set<Observer>();
let patches: ConsolePatch[] = [], removeErrors: (() => void) | undefined;
let emitting = false;

function emit(capture: AutomaticCapture): void {
  if (emitting) return;
  emitting = true;
  try {
    for (const observer of observers) {
      if (capture.kind === 'error' ? !observer.errors : !observer.levels.has(capture.level)) continue;
      try { observer.listener(capture); } catch { /* Observers must not reach the app. */ }
    }
  } finally { emitting = false; }
}
function installErrors(): void {
  if (removeErrors || typeof window === 'undefined' || !Array.from(observers).some((observer) => observer.errors)) return;
  const targetWindow = window;
  const error = (event: ErrorEvent) => {
    try {
      const exception = event.error ?? { name: 'Error', message: event.message || 'Unhandled error',
        stack: event.filename ? `at ${event.filename}:${event.lineno}:${event.colno}` : '' };
      emit({ kind: 'error', error: exception, context: { handled: false } });
    } catch { /* An unreadable event is ignored. */ }
  };
  const rejection = (event: PromiseRejectionEvent) => {
    try { emit({ kind: 'error', error: event.reason, context: { handled: false } }); } catch { /* An unreadable event is ignored. */ }
  };
  const remove = () => {
    try { targetWindow.removeEventListener('error', error); } catch { /* Cleanup must not reach the app. */ }
    try { targetWindow.removeEventListener('unhandledrejection', rejection); } catch { /* Cleanup must not reach the app. */ }
  };
  try {
    targetWindow.addEventListener('error', error);
    targetWindow.addEventListener('unhandledrejection', rejection);
    removeErrors = remove;
  } catch { remove(); }
}
function installConsole(): void {
  if (patches.length || typeof console === 'undefined' || !Array.from(observers).some((observer) => observer.levels.size)) return;
  for (const method of ['debug', 'info', 'log', 'warn', 'error'] as const) {
    try {
      const original = console[method];
      if (typeof original !== 'function') continue;
      const owner = console;
      let active = true;
      const wrapper = function (this: unknown, ...args: unknown[]) {
        original.apply(this, args);
        if (active) emit({ kind: 'log', level: method === 'log' ? 'info' : method, arguments: args });
      };
      console[method] = wrapper;
      patches.push({ owner, method, original, wrapper, deactivate: () => { active = false; } });
    } catch { /* A frozen console is left alone. */ }
  }
}

export function subscribeCapture(listener: (capture: AutomaticCapture) => void, options: ObservabilityOptions): () => void {
  const errors = typeof options.errors === 'object' && options.errors.captureUnhandled === true;
  const captureConsole = typeof options.logs === 'object' ? options.logs.captureConsole : false;
  const levels = new Set<LogLevel>(Array.isArray(captureConsole) ? captureConsole : captureConsole === true
    ? ['debug', 'info', 'warn', 'error'] : []);
  const observer = { listener, errors, levels };
  observers.add(observer);
  installErrors(); installConsole();
  return () => {
    observers.delete(observer);
    if (!Array.from(observers).some((value) => value.errors)) { try { removeErrors?.(); } finally { removeErrors = undefined; } }
    if (!Array.from(observers).some((value) => value.levels.size)) {
      for (const patch of patches) {
        patch.deactivate();
        try { if (patch.owner[patch.method] === patch.wrapper) patch.owner[patch.method] = patch.original; } catch { /* A frozen console is left alone. */ }
      }
      patches = [];
    }
  };
}
