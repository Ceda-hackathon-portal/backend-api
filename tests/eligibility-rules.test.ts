import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EligibilityConfigurationError, parseEligibilityRuleSnapshot } from '../src/modules/eligibility/rules.js';

const valid = { eligibilityRules: { schemaVersion: 1, ruleVersion: '00000000-0000-4000-8000-000000000001', requirements: [
  { id: 'incorporated', mandatory: true, waivable: false, rule: { kind: 'attestation' } },
  { id: 'revenue', mandatory: true, applicable: true, waivable: false, rule: { kind: 'number', operator: 'gte', threshold: 100, unit: 'units' } },
] } };

test('explicit versioned rule snapshot validates without supplying defaults', () => {
  const parsed = parseEligibilityRuleSnapshot(valid);
  assert.equal(parsed?.version, valid.eligibilityRules.ruleVersion);
  assert.equal(parsed?.requirements.length, 2);
  assert.equal(parsed?.digest.length, 64);
  assert.equal(parseEligibilityRuleSnapshot({ themes: ['x'] }), null);
});

test('malformed or unsupported snapshots raise controlled config errors', () => {
  for (const eligibilityRules of [null, {}, { ...valid.eligibilityRules, schemaVersion: 2 },
    { ...valid.eligibilityRules, requirements: [] },
    { ...valid.eligibilityRules, requirements: [{ id: 'unsafe id', rule: { kind: 'attestation' } }] },
    { ...valid.eligibilityRules, requirements: [{ id: 'x', rule: { kind: 'number', operator: 'gt', threshold: 1 } }] },
    { ...valid.eligibilityRules, requirements: [{ id: 'x', rule: { kind: 'number', operator: 'gte', threshold: 1 } }] },
    { ...valid.eligibilityRules, requirements: [valid.eligibilityRules.requirements[0], valid.eligibilityRules.requirements[0]] }]) {
    assert.throws(() => parseEligibilityRuleSnapshot({ eligibilityRules }), EligibilityConfigurationError);
  }
});
