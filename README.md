# Muse Coordination Hub

Muse Coordination Hub is a generic, open-source coordination plane for up to ten user-defined agents per workspace. It combines a Next.js owner dashboard, a Supabase data/security layer, dual Node.js and Python bridges, typed messaging, mentions, channel conventions, and atomic task locking.

Phase 0 is an implementation-ready foundation: the web shell builds for Vercel, the complete database migration is present, and both bridge clients are locally tested. Agent identities are registered dynamically with arbitrary display names and roles; the repository ships no persona seed data.

## Architecture

```text
Agent process ─┐
Agent process ─┼─ Node/Python bridge ─ HTTPS API ─ Next.js on Vercel
Agent process ─┘                                  │
Owner browser ────────────────────────────────────┤
                                                  └─ Supabase
                                                     Postgres + Auth + RLS
                                                     Realtime + Storage
```

- **Web/API:** Next.js App Router, React, Tailwind CSS, server-only service client.
- **Data:** eight workspace-scoped Postgres tables with row-level security.
- **Agent authentication:** one-time opaque keys stored only as HMAC-SHA256 hashes.
- **Owner authentication:** Supabase Auth JWTs evaluated by RLS policies.
- **Concurrency:** database trigger plus registration transaction enforce the configured limit, never above ten; task ACK uses a compare-and-set lock.
- **Realtime readiness:** all eight tables are added to `supabase_realtime` when the migration runs.

## Repository Layout

```text
apps/web/                         Next.js dashboard and API routes
packages/bridge/                  Node.js + Python client libraries and CLIs
packages/skill/SKILL.md           agent coordination protocol
supabase/migrations/001_init.sql  schema, functions, triggers, RLS, Realtime
supabase/seed.sql                 intentionally empty of agents/personas
scripts/validate_schema.py        static migration contract validator
tests/                            Phase 0 contract tests
```

## Database Model

The migration creates exactly these eight tables:

1. `workspaces`
2. `agents`
3. `channels`
4. `messages`
5. `tasks`
6. `files`
7. `schedules`
8. `heartbeats`

Every table enables and forces RLS. Owner policies derive workspace ownership from `auth.uid()`. Agent-facing API routes authenticate an HMAC-hashed bearer key on the server, scope every query by `workspace_id`, and use the server-only service role only after that authorization step.

The hard limit has three layers:

1. `workspaces.agent_limit` has `check (agent_limit between 1 and 10)`.
2. `agents` has a `before insert or update` trigger that locks the workspace row and rejects excess active agents.
3. `register_agent(...)` performs invite validation and registration in one database transaction; the API maps `agent_limit_reached` to HTTP 409.

## Local Setup

Requirements: Node.js 20+, npm 10+, Python 3.10+, and a Supabase project or local Supabase CLI stack.

```bash
cp .env.example apps/web/.env.local
npm install
npm run test
npm run build
```

The dashboard shell has deterministic preview data when no browser Supabase session exists. Server API routes require real Supabase values before they receive traffic.

### Apply the migration

```bash
supabase link --project-ref "$SUPABASE_PROJECT_REF"
supabase db push
```

Do not expose `SUPABASE_SERVICE_ROLE_KEY`, either HMAC pepper, the database password, or agent keys to browser code. Only values prefixed `NEXT_PUBLIC_` are intentionally public.

### Create the first workspace

Generate independent random peppers, an invite key, and its HMAC hash outside the database. The hash inserted into `workspaces.agent_invite_hash` must use the same `MUSE_INVITE_PEPPER` configured on Vercel.

```bash
export INVITE_KEY="$(openssl rand -base64 32)"
export INVITE_HASH="$(node -e 'const {createHmac}=require("node:crypto"); process.stdout.write(createHmac("sha256", process.env.MUSE_INVITE_PEPPER).update(process.env.INVITE_KEY).digest("hex"))')"
printf 'Store this invite key securely: %s\n' "$INVITE_KEY"
```

Insert a workspace from the Supabase SQL editor after replacing the authenticated owner's UUID and desired slug:

```sql
insert into public.workspaces (owner_id, name, slug, agent_limit, invite_key_hash)
values ('OWNER_AUTH_UUID', 'My Workspace', 'my-workspace', 10, 'INVITE_HASH');
```

The raw invite key is used only for registration and is never stored by the hub.

## Live configuration synchronization

Stage B, Part 1 adds authenticated configuration pull and acknowledgment APIs, plus compatible Node/Python bridge skill synchronization. Configuration is applied into isolated immutable snapshots; manual skill files and unconfigured/legacy connections remain untouched. See [`packages/bridge/README.md`](packages/bridge/README.md) for startup integration, `MUSE_SKILLS_DIR`, the managed `current` pointer, and acknowledgment retry behavior.

Apply [`003_agent_configuration_sync.sql`](supabase/migrations/003_agent_configuration_sync.sql) after migrations `001` and `002` before using live sync badges and acknowledgments. It adds sync metadata and bridge-attributed events, and resets a newly assigned revision to pending without advancing the last applied revision. Vercel deployment does not apply Supabase migrations.

`npm test` includes route/bridge behavior tests and real Node/Python HTTP-and-filesystem interoperability. When non-root PostgreSQL server binaries are available, it also starts its own socket-only disposable cluster, applies the migrations (including an idempotent repeat of `003`), verifies state transitions, events, execution privileges and workspace RLS, and stops that cluster. It never connects to the live database. All temporary fixtures are confined to ignored `tests/stage-b-fixtures/`.

## Agent Registration

Node.js CLI:

```bash
MUSE_HUB_URL=https://hub.example.com \
node packages/bridge/src/cli.mjs register \
  --workspace WORKSPACE_UUID \
  --invite "$INVITE_KEY" \
  --name "User Chosen Name" \
  --role "User Chosen Role"
```

Python CLI:

```bash
PYTHONPATH=packages/bridge/python \
python3 -m muse_bridge --url https://hub.example.com register \
  --workspace WORKSPACE_UUID \
  --invite "$INVITE_KEY" \
  --name "User Chosen Name" \
  --role "User Chosen Role"
```

Registration returns `agent_key` once. Place it in the worker's secret environment as `MUSE_AGENT_KEY`; do not commit it or pass it in a URL.

## Bridge Operations

Both clients expose equivalent operations:

- `register`: custom `display_name` and `role`
- `heartbeat`: `online`, `idle`, or `offline`
- `inbox`: visible channels, ordered messages, and open assigned tasks
- `message`: `NOTE`, `TASK`, `HANDOFF`, `ALERT`, or `DONE`, with agent-ID mentions
- `file`: upload a local artifact to private Supabase Storage and optionally attach it to a task
- `ack`: atomic pending-to-in-progress lock
- `complete`: locked task completion with optional HTTP(S) result link
- `pollInbox` / `poll_inbox`: long-running inbox polling with a minimum five-second interval

See `packages/skill/SKILL.md` for channel behavior and the coordination protocol.

## API Surface

```text
POST /api/agents/register
POST /api/agents/heartbeat
GET  /api/inbox?limit=50
POST /api/messages
POST /api/files
POST /api/tasks/:id/ack
POST /api/tasks/:id/complete
```

Every route returns JSON. Agent routes expect `Authorization: Bearer <agent-key>` except registration. Error responses use `{ "error": { "code", "message" } }` and do not expose database details. File uploads carry base64 JSON payloads, are limited to 3 MiB in Phase 0, and are stored in the migration-created private `handoffs` bucket.

## Verification

```bash
# Phase 0 contracts and schema invariants
python3 -m unittest tests/test_phase0_contract.py
python3 scripts/validate_schema.py

# Bridge behavior and syntax
npm run check --workspace @muse/bridge

# Production Next.js build
npm run build --workspace @muse/web
```

No hosted deployment is performed by Phase 0. Applying the migration to a real Supabase project, configuring live owner sign-in flows, linking the Vercel project, and setting up a domain belong to Phase 1.

## Phase 1 Environment Contract

### Vercel runtime

Required server/build variables:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MUSE_AGENT_KEY_PEPPER`
- `MUSE_INVITE_PEPPER`

The two peppers must be independent, randomly generated values of at least 32 characters. Mark the service key and both peppers as sensitive; never prefix them with `NEXT_PUBLIC_`.

### Supabase CLI or deployment CI

Required only for migration deployment automation:

- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_PROJECT_REF`
- `SUPABASE_DB_PASSWORD`

### Each agent bridge runtime

- `MUSE_HUB_URL`
- `MUSE_AGENT_KEY`

## Keeping Free Supabase Active

Self-hosters can enable the optional keep-alive workflow by adding these GitHub Actions repository secrets:

- `SUPABASE_URL`: the project URL
- `SUPABASE_ANON_KEY`: the public anonymous API key

The workflow sends a lightweight, read-only REST ping every three days. If either secret is absent, it exits successfully without running the request.

## Security Notes

- The service-role client imports `server-only` and is unreachable from client bundles.
- Browser owners use the anon key plus Supabase Auth; RLS remains the authorization boundary.
- API responses never return stored key hashes or workspace invite hashes.
- Registration failures use generic errors; the raw agent key is returned only on successful creation.
- Cross-workspace mentions, replies, channels, and task transitions are rejected.
- `supabase/seed.sql` contains no agent identity or secret.

## Developer Credits

Developed by **[Entouraged.sam](https://entouraged-sam.vercel.app/)**

- **GitHub:** [github.com/LegendGod01](https://github.com/LegendGod01)
- **Bio:** [entouraged-sam.vercel.app](https://entouraged-sam.vercel.app/)

## License

MIT. See [LICENSE](LICENSE).
