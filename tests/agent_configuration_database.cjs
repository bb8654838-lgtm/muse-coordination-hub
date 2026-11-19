/* Starts and stops only its own PostgreSQL fixture; no live database access. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const probe = spawnSync("pg_config", ["--bindir"], { encoding: "utf8" });
if (probe.error || probe.status !== 0 || process.getuid?.() === 0) {
  console.log("Configuration PostgreSQL fixture skipped: non-root PostgreSQL installation required.");
} else {
  const bin = probe.stdout.trim();
  if (!["initdb", "pg_ctl", "psql"].every(name => fs.existsSync(path.join(bin, name)))) {
    console.log("Configuration PostgreSQL fixture skipped: server binaries unavailable.");
  } else {
    const fixtures = path.join(root, "tests", "stage-b-fixtures");
    fs.mkdirSync(fixtures, { recursive: true });
    const dir = fs.mkdtempSync(path.join(fixtures, "pg-"));
    const data = path.join(dir, "d"), sockets = path.join(dir, "s");
    fs.mkdirSync(sockets, { mode: 0o700 });
    assert.ok(Buffer.byteLength(path.join(sockets, ".s.PGSQL.5432")) < 104, "Fixture socket path is too long");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG")));
    Object.assign(env, { TMPDIR: dir, PGHOST: sockets, PGPORT: "5432", PGUSER: "muse_stage_b", PGDATABASE: "postgres", PGAPPNAME: "muse-stage-b-fixture" });
    const run = (name, args, input) => {
      const r = spawnSync(path.join(bin, name), args, { encoding: "utf8", env, input, timeout: 45000, maxBuffer: 1024 * 1024 });
      if (r.error || r.status !== 0) throw new Error(`${name} fixture failed: ${(r.stderr || r.error?.message || r.stdout || "").slice(-1800)}`);
      return r.stdout;
    };
    let started = false;
    try {
      run("initdb", ["-D", data, "--username=muse_stage_b", "--auth-local=trust", "--auth-host=reject", "--encoding=UTF8", "--no-locale"]);
      run("pg_ctl", ["-D", data, "-l", path.join(dir, "postgres.log"), "-w", "-o", `-k '${sockets}' -c listen_addresses='' -c shared_buffers=8MB -c max_connections=10 -c fsync=off -c synchronous_commit=off -c jit=off`, "start"]);
      started = true;
      run("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1"], `
        create role anon nologin;
        create role authenticated nologin;
        create role service_role nologin bypassrls;
        create schema auth;
        create table auth.users(id uuid primary key);
        create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
        grant usage on schema auth to public;
        create schema storage;
        create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
      `);
      for (const file of ["001_init.sql", "002_agent_configuration.sql", "003_agent_configuration_sync.sql", "003_agent_configuration_sync.sql"]) {
        run("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", path.join(root, "supabase", "migrations", file)]);
      }
      run("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", path.join(__dirname, "agent_configuration_database.sql")]);
      console.log("Configuration PostgreSQL migrations/idempotence/state/events/ACL/RLS passed.");
    } finally {
      if (started) run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
      assert.ok(!fs.existsSync(path.join(data, "postmaster.pid")), "Fixture PostgreSQL was not released");
    }
  }
}
