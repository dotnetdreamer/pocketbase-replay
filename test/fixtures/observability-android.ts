import { Capacitor } from '../../plugins/capacitor/node_modules/@capacitor/core';
import { PocketBaseReplay } from '../../plugins/capacitor/src/index';
import { NativeReplay } from '../../plugins/capacitor/src/native';
import { fetchTransport } from '../../src/index';
import { nativeTransport } from '../../src/detect';
import type { ObservabilityEvent, ObservabilityMetrics, ReplayTransport } from '../../src/index';

declare const __REPLAY_ANDROID_ENDPOINT__: string;

const endpoint = __REPLAY_ANDROID_ENDPOINT__;
const metadata = () => ({ deviceId: 'android-observability-fixture', platform: 'android', appVersion: 'native-verification', room: 'ANDROID_TEST' });
const captured: ObservabilityEvent[] = [];
const uploaded: ObservabilityEvent[] = [];
const states: boolean[] = [];
let firstReply = false;
let startupBeforeReply = false;
let armed = false;
let backgroundSeen = false;
let metrics: ObservabilityMetrics | null = null;
const statuses = new Map<string, string>();
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

document.body.innerHTML = `<main><h1>Android replay verification</h1><p id="platform"></p><ul id="results" role="status"></ul>
  <button id="stack">Capture JS stack</button><button id="dom">Capture DOMException</button>
  <button id="group">Capture grouped errors</button><button id="replay">Start replay only</button>
  <button id="background">Arm background check</button><pre id="metrics"></pre></main>`;
const style = document.createElement('style');
style.textContent = 'body{font:16px system-ui;margin:0;padding:20px;color:#18212f;background:#fff}h1{font-size:22px}button{display:block;width:100%;padding:12px;margin:8px 0;font:inherit}ul{padding-left:20px}pre{font-size:12px;white-space:pre-wrap}';
document.head.append(style);

function show(name: string, text: string): void {
  statuses.set(name, text);
  document.querySelector('#results')!.replaceChildren(...Array.from(statuses.values(), value => {
    const row = document.createElement('li'); row.textContent = value; return row;
  }));
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function flush(): Promise<void> {
  await PocketBaseReplay.flush();
  metrics = (await PocketBaseReplay.getObservabilityMetrics()).metrics;
  document.querySelector('#metrics')!.textContent = JSON.stringify({ metrics, nativeStates: states, captured: captured.length, uploaded: uploaded.length }, null, 2);
  check(metrics && metrics.droppedEvents === 0 && metrics.networkErrors === 0, 'Capture or transport failed');
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(label);
    await wait(100);
  }
}

function capturedError(message: string) {
  return captured.find(event => event.kind === 'error' && event.message === message);
}

function uploadedMessage(message: string): boolean { return uploaded.some(event => event.message === message); }

function button(id: string, run: () => Promise<void>): void {
  const element = document.querySelector<HTMLButtonElement>('#' + id)!;
  element.addEventListener('click', () => {
    element.disabled = true;
    run().catch(error => show(id, 'FAIL ' + (error instanceof Error ? error.message : String(error))))
      .finally(() => { element.disabled = false; });
  });
}

async function boot(): Promise<void> {
  check(Capacitor.getPlatform() === 'android', 'Android bridge required');
  check(Capacitor.isPluginAvailable('PocketBaseReplay'), 'Native replay plugin missing');
  const actual = nativeTransport() ?? fetchTransport();
  document.querySelector('#platform')!.textContent = `Native Android bridge, ${nativeTransport() ? 'native HTTP' : 'fetch'} transport`;
  const transport: ReplayTransport = {
    post: async (url, body) => {
      if (!firstReply && url.endsWith('/observability/config')) await wait(1500);
      const response = await actual.post(url, body);
      if (url.endsWith('/observability/config')) firstReply = true;
      else if (url.endsWith('/errors') || url.endsWith('/logs')) uploaded.push(...JSON.parse(body).events);
      return response;
    },
  };
  await NativeReplay.addListener('appStateChange', state => {
    states.push(state.isActive);
    if (!armed) return;
    if (!state.isActive) {
      backgroundSeen = true;
      void PocketBaseReplay.captureLog({ level: 'info', message: 'Android native background', attributes: { source: 'handleOnStop' } });
    } else if (backgroundSeen) {
      armed = false;
      void (async () => {
        await PocketBaseReplay.captureException({ error: new Error('Android native resumed error') });
        await PocketBaseReplay.captureLog({ level: 'info', message: 'Android native resumed', attributes: { source: 'handleOnResume' } });
        await flush();
        check(uploadedMessage('Android background pending'), 'Pending background log lost');
        check(uploadedMessage('Android native background') && uploadedMessage('Android native resumed'), 'Native lifecycle logs lost');
        check(uploadedMessage('Android native resumed error'), 'Resume error lost');
        check(states.includes(false) && states.at(-1) === true, 'Native background and resume events missing');
        show('background', 'BACKGROUND PASS');
      })().catch(error => show('background', 'FAIL ' + String(error)));
    }
  });
  await PocketBaseReplay.startObservability({
    endpoint, metadata, service: 'android-native-verification', errors: { captureUnhandled: true }, logs: true, transport,
    beforeSend: event => {
      captured.push(event);
      if (event.message === 'Android startup before config') startupBeforeReply = !firstReply;
      return event;
    },
  });
  setTimeout(() => { throw new TypeError('Android startup before config'); }, 0);
  await until(() => firstReply && !!capturedError('Android startup before config'), 'Startup error was not captured');
  await flush();
  check(startupBeforeReply && uploadedMessage('Android startup before config'), 'Startup error did not survive the first reply');
  show('startup', 'STARTUP PASS');

  button('stack', async () => {
    setTimeout(function androidStackProbe() { throw new TypeError('Android real JS stack'); }, 0);
    await until(() => !!capturedError('Android real JS stack'), 'Unhandled JavaScript error missing');
    const event = capturedError('Android real JS stack');
    check(event?.kind === 'error' && event.stack?.includes('androidStackProbe') && event.handled === false, 'Chrome stack or unhandled status missing');
    await flush(); check(uploadedMessage('Android real JS stack'), 'JavaScript error was not uploaded');
    show('stack', 'STACK PASS');
  });
  button('dom', async () => {
    await PocketBaseReplay.captureException({ error: new DOMException('Android DOMException denied', 'NotAllowedError') });
    const event = capturedError('Android DOMException denied');
    check(event?.kind === 'error' && event.name === 'NotAllowedError', 'DOMException name or message missing');
    await flush(); check(uploadedMessage('Android DOMException denied'), 'DOMException was not uploaded');
    show('dom', 'DOMEXCEPTION PASS');
  });
  button('group', async () => {
    for (const message of ['Android grouped error alpha', 'Android grouped error beta']) {
      const result = await PocketBaseReplay.captureException({ error: new Error(message), groupingKey: 'android-native-group', attributes: { fixture: true } });
      check(result.id, 'Grouped error capture was refused');
    }
    await flush();
    const events = uploaded.filter(event => event.message.startsWith('Android grouped error'));
    check(events.length === 2 && events.every(event => event.attributes?.groupingKey === 'android-native-group'), 'Explicit grouping key missing');
    show('group', 'GROUPING PASS');
  });
  button('replay', async () => {
    await PocketBaseReplay.start({ endpoint, metadata, transport });
    await PocketBaseReplay.captureException({ error: new Error('Android after replay-only start') });
    await flush(); check(uploadedMessage('Android after replay-only start'), 'Replay-only start stopped observability');
    show('replay', 'REPLAY START PASS');
  });
  button('background', async () => {
    backgroundSeen = false; armed = true;
    await PocketBaseReplay.captureLog({ level: 'info', message: 'Android background pending' });
    show('background', 'BACKGROUND ARMED');
  });
  show('ready', 'READY');
}

void boot().catch(error => show('boot', 'FAIL ' + (error instanceof Error ? error.message : String(error))));
