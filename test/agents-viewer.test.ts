import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentSetups, relativeTime, requestText, scopeText, type AgentRequest } from '../viewer/agents';

const url = 'https://replay.example.com/api/replay/mcp';
const key = 'pbr_mcp_' + 'A1b2C3d4'.repeat(5);

test('every agent gets a setup that names the server URL and sends the key as a bearer token', () => {
  const setups = agentSetups(url, key);
  assert.deepEqual(setups.map((setup) => setup.id), ['claude-code', 'cursor', 'vscode', 'windsurf', 'codex', 'gemini', 'claude-desktop', 'other']);
  for (const setup of setups) {
    assert.ok(setup.text.includes(url), setup.id);
    assert.ok(setup.where && setup.hint, setup.id);
  }
  assert.equal(setups[0].text, `claude mcp add --transport http --scope user pocketbase-replay ${url} --header "Authorization: Bearer ${key}"`);
  const cursor = JSON.parse(setups[1].text);
  assert.deepEqual(cursor, { mcpServers: { 'pocketbase-replay': { url, headers: { Authorization: `Bearer ${key}` } } } });
  assert.deepEqual(JSON.parse(setups[3].text).mcpServers['pocketbase-replay'], { serverUrl: url, headers: { Authorization: `Bearer ${key}` } });
  assert.deepEqual(JSON.parse(setups[5].text).mcpServers['pocketbase-replay'], { httpUrl: url, headers: { Authorization: `Bearer ${key}` } });
  const desktop = JSON.parse(setups[6].text).mcpServers['pocketbase-replay'];
  assert.deepEqual(desktop.args, ['-y', 'mcp-remote', url, '--header', 'Authorization:${PB_REPLAY_AUTH}']);
  assert.equal(desktop.env.PB_REPLAY_AUTH, `Bearer ${key}`);
});

test('setups that live in files people commit keep the key out of them', () => {
  const [, , vscode, , codex] = agentSetups(url, key);
  // VS Code asks for the key and keeps it in its secret storage.
  const config = JSON.parse(vscode.text);
  assert.ok(!vscode.text.includes(key));
  assert.equal(config.inputs[0].password, true);
  assert.equal(config.servers['pocketbase-replay'].headers.Authorization, 'Bearer ${input:pocketbase-replay-key}');
  assert.equal(config.servers['pocketbase-replay'].type, 'http');
  // Codex reads it from an environment variable.
  assert.equal(codex.text, `[mcp_servers.pocketbase-replay]\nurl = "${url}"\nbearer_token_env_var = "PB_REPLAY_MCP_KEY"`);
  assert.ok(codex.hint.includes(`export PB_REPLAY_MCP_KEY=${key}`));
});

test('keys and requests are described in a few plain words', () => {
  assert.equal(scopeText(['issues', 'logs', 'recordings']), 'Issues and errors, logs and recordings');
  assert.equal(scopeText(['logs']), 'Logs');
  const now = Date.UTC(2026, 9, 16, 12);
  assert.equal(relativeTime(0, now), 'never');
  assert.equal(relativeTime(now - 2000, now), 'just now');
  assert.equal(relativeTime(now - 90 * 60000, now), '2 h ago');
  assert.equal(relativeTime(now + 3 * 86400000, now), 'in 3 d');
  const entry = (method: string, name: string) => ({ method, name } as AgentRequest);
  assert.equal(requestText(entry('tools/call', 'investigate_issue')), 'investigate_issue');
  assert.equal(requestText(entry('resources/read', 'pbreplay://issue/abc')), 'read pbreplay://issue/abc');
  assert.equal(requestText(entry('prompts/get', 'fix-issue')), 'prompt fix-issue');
});
