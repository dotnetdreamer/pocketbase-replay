// AI agents: read-only keys for coding agents such as Claude Code and Cursor, how to set each one up, and what
// they have read. The server side is server/pb_hooks/lib/mcp.js.

export type AgentScope = 'issues' | 'logs' | 'recordings';

export interface AgentKey {
  id: string; label: string; prefix: string; scopes: AgentScope[]; createdAt: number; expiresAt: number;
  lastUsedAt: number; lastClient: string; createdBy: string;
}

export interface AgentRequest {
  id: string; key: string; keyLabel: string; client: string; method: string; name: string; arguments: string;
  status: string; error: string; durationMs: number; resultChars: number; timestamp: number;
}

interface AgentAccess { keys: AgentKey[]; audit: AgentRequest[]; path: string }

export interface AgentSetup { id: string; name: string; where: string; text: string; hint: string }

const SCOPE_NAMES: Record<AgentScope, string> = { issues: 'issues and errors', logs: 'logs', recordings: 'recordings' };
const SERVER_NAME = 'pocketbase-replay';

// Ready-to-use setup for each agent, with the key kept out of files that are likely to be committed.
export function agentSetups(url: string, key: string): AgentSetup[] {
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  return [
    {
      id: 'claude-code', name: 'Claude Code', where: 'Run in a terminal',
      text: `claude mcp add --transport http --scope user ${SERVER_NAME} ${url} --header "Authorization: Bearer ${key}"`,
      hint: 'Then ask Claude what is broken in production, or type /mcp to see the server and its prompts',
    },
    {
      id: 'cursor', name: 'Cursor', where: 'Add to ~/.cursor/mcp.json',
      text: json({ mcpServers: { [SERVER_NAME]: { url, headers: { Authorization: `Bearer ${key}` } } } }),
      hint: 'Use the file in your home folder, not the project, so the key stays out of git',
    },
    {
      id: 'vscode', name: 'VS Code', where: 'Add to .vscode/mcp.json',
      text: json({
        inputs: [{ type: 'promptString', id: `${SERVER_NAME}-key`, description: 'PocketBase Replay agent key', password: true }],
        servers: { [SERVER_NAME]: { type: 'http', url, headers: { Authorization: `Bearer \${input:${SERVER_NAME}-key}` } } },
      }),
      hint: 'VS Code asks for the key once and keeps it in its secret storage, so this file can be committed',
    },
    {
      id: 'windsurf', name: 'Windsurf', where: 'Add to ~/.codeium/windsurf/mcp_config.json',
      text: json({ mcpServers: { [SERVER_NAME]: { serverUrl: url, headers: { Authorization: `Bearer ${key}` } } } }),
      hint: 'Refresh the MCP servers in Cascade after saving',
    },
    {
      id: 'codex', name: 'Codex', where: 'Add to ~/.codex/config.toml',
      text: `[mcp_servers.${SERVER_NAME}]\nurl = "${url}"\nbearer_token_env_var = "PB_REPLAY_MCP_KEY"`,
      hint: `Set the key in the shell that starts Codex: export PB_REPLAY_MCP_KEY=${key}`,
    },
    {
      id: 'gemini', name: 'Gemini CLI', where: 'Add to ~/.gemini/settings.json',
      text: json({ mcpServers: { [SERVER_NAME]: { httpUrl: url, headers: { Authorization: `Bearer ${key}` } } } }),
      hint: 'Restart Gemini CLI, then check the server with /mcp',
    },
    {
      id: 'claude-desktop', name: 'Claude Desktop', where: 'Add to claude_desktop_config.json',
      text: json({ mcpServers: { [SERVER_NAME]: { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${PB_REPLAY_AUTH}'], env: { PB_REPLAY_AUTH: `Bearer ${key}` } } } }),
      hint: 'Claude Desktop reaches the server through the mcp-remote bridge, which needs Node.js',
    },
    {
      id: 'other', name: 'Other', where: 'Any MCP client with Streamable HTTP',
      text: `URL: ${url}\nHeader: Authorization: Bearer ${key}`,
      hint: 'The server speaks MCP 2025-03-26 to 2026-07-28 and needs no sessions',
    },
  ];
}

// A dashboard link an agent was given: #session=<id>&at=<ms>, #issue=<id> or #log=<id>.
export type DashboardLink = { kind: 'session'; id: string; at?: number } | { kind: 'issue' | 'log'; id: string };

export function parseDashboardLink(hash: string): DashboardLink | undefined {
  const values = new URLSearchParams(hash.replace(/^#/, ''));
  const id = (name: string) => { const value = values.get(name) ?? ''; return /^[a-z0-9]{15}$/.test(value) ? value : ''; };
  if (id('session')) {
    const at = Number(values.get('at'));
    return Number.isSafeInteger(at) && at > 0 ? { kind: 'session', id: id('session'), at } : { kind: 'session', id: id('session') };
  }
  if (id('issue')) return { kind: 'issue', id: id('issue') };
  if (id('log')) return { kind: 'log', id: id('log') };
  return undefined;
}

export function scopeText(scopes: AgentScope[]): string {
  const names = scopes.map((scope) => SCOPE_NAMES[scope] ?? scope);
  const text = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? 'nothing';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function relativeTime(ms: number, now: number): string {
  if (!(ms > 0)) return 'never';
  const seconds = Math.round(Math.abs(now - ms) / 1000);
  const future = ms > now;
  const amount = seconds < 60 ? `${seconds} s` : seconds < 3600 ? `${Math.round(seconds / 60)} min` : seconds < 86400 ? `${Math.round(seconds / 3600)} h` : `${Math.round(seconds / 86400)} d`;
  return seconds < 5 ? 'just now' : future ? `in ${amount}` : `${amount} ago`;
}

// What an agent asked for, in a few words: the tool, prompt or resource it used.
export function requestText(entry: AgentRequest): string {
  const name = entry.name || entry.method;
  if (entry.method === 'tools/call') return name;
  if (entry.method === 'resources/read') return `read ${name}`;
  if (entry.method === 'prompts/get') return `prompt ${name}`;
  return name;
}

type AdminRequest = (path: string, body?: unknown, method?: string) => Promise<any>;

export function installAgentsPanel(request: AdminRequest, base: string): { reset(): void } {
  const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = element<HTMLDialogElement>('agents-dialog');
  const opener = element('open-agents');
  // A page cached from before the panel existed has neither; the rest of the dashboard still works.
  if (!dialog || !opener) return { reset() {} };
  const form = element<HTMLFormElement>('agents-create');
  const keyValue = element<HTMLInputElement>('agents-key-value');
  const snippet = element('agents-snippet');
  const clients = element('agents-clients');
  const url = `${location.origin}${base}/api/replay/mcp`;
  let access: AgentAccess | undefined;
  let generation = 0;
  let busy = false;
  let setups: AgentSetup[] = [];
  let chosen = 'claude-code';

  const say = (message: string) => { element('agents-state').textContent = message; };
  const fail = (error: unknown) => { element('agents-error').textContent = error instanceof Error ? error.message : 'Request failed'; };

  function copy(text: string, field: HTMLElement | null, done: string): void {
    const current = generation;
    const select = () => {
      if (field instanceof HTMLInputElement) { field.focus(); field.select(); }
      else if (field) window.getSelection()?.selectAllChildren(field);
    };
    if (!navigator.clipboard) { select(); say('Selected, copy it with your browser'); return; }
    void navigator.clipboard.writeText(text).then(() => { if (current === generation) say(done); })
      .catch(() => { if (current === generation) { select(); say('Select and copy it with your browser'); } });
  }

  function clearSecret(): void {
    keyValue.value = '';
    setups = [];
    snippet.textContent = '';
    element('agents-created').hidden = true;
  }

  function showSetup(): void {
    const setup = setups.find((item) => item.id === chosen) ?? setups[0];
    if (!setup) return;
    for (const button of clients.querySelectorAll<HTMLButtonElement>('button')) {
      const selected = button.dataset.client === setup.id;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    element('agents-where').textContent = setup.where;
    snippet.textContent = setup.text;
    element('agents-snippet-hint').textContent = setup.hint;
  }

  function renderKeys(): void {
    const now = Date.now();
    const keys = access?.keys ?? [];
    element('agents-keys-empty').hidden = keys.length > 0;
    element('agents-keys').replaceChildren(...keys.map((key) => {
      const item = document.createElement('li');
      const info = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = key.label;
      const scopes = document.createElement('small');
      scopes.textContent = `Reads ${scopeText(key.scopes).toLowerCase()}`;
      const detail = document.createElement('small');
      const expired = key.expiresAt > 0 && key.expiresAt <= now;
      detail.textContent = [`${key.prefix}…`, `created ${new Date(key.createdAt).toLocaleDateString()}${key.createdBy ? ` by ${key.createdBy}` : ''}`,
        key.expiresAt ? `${expired ? 'expired' : 'expires'} ${new Date(key.expiresAt).toLocaleDateString()}` : 'never expires',
        key.lastUsedAt ? `last used ${relativeTime(key.lastUsedAt, now)}${key.lastClient ? ` by ${key.lastClient}` : ''}` : 'not used yet'].join(' · ');
      if (expired) item.classList.add('expired');
      info.append(name, scopes, detail);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'danger';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${key.label}`);
      remove.disabled = busy;
      remove.addEventListener('click', () => {
        if (!confirm(`Remove ${key.label}? Agents using this key lose access at once`)) return;
        void action(async (current) => {
          await request(`/api/replay/mcp/keys/${encodeURIComponent(key.id)}`, undefined, 'DELETE');
          if (current !== generation) return;
          await load(current);
          say('Key removed');
        });
      });
      item.append(info, remove);
      return item;
    }));
  }

  function renderActivity(): void {
    const now = Date.now();
    const entries = access?.audit ?? [];
    element('agents-activity-empty').hidden = entries.length > 0;
    element('agents-activity').replaceChildren(...entries.map((entry) => {
      const item = document.createElement('li');
      item.dataset.status = entry.status;
      const what = document.createElement('strong');
      what.textContent = requestText(entry);
      const detail = document.createElement('small');
      detail.textContent = [relativeTime(entry.timestamp, now), entry.keyLabel || 'removed key', entry.client,
        entry.status === 'ok' ? `${entry.durationMs} ms` : entry.status === 'denied' ? 'refused: outside the key\'s scopes' : entry.error || entry.status].filter(Boolean).join(' · ');
      item.title = new Date(entry.timestamp).toLocaleString();
      item.append(what, detail);
      return item;
    }));
  }

  function setBusy(value: boolean): void {
    busy = value;
    form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button').forEach((control) => { control.disabled = value || !access; });
    element('agents-keys').querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = value; });
  }

  async function load(current: number): Promise<void> {
    const result: AgentAccess = await request('/api/replay/mcp/keys');
    if (current !== generation) return;
    access = result;
    renderKeys();
    renderActivity();
  }

  async function action(operation: (current: number) => Promise<void>): Promise<void> {
    if (busy) return;
    const current = generation;
    element('agents-error').textContent = '';
    say('');
    setBusy(true);
    try { await operation(current); } catch (error) { if (current === generation) fail(error); } finally { if (current === generation) setBusy(false); }
  }

  clients.replaceChildren(...agentSetups(url, '').map((setup) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.dataset.client = setup.id;
    button.textContent = setup.name;
    button.addEventListener('click', () => { chosen = setup.id; showSetup(); });
    return button;
  }));
  clients.addEventListener('keydown', (event: KeyboardEvent) => {
    const buttons = [...clients.querySelectorAll<HTMLButtonElement>('button')];
    const index = buttons.findIndex((button) => button.dataset.client === chosen);
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -2;
    if (next === -2 || !buttons.length) return;
    event.preventDefault();
    const target = buttons[(next + buttons.length) % buttons.length];
    chosen = target.dataset.client!;
    showSetup();
    target.focus();
  });

  opener.addEventListener('click', () => {
    const current = ++generation;
    clearSecret();
    access = undefined;
    element('agents-url').textContent = url;
    element('agents-error').textContent = '';
    say('Loading agent access');
    element('agents-keys').replaceChildren();
    element('agents-activity').replaceChildren();
    setBusy(true);
    dialog.showModal();
    void load(current).then(() => { if (current === generation) say(''); })
      .catch((error: unknown) => { if (current === generation) { say(''); fail(error); } })
      .finally(() => { if (current === generation) setBusy(false); });
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy || !access) return;
    const label = (form.elements.namedItem('label') as HTMLInputElement).value.trim();
    const scopes = [...form.querySelectorAll<HTMLInputElement>('input[name="scope"]:checked')].map((input) => input.value);
    const expiresInDays = Number((form.elements.namedItem('expires') as HTMLSelectElement).value);
    if (!label) return;
    if (!scopes.length) { fail(new Error('Choose at least one kind of data the agent may read')); return; }
    void action(async (current) => {
      clearSecret();
      const result: { key: AgentKey; secret: string } = await request('/api/replay/mcp/keys', { label, scopes, expiresInDays });
      if (current !== generation) return;
      (form.elements.namedItem('label') as HTMLInputElement).value = '';
      keyValue.value = result.secret;
      setups = agentSetups(url, result.secret);
      element('agents-created').hidden = false;
      showSetup();
      await load(current);
      say('Key created. Copy it or a setup below before closing this panel');
      keyValue.focus();
      keyValue.select();
    });
  });

  element('agents-copy-key').addEventListener('click', () => { if (keyValue.value) copy(keyValue.value, keyValue, 'Key copied'); });
  element('agents-copy-snippet').addEventListener('click', () => { if (snippet.textContent) copy(snippet.textContent, snippet, 'Setup copied'); });
  element('agents-copy-url').addEventListener('click', () => copy(url, element('agents-url'), 'Server URL copied'));
  element('agents-refresh').addEventListener('click', () => { void action((current) => load(current)); });
  const close = () => { generation++; clearSecret(); };
  element('close-agents').addEventListener('click', () => { close(); dialog.close(); });
  dialog.addEventListener('cancel', close);
  dialog.addEventListener('close', () => { if (!dialog.open) close(); });
  return {
    reset(): void {
      close();
      access = undefined;
      dialog.close();
      element('agents-keys').replaceChildren();
      element('agents-activity').replaceChildren();
      element('agents-error').textContent = '';
      say('');
    },
  };
}
