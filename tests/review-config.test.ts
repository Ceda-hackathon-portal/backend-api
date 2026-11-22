import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishedScoringConfig } from '../src/infrastructure/review-config.js';

test('scoring config is read only from an explicit versioned publication snapshot', () => {
  const scoring = { criteria: [{ id: 'configured-criterion', minimum: 0, maximum: 8, evidenceRequired: true }] } as const;
  assert.deepEqual(publishedScoringConfig({ themes: ['digital'], reviewPolicy: { schemaVersion: 1, scoring } }), scoring);
  assert.equal(publishedScoringConfig({ themes: ['digital'] }), null);
  assert.equal(publishedScoringConfig({ reviewPolicy: { schemaVersion: 2, scoring } }), null);
});

test('invalid published scoring config fails closed without default criteria or thresholds', () => {
  assert.equal(publishedScoringConfig({ reviewPolicy: { schemaVersion: 1, scoring: { criteria: [] } } }), null);
  assert.equal(publishedScoringConfig({ reviewPolicy: { schemaVersion: 1, scoring: { criteria: [
    { id: 'criterion', minimum: 0, maximum: Number.POSITIVE_INFINITY, evidenceRequired: true },
  ] } } }), null);
  assert.equal(publishedScoringConfig({ reviewPolicy: { schemaVersion: 1, scoring: { criteria: [
    { id: 'criterion', minimum: 0, maximum: 5, evidenceRequired: true, unsupported: true },
  ] } } }), null);
});
