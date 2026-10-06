import rrwebPlayer from 'rrweb-player';
import 'rrweb-player/dist/style.css';
import './style.css';
import { dayBound, IDLE_KEPT_MS, recordedAt, recoverEvents, shortenIdle, type IdlePeriod, type StoredChunk } from './decode';
import { keepPlaying } from './player';
import { installSecurityPanel } from './security';
import {
  bucketLabel, LogVolumeRequest, OBSERVABILITY_RATE_DEFAULTS, PagedRecords, replayOffset, telemetryQuery, VOLUME_GROUPS, volumeColumns, volumeScale,
  type ErrorOccurrence, type Issue, type IssueAlert, type IssueStatus, type LogEntry, type LogVolume, type ObservabilitySettings, type VolumeColumn,
} from './observability';

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
type ReplayPlayer = rrwebPlayer & { $destroy(): void; $set(size: { width: number; height: number }): void };
let player: ReplayPlayer | undefined;
let playbackGeneration = 0;
let watching = '';
let idle: IdlePeriod[] = [];
let recordingGaps = 0;
let playbackErrors = 0;
let clockText = '';
type DashboardTab = 'sessions' | 'issues' | 'logs';
let activeTab: DashboardTab = 'sessions';
const issues = new PagedRecords<Issue>();
const logs = new PagedRecords<LogEntry>();
const alerts = new PagedRecords<IssueAlert>();
const occurrences = new PagedRecords<ErrorOccurrence>();
let selectedIssue: Issue | undefined;
let selectedOccurrence: ErrorOccurrence | undefined;
let selectedLog: LogEntry | undefined;
let issueGeneration = 0;
let logGeneration = 0;
let changingIssue = false;
let alertRefreshTimer = 0;
let dashboardDisposed = false;
const readAlerts = new Set<string>();
const acknowledgingAlerts = new Set<string>();
let volume: LogVolume | undefined;
let volumeData: VolumeColumn[] = [];
const volumeRequest = new LogVolumeRequest();
let volumeFocus = -1;
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

const securityPanel = installSecurityPanel(request);

function markWatching(): void {
  for (const item of $('sessions').children) {
    const current = (item as HTMLElement).dataset.session === watching;
    item.classList.toggle('watching', current);
    const open = item.querySelector('.session-open');
    if (current) open?.setAttribute('aria-current', 'true'); else open?.removeAttribute('aria-current');
  }
}

function showViewer(state: 'empty' | 'loading' | 'recording'): void {
  $('no-recording').hidden = state !== 'empty';
  $('recording-loading').hidden = state !== 'loading';
  $('recording').hidden = state !== 'recording';
  $('viewer').setAttribute('aria-busy', String(state === 'loading'));
}

function closePlayer(): void {
  playbackGeneration++;
  watching = '';
  player?.$destroy();
  player = undefined;
  $('player').replaceChildren();
  showViewer('empty');
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
  stopAlertRefresh();
  readAlerts.clear();
  acknowledgingAlerts.clear();
  token = '';
  try { sessionStorage.removeItem('pocketbase-replay-admin'); } catch { /* Memory-only login. */ }
  closePlayer();
  resetList();
  for (const records of [issues, logs, alerts, occurrences]) records.reset(new URLSearchParams());
  closeIssue();
  closeLog();
  $('issues').replaceChildren();
  $('logs').replaceChildren();
  $('alerts').replaceChildren();
  clearVolume();
  $('issues-alert-badge').hidden = true;
  $('dashboard').hidden = true;
  $('dashboard-tabs').hidden = true;
  $('header-actions').hidden = true;
  securityPanel.reset();
  $<HTMLDialogElement>('settings-dialog').close();
  $<HTMLDialogElement>('erase-dialog').close();
  $<HTMLDialogElement>('observability-settings-dialog').close();
  $('login').hidden = false;
  void selectTab('sessions', false);
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

// Each call deletes a bounded batch of account data and reports what remains.
function confirmErase(account: string): Promise<boolean> {
  const dialog = $<HTMLDialogElement>('erase-dialog');
  const input = field('erase-confirm', 'confirm_account');
  $('erase-text').textContent = `Every recording, error and log for account ${account} will be deleted. This cannot be undone`;
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
  let deletedErrors = 0;
  let deletedLogs = 0;
  let remaining = false;
  for (let batch = 0; batch < 100; batch++) {
    const result = await request(`/api/replay/accounts/${encodeURIComponent(account)}`, undefined, 'DELETE');
    deleted += result.deletedSessions;
    deletedErrors += result.deletedErrors ?? 0;
    deletedLogs += result.deletedLogs ?? 0;
    remaining = result.remainingSessions > 0 || (result.remainingErrors ?? 0) > 0 || (result.remainingLogs ?? 0) > 0;
    if (!remaining) break;
  }
  closePlayer();
  await search();
  issues.reset();
  logs.reset();
  alerts.reset();
  closeIssue();
  closeLog();
  clearVolume();
  renderIssues();
  renderLogs();
  renderAlerts();
  status(`Deleted ${deleted} recording(s), ${deletedErrors} error(s) and ${deletedLogs} log(s) for account ${account}${remaining ? '. More data remains, repeat the deletion to finish' : ''}`, remaining);
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

async function watch(sessionId: string, timestamp?: number): Promise<void> {
  closePlayer();
  watching = sessionId;
  markWatching();
  const generation = playbackGeneration;
  showViewer('loading');
  if (stacked()) $('viewer').scrollIntoView({ block: 'start' });
  status('Loading recording...');
  try {
    await loadRecording(sessionId, generation, timestamp);
  } catch (error) {
    // A failed load empties the panel again; a load already replaced by another is ignored.
    if (generation !== playbackGeneration) return;
    closePlayer();
    throw error;
  }
}

async function loadRecording(sessionId: string, generation: number, timestamp?: number): Promise<void> {
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
  showViewer('recording');
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
  }) as ReplayPlayer;
  keepPlaying(player.getReplayer(), (error) => { if (generation === playbackGeneration) playbackError(error); });
  const start = shortened.events[0].timestamp;
  player.addEventListener('ui-update-current-time', (value) => {
    if (generation === playbackGeneration) showClock(start + (value as { payload: number }).payload);
  });
  if (timestamp === undefined) player.play();
  else player.goto(replayOffset(recovered.events, shortened.events, timestamp), true);
  if (stacked()) $('viewer').scrollIntoView({ block: 'start' });
  status('Recording loaded');
}

async function open(): Promise<void> {
  await Promise.all([loadSettings(), loadObservabilitySettings()]);
  $('login').hidden = true;
  $('dashboard').hidden = false;
  $('dashboard-tabs').hidden = false;
  $('header-actions').hidden = false;
  await search();
  status('');
}

async function loadObservabilitySettings(): Promise<void> {
  const settings: ObservabilitySettings = await request('/api/replay/observability/settings');
  for (const key of ['errors_enabled', 'logs_enabled', 'alerts_enabled'] as const) {
    field('observability-settings', key).checked = settings[key] === true;
  }
  for (const key of ['errors_retention_days', 'logs_retention_days', 'daily_limit_mb'] as const) {
    field('observability-settings', key).value = String(settings[key]);
  }
  for (const key of Object.keys(OBSERVABILITY_RATE_DEFAULTS) as (keyof typeof OBSERVABILITY_RATE_DEFAULTS)[]) {
    field('observability-settings', key).value = String(settings[key] ?? OBSERVABILITY_RATE_DEFAULTS[key]);
  }
  // An older server has no webhook setting.
  field('observability-settings', 'alert_webhook_url').value = typeof settings.alert_webhook_url === 'string' ? settings.alert_webhook_url : '';
  $('webhook-test-state').textContent = '';
  $('errors-disabled').hidden = settings.errors_enabled === true;
  $('logs-disabled').hidden = settings.logs_enabled === true;
}

async function selectTab(tab: DashboardTab, load = true): Promise<void> {
  if (tab !== 'sessions' && activeTab === 'sessions') closePlayer();
  activeTab = tab;
  for (const name of ['sessions', 'issues', 'logs'] as const) {
    const selected = name === tab;
    $(`${name}-view`).hidden = !selected;
    $(`${name}-tab`).setAttribute('aria-selected', String(selected));
    $(`${name}-tab`).tabIndex = selected ? 0 : -1;
  }
  status('');
  scheduleAlertRefresh();
  if (!load) return;
  if (tab === 'issues') {
    await Promise.all([issues.page ? Promise.resolve() : searchIssues(), alerts.page ? Promise.resolve() : refreshAlerts()]);
  } else if (tab === 'logs' && !logs.page) await searchLogs();
}

function filterQuery(id: string, keys: string[]): URLSearchParams {
  return telemetryQuery(Object.fromEntries(keys.map((key) => [key, field(id, key).value])));
}

function dateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function badge(text: string, level = ''): HTMLSpanElement {
  const label = document.createElement('span');
  label.className = 'badge';
  label.textContent = text;
  if (level) label.dataset.level = level;
  return label;
}

function entryRow(id: string, title: string, info: (string | HTMLElement)[], selected: boolean, action: () => void): HTMLLIElement {
  const row = document.createElement('li');
  row.className = 'telemetry-row';
  row.classList.toggle('selected', selected);
  row.dataset.record = id;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'telemetry-open';
  if (selected) button.setAttribute('aria-current', 'true');
  const heading = document.createElement('strong');
  heading.textContent = title;
  const meta = document.createElement('span');
  meta.className = 'telemetry-meta';
  for (const item of info) {
    if (!item) continue;
    if (typeof item === 'string') {
      const text = document.createElement('span');
      text.textContent = item;
      meta.append(text);
    } else meta.append(item);
  }
  button.append(heading, meta);
  button.addEventListener('click', action);
  row.append(button);
  return row;
}

function pageState<T extends { id: string }>(records: PagedRecords<T>, prefix: string, noun: string): void {
  $(`${prefix}-state`).textContent = records.loading ? `Loading ${noun}...`
    : !records.page ? '' : !records.totalItems ? `No ${noun} match these filters`
      : records.more ? '' : `All ${noun} loaded`;
  $<HTMLButtonElement>(`${prefix}-more`).hidden = !records.page || !records.more;
  $<HTMLButtonElement>(`${prefix}-more`).disabled = records.loading;
}

function renderIssues(): void {
  $('issues').replaceChildren(...Array.from(issues.items.values(), (issue) => entryRow(issue.id, issue.title, [
    badge(issue.status), badge(issue.level, issue.level), issue.service,
    `${issue.occurrenceCount} occurrence${issue.occurrenceCount === 1 ? '' : 's'}`, `Last seen ${dateTime(issue.lastSeen)}`,
  ], selectedIssue?.id === issue.id, () => run(() => openIssue(issue.id)))));
  $('issue-count').textContent = issues.page ? `${issues.totalItems} issue${issues.totalItems === 1 ? '' : 's'}, ${issues.items.size} loaded` : '';
  pageState(issues, 'issues', 'issues');
}

async function searchIssues(): Promise<void> {
  const query = filterQuery('issue-filters', ['q', 'status', 'service', 'accountId', 'deviceId', 'sessionId', 'from', 'to']);
  showAdvancedFilterCount('issue-filters', query);
  issues.reset(query);
  closeIssue();
  renderIssues();
  await loadIssues();
}

async function loadIssues(): Promise<void> {
  const generation = issues.begin();
  if (generation === undefined) return;
  renderIssues();
  try {
    const query = new URLSearchParams(issues.query);
    query.set('page', String(issues.page + 1));
    issues.accept(await request(`/api/replay/issues?${query}`), generation);
  } finally {
    issues.finish(generation);
    if (generation === issues.generation) renderIssues();
  }
}

function closeIssue(): void {
  issueGeneration++;
  selectedIssue = undefined;
  selectedOccurrence = undefined;
  occurrences.reset(new URLSearchParams());
  $('issue-detail').hidden = true;
  $('no-issue').hidden = false;
  $('occurrence-detail').hidden = true;
  $('occurrences').replaceChildren();
  for (const row of $('issues').children) {
    row.classList.remove('selected');
    row.querySelector('button')?.removeAttribute('aria-current');
  }
}

function issueSummary(): void {
  if (!selectedIssue) return;
  const issue = selectedIssue;
  $('issue-title').textContent = issue.title;
  $('issue-summary').textContent = [
    issue.status === 'resolved' && issue.resolvedAt ? `Resolved ${dateTime(issue.resolvedAt)}` : issue.status,
    `${issue.occurrenceCount} occurrence${issue.occurrenceCount === 1 ? '' : 's'}`,
    `First seen ${dateTime(issue.firstSeen)}`, `Last seen ${dateTime(issue.lastSeen)}`,
  ].join(' · ');
  $('issue-actions').querySelectorAll<HTMLButtonElement>('[data-issue-status]').forEach((button) => {
    button.hidden = button.dataset.issueStatus === issue.status;
    button.disabled = changingIssue;
  });
}

async function openIssue(id: string): Promise<void> {
  closeIssue();
  const generation = issueGeneration;
  status('Loading issue...');
  const result = await request(`/api/replay/issues/${encodeURIComponent(id)}?page=1`);
  if (generation !== issueGeneration) return;
  selectedIssue = result.issue;
  occurrences.accept(result, occurrences.generation);
  $('issue-detail').hidden = false;
  $('no-issue').hidden = true;
  issueSummary();
  renderIssues();
  renderOccurrences();
  const first = occurrences.items.values().next().value;
  if (first) showOccurrence(first);
  if (stacked()) $('issue-title').scrollIntoView({ block: 'start' });
  $('issue-title').focus({ preventScroll: true });
  status('');
}

async function changeIssue(statusValue: IssueStatus): Promise<void> {
  if (!selectedIssue || changingIssue) return;
  const id = selectedIssue.id;
  const generation = issueGeneration;
  const listVersion = issues.generation;
  changingIssue = true;
  issueSummary();
  try {
    const saved: Issue = await request(`/api/replay/issues/${encodeURIComponent(id)}`, { status: statusValue });
    if (generation !== issueGeneration || selectedIssue?.id !== id) return;
    selectedIssue = { ...selectedIssue, status: saved.status, resolvedAt: saved.resolvedAt };
    if (issues.items.has(id)) {
      if (issues.query.get('status') && issues.query.get('status') !== statusValue) {
        issues.items.delete(id);
        issues.totalItems = Math.max(0, issues.totalItems - 1);
        const query = new URLSearchParams(issues.query);
        query.set('page', String(issues.page));
        issues.accept(await request(`/api/replay/issues?${query}`), listVersion);
      } else issues.items.set(id, selectedIssue);
    }
    renderIssues();
    toast(statusValue === 'resolved' ? 'Issue resolved' : statusValue === 'ignored' ? 'Issue ignored' : 'Issue reopened');
  } finally {
    changingIssue = false;
    issueSummary();
  }
}

function renderOccurrences(): void {
  $('occurrences').replaceChildren(...Array.from(occurrences.items.values(), (entry) => entryRow(entry.id, dateTime(entry.timestamp), [
    entry.accountId || 'Guest', entry.deviceId, entry.service, badge(entry.level, entry.level), entry.handled ? 'Handled' : 'Unhandled',
  ], selectedOccurrence?.id === entry.id, () => showOccurrence(entry))));
  pageState(occurrences, 'occurrences', 'occurrences');
}

async function loadOccurrences(): Promise<void> {
  if (!selectedIssue) return;
  const id = selectedIssue.id;
  const generation = occurrences.begin();
  if (generation === undefined) return;
  renderOccurrences();
  try {
    occurrences.accept(await request(`/api/replay/issues/${encodeURIComponent(id)}?page=${occurrences.page + 1}`), generation);
  } finally {
    occurrences.finish(generation);
    if (generation === occurrences.generation) renderOccurrences();
  }
}

function showContext(target: string, entry: LogEntry, handled?: boolean): void {
  const context = document.createElement('dl');
  context.className = 'context-grid';
  const values: [string, string][] = [
    ['Recorded at', dateTime(entry.timestamp)], ['Level', entry.level], ['Service', entry.service || 'No service supplied'],
    ['Account', entry.accountId || 'Guest'], ['Device', entry.deviceId || 'No device supplied'],
    ['Session', entry.sessionId || 'No session supplied'], ['Platform', entry.platform || 'No platform supplied'],
    ['App version', entry.appVersion || 'No version supplied'], ['Room', entry.room || 'No room supplied'],
  ];
  if (handled !== undefined) values.push(['Error', handled ? 'Handled' : 'Unhandled']);
  for (const [name, value] of values) {
    const term = document.createElement('dt');
    term.textContent = name;
    const definition = document.createElement('dd');
    definition.textContent = value;
    if (name === 'Session' && entry.sessionId && entry.replayAvailable === true) {
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = 'Watch replay';
      open.addEventListener('click', () => run(async () => {
        await selectTab('sessions', false);
        await watch(entry.sessionId, entry.timestamp);
      }));
      definition.append(open);
    }
    context.append(term, definition);
  }
  $(target).replaceChildren(context);
}

function showOccurrence(entry: ErrorOccurrence): void {
  selectedOccurrence = entry;
  $('occurrence-detail').hidden = false;
  $('occurrence-stack').textContent = entry.stack || 'No stack trace supplied';
  $('occurrence-attributes').textContent = JSON.stringify(entry.attributes ?? {}, null, 2);
  $('issue-logs').hidden = !entry.sessionId;
  showContext('occurrence-context', entry, entry.handled);
  renderOccurrences();
  if (stacked()) $('occurrence-detail').scrollIntoView({ block: 'nearest' });
}

function renderLogs(): void {
  $('logs').replaceChildren(...Array.from(logs.items.values(), (entry) => entryRow(entry.id, entry.message, [
    badge(entry.level, entry.level), entry.service, dateTime(entry.timestamp), entry.accountId || 'Guest',
  ], selectedLog?.id === entry.id, () => run(() => openLog(entry.id)))));
  $('log-count').textContent = logs.page ? `${logs.totalItems} log${logs.totalItems === 1 ? '' : 's'}, ${logs.items.size} loaded` : '';
  pageState(logs, 'logs', 'logs');
}

async function searchLogs(): Promise<void> {
  const query = filterQuery('log-filters', ['q', 'level', 'service', 'accountId', 'deviceId', 'sessionId', 'from', 'to']);
  showAdvancedFilterCount('log-filters', query);
  logs.reset(query);
  closeLog();
  renderLogs();
  await Promise.all([loadLogs(), loadVolume(query)]);
}

function showAdvancedFilterCount(id: string, query: URLSearchParams): void {
  const count = ['accountId', 'deviceId', 'sessionId', 'from', 'to'].filter((key) => query.has(key)).length;
  form(id).querySelector<HTMLElement>('.filter-options summary span')!.textContent = count ? ` (${count} active)` : '';
}

const SVG = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function clearVolume(): void {
  volumeRequest.reset();
  renderVolumeState();
}

function emptyVolume(): void {
  $('log-volume').hidden = true;
  $('log-volume-chart').replaceChildren();
  $('log-volume-table').replaceChildren();
  $('log-volume-tip').hidden = true;
}

function renderVolumeState(): void {
  // Redrawn only when the counts change; a search still loading dims the chart already shown.
  if (volume !== volumeRequest.value) {
    volume = volumeRequest.value;
    volumeData = volume ? volumeColumns(volume) : [];
    volumeFocus = -1;
    renderVolume();
  }
  const refreshing = volumeRequest.loading && !!volume;
  if (refreshing) hideVolumeTip();
  $('log-volume').classList.toggle('refreshing', refreshing);
  $('log-volume').setAttribute('aria-busy', String(volumeRequest.loading));
  // Text only where no chart is drawn, so a refresh never pushes the chart down a line.
  $('log-volume-state').textContent = volumeRequest.failed ? 'Could not load log volume. Use Find logs to retry'
    : volumeRequest.loading && !volume ? 'Loading log volume...' : '';
  $('log-volume-state').classList.toggle('error', volumeRequest.failed);
}

function loadVolume(query: URLSearchParams): Promise<void> {
  return volumeRequest.load(query, (current) => request(`/api/replay/logs/volume?${current}`), renderVolumeState);
}

function periodLabel(column: VolumeColumn): string {
  const sameDay = new Date(column.start).toDateString() === new Date(column.end).toDateString();
  const day = { month: 'short', day: 'numeric' } as const, time = { hour: '2-digit', minute: '2-digit' } as const;
  const start = new Date(column.start).toLocaleString(undefined, volume && volume.bucketMs >= 86400000 ? day : { ...day, ...time });
  if (volume && volume.bucketMs >= 86400000) return volume.bucketMs === 86400000 ? start : `${start} to ${new Date(column.end).toLocaleString(undefined, day)}`;
  return `${start} to ${new Date(column.end + 1).toLocaleString(undefined, sameDay ? time : { ...day, ...time })}`;
}

function roundedTop(x: number, y: number, width: number, height: number, radius: number): string {
  return `M${x},${y + height}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + width - radius}Q${x + width},${y} ${x + width},${y + radius}V${y + height}Z`;
}

const VOLUME_BOX = { height: 124, left: 44, right: 6, top: 8, bottom: 22 };

function renderVolume(): void {
  const chart = $('log-volume-chart');
  $('log-volume-tip').hidden = true;
  if (!volume || !volume.total || !volumeData.length) { emptyVolume(); return; }
  $('log-volume').hidden = false;
  $('log-volume-range').textContent = `${volume.total.toLocaleString()} in ${bucketLabel(volume.bucketMs)} periods`;
  const width = Math.max(240, chart.clientWidth), { height, left, right, top, bottom } = VOLUME_BOX;
  const plot = { width: width - left - right, height: height - top - bottom };
  const max = volumeScale(Math.max(...volumeData.map((column) => column.total)));
  const slot = plot.width / volumeData.length;
  const bar = Math.max(1, Math.min(24, slot - 2));
  const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true' });
  root.append(svg('rect', { class: 'volume-hover', x: 0, y: top, width: slot, height: plot.height, visibility: 'hidden' }));
  for (const fraction of [0, 0.5, 1]) {
    const y = top + plot.height - fraction * plot.height;
    root.append(svg('line', { x1: left, x2: width - right, y1: y, y2: y, class: fraction ? 'volume-grid' : 'volume-axis' }));
    const tick = svg('text', { x: left - 6, y: y + 4, 'text-anchor': 'end', class: 'volume-tick' });
    tick.textContent = (max * fraction).toLocaleString();
    root.append(tick);
  }
  volumeData.forEach((column, index) => {
    const x = left + index * slot + (slot - bar) / 2;
    const parts = column.groups.map((count, group) => ({ count, group })).filter((part) => part.count > 0);
    let base = top + plot.height;
    parts.forEach((part, order) => {
      // A 2px gap in the surface colour between segments, taken out of the upper one so the column keeps its height.
      const gap = order ? 2 : 0;
      const size = Math.max(1, part.count / max * plot.height - gap);
      base -= gap;
      const radius = order === parts.length - 1 ? Math.min(4, bar / 2, size) : 0;
      const shape = radius ? svg('path', { d: roundedTop(x, base - size, bar, size, radius) }) : svg('rect', { x, y: base - size, width: bar, height: size });
      shape.setAttribute('class', `volume-bar volume-${VOLUME_GROUPS[part.group].key}`);
      root.append(shape);
      base -= size;
    });
  });
  const day = { month: 'short', day: 'numeric' } as const, time = { hour: '2-digit', minute: '2-digit' } as const;
  const longRange = volume.to - volume.from >= 86400000 || new Date(volume.from).toDateString() !== new Date(volume.to).toDateString();
  for (const [at, anchor, x] of [[volume.from, 'start', left], [volume.to, 'end', width - right]] as const) {
    const label = svg('text', { x, y: height - 6, 'text-anchor': anchor, class: 'volume-tick' });
    label.textContent = new Date(at).toLocaleString(undefined, longRange ? { ...day, ...(volume.bucketMs < 86400000 ? time : {}) } : time);
    root.append(label);
  }
  chart.replaceChildren(root);
  const table = $('log-volume-table');
  const header = document.createElement('tr');
  for (const name of ['Period', 'Total', ...VOLUME_GROUPS.map((group) => group.label)]) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = name;
    header.append(cell);
  }
  const rows = volumeData.filter((column) => column.total).map((column) => {
    const row = document.createElement('tr');
    for (const value of [periodLabel(column), column.total, ...column.groups]) {
      const cell = document.createElement('td');
      cell.textContent = typeof value === 'number' ? value.toLocaleString() : value;
      row.append(cell);
    }
    return row;
  });
  table.replaceChildren(header, ...rows);
}

// Values lead and level names follow, each keyed by a short line in its group's colour.
function showVolumeTip(index: number): void {
  const column = volumeData[index];
  const chart = $('log-volume-chart'), tip = $('log-volume-tip');
  // Dimmed counts belong to the previous search, so they are not read out.
  if (!column || !volume || volumeRequest.loading) return;
  volumeFocus = index;
  const slot = (chart.clientWidth - VOLUME_BOX.left - VOLUME_BOX.right) / volumeData.length;
  const hover = chart.querySelector<SVGRectElement>('.volume-hover');
  hover?.setAttribute('x', String(VOLUME_BOX.left + index * slot));
  hover?.setAttribute('width', String(slot));
  hover?.setAttribute('visibility', 'visible');
  const title = document.createElement('strong');
  title.textContent = periodLabel(column);
  const list = document.createElement('div');
  list.className = 'tip-rows';
  const levels: [string, string, number][] = [];
  VOLUME_GROUPS.forEach((group) => {
    for (const level of group.levels) levels.push([group.key, level, column.counts[level] ?? 0]);
  });
  for (const [group, level, count] of [...levels, ['', 'Total', column.total] as [string, string, number]]) {
    const value = document.createElement('b');
    value.textContent = count.toLocaleString();
    const name = document.createElement('span');
    name.textContent = level === 'warn' ? 'Warning' : level.charAt(0).toUpperCase() + level.slice(1);
    if (group) name.dataset.group = group;
    list.append(value, name);
  }
  tip.replaceChildren(title, list);
  tip.hidden = false;
  const center = chart.offsetLeft + VOLUME_BOX.left + (index + 0.5) * slot;
  const room = (chart.offsetParent as HTMLElement | null)?.clientWidth ?? chart.clientWidth;
  tip.style.left = `${Math.max(0, Math.min(room - tip.offsetWidth, center + 12 + tip.offsetWidth > room ? center - 12 - tip.offsetWidth : center + 12))}px`;
  tip.style.top = `${chart.offsetTop + VOLUME_BOX.top}px`;
}

function hideVolumeTip(): void {
  $('log-volume-tip').hidden = true;
  $('log-volume-chart').querySelector('.volume-hover')?.setAttribute('visibility', 'hidden');
}

function volumeIndexAt(clientX: number): number {
  const chart = $('log-volume-chart');
  const slot = (chart.clientWidth - VOLUME_BOX.left - VOLUME_BOX.right) / Math.max(1, volumeData.length);
  const index = Math.floor((clientX - chart.getBoundingClientRect().left - VOLUME_BOX.left) / slot);
  return Math.max(0, Math.min(volumeData.length - 1, index));
}

async function loadLogs(): Promise<void> {
  const generation = logs.begin();
  if (generation === undefined) return;
  renderLogs();
  try {
    const query = new URLSearchParams(logs.query);
    query.set('page', String(logs.page + 1));
    logs.accept(await request(`/api/replay/logs?${query}`), generation);
  } finally {
    logs.finish(generation);
    if (generation === logs.generation) renderLogs();
  }
}

function closeLog(): void {
  logGeneration++;
  selectedLog = undefined;
  $('log-detail').hidden = true;
  $('no-log').hidden = false;
  for (const row of $('logs').children) {
    row.classList.remove('selected');
    row.querySelector('button')?.removeAttribute('aria-current');
  }
}

async function openLog(id: string): Promise<void> {
  closeLog();
  const generation = logGeneration;
  status('Loading log...');
  const entry: LogEntry = await request(`/api/replay/logs/${encodeURIComponent(id)}`);
  if (generation !== logGeneration) return;
  selectedLog = entry;
  $('log-detail').hidden = false;
  $('no-log').hidden = true;
  $('log-title').textContent = `${entry.level.toUpperCase()} log`;
  $('log-message').textContent = entry.message;
  $('log-attributes').textContent = JSON.stringify(entry.attributes ?? {}, null, 2);
  $('log-issues').hidden = !entry.sessionId;
  showContext('log-context', entry);
  renderLogs();
  if (stacked()) $('log-title').scrollIntoView({ block: 'start' });
  $('log-title').focus({ preventScroll: true });
  status('');
}

async function logsForSession(sessionId: string): Promise<void> {
  form('log-filters').reset();
  field('log-filters', 'sessionId').value = sessionId;
  await selectTab('logs', false);
  await searchLogs();
}

async function issuesForSession(sessionId: string): Promise<void> {
  form('issue-filters').reset();
  field('issue-filters', 'status').value = '';
  field('issue-filters', 'sessionId').value = sessionId;
  await selectTab('issues', false);
  await Promise.all([searchIssues(), alerts.page ? Promise.resolve() : refreshAlerts()]);
}

function renderAlerts(): void {
  const unread = Array.from(alerts.items.values()).filter((alert) => !alert.acknowledged && !readAlerts.has(alert.id)).length;
  $('alert-count').textContent = alerts.page ? `(${unread} unread${alerts.more ? ' loaded' : ''})` : '';
  $('issues-alert-badge').textContent = String(unread);
  $('issues-alert-badge').hidden = !unread;
  $('issues-alert-badge').setAttribute('aria-label', `${unread} unread alerts${alerts.more ? ' loaded' : ''}`);
  $('alerts-state').textContent = alerts.loading ? 'Loading alerts...'
    : !field('observability-settings', 'alerts_enabled').checked ? 'Issue alerts are off in settings'
      : alerts.page && !alerts.totalItems ? 'No issue alerts yet' : `${alerts.totalItems} alert${alerts.totalItems === 1 ? '' : 's'}`;
  const ordered = Array.from(alerts.items.values()).sort((left, right) => right.timestamp - left.timestamp);
  $('alerts').replaceChildren(...ordered.map((alert) => {
    const isRead = alert.acknowledged || readAlerts.has(alert.id);
    const delivery = alert.delivery === 'sent' ? 'Sent to webhook' : alert.delivery === 'failed' ? 'Webhook did not accept it' : alert.delivery === 'pending' ? 'Sending to webhook' : '';
    const row = entryRow(alert.id, alert.title, [alert.kind === 'regressed' ? 'Resolved issue returned' : 'New issue', dateTime(alert.timestamp), delivery], false,
      () => run(() => openIssue(alert.issueId)));
    row.classList.add('alert-row');
    row.classList.toggle('acknowledged', isRead);
    const acknowledge = document.createElement('button');
    acknowledge.type = 'button';
    acknowledge.className = 'secondary';
    acknowledge.textContent = isRead ? 'Read' : 'Mark read';
    acknowledge.disabled = isRead || acknowledgingAlerts.has(alert.id);
    acknowledge.setAttribute('aria-label', `Mark alert for ${alert.title} as read`);
    acknowledge.addEventListener('click', () => run(async () => {
      if (acknowledgingAlerts.has(alert.id)) return;
      const generation = alerts.generation;
      acknowledgingAlerts.add(alert.id);
      acknowledge.disabled = true;
      try {
        await request(`/api/replay/alerts/${encodeURIComponent(alert.id)}/acknowledge`, { acknowledged: true });
        if (generation !== alerts.generation) return;
        readAlerts.add(alert.id);
        if (alerts.items.has(alert.id)) alerts.items.set(alert.id, { ...alert, acknowledged: true });
      } finally {
        acknowledgingAlerts.delete(alert.id);
        if (generation === alerts.generation) renderAlerts();
      }
    }));
    row.append(acknowledge);
    return row;
  }));
  $<HTMLButtonElement>('alerts-more').hidden = !alerts.page || !alerts.more;
  $<HTMLButtonElement>('alerts-more').disabled = alerts.loading;
  $<HTMLButtonElement>('refresh-alerts').disabled = alerts.loading;
}

async function refreshAlerts(): Promise<void> {
  alerts.reset(new URLSearchParams());
  await loadAlerts();
}

async function loadAlerts(): Promise<void> {
  const generation = alerts.begin();
  if (generation === undefined) return;
  renderAlerts();
  try {
    alerts.accept(await request(`/api/replay/alerts?page=${alerts.page + 1}`), generation);
  } finally {
    alerts.finish(generation);
    if (generation === alerts.generation) renderAlerts();
  }
}

function stopAlertRefresh(): void {
  clearTimeout(alertRefreshTimer);
  alertRefreshTimer = 0;
}

function scheduleAlertRefresh(): void {
  stopAlertRefresh();
  if (!token || activeTab !== 'issues' || document.hidden || dashboardDisposed) return;
  alertRefreshTimer = window.setTimeout(() => {
    void pollAlerts().catch(() => {
      if (activeTab === 'issues' && token) $('alerts-state').textContent = 'Could not refresh alerts. Use Refresh to retry';
    }).finally(scheduleAlertRefresh);
  }, 30_000);
}

async function pollAlerts(): Promise<void> {
  if (!token || activeTab !== 'issues' || document.hidden || dashboardDisposed) return;
  const generation = alerts.begin(true);
  if (generation === undefined) return;
  try {
    alerts.accept(await request('/api/replay/alerts?page=1'), generation, true);
  } finally {
    alerts.finish(generation);
    if (generation === alerts.generation) renderAlerts();
  }
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
$('open-observability-settings').addEventListener('click', () => run(async () => {
  await loadObservabilitySettings();
  $('observability-settings-error').textContent = '';
  $<HTMLDialogElement>('observability-settings-dialog').showModal();
}));
$('close-observability-settings').addEventListener('click', () => $<HTMLDialogElement>('observability-settings-dialog').close());
$('test-webhook').addEventListener('click', () => {
  const button = $<HTMLButtonElement>('test-webhook');
  const state = $('webhook-test-state');
  button.disabled = true;
  state.textContent = 'Sending...';
  request('/api/replay/alerts/test', { alert_webhook_url: field('observability-settings', 'alert_webhook_url').value.trim() })
    .then(() => { state.textContent = 'Test alert sent. Check that it arrived'; })
    .catch((error: unknown) => { state.textContent = error instanceof Error ? error.message : 'Request failed'; })
    .finally(() => { button.disabled = false; });
});
$('log-volume-chart').addEventListener('pointermove', (event) => { if (volumeData.length) showVolumeTip(volumeIndexAt(event.clientX)); });
$('log-volume-chart').addEventListener('pointerleave', () => { if (document.activeElement !== $('log-volume-chart')) hideVolumeTip(); });
$('log-volume-chart').addEventListener('focus', () => {
  if (!volumeData.length) return;
  const last = volumeData.map((column) => column.total > 0).lastIndexOf(true);
  showVolumeTip(volumeFocus >= 0 ? volumeFocus : last);
});
$('log-volume-chart').addEventListener('blur', hideVolumeTip);
$('log-volume-chart').addEventListener('keydown', (event: KeyboardEvent) => {
  if (!volumeData.length) return;
  const moves: Record<string, number> = { ArrowLeft: volumeFocus - 1, ArrowRight: volumeFocus + 1, Home: 0, End: volumeData.length - 1 };
  if (event.key === 'Escape') { hideVolumeTip(); return; }
  if (!(event.key in moves)) return;
  event.preventDefault();
  showVolumeTip(Math.max(0, Math.min(volumeData.length - 1, moves[event.key])));
});
new ResizeObserver(() => { if (volume) renderVolume(); }).observe($('log-volume-chart'));
form('observability-settings').addEventListener('submit', (event) => {
  event.preventDefault();
  $('observability-settings-error').textContent = '';
  const submit = form('observability-settings').querySelector<HTMLButtonElement>('button[type="submit"]')!;
  submit.disabled = true;
  void (async () => {
    const settings: ObservabilitySettings = {
      errors_enabled: field('observability-settings', 'errors_enabled').checked,
      logs_enabled: field('observability-settings', 'logs_enabled').checked,
      alerts_enabled: field('observability-settings', 'alerts_enabled').checked,
      errors_retention_days: Number(field('observability-settings', 'errors_retention_days').value),
      logs_retention_days: Number(field('observability-settings', 'logs_retention_days').value),
      daily_limit_mb: Number(field('observability-settings', 'daily_limit_mb').value),
      alert_webhook_url: field('observability-settings', 'alert_webhook_url').value.trim(),
      sessions_per_device_hour: Number(field('observability-settings', 'sessions_per_device_hour').value),
      sessions_per_ip_hour: Number(field('observability-settings', 'sessions_per_ip_hour').value),
      sessions_per_hour: Number(field('observability-settings', 'sessions_per_hour').value),
      config_requests_per_ip_minute: Number(field('observability-settings', 'config_requests_per_ip_minute').value),
      upload_requests_per_ip_minute: Number(field('observability-settings', 'upload_requests_per_ip_minute').value),
      upload_mb_per_ip_hour: Number(field('observability-settings', 'upload_mb_per_ip_hour').value),
    };
    await request('/api/replay/observability/settings', settings);
    await loadObservabilitySettings();
    renderAlerts();
    $<HTMLDialogElement>('observability-settings-dialog').close();
    toast('Diagnostics settings saved');
  })().catch((error: unknown) => {
    $('observability-settings-error').textContent = error instanceof Error ? error.message : 'Request failed';
  }).finally(() => { submit.disabled = false; });
});
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
for (const tab of ['sessions', 'issues', 'logs'] as const) {
  $(`${tab}-tab`).addEventListener('click', () => run(() => selectTab(tab)));
  $(`${tab}-tab`).addEventListener('keydown', (event: KeyboardEvent) => {
    const tabs: DashboardTab[] = ['sessions', 'issues', 'logs'];
    let next = tabs.indexOf(tab);
    if (event.key === 'ArrowRight') next = (next + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (next + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    $(`${tabs[next]}-tab`).focus();
    run(() => selectTab(tabs[next]));
  });
}
form('issue-filters').addEventListener('submit', (event) => { event.preventDefault(); run(searchIssues); });
for (const id of ['observability-settings', 'issue-filters', 'log-filters']) {
  form(id).addEventListener('invalid', (event) => {
    if (event.target instanceof HTMLElement) event.target.closest('details')?.setAttribute('open', '');
  }, true);
}
form('log-filters').addEventListener('submit', (event) => { event.preventDefault(); run(searchLogs); });
$('issues-more').addEventListener('click', () => run(loadIssues));
$('logs-more').addEventListener('click', () => run(loadLogs));
$('alerts-more').addEventListener('click', () => run(loadAlerts));
$('occurrences-more').addEventListener('click', () => run(loadOccurrences));
$('refresh-alerts').addEventListener('click', () => run(refreshAlerts));
$('close-issue').addEventListener('click', closeIssue);
$('close-log').addEventListener('click', closeLog);
$('issue-actions').querySelectorAll<HTMLButtonElement>('[data-issue-status]').forEach((button) => {
  button.addEventListener('click', () => run(() => changeIssue(button.dataset.issueStatus as IssueStatus)));
});
$('issue-logs').addEventListener('click', () => { if (selectedOccurrence?.sessionId) run(() => logsForSession(selectedOccurrence!.sessionId)); });
$('log-issues').addEventListener('click', () => { if (selectedLog?.sessionId) run(() => issuesForSession(selectedLog!.sessionId)); });
$('recording-issues').addEventListener('click', () => { const id = watching; if (id) run(() => issuesForSession(id)); });
$('recording-logs').addEventListener('click', () => { const id = watching; if (id) run(() => logsForSession(id)); });
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  if (activeTab === 'issues' && selectedIssue) { closeIssue(); $('issues-tab').focus(); }
  else if (activeTab === 'logs' && selectedLog) { closeLog(); $('logs-tab').focus(); }
});
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
document.addEventListener('visibilitychange', scheduleAlertRefresh);
window.addEventListener('pagehide', () => { dashboardDisposed = true; stopAlertRefresh(); closePlayer(); securityPanel.reset(); });
window.addEventListener('pageshow', () => { dashboardDisposed = false; scheduleAlertRefresh(); });
if (token) void open().catch(() => { signOut(); status('Sign in again to view recordings'); });
