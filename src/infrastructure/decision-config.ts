import { z } from 'zod';
import type { DecisionPolicy } from '../modules/decisions/policy.js';

const schema = z.strictObject({
  schemaVersion: z.literal(1),
  permittedOutcomes: z.array(z.enum(['APPROVED', 'REJECTED', 'REVISION_REQUESTED'])).min(1),
}).superRefine((policy, context) => {
  if (new Set(policy.permittedOutcomes).size !== policy.permittedOutcomes.length) {
    context.addIssue({ code: 'custom', path: ['permittedOutcomes'], message: 'Permitted outcomes must be unique' });
  }
});

/** Decision outcomes come only from the explicit immutable programme-version publication. */
export function publishedDecisionPolicy(value: unknown): DecisionPolicy | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('decisionPolicy' in value)) return null;
  const parsed = schema.safeParse(value.decisionPolicy);
  return parsed.success ? { permittedOutcomes: [...parsed.data.permittedOutcomes] } : null;
}
