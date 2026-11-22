import { z } from 'zod';
import type { ScoringConfig } from '../modules/evaluations/policy.js';

const criterionSchema = z.strictObject({
  id: z.string().min(1).max(100),
  minimum: z.number().finite(),
  maximum: z.number().finite(),
  evidenceRequired: z.boolean(),
  commentRequired: z.boolean().optional(),
  weight: z.number().finite().optional(),
});

const reviewPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  scoring: z.strictObject({
    criteria: z.array(criterionSchema).min(1),
    aggregation: z.enum(['SUM', 'WEIGHTED_SUM']).optional(),
  }),
}).superRefine(({ scoring }, context) => {
  const criteria = scoring.criteria;
  if (new Set(criteria.map(criterion => criterion.id)).size !== criteria.length) {
    context.addIssue({ code: 'custom', path: ['scoring', 'criteria'], message: 'Criterion identifiers must be unique' });
  }
  criteria.forEach((criterion, index) => {
    if (criterion.maximum < criterion.minimum) context.addIssue({ code: 'custom', path: ['scoring', 'criteria', index], message: 'Criterion bounds are invalid' });
  });
  if (scoring.aggregation === 'WEIGHTED_SUM' && criteria.some(criterion => criterion.weight === undefined || criterion.weight < 0)) {
    context.addIssue({ code: 'custom', path: ['scoring', 'criteria'], message: 'Weighted scoring requires valid configured weights' });
  }
});

/** Reads only the explicitly versioned review-policy member of a published, immutable config. */
export function publishedScoringConfig(value: unknown): ScoringConfig | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('reviewPolicy' in value)) return null;
  const result = reviewPolicySchema.safeParse(value.reviewPolicy);
  if (!result.success) return null;
  const scoring = result.data.scoring;
  return {
    criteria: scoring.criteria.map(({ weight, commentRequired, ...criterion }) => ({ ...criterion,
      ...(commentRequired === undefined ? {} : { commentRequired }), ...(weight === undefined ? {} : { weight }) })),
    ...(scoring.aggregation === undefined ? {} : { aggregation: scoring.aggregation }),
  };
}
