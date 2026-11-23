// Development only: publishes a fictional programme and creates local test staff.
//   DATABASE_URL=<loopback owner URL> node scripts/provision-local.mjs <accounts.json> <logins.txt>
// Run `npm run build` first. Both output files hold local test credentials: keep them out of git.
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { localPasswordHash } from '../dist/src/modules/auth/crypto.js';
import { parseEligibilityRuleSnapshot } from '../dist/src/modules/eligibility/rules.js';

const [accountsFile, loginsFile] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url || !accountsFile || !loginsFile || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
  console.error('A loopback DATABASE_URL and two output paths are required.');
  process.exit(1);
}

const READ = 'eligibility.read-submission';
const staff = [
  ['manager@example.test', 'Programme Manager', ['assignment.manage', 'eligibility.screen', 'decision.publish', READ]],
  ['officer@example.test', 'Eligibility Officer', ['assignment.manage', 'eligibility.verify', READ]],
  ['reviewer1@example.test', 'Reviewer One', ['evaluation.write', 'evaluation.submit', READ]],
  ['reviewer2@example.test', 'Reviewer Two', ['evaluation.write', 'evaluation.submit', READ]],
  ['adjudicator@example.test', 'Adjudicator', ['adjudication.read', 'adjudication.decide', READ]],
];

const criteria = [
  ['problem', 'Problem and innovation', 'Is the problem clear, and what does the idea do differently?', 25],
  ['market', 'Market potential', 'Who would use or pay for it, and how many?', 25],
  ['feasibility', 'Feasibility', 'Can the team build and sustain it?', 20],
  ['team', 'Team', 'Does the proposal show the skills it needs?', 15],
  ['impact', 'Impact', 'Who benefits, and how would the difference be measured?', 15],
];
const config = {
  themes: ['digital', 'sustainable', 'inclusive'],
  reviewersPerApplication: 2,
  criteriaText: criteria.map(([id, name, description]) => ({ id, name, description })),
  reviewPolicy: {
    schemaVersion: 1,
    // Scores run 1 to 5. weight / 5 makes a perfect review total 100.
    scoring: {
      aggregation: 'WEIGHTED_SUM',
      criteria: criteria.map(([id, , , weight]) => ({ id, minimum: 1, maximum: 5, evidenceRequired: true, weight: weight / 5 })),
    },
  },
  // Resubmission is not implemented, so a revision request is not an available outcome.
  decisionPolicy: { schemaVersion: 1, permittedOutcomes: ['APPROVED', 'REJECTED'] },
};

const db = new pg.Client({ connectionString: url });
await db.connect();
try {
  await db.query('BEGIN');
  if ((await db.query("SELECT 1 FROM programmes WHERE code='ICH-2026'")).rowCount) throw new Error('Already provisioned.');

  const programmeId = randomUUID();
  const versionId = randomUUID();
  await db.query('INSERT INTO programmes (id,code,name) VALUES ($1,$2,$3)', [programmeId, 'ICH-2026', 'CEDA Innovation Challenge 2026']);
  await db.query(
    `INSERT INTO programme_versions (id,programme_id,version,published_at,opens_at,closes_at,config)
     VALUES ($1,$2,1,now(),now()-interval '1 minute',now()+interval '30 days',$3)`,
    [versionId, programmeId, JSON.stringify(config)],
  );

  const ruleId = randomUUID();
  const snapshot = {
    schemaVersion: 1, ruleVersion: ruleId,
    requirements: [{ id: 'botswana-citizen', mandatory: true, waivable: false, rule: { kind: 'attestation' } }],
  };
  await db.query(
    `INSERT INTO eligibility_rule_versions (id,programme_id,programme_version_id,version,schema_version,snapshot,digest,published_at)
     VALUES ($1,$2,$3,1,1,$4,$5,now())`,
    [ruleId, programmeId, versionId, JSON.stringify(snapshot), parseEligibilityRuleSnapshot({ eligibilityRules: snapshot }).digest],
  );

  const issuer = randomUUID();
  await db.query("INSERT INTO users (id,email,name,status) VALUES ($1,$2,'Local provisioning','ACTIVE')", [issuer, `provisioning-${issuer}@example.test`]);

  const accounts = [];
  const logins = ['CEDA local staff test logins (this computer only)', 'Open: http://localhost:5173/staff', ''];
  for (const [email, name, permissions] of staff) {
    const userId = randomUUID();
    await db.query("INSERT INTO users (id,email,name,status) VALUES ($1,$2,$3,'ACTIVE')", [userId, email, name]);
    await db.query("INSERT INTO identities (id,issuer,subject,user_id) VALUES ($1,'urn:ceda:local-development',$2,$3)", [randomUUID(), email, userId]);
    for (const permission of permissions) {
      await db.query(
        'INSERT INTO programme_grants (id,user_id,programme_id,permission,granted_by_id,granted_at) VALUES ($1,$2,$3,$4,$5,now())',
        [randomUUID(), userId, programmeId, permission, issuer],
      );
    }
    const password = `Ceda-${randomBytes(12).toString('hex').match(/.{6}/g).join('-')}`;
    accounts.push({ email, name, passwordHash: localPasswordHash(password) });
    logins.push(name, `  Email:    ${email}`, `  Password: ${password}`, '');
  }

  writeFileSync(accountsFile, JSON.stringify(accounts, null, 2));
  writeFileSync(loginsFile, logins.join('\r\n'));
  await db.query('COMMIT');
  console.log('Programme and 5 staff accounts provisioned.');
} catch (error) {
  await db.query('ROLLBACK');
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
