create table workspace_state (
  singleton boolean primary key default true check (singleton),
  revision bigint not null check (revision >= 0)
);
insert into workspace_state (singleton, revision) values (true, 0);

create table projects (
  id text primary key,
  title text not null,
  brief text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table "references" (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  title text,
  source_url text,
  creator text,
  notes text,
  captured_at timestamptz not null,
  capture_method text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (id, project_id)
);

create table assets (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  reference_id text not null references "references"(id) on delete cascade,
  kind text not null check (kind in ('image', 'video', 'url')),
  locator text not null,
  media_type text,
  captured_at timestamptz not null,
  provenance jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (id, reference_id),
  foreign key (reference_id, project_id) references "references"(id, project_id)
);

create table targets (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  reference_id text not null references "references"(id) on delete cascade,
  asset_id text,
  kind text not null check (kind in ('reference', 'asset', 'region', 'frame', 'interaction')),
  detail jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (id, project_id),
  foreign key (reference_id, project_id) references "references"(id, project_id),
  foreign key (asset_id, reference_id) references assets(id, reference_id),
  check (kind <> 'asset' or asset_id is not null)
);

create table moments (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  target_id text not null references targets(id) on delete cascade,
  label text,
  start_value double precision,
  end_value double precision,
  state jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (id, target_id),
  foreign key (target_id, project_id) references targets(id, project_id),
  check (start_value is null or start_value >= 0),
  check (end_value is null or end_value >= coalesce(start_value, 0))
);

create table selections (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  target_id text not null references targets(id) on delete cascade,
  moment_id text,
  aspect text not null,
  intent text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  foreign key (target_id, project_id) references targets(id, project_id),
  foreign key (moment_id, target_id) references moments(id, target_id)
);

create table boards (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  title text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table board_selections (
  board_id text not null references boards(id) on delete cascade,
  selection_id text not null references selections(id) on delete cascade,
  position integer not null check (position >= 0),
  primary key (board_id, selection_id),
  unique (board_id, position)
);

create table signals (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  event text not null check (event in ('capture', 'enrich', 'selection.create', 'board.change', 'export')),
  subject_type text not null,
  subject_id text not null,
  occurred_at timestamptz not null,
  facts jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table media_objects (
  id text primary key,
  object_key text not null unique,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes >= 0),
  media_type text,
  original_name text,
  created_at timestamptz not null
);

create index references_project_id_idx on "references" (project_id);
create index references_project_updated_idx on "references" (project_id, updated_at);
create index assets_project_id_idx on assets (project_id);
create index assets_reference_id_idx on assets (reference_id);
create index targets_project_id_idx on targets (project_id);
create index targets_reference_id_idx on targets (reference_id);
create index targets_asset_id_idx on targets (asset_id);
create index moments_project_id_idx on moments (project_id);
create index moments_target_id_idx on moments (target_id);
create index selections_project_id_idx on selections (project_id);
create index selections_target_id_idx on selections (target_id);
create index selections_moment_id_idx on selections (moment_id);
create index boards_project_id_idx on boards (project_id);
create index board_selections_board_position_idx on board_selections (board_id, position);
create index board_selections_selection_id_idx on board_selections (selection_id);
create index signals_project_id_idx on signals (project_id);
create index signals_project_occurred_idx on signals (project_id, occurred_at);
