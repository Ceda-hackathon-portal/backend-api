import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    assessOfficerEvidence,
    screenEligibility,
    type EligibilityEvidence,
    type EligibilityRequirement,
} from '../src/modules/eligibility/eligibilityPolicy.js';

const requirements = [
    { id: 'declaration', waivable: false, rule: { kind: 'attestation' } },
    { id: 'minimum', waivable: false, rule: { kind: 'number', operator: 'gte', threshold: 10, unit: 'units' } },
    { id: 'maximum', waivable: false, rule: { kind: 'number', operator: 'lte', threshold: 100, unit: 'units' } },
] satisfies EligibilityRequirement[];
const evidence = [
    { id: 'a', requirementId: 'declaration', verified: true, value: true },
    { id: 'b', requirementId: 'minimum', verified: true, value: 10, unit: 'units' },
    { id: 'c', requirementId: 'maximum', verified: true, value: 100, unit: 'units' },
] satisfies EligibilityEvidence[];

test('inclusive numerical thresholds and attestation produce MET', () => {
    assert.deepEqual(screenEligibility(requirements, evidence), {
        status: 'MET',
        findings: requirements.map(({ id }) => ({ requirementId: id, status: 'MET' })),
    });
});

test('values outside configured thresholds produce NOT_MET', () => {
    const changed = evidence.map((item) => item.id === 'b' ? { ...item, value: 9 } : item);
    assert.equal(assessOfficerEvidence(requirements, changed).status, 'NOT_MET');
    assert.equal(assessOfficerEvidence(requirements, [evidence[0]!, evidence[1]!, { ...evidence[2]!, value: 101 }]).status, 'NOT_MET');
});

test('absent, null, and missing values are UNKNOWN, including when another requirement fails', () => {
    const result = screenEligibility(requirements, [
        { ...evidence[0]!, value: false },
        { ...evidence[1]!, value: null },
        { id: 'missing-value', requirementId: 'maximum' },
    ]);
    assert.equal(result.status, 'UNKNOWN');
    assert.deepEqual(result.findings.map(({ status, unknownReason }) => [status, unknownReason]), [
        ['UNKNOWN', 'UNVERIFIED'], ['UNKNOWN', 'MISSING'], ['UNKNOWN', 'MISSING'],
    ]);
});

test('conflicting evidence is UNKNOWN regardless of input order', () => {
    const conflicting = [...evidence, { id: 'd', requirementId: 'minimum', verified: true, value: 11, unit: 'units' }];
    const forward = screenEligibility(requirements, conflicting);
    const reversed = screenEligibility(requirements, conflicting.toReversed());
    assert.deepEqual(forward, reversed);
    assert.deepEqual(forward.findings[1], { requirementId: 'minimum', status: 'UNKNOWN', unknownReason: 'CONFLICT' });
});

test('officer assessment is independent and has no completed flag or officer ID shortcut', () => {
    assert.equal(screenEligibility(requirements, evidence).status, 'MET');
    const finding = assessOfficerEvidence(requirements, [{ ...evidence[0]!, value: false }, ...evidence.slice(1)]);
    assert.equal(finding.status, 'NOT_MET');
    assert.equal('completed' in finding, false);
    assert.equal('officerId' in finding, false);
});

test('configuration and evidence validation rejects ambiguous or malformed inputs', () => {
    assert.throws(() => screenEligibility([], []), /At least one/);
    assert.throws(() => screenEligibility([requirements[0]!, requirements[0]!], []), /unique/);
    assert.throws(() => screenEligibility([{ id: 'x', rule: { kind: 'number', operator: 'gte', threshold: Number.NaN, unit: 'units' } }], []), /numerical/);
    assert.throws(() => screenEligibility(requirements, [...evidence, evidence[0]!]), /Evidence IDs/);
    assert.throws(() => screenEligibility(requirements, [{ id: 'x', requirementId: 'other', value: true }]), /unconfigured/);
    assert.throws(() => screenEligibility(requirements, [{ ...evidence[1]!, value: Number.POSITIVE_INFINITY }]), /does not match/);
    assert.throws(() => screenEligibility(requirements, [{ ...evidence[1]!, value: true }]), /does not match/);
    assert.throws(() => screenEligibility(requirements, [{ ...evidence[1]!, unit: 'other' }]), /unit/);
});

test('verified mandatory non-waivable failure outranks missing evidence but is never a decision', () => {
    const result = assessOfficerEvidence(requirements, [{ ...evidence[0]!, value: false }]);
    assert.equal(result.status, 'NOT_MET');
    assert.equal(result.findings[1]?.status, 'UNKNOWN');
    assert.equal('decision' in result, false);
    assert.equal(screenEligibility(requirements, [{ ...evidence[0]!, value: false }]).status, 'UNKNOWN');
});

test('unverified and waivable failures need review; optional and inapplicable rules do not block', () => {
    assert.equal(assessOfficerEvidence(requirements, [{ ...evidence[0]!, value: false, verified: false }, ...evidence.slice(1)]).status, 'UNKNOWN');
    assert.equal(assessOfficerEvidence(requirements, [{ ...evidence[0]!, verified: false }, ...evidence.slice(1)]).status, 'UNKNOWN');
    assert.equal(assessOfficerEvidence(requirements.map(r => ({ ...r, waivable: true })), [{ ...evidence[0]!, value: false }, ...evidence.slice(1)]).status, 'UNKNOWN');
    assert.equal(assessOfficerEvidence(requirements.map(r => ({ ...r, mandatory: false })), []).status, 'MET');
    assert.equal(assessOfficerEvidence(requirements.map(r => ({ ...r, applicable: false })), []).status, 'MET');
});

test('every configured finding survives aggregation, including optional and inapplicable UNKNOWNs', () => {
    const configured: EligibilityRequirement[] = [requirements[0]!,
        { ...requirements[1]!, mandatory: false }, { ...requirements[2]!, applicable: false }];
    const result = assessOfficerEvidence(configured, [{ ...evidence[0]!, value: false }]);
    assert.equal(result.status, 'NOT_MET');
    assert.deepEqual(result.findings.map(f => [f.requirementId, f.status]), [
        ['declaration', 'NOT_MET'], ['minimum', 'UNKNOWN'], ['maximum', 'UNKNOWN'],
    ]);
    assert.equal(assessOfficerEvidence(configured, [evidence[0]!]).status, 'MET');
});
