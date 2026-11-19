#!/usr/bin/env python3
"""Exercise the real migrations on a private Unix-socket PostgreSQL cluster."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]
VERIFY = ROOT / ".verification"


def main() -> None:
    pg_config = shutil.which("pg_config")
    if not pg_config:
        raise SystemExit("PostgreSQL binaries unavailable; no SQL behavior checks were run.")
    binaries = Path(subprocess.check_output([pg_config, "--bindir"], text=True).strip())
    for name in ("initdb", "pg_ctl", "psql"):
        if not (binaries / name).is_file():
            raise SystemExit(f"Missing {name}; no SQL behavior checks were run.")
    VERIFY.mkdir(exist_ok=True)
    run = VERIFY / ("postgres-" + uuid.uuid4().hex[:12])
    run.mkdir(mode=0o700)
    data, sockets = run / "data", run / "socket"
    sockets.mkdir(mode=0o700)
    temporary = VERIFY / "tmp"
    temporary.mkdir(exist_ok=True)
    environment = dict(os.environ, TMPDIR=str(temporary))
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    running = False
    checked = []
    with (run / "validation.log").open("w") as log:
        def execute(command):
            subprocess.run([str(part) for part in command], cwd=ROOT, env=environment,
                           stdout=log, stderr=subprocess.STDOUT, check=True)
        try:
            execute([binaries / "initdb", "-D", data, "--username=stage_a_test",
                     "--auth-local=trust", "--auth-host=reject", "--no-locale", "--encoding=UTF8"])
            execute([binaries / "pg_ctl", "-D", data, "-l", run / "server.log", "-w", "start",
                     "-o", f"-F -c listen_addresses='' -k {sockets} -p {port}"])
            running = True
            psql = [binaries / "psql", "-X", "-q", "-h", sockets, "-p", str(port),
                    "-U", "stage_a_test", "-d", "postgres", "-v", "ON_ERROR_STOP=1"]
            fixtures = ROOT / "tests" / "fixtures"
            for source in [fixtures / "configuration_postgres_bootstrap.sql",
                           ROOT / "supabase/migrations/001_init.sql",
                           ROOT / "supabase/migrations/002_agent_configuration.sql",
                           ROOT / "supabase/migrations/002_agent_configuration.sql",
                           fixtures / "configuration_postgres_behavior.sql"]:
                execute([*psql, "-f", source])
                checked.append(str(source.relative_to(ROOT)))
        finally:
            if running:
                execute([binaries / "pg_ctl", "-D", data, "-m", "fast", "-w", "stop"])
    result = {"passed": True, "private_cluster_stopped": True, "checks": checked,
              "log": str(run / "validation.log")}
    (VERIFY / "stage-a-postgres-result.json").write_text(json.dumps(result, indent=2) + "\n")
    print("PostgreSQL configuration: PASS (001 + 002 + idempotent 002, owner RLS, CAS, neutral registration, immutable versions, applied_revision remains zero)")
    print(f"Private cluster stopped; evidence: {run / 'validation.log'}")


if __name__ == "__main__":
    main()
