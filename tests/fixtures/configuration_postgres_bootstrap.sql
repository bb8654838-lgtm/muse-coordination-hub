-- Only for a fresh, disposable local PostgreSQL cluster.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
grant usage on schema auth to authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase's pre-existing private Storage bucket metadata boundary.
create schema storage;
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint
);
