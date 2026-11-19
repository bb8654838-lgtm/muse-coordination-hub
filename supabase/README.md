# Database migrations

Apply migrations in order:

1. `001_init.sql`: core workspace, authentication and task schema.
2. `002_agent_configuration.sql`: skills, roles, versioned configuration and owner save API.
3. `003_agent_configuration_sync.sql`: bridge-reported staged/applied/failed state and audit events.

Migration `003` is safe to apply again. It preserves the last applied revision when an owner saves a newer desired revision, grants acknowledgment execution only to `service_role`, and retains workspace owner RLS. Unconfigured records are not created by acknowledgment attempts. Vercel deployment does not automatically apply these SQL migrations.

`node tests/agent_configuration_database.cjs` exercises the migrations on a private, disposable, socket-only PostgreSQL cluster when server binaries are available. The fixture never connects to a live database and is stopped after the test.
