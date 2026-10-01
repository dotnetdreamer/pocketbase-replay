import rrwebPlayer from 'rrweb-player';
import 'rrweb-player/dist/style.css';
import './style.css';
import { dayBound, IDLE_KEPT_MS, recordedAt, recoverEvents, shortenIdle, type IdlePeriod, type StoredChunk } from './decode';
import { keepPlaying } from './player';

interface Session {
  sessionId: string; accountId: string; deviceId: string; platform: string; appVersion: string;
  rooms: string[]; startedAt: number; compressedBytes: number; chunkCount: number;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const form = (id: string) => $(id) as HTMLFormElement;
const field = (id: string, name: string) => form(id).elements.namedItem(name) as HTMLInputElement;
let token = '';
let filters = new URLSearchParams();
let page = 0;
let totalPages = 1;
let totalItems = 0;
let listGeneration = 0;
let loadingList = -1;
const listed = new Set<string>();
let player: rrwebPlayer | undefined;
let playbackGeneration = 0;
let watching = '';
let idle: IdlePeriod[] = [];
let recordingGaps = 0;
let playbackErrors = 0;
let clockText = '';
try { token = sessionStorage.getItem('pocketbase-replay-admin') ?? ''; } catch { /* Memory-only login. */ }

function status(message: string, error = false): void {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}

let toastTimer = 0;
function toast(message: string): void {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { $('toast').hidden = true; }, 3000);
}

// Whatever a proxy put in front of /dash/replay, e.g. '/replay'; empty when served at the root.
const base = location.pathname.replace(/\/dash\/replay\/?$/, '');

async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<any> {
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || `Request failed (${response.status})`);
  return data;
}

function markWatching(): void {
  for (const item of $('sessions').children) {
    const current = (item as HTMLElement).dataset.session === watching;
    item.classList.toggle('watching', current);
    const open = item.querySelector('.session-open');
    if (current) open?.setAttribute('aria-current', 'true'); else open?.removeAttribute('aria-current');
  }
}

function closePlayer(): void {
  playbackGeneration++;
  watching = '';
  player?.$destroy();
  player = undefined;
  $('player').replaceChildren();
  $('recording').hidden = true;
  $('no-recording').hidden = false;
  markWatching();
}

function resetList(): void {
  listGeneration++;
  page = 0;
  totalPages = 1;
  totalItems = 0;
  listed.clear();
  $('sessions').replaceChildren();
  listState();
}

function signOut(): void {
  token = '';
  try { sessionStorage.removeItem('pocketbase-replay-admin'); } catch { /* Memory-only login. */ }
  closePlayer();
  resetList();
  $('dashboard').hidden = true;
  $('logout').hidden = true;
  $('open-settings').hidden = true;
  $<HTMLDialogElement>('settings-dialog').close();
  $<HTMLDialogElement>('erase-dialog').close();
  $('login').hidden = false;
}

async function loadSettings(): Promise<void> {
  const settings = await request('/api/replay/settings');
  for (const key of ['mode', 'percentage', 'retention_days']) field('settings', key).value = String(settings[key]);
  field('settings', 'daily_limit_mb').value = String(settings.daily_limit_mb ?? 1024);
  field('settings', 'account_ids').value = settings.account_ids.join('\n');
  // An older server has no selector settings.
  for (const key of ['mask_selector', 'block_selector']) field('settings', key).value = typeof settings[key] === 'string' ? settings[key] : '';
  field('settings', 'record_images').checked = settings.record_images === true;
  showModeFields();
}

// Only the field for the chosen mode is shown; the other keeps its value.
function showModeFields(): void {
  const mode = field('settings', 'mode').value;
  form('settings').querySelectorAll<HTMLElement>('[data-mode]').forEach((label) => { label.hidden = label.dataset.mode !== mode; });
}

function selectors(name: string, label: string): string {
  const value = field('settings', name).value.trim();
  try {
    if (value) document.createElement('div').matches(value);
  } catch {
    throw new Error(`${label}: this browser cannot read these CSS selectors. Nothing was saved`);
  }
  return value;
}

function line(main: string, aside: string): HTMLSpanElement {
  const row = document.createElement('span');
  const text = document.createElement('span');
  const small = document.createElement('small');
  text.textContent = main;
  small.textContent = aside;
  row.append(text, small);
  return row;
}

function sessionItem(session: Session): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'session';
  item.dataset.session = session.sessionId;
  const who = session.accountId || 'Guest';
  const started = new Date(session.startedAt).toLocaleString();
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'session-open';
  open.disabled = session.chunkCount === 0;
  open.append(
    line(who, started),
    line(session.deviceId, session.chunkCount ? `${(session.compressedBytes / 1024).toFixed(1)} KB` : 'No recording data'),
    line([session.platform, session.appVersion].filter(Boolean).join(' '), session.rooms.join(', ') || 'No room'),
  );
  open.addEventListener('click', () => run(() => watch(session.sessionId)));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger';
  remove.textContent = 'Delete';
  remove.setAttribute('aria-label', `Delete the recording of ${who} from ${started}`);
  remove.addEventListener('click', () => run(() => removeSession(session, item)));
  item.append(open, remove);
  return item;
}

function listState(): void {
  const loading = loadingList === listGeneration;
  const more = page < totalPages;
  $('sessions-state').textContent = loading ? 'Loading sessions...'
    : !page ? '' : !totalItems ? 'No sessions match these filters' : more ? '' : 'No more sessions';
  $('load-more').hidden = loading || !page || !more;
  $('session-count').textContent = !page ? ''
    : `${totalItems} session${totalItems === 1 ? '' : 's'}${more ? `, ${listed.size} loaded` : ''}`;
}

function nearListEnd(): boolean {
  const box = $('session-scroll');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 300;
}

async function loadPage(number: number, generation: number): Promise<void> {
  const query = new URLSearchParams(filters);
  query.set('page', String(number));
  const result = await request(`/api/replay/sessions?${query}`);
  if (generation !== listGeneration) return;
  page = Math.max(page, number);
  totalPages = Math.max(1, result.totalPages);
  totalItems = result.totalItems;
  for (const session of result.items as Session[]) {
    // A session started since the first page pushes the others down, so one can come round again.
    if (listed.has(session.sessionId)) continue;
    listed.add(session.sessionId);
    $('sessions').append(sessionItem(session));
  }
  markWatching();
}

// The list loads the server's 30-session pages one at a time as it is scrolled.
async function loadMore(): Promise<void> {
  const generation = listGeneration;
  if (loadingList === generation || page >= totalPages) return;
  loadingList = generation;
  listState();
  try {
    await loadPage(page + 1, generation);
  } finally {
    if (loadingList === generation) loadingList = -1;
    if (generation === listGeneration) listState();
  }
  // A page that does not fill the list leaves the end in view, which the observer does not report again.
  if (generation === listGeneration && nearListEnd()) await loadMore();
}

async function search(): Promise<void> {
  const query = new URLSearchParams();
  for (const key of ['account', 'device', 'room', 'from', 'to']) {
    const value = field('filters', key).value.trim();
    if (!value) continue;
    query.set(key, key === 'from' || key === 'to' ? String(dayBound(value, key === 'to')) : value);
  }
  filters = query;
  resetList();
  $('session-scroll').scrollTop = 0;
  await loadMore();
}

async function removeSession(session: Session, item: HTMLElement): Promise<void> {
  const who = session.accountId || 'Guest';
  if (!confirm(`Delete the recording of ${who} from ${new Date(session.startedAt).toLocaleString()}? This cannot be undone.`)) return;
  await request(`/api/replay/sessions/${encodeURIComponent(session.sessionId)}`, undefined, 'DELETE');
  if (watching === session.sessionId) closePlayer();
  item.remove();
  listed.delete(session.sessionId);
  totalItems = Math.max(0, totalItems - 1);
  listState();
  status('Recording deleted');
  // Later sessions moved up one place, so the last loaded page now ends with one not shown yet.
  if (page) await loadPage(page, listGeneration);
  listState();
}

// The server deletes 200 sessions per call and reports what is left.
// Deleting every recording cannot be undone, so the account ID has to be typed again.
function confirmErase(account: string): Promise<boolean> {
  const dialog = $<HTMLDialogElement>('erase-dialog');
  const input = field('erase-confirm', 'confirm_account');
  $('erase-text').textContent = `Every recording of account ${account} will be deleted. This cannot be undone.`;
  input.value = '';
  input.oninput = () => { $<HTMLButtonElement>('erase-go').disabled = input.value.trim() !== account; };
  $<HTMLButtonElement>('erase-go').disabled = true;
  dialog.returnValue = '';
  dialog.showModal();
  input.focus();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'delete'), { once: true }));
}

async function eraseAccountRecordings(): Promise<void> {
  const account = field('filters', 'account').value.trim();
  if (!account) { status('Enter an account ID in the Account filter first', true); return; }
  if (!await confirmErase(account)) return;
  let deleted = 0;
  for (let batch = 0; batch < 100; batch++) {
    const result = await request(`/api/replay/accounts/${encodeURIComponent(account)}`, undefined, 'DELETE');
    deleted += result.deletedSessions;
    if (result.remainingSessions === 0) break;
  }
  closePlayer();
  await search();
  status(`Deleted ${deleted} recording(s) of account ${account}`);
}

function duration(ms: number): string {
  if (ms < 59_500) return `${Math.round(ms / 1000)} s`;
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function notes(): void {
  $('gaps').textContent = [
    recordingGaps ? `${recordingGaps} recording gap(s). Playback resumes at the next complete screen snapshot` : '',
    playbackErrors ? `${playbackErrors} screen change(s) could not be replayed and were skipped` : '',
  ].filter(Boolean).join('. ');
}

function playbackError(error: unknown): void {
  if (++playbackErrors <= 3) console.warn('Replay: skipped an event the player could not apply', error);
  notes();
}

function showClock(timestamp: number): void {
  const text = `Recorded at ${new Date(recordedAt(idle, timestamp)).toLocaleTimeString()}`;
  if (text === clockText) return;
  clockText = text;
  $('clock').textContent = text;
}

// A wide screen's panel gives the player its space; stacked, it gets the window below the recording's
// details. rrweb's controls take 80 px of it, the clock line most of the rest.
function playerSize(): { width: number; height: number } {
  const box = $('player');
  const above = box.getBoundingClientRect().top - $('viewer').getBoundingClientRect().top;
  const height = stacked() ? Math.min(720, window.innerHeight - above - 130) : box.clientHeight - 80;
  return { width: Math.max(240, box.clientWidth), height: Math.max(240, height) };
}

function stacked(): boolean {
  return window.matchMedia('(max-width: 900px)').matches;
}

async function watch(sessionId: string): Promise<void> {
  closePlayer();
  watching = sessionId;
  markWatching();
  const generation = playbackGeneration;
  status('Loading recording...');
  const chunks: StoredChunk[] = [];
  let session: any;
  for (let part = 1; ; part++) {
    const data = await request(`/api/replay/sessions/${encodeURIComponent(sessionId)}/chunks?page=${part}`);
    if (generation !== playbackGeneration) return;
    chunks.push(...data.items);
    session = data.session;
    if (chunks.reduce((sum, chunk) => sum + chunk.rawBytes, 0) > 96 * 1024 * 1024) {
      throw new Error('Recording exceeds the playback memory limit');
    }
    if (part >= data.totalPages) break;
  }
  const recovered = recoverEvents(chunks);
  const shortened = shortenIdle(recovered.events);
  idle = shortened.idle;
  recordingGaps = recovered.gaps;
  playbackErrors = 0;
  clockText = '';
  $('no-recording').hidden = true;
  $('recording').hidden = false;
  $('recording-title').textContent = `${session.accountId || 'Guest'} · ${session.deviceId}`;
  $('recording-info').textContent = `${session.platform} · ${session.appVersion} · ${new Date(session.startedAt).toLocaleString()} · Canvas content is not recorded`;
  notes();
  const quiet = idle.reduce((sum, period) => sum + period.to - period.from, 0);
  $('idle').textContent = idle.length
    ? `${duration(quiet)} with nothing recorded, such as time in the background, is shortened to ${IDLE_KEPT_MS / 1000} s per stretch. Marks on the timeline show where`
    : '';
  $('clock').textContent = '';
  const marks = idle.map((period) => ({
    type: 5, timestamp: Math.round((period.start + period.end) / 2),
    data: { tag: `${period.background ? 'Recording paused' : 'Nothing recorded'} for ${duration(period.to - period.from)}`, payload: {} },
  }));
  player = new rrwebPlayer({
    target: $('player'),
    props: {
      events: [...shortened.events, ...marks] as any,
      ...playerSize(),
      autoPlay: false, skipInactive: false, showWarning: false, showDebug: false,
      UNSAFE_replayCanvas: false,
      tags: Object.fromEntries(marks.map((mark) => [mark.data.tag, '#ffc38a'])),
    },
  });
  keepPlaying(player.getReplayer(), (error) => { if (generation === playbackGeneration) playbackError(error); });
  const start = shortened.events[0].timestamp;
  player.addEventListener('ui-update-current-time', (value) => {
    if (generation === playbackGeneration) showClock(start + (value as { payload: number }).payload);
  });
  player.play();
  if (stacked()) $('viewer').scrollIntoView({ block: 'start' });
  status('Recording loaded');
}

async function open(): Promise<void> {
  await loadSettings();
  $('login').hidden = true;
  $('dashboard').hidden = false;
  $('logout').hidden = false;
  $('open-settings').hidden = false;
  await search();
  status('');
}

function run(action: () => Promise<void>): void {
  void action().catch((error: unknown) => status(error instanceof Error ? error.message : 'Request failed', true));
}

form('login').addEventListener('submit', (event) => {
  event.preventDefault();
  run(async () => {
    const result = await request('/api/collections/_superusers/auth-with-password', {
      identity: field('login', 'email').value, password: field('login', 'password').value,
    });
    token = result.token;
    field('login', 'password').value = '';
    try { sessionStorage.setItem('pocketbase-replay-admin', token); } catch { /* Memory-only login. */ }
    await open();
  });
});
$('open-settings').addEventListener('click', () => run(async () => {
  await loadSettings();
  $('settings-error').textContent = '';
  $<HTMLDialogElement>('settings-dialog').showModal();
}));
$('close-settings').addEventListener('click', () => $<HTMLDialogElement>('settings-dialog').close());
field('settings', 'mode').addEventListener('change', showModeFields);
$('erase-cancel').addEventListener('click', () => $<HTMLDialogElement>('erase-dialog').close());
form('settings').addEventListener('submit', (event) => {
  event.preventDefault();
  $('settings-error').textContent = '';
  // The page status sits behind the modal, so errors are shown in the dialog.
  void (async () => {
    // Built first, so a bad selector is reported before anything is asked.
    const settings = {
      mode: field('settings', 'mode').value,
      percentage: Number(field('settings', 'percentage').value),
      account_ids: field('settings', 'account_ids').value.split(/[\s,]+/).filter(Boolean),
      retention_days: Number(field('settings', 'retention_days').value),
      daily_limit_mb: Number(field('settings', 'daily_limit_mb').value),
      mask_selector: selectors('mask_selector', 'Mask text in'),
      block_selector: selectors('block_selector', 'Block elements'),
      record_images: field('settings', 'record_images').checked,
    };
    if (!confirm('Save these recording settings? Open apps pick them up within a minute.')) return;
    await request('/api/replay/settings', settings);
    await loadSettings();
    $<HTMLDialogElement>('settings-dialog').close();
    toast('Settings saved');
  })().catch((error: unknown) => { $('settings-error').textContent = error instanceof Error ? error.message : 'Request failed'; });
});
form('filters').addEventListener('submit', (event) => { event.preventDefault(); run(search); });
$('erase-account').addEventListener('click', () => run(eraseAccountRecordings));
$('load-more').addEventListener('click', () => run(loadMore));
new IntersectionObserver((entries) => {
  if (entries.some((entry) => entry.isIntersecting)) run(loadMore);
}, { root: $('session-scroll'), rootMargin: '0px 0px 300px 0px' }).observe($('sessions-end'));
$('close-recording').addEventListener('click', closePlayer);
$('logout').addEventListener('click', () => { signOut(); status('Signed out'); });
// The space changes with the window and with notes that appear during playback.
let resizeTimer = 0;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (!player) return;
    player.$set(playerSize());
    player.triggerResize();
  }, 100);
}).observe($('player'));
window.addEventListener('pagehide', closePlayer);
if (token) void open().catch(() => { signOut(); status('Sign in again to view recordings'); });
