# Bridge clients

Node and Python clients for the configuration and task APIs.

## Live configuration sync (Stage B, Part 1)

The command-line clients synchronize configuration at startup and after heartbeats. Library users can explicitly call `client.syncConfiguration()` (Node) or `client.sync_configuration()` (Python) at startup; registration and heartbeat helpers also perform synchronization. Configuration endpoints use the same bearer key as the existing bridge APIs:

- `GET /api/agents/me/configuration`: pulls the active revision, resolved `SKILL.md` contents, role prompt/summary, and allowed actions; an unconfigured connection returns HTTP 204.
- `POST /api/agents/me/configuration/ack`: reports `staged`, `applied`, or `failed`, with an optional bounded error for failures.

Set `MUSE_SKILLS_DIR`, or pass `skillsDirectory` (Node) / `skills_directory` (Python), to choose the skill root. The default is `~/skills`. Each connection owns a separate `muse-managed/<connection-hash>/` namespace. A complete immutable revision contains skill directories and `configuration.json`; `current` is switched atomically only after all files are validated and written. Consumers should follow `current` when loading skills. Old snapshots and manual sibling files are retained, not replaced or deleted. Node and Python use compatible markers, snapshots, and content hashes, including CRLF and Unicode content.

A successful local apply is preserved when its acknowledgment cannot be delivered; the next heartbeat retries the acknowledgment. HTTP 204 and legacy HTTP 404 responses create no managed files. Filesystem conflicts, unmanaged entries, symlinks, corrupt snapshots, and unexpected paths fail closed rather than overwriting user-owned data. The bridges materialize configuration but do not execute actions or change any running model's system prompt.

Install Supabase migration `003_agent_configuration_sync.sql` after `001` and `002`. It records bridge-reported sync state and audit events; `applied_revision` advances only on an applied acknowledgment. Deployment does not automatically run database migrations.
