import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishedDecisionPolicy } from '../src/infrastructure/decision-config.js';

test('published decision policy accepts only explicitly configured supported outcomes', () => {
  assert.deepEqual(publishedDecisionPolicy({ decisionPolicy: { schemaVersion: 1, permittedOutcomes: ['APPROVED', 'REVISION_REQUESTED'] } }),
    { permittedOutcomes: ['APPROVED', 'REVISION_REQUESTED'] });
});

test('missing, malformed, duplicate or unsupported decision policy fails closed without defaults', () => {
  for (const config of [undefined, {}, { decisionPolicy: {} },
    { decisionPolicy: { schemaVersion: 1, permittedOutcomes: [] } },
    { decisionPolicy: { schemaVersion: 1, permittedOutcomes: ['APPROVED', 'APPROVED'] } },
    { decisionPolicy: { schemaVersion: 1, permittedOutcomes: ['AUTO_APPROVE'] } },
    { decisionPolicy: { schemaVersion: 1, permittedOutcomes: ['APPROVED'], threshold: 1 } }]) {
    assert.equal(publishedDecisionPolicy(config), null);
  }
});
