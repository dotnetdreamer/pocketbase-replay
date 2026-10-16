migrate((app) => {
  // Why a device in trigger mode uploaded what it kept, such as an error or a bug report.
  const sessions = app.findCollectionByNameOrId('replay_sessions');
  if (sessions.fields.getByName('trigger')) return;
  sessions.fields.add(new TextField({ name: 'trigger', max: 64 }));
  app.save(sessions);
}, (app) => {
  const sessions = app.findCollectionByNameOrId('replay_sessions');
  if (!sessions.fields.getByName('trigger')) return;
  sessions.fields.removeByName('trigger');
  app.save(sessions);
});
