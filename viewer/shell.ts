import type { DashboardTab } from './links';

interface RecordingState { mode?: string; percentage?: number; account_ids?: string[]; upload_mode?: string }
interface DiagnosticsState { errors_enabled?: boolean; logs_enabled?: boolean }
type Tone = 'on' | 'off' | 'warn' | 'alert';
type Link = 'in' | 'retry' | 'lost' | 'offline';

export interface Shell {
  signedIn(value: boolean): void;
  // Whether a request got any answer from the server, an error included.
  reachable(answered: boolean): void;
  recording(settings: RecordingState): void;
  diagnostics(settings: DiagnosticsState): void;
  view(tab: DashboardTab): void;
  alerts(unread: number): void;
}

const VIEWS: Record<DashboardTab, string> = { sessions: 'Sessions', issues: 'Issues', logs: 'Logs' };
const SHORTCUTS: Record<string, DashboardTab> = { 1: 'sessions', 2: 'issues', 3: 'logs' };
const LINKS: Record<Link, string> = { in: 'Connected', retry: 'Reconnecting', lost: 'Server unreachable', offline: 'Offline' };

// Plays a CSS animation again, as when the same element shows a new message.
function replay(element: HTMLElement, name: string, on: boolean): void {
  element.classList.remove(name);
  void element.offsetWidth;
  if (on) element.classList.add(name);
}

// The frame around the dashboard: what is being recorded, the status bar and its clock, keyboard shortcuts, and the
// light that follows the pointer over list rows. A page cached from before these existed lacks their elements, so
// each is left out on its own and the dashboard still starts. probe sends any request, to learn whether the server
// answers.
export function installShell(openRecording: () => void, probe: () => Promise<unknown>): Shell {
  const $ = (id: string) => document.getElementById(id);
  const pill = $('live-pill') as HTMLButtonElement | null;
  let signed = false;
  // Connected only while the last request was answered, rather than whenever someone is signed in.
  let link: Link = 'in';
  let answeredAt = 0;

  function connection(): void {
    const state = $('sb-state');
    if (!state) return;
    state.dataset.state = signed ? link : 'out';
    state.textContent = signed ? LINKS[link] : 'Signed out';
    state.title = signed && answeredAt ? `The server last answered at ${new Date(answeredAt).toLocaleTimeString()}` : '';
  }

  // The browser only guesses at the network, and a server on this computer answers even offline, so the server is
  // asked whenever the guess changes.
  function recheck(): void {
    link = navigator.onLine ? 'retry' : 'offline';
    connection();
    if (signed) void probe().catch(() => { /* The request has reported what happened. */ });
  }
  window.addEventListener('online', recheck);
  window.addEventListener('offline', recheck);

  function item(id: string, text: string, tone?: Tone): void {
    const element = $(id);
    if (!element) return;
    element.textContent = text;
    if (tone) element.dataset.tone = tone; else delete element.dataset.tone;
    element.hidden = !signed || !text;
  }

  function setPill(state: string, text: string, detail = '', title = ''): void {
    if (!pill) return;
    pill.dataset.state = state;
    pill.disabled = state === 'out';
    pill.title = title;
    const label = $('live-text'), more = $('live-detail');
    if (label) label.textContent = text;
    if (more) more.textContent = detail;
  }

  pill?.addEventListener('click', () => { if (signed) openRecording(); });

  const clock = $('sb-clock');
  const tick = () => { if (clock) clock.textContent = new Date().toLocaleTimeString(); };
  tick();
  if (clock) window.setInterval(tick, 1000);

  // New status lines and toasts slide in, and a toast's countdown starts over when its message changes.
  const status = $('status');
  if (status) new MutationObserver(() => replay(status, 'flash', !!status.textContent)).observe(status, { childList: true, characterData: true, subtree: true });
  const toast = $('toast');
  if (toast) {
    new MutationObserver(() => {
      toast.classList.add('restart');
      void toast.offsetWidth;
      toast.classList.remove('restart');
    }).observe(toast, { childList: true, characterData: true, subtree: true });
  }

  // / searches the open view and 1 to 3 switch views, unless a field or dialog has the keyboard.
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (!signed || document.querySelector('dialog[open]')) return;
    if ((event.target as Element | null)?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    if (event.key === '/') {
      const field = document.querySelector<HTMLInputElement>('[role="tabpanel"]:not([hidden]) form input');
      if (!field) return;
      event.preventDefault();
      field.focus();
      field.select();
    } else if (Object.prototype.hasOwnProperty.call(SHORTCUTS, event.key)) {
      const tab = $(`${SHORTCUTS[event.key]}-tab`);
      if (!tab) return;
      event.preventDefault();
      tab.click();
      // What had the keyboard may have gone with the view it was in, so the keyboard moves to the tab.
      tab.focus();
    }
  });

  // Rows light up where the pointer is; one frame's move at a time.
  let lit: HTMLElement | null = null;
  let moved: PointerEvent | undefined;
  let frame = 0;
  document.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse') return;
    moved = event;
    if (!frame) frame = requestAnimationFrame(light);
  }, { passive: true });
  function light(): void {
    frame = 0;
    if (!moved) return;
    const row = (moved.target as Element | null)?.closest?.<HTMLElement>('.session, .telemetry-row') ?? null;
    if (row !== lit) {
      lit?.style.removeProperty('--mx');
      lit?.style.removeProperty('--my');
      lit = row;
    }
    if (!row) return;
    const box = row.getBoundingClientRect();
    row.style.setProperty('--mx', `${moved.clientX - box.left}px`);
    row.style.setProperty('--my', `${moved.clientY - box.top}px`);
  }

  return {
    signedIn(value) {
      signed = value;
      connection();
      for (const id of ['sb-view', 'sb-recording', 'sb-diagnostics', 'sb-alerts']) {
        const element = $(id);
        if (element) element.hidden = !value || !element.textContent;
      }
      const keys = $('sb-keys');
      if (keys) keys.hidden = !value;
      if (!value) setPill('out', 'Signed out');
    },
    reachable(answered) {
      if (answered) answeredAt = Date.now();
      link = answered ? 'in' : navigator.onLine ? 'lost' : 'offline';
      connection();
    },
    recording(settings) {
      const on = settings.mode === 'percentage' || settings.mode === 'accounts';
      const accounts = settings.account_ids?.length ?? 0;
      const scope = settings.mode === 'percentage' ? `${settings.percentage ?? 0}%` : `${accounts} account${accounts === 1 ? '' : 's'}`;
      const trigger = on && settings.upload_mode === 'trigger';
      if (!on) setPill('off', 'Recording off', '', 'Nobody is recorded. Open Recording settings');
      else {
        const who = settings.mode === 'percentage' ? `${scope} of devices` : scope;
        setPill(trigger ? 'trigger' : 'on', 'Recording', trigger ? `${scope} · on trigger` : scope,
          `Records ${who}${trigger ? ', uploading only when something breaks' : ''}. Open Recording settings`);
      }
      item('sb-recording', on ? `Rec ${scope}${trigger ? ' · trigger' : ''}` : 'Rec off', on ? (trigger ? 'warn' : 'on') : 'off');
    },
    diagnostics(settings) {
      const errors = settings.errors_enabled === true, logs = settings.logs_enabled === true;
      item('sb-diagnostics', `Errors ${errors ? 'on' : 'off'} · Logs ${logs ? 'on' : 'off'}`, errors && logs ? 'on' : errors || logs ? 'warn' : 'off');
    },
    view(tab) {
      item('sb-view', VIEWS[tab]);
    },
    alerts(unread) {
      item('sb-alerts', unread ? `${unread} unread alert${unread === 1 ? '' : 's'}` : 'No unread alerts', unread ? 'alert' : 'off');
    },
  };
}
