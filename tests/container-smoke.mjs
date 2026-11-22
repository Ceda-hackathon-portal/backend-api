// Local disposable Linux Docker resources only. No AWS API calls or deployments.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
if (process.platform !== 'linux') throw new Error('Run this smoke test on a disposable Linux Docker host.');
function command(executable, args, allowedFailure = false) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 300000, windowsHide: true });
  if (result.status !== 0 && !allowedFailure) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error('Container verification command failed');
  }
  return result;
}
const context = JSON.parse(command('docker', ['context', 'inspect']).stdout)[0];
if (!context.Endpoints.docker.Host.startsWith('unix://') || (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix://'))) {
  throw new Error('Use a local disposable Docker daemon.');
}
const id = randomUUID().replaceAll('-', '');
const project = 'ceda-smoke-' + id;
const directory = resolve('.runtime', project);
const privateDirectory = join(directory, 'private');
mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
for (const name of ['compose.yml', 'Caddyfile', 'pg_hba.conf']) copyFileSync(join('ops/staging', name), join(directory, name));
const password = randomBytes(32).toString('hex');
const migrationPassword = randomBytes(32).toString('hex');
const runtimePassword = randomBytes(32).toString('hex');
const runtimeImage = 'ceda-backend:' + id;
const migrationImage = 'ceda-migration:' + id;
writeFileSync(join(privateDirectory, 'postgres_password'), password, { mode: 0o600 });
writeFileSync(join(privateDirectory, 'api.env'), [
  'DATABASE_URL=postgresql://ceda_app:' + runtimePassword + '@postgres:5432/ceda_staging',
  'ALLOWED_ORIGINS=https://portal.staging.example.test', 'AUTH_ENABLED=false',
].join('\n'), { mode: 0o600 });
writeFileSync(join(privateDirectory, 'migration.env'),
  'DATABASE_URL=postgresql://ceda_migrator:' + migrationPassword + '@postgres:5432/ceda_staging?sslmode=require&sslaccept=strict&sslcert=/run/db/ca.crt\n', { mode: 0o600 });
writeFileSync(join(directory, 'compose.env'), [
  'API_IMAGE=' + runtimeImage, 'MIGRATION_IMAGE=' + migrationImage,
  'API_HOST=api.staging.example.test', 'ACME_EMAIL=fixture@example.test',
].join('\n'));
const composeArguments = ['compose', '-p', project, '--env-file', join(directory, 'compose.env'), '-f', join(directory, 'compose.yml')];
const compose = (args, allowedFailure = false) => command('docker', [...composeArguments, ...args], allowedFailure);
const sql = statement => compose(['exec', '-T', '--user', 'postgres', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-d', 'ceda_staging', '-Atc', statement]).stdout.trim();
const inApi = source => compose(['exec', '-T', 'api', 'node', '--input-type=module', '-e', source]);
try {
  command('docker', ['build', '--target', 'migration', '-t', migrationImage, '.']);
  command('docker', ['build', '--target', 'runtime', '-t', runtimeImage, '.']);
  command('sh', ['ops/staging/create-db-tls.sh', join(privateDirectory, 'tls')]);
  const uid = command('docker', ['run', '--rm', '--entrypoint', 'id', 'postgres:17-bookworm', '-u', 'postgres']).stdout.trim();
  const gid = command('docker', ['run', '--rm', '--entrypoint', 'id', 'postgres:17-bookworm', '-g', 'postgres']).stdout.trim();
  command('docker', ['run', '--rm', '--user', '0', '-v', join(privateDirectory, 'tls') + ':/tls', '--entrypoint', 'sh', 'postgres:17-bookworm', '-c', 'chown ' + uid + ':' + gid + ' /tls/server.key && chmod 600 /tls/server.key']);
  compose(['config', '--quiet']);
  // Validate proxy configuration without starting ACME or exposing any listener.
  command('docker', ['run', '--rm', '-e', 'API_HOST=api.staging.example.test', '-e', 'ACME_EMAIL=fixture@example.test', '-v', join(directory, 'Caddyfile') + ':/etc/caddy/Caddyfile:ro', 'caddy:2', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile']);
  compose(['up', '-d', '--wait', 'postgres']);
  sql("CREATE ROLE ceda_migrator LOGIN PASSWORD '" + migrationPassword + "' NOSUPERUSER NOCREATEDB NOCREATEROLE; CREATE ROLE ceda_app LOGIN PASSWORD '" + runtimePassword + "' NOSUPERUSER NOCREATEDB NOCREATEROLE; ALTER SCHEMA public OWNER TO ceda_migrator;");
  compose(['up', '-d', '--wait', 'api']);
  assert.equal(sql("SELECT count(*) FROM pg_tables WHERE schemaname='public'"), '0', 'API startup must never run migrations');
  assert.notEqual(inApi("console.log(process.getuid())").stdout.trim(), '0');
  inApi("const r=await fetch('http://127.0.0.1:3001/health/live'); if(r.status!==200)process.exit(1)");
  // A separate operator invocation runs migrations with owner credentials.
  const migrate = ['--profile', 'tools', 'run', '--rm', 'migration', 'node', 'node_modules/prisma/build/index.js', 'migrate', 'deploy'];
  compose(migrate);
  const expectedMigrations = readdirSync('prisma/migrations', { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join('prisma/migrations', entry.name, 'migration.sql')))
    .map(entry => ({ name: entry.name, checksum: createHash('sha256').update(readFileSync(join('prisma/migrations', entry.name, 'migration.sql'))).digest('hex') }))
    .sort((left, right) => left.name.localeCompare(right.name));
  assert.ok(expectedMigrations.length > 0, 'The reviewed migration set must not be empty');
  const appliedMigrations = () => JSON.parse(sql(`SELECT COALESCE(json_agg(json_build_object('name',migration_name,'checksum',checksum) ORDER BY started_at,migration_name),'[]'::json)::text FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`));
  assert.deepEqual(appliedMigrations(), expectedMigrations, 'Every reviewed migration must apply in order with its original checksum');
  assert.match(compose(migrate).stdout, /No pending migrations to apply/);
  assert.deepEqual(appliedMigrations(), expectedMigrations, 'Repeat deployment must not change migration history');
  assert.equal(sql('SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL'), '0');
  assert.match(compose(['--profile', 'tools', 'run', '--rm', 'migration']).stdout, /Database schema is up to date/);
  compose(['cp', 'ops/runtime-role.sql', 'postgres:/tmp/runtime-role.sql']);
  compose(['exec', '-T', '--user', 'postgres', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-d', 'ceda_staging', '-f', '/tmp/runtime-role.sql']);
  sql('GRANT ceda_runtime TO ceda_app');
  inApi("import pg from 'pg';import fs from 'node:fs';const c=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:true,ca:fs.readFileSync('/run/db/ca.crt','utf8')}});await c.connect();const r=await c.query('SELECT current_user AS name,ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');if(r.rows[0].name!=='ceda_app'||!r.rows[0].ssl)process.exitCode=1;await c.query('SELECT count(*) FROM applications');await c.end()");
  inApi("import pg from 'pg';const c=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:true}});let rejected=false;try{await c.connect()}catch{rejected=true}finally{await c.end()}if(!rejected)process.exitCode=1");
  compose(['exec', '-T', 'api', 'node', 'healthcheck.mjs']);
  compose(['stop', '-t', '15', 'api']);
  const containerId = compose(['ps', '-a', '-q', 'api']).stdout.trim();
  assert.equal(command('docker', ['inspect', '--format', '{{.State.ExitCode}}', containerId]).stdout.trim(), '0');
  console.log('Container smoke passed: non-root compiled startup, TLS database, separate migration replay, runtime role, readiness and graceful shutdown.');
} finally {
  compose(['down', '--volumes', '--remove-orphans']);
  command('docker', ['image', 'rm', runtimeImage, migrationImage], true);
}
