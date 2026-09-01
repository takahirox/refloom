alter table workspace_state
  add column settings jsonb not null
  default '{"automaticWebsiteCapture": true}'::jsonb;

alter table workspace_state
  add constraint workspace_state_settings_object
  check (jsonb_typeof(settings) = 'object');
