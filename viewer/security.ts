import { OBSERVABILITY_RATE_DEFAULTS } from './observability';

const RATE_DEFAULTS = {
  replay: {
    config_requests_per_ip_minute: 120, start_requests_per_ip_minute: 30,
    upload_requests_per_ip_minute: 240, upload_mb_per_ip_hour: 64,
    sessions_per_device_hour: 12, sessions_per_ip_hour: 120, sessions_per_hour: 3000,
  },
  observability: OBSERVABILITY_RATE_DEFAULTS,
} as const;

type RateLimits = {
  -readonly [Group in keyof typeof RATE_DEFAULTS]: Record<keyof typeof RATE_DEFAULTS[Group], number>;
};

interface IngestionKey {
  id: string;
  label: string;
  prefix: string;
  createdAt: number;
}

interface SecuritySettings {
  requireApiKey: boolean;
  requireAccount: boolean;
  keys: IngestionKey[];
}

type AdminRequest = (path: string, body?: unknown, method?: string) => Promise<any>;

export function installSecurityPanel(request: AdminRequest): { reset(): void } {
  const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = element<HTMLDialogElement>('security-dialog');
  const settingsForm = element<HTMLFormElement>('security-settings');
  const createForm = element<HTMLFormElement>('security-create-key');
  const limitsForm = element<HTMLFormElement>('security-limits');
  const limitGroups = ['replay', 'observability'] as const;
  const input = (form: HTMLFormElement, name: string) => form.elements.namedItem(name) as HTMLInputElement;
  const rawKey = element<HTMLInputElement>('security-key-value');
  let settings: SecuritySettings | undefined;
  let limits: RateLimits | undefined;
  let generation = 0;
  let busy = false;

  function clearKey(): void {
    rawKey.value = '';
    element('security-created-key').hidden = true;
  }

  function showRequirements(): void {
    if (!settings) return;
    input(settingsForm, 'requireApiKey').checked = settings.requireApiKey;
    input(settingsForm, 'requireAccount').checked = settings.requireAccount;
  }

  function showLimits(value: RateLimits): void {
    for (const group of limitGroups) {
      const values: Record<string, number> = value[group];
      for (const key of Object.keys(RATE_DEFAULTS[group])) {
        input(limitsForm, `${group}.${key}`).value = String(values[key]);
      }
    }
  }

  function setLimitsBusy(value: boolean): void {
    limitsForm.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach((control) => {
      control.disabled = value || !limits;
    });
  }

  function updateKeyHint(): void {
    element('security-key-hint').textContent = settings?.keys.length
      ? 'Add the key to your app before turning this on. Apps without a valid key will stop sending data.'
      : 'Create an API key below to enable this option. Then add the key to your app before turning it on.';
  }

  function render(): void {
    if (!settings) return;
    const requireKey = input(settingsForm, 'requireApiKey');
    const requireAccount = input(settingsForm, 'requireAccount');
    requireKey.disabled = busy || settings.keys.length === 0;
    if (settings.keys.length === 0) requireKey.checked = false;
    requireAccount.disabled = busy;
    settingsForm.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled = busy;
    createForm.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled = busy;
    input(createForm, 'label').disabled = busy;
    setLimitsBusy(busy);
    updateKeyHint();
    element('security-keys-empty').hidden = settings.keys.length > 0;
    element('security-keys').replaceChildren(...settings.keys.map((key) => {
      const item = document.createElement('li');
      const info = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = key.label;
      const detail = document.createElement('small');
      detail.textContent = `${key.prefix}… · ${new Date(key.createdAt).toLocaleDateString()}`;
      info.append(name, detail);
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'danger';
      revoke.textContent = 'Remove';
      revoke.setAttribute('aria-label', `Remove ${key.label}`);
      revoke.disabled = busy || (settings!.requireApiKey && settings!.keys.length === 1);
      if (settings!.requireApiKey && settings!.keys.length === 1) {
        const reason = document.createElement('small');
        reason.id = 'security-last-key-hint';
        reason.textContent = 'Create another key, or turn off Require API key and save, to remove this key.';
        info.append(reason);
        revoke.title = reason.textContent;
        revoke.setAttribute('aria-describedby', reason.id);
      }
      revoke.addEventListener('click', () => {
        if (!confirm(`Remove ${key.label}? Apps using this key will stop sending data while API keys are required.`)) return;
        void action(async (current) => {
          const result: SecuritySettings = await request(`/api/replay/security/keys/${encodeURIComponent(key.id)}`, undefined, 'DELETE');
          if (current !== generation) return;
          clearKey();
          settings = result;
          element('security-state').textContent = 'Key removed';
        });
      });
      item.append(info, revoke);
      return item;
    }));
  }

  function setBusy(value: boolean): void {
    busy = value;
    const settingsDisabled = value || !settings;
    input(settingsForm, 'requireApiKey').disabled = settingsDisabled || !settings?.keys.length;
    input(settingsForm, 'requireAccount').disabled = settingsDisabled;
    settingsForm.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled = settingsDisabled;
    createForm.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled = settingsDisabled;
    input(createForm, 'label').disabled = settingsDisabled;
    setLimitsBusy(value);
    element('security-keys').querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
      button.disabled = value || (!!settings?.requireApiKey && settings.keys.length === 1);
    });
  }

  async function action(operation: (current: number) => Promise<void>, feedback = 'security'): Promise<void> {
    if (busy) return;
    const current = generation;
    element(`${feedback}-error`).textContent = '';
    element(`${feedback}-state`).textContent = '';
    setBusy(true);
    try {
      await operation(current);
      if (current === generation) render();
    } catch (error) {
      if (current === generation) {
        element(`${feedback}-state`).textContent = '';
        element(`${feedback}-error`).textContent = error instanceof Error ? error.message : 'Request failed';
      }
    } finally {
      if (current === generation) setBusy(false);
    }
  }

  element('open-security').addEventListener('click', () => {
    const current = ++generation;
    clearKey();
    element('security-error').textContent = '';
    element('security-state').textContent = 'Loading settings...';
    settings = undefined;
    limits = undefined;
    limitsForm.reset();
    element('security-limits-error').textContent = '';
    element('security-limits-state').textContent = 'Loading limits...';
    element('security-keys').replaceChildren();
    setBusy(true);
    dialog.showModal();
    void request('/api/replay/security').then((result: SecuritySettings) => {
      if (current !== generation) return;
      settings = result;
      showRequirements();
      element('security-state').textContent = '';
      render();
    }).catch((error: unknown) => {
      if (current !== generation) return;
      element('security-state').textContent = '';
      element('security-error').textContent = error instanceof Error ? error.message : 'Could not load settings';
    }).finally(() => {
      if (current === generation) setBusy(false);
    });
    void request('/api/replay/security/limits').then((result: RateLimits) => {
      if (current !== generation) return;
      limits = result;
      showLimits(result);
      element('security-limits-state').textContent = '';
      setLimitsBusy(busy);
    }).catch((error: unknown) => {
      if (current !== generation) return;
      element('security-limits-state').textContent = '';
      element('security-limits-error').textContent = error instanceof Error ? error.message : 'Could not load limits';
    });
  });

  limitsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy || !limits || !limitsForm.reportValidity()) return;
    const next = Object.fromEntries(limitGroups.map((group) => [group,
      Object.fromEntries(Object.keys(RATE_DEFAULTS[group]).map((key) => [key, Number(input(limitsForm, `${group}.${key}`).value)])),
    ])) as RateLimits;
    void action(async (current) => {
      element('security-limits-state').textContent = 'Saving limits...';
      const result: RateLimits = await request('/api/replay/security/limits', next);
      if (current !== generation) return;
      limits = result;
      showLimits(result);
      element('security-limits-state').textContent = 'Limits saved. New requests use these limits';
    }, 'security-limits');
  });

  element('security-limits-defaults').addEventListener('click', () => {
    if (busy || !limits) return;
    showLimits(RATE_DEFAULTS);
    element('security-limits-error').textContent = '';
    element('security-limits-state').textContent = 'Default limits selected. Click Save limits to apply';
  });

  settingsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy || !settings) return;
    const next = {
      requireApiKey: input(settingsForm, 'requireApiKey').checked,
      requireAccount: input(settingsForm, 'requireAccount').checked,
    };
    if (!busy && next.requireApiKey && !settings?.keys.length) {
      element('security-error').textContent = 'Create an API key below before saving. Give it a name and click Create key';
      input(createForm, 'label').focus();
      return;
    }
    void action(async (current) => {
      const result: SecuritySettings = await request('/api/replay/security', next);
      if (current !== generation) return;
      settings = result;
      showRequirements();
      element('security-state').textContent = 'Settings saved. These settings apply to new requests';
    });
  });

  input(settingsForm, 'requireApiKey').addEventListener('change', () => {
    element('security-error').textContent = '';
    updateKeyHint();
  });

  createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy || !settings) return;
    const label = input(createForm, 'label').value.trim();
    if (!label) return;
    void action(async (current) => {
      clearKey();
      const result: { key: IngestionKey; apiKey: string } = await request('/api/replay/security/keys', { label });
      if (current !== generation) return;
      settings = { ...settings!, keys: [...settings!.keys, result.key] };
      input(createForm, 'label').value = '';
      rawKey.value = result.apiKey;
      element('security-created-key').hidden = false;
      element('security-state').textContent = 'Key created. Copy it before closing this panel';
      rawKey.focus();
      rawKey.select();
    });
  });

  element('security-copy-key').addEventListener('click', () => {
    const key = rawKey.value;
    if (!key) return;
    const current = generation;
    if (!navigator.clipboard) {
      rawKey.focus();
      rawKey.select();
      element('security-state').textContent = 'Key selected. Copy it with your browser';
      return;
    }
    void navigator.clipboard.writeText(key).then(() => {
      if (current === generation) element('security-state').textContent = 'Key copied';
    }).catch(() => {
      if (current !== generation) return;
      rawKey.focus();
      rawKey.select();
      element('security-state').textContent = 'Select and copy the key with your browser';
    });
  });

  element('close-security').addEventListener('click', () => { generation++; clearKey(); dialog.close(); });
  dialog.addEventListener('cancel', () => { generation++; clearKey(); });
  dialog.addEventListener('close', () => { if (!dialog.open) { generation++; clearKey(); } });
  return {
    reset(): void {
      generation++;
      clearKey();
      settings = undefined;
      limits = undefined;
      limitsForm.reset();
      setLimitsBusy(true);
      dialog.close();
      element('security-keys').replaceChildren();
      input(createForm, 'label').value = '';
      element('security-error').textContent = '';
      element('security-state').textContent = '';
      element('security-limits-error').textContent = '';
      element('security-limits-state').textContent = '';
    },
  };
}
