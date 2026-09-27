migrate((app) => {
  // Only for a PocketBase that serves replay alone: throttle logins and close public sign-up.
  const settings = app.settings();
  const current = settings.rateLimits.rules || [];
  const rules = [];
  let auth = false;
  for (let i = 0; i < current.length; i++) {
    const rule = current[i];
    if (rule.label === '*:auth') auth = true;
    rules.push({ label: rule.label, audience: rule.audience || '', duration: rule.duration, maxRequests: rule.maxRequests });
  }
  if (!auth) rules.push({ label: '*:auth', audience: '', duration: 3, maxRequests: 2 });
  unmarshal({ rateLimits: { enabled: true, rules: rules } }, settings);
  app.save(settings);
  let users = null;
  try { users = app.findCollectionByNameOrId('users'); } catch (_) {}
  if (users) {
    unmarshal({ createRule: null }, users);
    app.save(users);
  }
}, () => {});
