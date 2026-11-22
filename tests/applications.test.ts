import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ApplicationService, budgetDto, budgetDraftDto, parseStoredBudget, type Application, type ApplicationRepository, type ApplicationTransaction, type Submission } from '../src/modules/applications/service.js';
function fixture() {
    const owner = { userId: randomUUID(), sessionId: randomUUID(), authnLevel: 'oidc' };
    const other = { ...owner, userId: randomUUID() };
    const programmeId = randomUUID(), versionId = randomUUID();
    let state = { applications: new Map<string, Application>(), receipts: new Map<string, Submission>(), events: [] as string[] };
    let tail = Promise.resolve();
    let failAudit = false;
    let requirementsReady = false;
    const repository: ApplicationRepository = {
        transaction<T>(work: (tx: ApplicationTransaction) => Promise<T>): Promise<T> {
            const result = tail.then(async () => {
                const next = structuredClone(state);
                const tx: ApplicationTransaction = {
                    async submission() { return null; },
                    async requireProgrammePermission() { throw new Error('No staff grant in applicant fixture'); },
                    async now() { return new Date('2026-11-20T12:00:00Z'); },
                    async requireSession(principal) { assert.equal(principal.sessionId, owner.sessionId); },
                    async programme(id, version) { return id === programmeId && version === versionId ? { id: versionId, programmeId, opensAt: new Date('2026-11-19'), closesAt: new Date('2026-11-23'), themes: ['digital'] } : null; },
                    async applications() { return Array.from(next.applications.values()); },
                    async application(id) { return next.applications.get(id) ?? null; },
                    async requirements() { return requirementsReady ? { budget: { items: [{ description: 'Fictional item', amount: '1.00' }], fundingRequested: '', notApplicable: false }, documents: [{ id: randomUUID(), category: 'technical-proposal', name: 'fictional.pdf', contentType: 'application/pdf', sizeBytes: 100, sha256: 'a'.repeat(64), uploadedAt: new Date(), expiresAt: null }] } : { budget: { items: [], fundingRequested: '', notApplicable: false }, documents: [] }; },
                    async insert(application) { next.applications.set(application.id, application); },
                    async save(application) { next.applications.set(application.id, application); },
                    async receipt(actor, id, key) { return next.receipts.get([actor, id, key].join('/')) ?? null; },
                    async submit(application, submission, actor, key) { next.applications.set(application.id, application); next.receipts.set([actor, application.id, key].join('/'), submission); },
                    async record(_actor, _id, action) { if (failAudit)
                        throw new Error('audit unavailable'); next.events.push(action); },
                };
                const value = await work(tx);
                state = next;
                return structuredClone(value);
            });
            tail = result.then(() => { }, () => { });
            return result;
        },
    };
    return { service: new ApplicationService(repository), owner, other, programmeId, versionId, state: () => state, failAudit() { failAudit = true; }, ready() { requirementsReady = true; } };
}
const fields = { title: 'Idea', theme: 'digital', problem: 'Problem', solution: 'Solution', impact: 'Impact', team: 'Team' };
test('drafts keep half-typed budget rows that the submission rule rejects', () => {
    for (const budget of [
        { items: [{ description: '', amount: '' }], fundingRequested: '', notApplicable: false },
        { items: [{ description: 'Pump', amount: '' }], fundingRequested: '', notApplicable: false },
        { items: [{ description: '', amount: '10' }], fundingRequested: '', notApplicable: false },
        { items: [{ description: 'Pump', amount: '10' }], fundingRequested: '200', notApplicable: false },
    ]) {
        assert.deepEqual(budgetDraftDto.parse(budget), budget);
        assert.deepEqual(parseStoredBudget(budget), budget);
        assert.equal(budgetDto.safeParse(budget).success, false);
    }
    assert.equal(budgetDraftDto.safeParse({ items: [{ description: 'Pump', amount: '-1' }], fundingRequested: '', notApplicable: false }).success, false);
});
test('budget validation uses exact decimal amounts and reads legacy rows safely', () => {
    assert.deepEqual(parseStoredBudget({}), { items: [], fundingRequested: '', notApplicable: false });
    const value = budgetDto.parse({ items: [{ description: 'Fictional item', amount: '0.10' }], fundingRequested: '0.10', notApplicable: false });
    assert.equal(value.items[0]!.amount, '0.10');
    assert.throws(() => budgetDto.parse({ items: [{ description: 'Fictional item', amount: '1.00' }], fundingRequested: '1.01', notApplicable: false }));
});
test('application ownership, programme binding, stale revisions and invalid submissions', async () => {
    const f = fixture();
    await assert.rejects(f.service.create(f.owner, randomUUID(), f.versionId), { status: 404 });
    const app = await f.service.create(f.owner, f.programmeId, f.versionId);
    await assert.rejects(f.service.read(f.other, app.id), { status: 404 });
    await assert.rejects(f.service.update(f.other, app.id, 0, fields), { status: 404 });
    await assert.rejects(f.service.submit(f.owner, app.id, 0, 'submit'), { status: 422 });
    await f.service.update(f.owner, app.id, 0, fields);
    await assert.rejects(f.service.update(f.owner, app.id, 0, fields), { status: 409 });
});
test('concurrent submission retries return one immutable snapshot and receipt', async () => {
    const f = fixture();
    const app = await f.service.create(f.owner, f.programmeId, f.versionId);
    await f.service.update(f.owner, app.id, 0, fields);
    await assert.rejects(f.service.submit(f.owner, app.id, 1, 'missing'), { status: 422 });
    f.ready();
    const [a, b] = await Promise.all([f.service.submit(f.owner, app.id, 1, 'same'), f.service.submit(f.owner, app.id, 1, 'same')]);
    assert.deepEqual(a, b);
    a.fields.title = 'changed locally';
    assert.equal((await f.service.submit(f.owner, app.id, 1, 'same')).fields.title, fields.title);
    assert.equal(f.state().receipts.size, 1);
    assert.equal(f.state().events.filter(action => action === 'application.submitted').length, 1);
    await assert.rejects(f.service.submit(f.owner, app.id, 0, 'same'), { status: 409 });
    await assert.rejects(f.service.update(f.owner, app.id, 2, fields), { status: 409 });
});
test('audit failure rolls back application state and receipts', async () => {
    const f = fixture();
    const app = await f.service.create(f.owner, f.programmeId, f.versionId);
    await f.service.update(f.owner, app.id, 0, fields);
    f.ready();
    f.failAudit();
    await assert.rejects(f.service.submit(f.owner, app.id, 1, 'retry'), /audit unavailable/);
    assert.equal(f.state().applications.get(app.id)?.stage, 'DRAFT');
    assert.equal(f.state().receipts.size, 0);
});

test('structured applicant eligibility evidence is optional and cannot claim verification or provenance', async () => {
    const f = fixture();
    const app = await f.service.create(f.owner, f.programmeId, f.versionId);
    const updated = await f.service.update(f.owner, app.id, 0, { ...fields, eligibilityEvidence: [
        { requirementId: 'declared', value: true },
        { requirementId: 'amount', value: 12.5, unit: 'units' },
    ] });
    assert.deepEqual(updated.fields.eligibilityEvidence, [
        { requirementId: 'declared', value: true },
        { requirementId: 'amount', value: 12.5, unit: 'units' },
    ]);
    await assert.rejects(f.service.update(f.owner, app.id, 1, { ...fields, eligibilityEvidence: [
        { requirementId: 'declared', value: true, verified: true },
    ] }));
    await assert.rejects(f.service.update(f.owner, app.id, 1, { ...fields, eligibilityEvidence: [
        { requirementId: 'declared', value: true, evidenceId: 'client-controlled' },
    ] }));
    assert.equal((await f.service.read(f.owner, app.id)).revision, 1);
});
