alter table "references" add column analyses jsonb not null default '[]'::jsonb;
alter table "references" add constraint reference_analyses_array check (jsonb_typeof(analyses) = 'array');
