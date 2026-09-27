import rrwebPlayer from 'rrweb-player';
import 'rrweb-player/dist/style.css';
import './style.css';
import { dayBound, recoverEvents, type StoredChunk } from './decode';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const form = (id: string) => $(id) as HTMLFormElement;
const field = (id: string, name: string) => form(id).elements.namedItem(name) as HTMLInputElement;
let token = '';
let page = 1;
let totalPages = 1;
let player: rrwebPlayer | undefined;
let playbackGeneration = 0;
try { token = sessionStorage.getItem('pocketbase-replay-admin') ?? ''; } catch { /* Memory-only login. */ }

function status(message: string, error = false): void {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}

async function request(path: string, body?: unknown): Promise<any> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || `Request failed (${response.status})`);
  return data;
}

function closePlayer(): void {
  playbackGeneration++;
  player?.$destroy();
  player = undefined;
  $('player').replaceChildren();
  $('recording').hidden = true;
}

function signOut(): void {
  token = '';
  try { sessionStorage.removeItem('pocketbase-replay-admin'); } catch { /* Memory-only login. */ }
  closePlayer();
  $('sessions').replaceChildren();
  $('dashboard').hidden = true;
  $('logout').hidden = true;
  $('login').hidden = false;
}

async function loadSettings(): Promise<void> {
  const settings = await request('/api/replay/settings');
  for (const key of ['mode', 'percentage', 'retention_days']) field('settings', key).value = String(settings[key]);
  field('settings', 'daily_limit_mb').value = String(settings.daily_limit_mb ?? 1024);
  field('settings', 'account_ids').value = settings.account_ids.join('\n');
  // An older server has no selector settings.
  for (const key of ['mask_selector', 'block_selector']) field('settings', key).value = typeof settings[key] === 'string' ? settings[key] : '';
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

function cell(row: HTMLTableRowElement, value: string, secondary?: string): void {
  const td = row.insertCell();
  td.textContent = value;
  if (secondary) { const small = document.createElement('small'); small.textContent = secondary; td.append(small); }
}

async function list(): Promise<void> {
  const query = new URLSearchParams({ page: String(page) });
  for (const key of ['account', 'device', 'room', 'from', 'to']) {
    const value = field('filters', key).value.trim();
    if (!value) continue;
    query.set(key, key === 'from' || key === 'to' ? String(dayBound(value, key === 'to')) : value);
  }
  const result = await request(`/api/replay/sessions?${query}`);
  totalPages = Math.max(1, result.totalPages);
  const body = $('sessions');
  body.replaceChildren();
  for (const session of result.items) {
    const row = document.createElement('tr');
    cell(row, new Date(session.startedAt).toLocaleString());
    cell(row, session.accountId || 'Guest', session.deviceId);
    cell(row, session.platform, session.appVersion);
    cell(row, session.rooms.join(', ') || 'No room');
    cell(row, `${(session.compressedBytes / 1024).toFixed(1)} KB`, `${session.chunkCount} chunks`);
    const button = document.createElement('button');
    button.textContent = 'Watch';
    button.disabled = session.chunkCount === 0;
    button.addEventListener('click', () => run(() => watch(session.sessionId)));
    row.insertCell().append(button);
    body.append(row);
  }
  if (!result.items.length) { const row = document.createElement('tr'); cell(row, 'No sessions match these filters'); body.append(row); }
  $('page').textContent = `${page} / ${totalPages}`;
  $<HTMLButtonElement>('previous').disabled = page <= 1;
  $<HTMLButtonElement>('next').disabled = page >= totalPages;
}

async function watch(sessionId: string): Promise<void> {
  closePlayer();
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
  const { events, gaps } = recoverEvents(chunks);
  $('recording').hidden = false;
  $('recording-title').textContent = `${session.accountId || 'Guest'} · ${session.deviceId}`;
  $('recording-info').textContent = `${session.platform} · ${session.appVersion} · ${new Date(session.startedAt).toLocaleString()} · Canvas content is not recorded`;
  $('gaps').textContent = gaps ? `${gaps} recording gap(s). Playback resumes at the next complete screen snapshot` : '';
  player = new rrwebPlayer({
    target: $('player'),
    props: {
      events: events as any,
      width: Math.max(240, $('player').clientWidth),
      height: Math.max(300, Math.min(720, window.innerHeight - 180)),
      autoPlay: true, skipInactive: false, showWarning: false, showDebug: false,
      UNSAFE_replayCanvas: false,
    },
  });
  $('recording').scrollIntoView({ block: 'start' });
  status('Recording loaded');
}

async function open(): Promise<void> {
  await loadSettings();
  $('login').hidden = true;
  $('dashboard').hidden = false;
  $('logout').hidden = false;
  await list();
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
form('settings').addEventListener('submit', (event) => {
  event.preventDefault();
  run(async () => {
    await request('/api/replay/settings', {
      mode: field('settings', 'mode').value,
      percentage: Number(field('settings', 'percentage').value),
      account_ids: field('settings', 'account_ids').value.split(/[\s,]+/).filter(Boolean),
      retention_days: Number(field('settings', 'retention_days').value),
      daily_limit_mb: Number(field('settings', 'daily_limit_mb').value),
      mask_selector: selectors('mask_selector', 'Mask text in'),
      block_selector: selectors('block_selector', 'Block elements'),
    });
    await loadSettings(); status('Settings saved');
  });
});
form('filters').addEventListener('submit', (event) => { event.preventDefault(); page = 1; run(list); });
$('previous').addEventListener('click', () => { page = Math.max(1, page - 1); run(list); });
$('next').addEventListener('click', () => { page = Math.min(totalPages, page + 1); run(list); });
$('close-recording').addEventListener('click', closePlayer);
$('logout').addEventListener('click', () => { signOut(); status('Signed out'); });
window.addEventListener('pagehide', closePlayer);
if (token) void open().catch(() => { signOut(); status('Sign in again to view recordings'); });
