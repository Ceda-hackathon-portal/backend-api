# Prisma 7 / Node 24 / PostgreSQL 17 compatibility spike

Windows x64 experiment only, not application business modules. All packages are dev dependencies, pinned in this directory's package-lock. No global Node/Postgres installation and no external database accepted by the runner. Native database binary is a third-party portable test distribution; its beta package tag is not a production deployment recommendation. Production database candidate remains supported PostgreSQL17/RDS.

From this directory, install locked tooling with npm.cmd ci --cache ../../.npm-cache (network approval may be needed). Npm11 may withhold package install scripts; inspect before enabling any. The runner reports whether required binaries are available; do not disable TLS verification to fetch engines.

Run on Windows:

```powershell
.\node_modules\node-win-x64\bin\node.exe run.mjs
```

The runner creates a fresh UUID-named .runtime directory and PostgreSQL17 cluster on a dynamically selected 127.0.0.1 port. initdb trust authentication is for loopback disposable fixtures ONLY. It never connects to an existing development or production database. Start/stop use hidden child processes; finally invokes pg_ctl fast shutdown. Ignored data is retained for inspection rather than automatically recursively deleted. Verify the cluster is stopped after a failed run; pg_ctl -D <exact-run-data-directory> status/stop only for a directory created by this runner.

Stages: Prisma validate/generate, two SQL migrations, repeat migrate deploy, migration status, strict TS compile and compiled ESM runtime tests. Fixtures exercise nullable/UUID/time/decimal/JSON/Unicode, FK/unique/check constraints, rollback, concurrent optimistic updates and SQL immutability. They do not implement submission services or policy.

No AWS, TLS bypass, identity provider, S3, production app schema, Express API or frontend integration. See ../../docs/COMPATIBILITY.md for actual observed results and unverified areas. Root package/lockfiles are untouched.
