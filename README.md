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

## Beginner Quickstart

Requirements: Node.js 20+, npm 10+, Python 3.10+ (for the Python bridge), and a Supabase project. A Vercel account is needed only for hosted deployment.

### 1. Install and configure the web app

Clone the repository, install dependencies, and copy the safe environment template.

Linux/macOS:

```bash
npm install
cp .env.example apps/web/.env.local
```

Windows PowerShell:

```powershell
npm install
Copy-Item .env.example apps/web/.env.local
```

Fill the three Supabase runtime values and two independent HMAC peppers in `apps/web/.env.local`. Generate each pepper separately with this cross-platform command:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Only variables prefixed with `NEXT_PUBLIC_` are browser-visible. Keep `SUPABASE_SERVICE_ROLE_KEY`, both HMAC peppers, database credentials, invite keys, and agent keys server-side and out of Git.

### 2. Apply Supabase migrations 001-003

Link the Supabase CLI and push the migrations. They run in filename order: `001_init.sql`, `002_agent_configuration.sql`, then `003_agent_configuration_sync.sql`.

```bash
npx supabase@latest login
npx supabase@latest link --project-ref "$SUPABASE_PROJECT_REF"
npx supabase@latest db push
```

On Windows PowerShell, use `$env:SUPABASE_PROJECT_REF` instead of `$SUPABASE_PROJECT_REF`. Alternatively, paste the three files from [`supabase/migrations`](supabase/migrations) into the Supabase SQL editor in the same order. Vercel deployment does **not** apply database migrations.

### 3. Create the owner and first workspace

1. In Supabase, open **Authentication -> Users**, create an email/password user, and copy its UUID. Muse has no public owner-signup route; the password stays in Supabase Auth and is not an application environment variable.
2. In the Supabase SQL editor, create the workspace. The all-zero bootstrap hash disables agent registration until you rotate the invite in the dashboard.

```sql
insert into public.workspaces (owner_id, name, agent_limit, agent_invite_hash)
values ('OWNER_AUTH_UUID', 'My Workspace', 10, repeat('0', 64));
```

3. Sign in at `/login`, open the owner dashboard, choose **Agent invite key**, and rotate it. The raw invite is displayed once; store it securely. Register agents with the commands in [Agent Registration](#agent-registration).

### 4. Run locally or deploy to Vercel

Local development:

```bash
npm run dev --workspace @muse/web
```

Open `http://localhost:3000/login`. Before a production deployment, run the same gates used by CI:

```bash
npm test
npm run check
npm run build
```

For Vercel, import the repository, keep the repository root as the project root, and add these five runtime variables in **Project Settings -> Environment Variables**:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MUSE_AGENT_KEY_PEPPER`
- `MUSE_INVITE_PEPPER`

Then deploy from the Vercel dashboard or CLI:

```bash
npx vercel@latest --prod
```

### 5. Configure up to 10 agents from `/admin`

After registering at least one agent, sign in as the workspace owner and open `/admin`:

1. Select a connected agent slot. A workspace can have at most 10 active agents.
2. In **Role template**, choose one of the 10 numbered starter presets, or keep a custom role.
3. Review the preset's skills and action permissions; presets are starting points, not hidden grants.
4. Save the configuration and repeat for each connected slot. The bridge acknowledgment moves the revision from pending to its applied state.

Configuration snapshots are isolated per connection. Manual skill directories and legacy or unconfigured agents are not overwritten.

### 6. Connect a Node or Python bridge with one command

Registration returns a one-time `agent_key`. Replace the placeholders below and choose one command; environment variables are safer than CLI key flags. The watcher polls the inbox and synchronizes the assigned configuration at startup.

Node, Linux/macOS:

```bash
MUSE_HUB_URL='http://localhost:3000' MUSE_AGENT_KEY='<agent-key>' node packages/bridge/src/cli.mjs inbox --watch --interval 60
```

Node, Windows PowerShell:

```powershell
$env:MUSE_HUB_URL='http://localhost:3000'; $env:MUSE_AGENT_KEY='<agent-key>'; node packages/bridge/src/cli.mjs inbox --watch --interval 60
```

Python, Linux/macOS:

```bash
MUSE_HUB_URL='http://localhost:3000' MUSE_AGENT_KEY='<agent-key>' PYTHONPATH=packages/bridge/python python3 -m muse_bridge inbox --watch --interval 60
```

Python, Windows PowerShell:

```powershell
$env:MUSE_HUB_URL='http://localhost:3000'; $env:MUSE_AGENT_KEY='<agent-key>'; $env:PYTHONPATH='packages/bridge/python'; py -m muse_bridge inbox --watch --interval 60
```

For a hosted hub, replace `http://localhost:3000` with the Vercel URL. Managed snapshots default to `./skills/muse-managed/<connection-hash>/`; library callers can select another root with `skillsDirectory` (Node) or `skills_directory` (Python).

## Live configuration synchronization

Stage B, Part 1 adds authenticated configuration pull and acknowledgment APIs, plus compatible Node/Python bridge skill synchronization. Configuration is applied into isolated immutable snapshots; manual skill files and unconfigured/legacy connections remain untouched. See [`packages/bridge/README.md`](packages/bridge/README.md) for startup integration, the managed `current` pointer, library directory options, and acknowledgment retry behavior.

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
