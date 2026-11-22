import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EligibilityRequirement } from './eligibilityPolicy.js';

/** Explicit opt-in path inside the pinned ProgrammeVersion.config JSON. */
export const eligibilityRuleSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  ruleVersion: z.string().uuid(),
  requirements: z.array(z.object({
    id: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    mandatory: z.boolean().optional(),
    applicable: z.boolean().optional(),
    waivable: z.boolean().optional(),
    rule: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('attestation') }).strict(),
      z.object({ kind: z.literal('number'), operator: z.enum(['gte', 'lte']), threshold: z.number().finite(), unit: z.string().trim().min(1).max(40) }).strict(),
    ]),
  }).strict()).min(1).max(200),
}).strict();

export type EligibilityRuleSnapshot = Readonly<z.infer<typeof eligibilityRuleSnapshotSchema>>;
export class EligibilityConfigurationError extends Error {
  readonly code = 'INVALID_ELIGIBILITY_CONFIGURATION';
  constructor(message: string) { super(message); this.name = 'EligibilityConfigurationError'; }
}

/** Missing config means no screening configuration; malformed explicit config is an error. */
export function parseEligibilityRuleSnapshot(config: unknown): { readonly version: string; readonly requirements: readonly EligibilityRequirement[]; readonly digest: string } | null {
  if (!config || typeof config !== 'object' || !Object.hasOwn(config, 'eligibilityRules')) return null;
  const parsed = eligibilityRuleSnapshotSchema.safeParse((config as Record<string, unknown>).eligibilityRules);
  if (!parsed.success) throw new EligibilityConfigurationError(`Programme eligibilityRules configuration is invalid: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  const ids = new Set<string>();
  for (const requirement of parsed.data.requirements) {
    if (!requirement.id.trim() || ids.has(requirement.id)) throw new EligibilityConfigurationError('Programme eligibilityRules contains empty or duplicate requirement identifiers');
    ids.add(requirement.id);
  }
  const requirements: EligibilityRequirement[] = parsed.data.requirements.map(item => ({
    id: item.id,
    rule: item.rule,
    ...(item.mandatory === undefined ? {} : { mandatory: item.mandatory }),
    ...(item.applicable === undefined ? {} : { applicable: item.applicable }),
    ...(item.waivable === undefined ? {} : { waivable: item.waivable }),
  }));
  return Object.freeze({ version: parsed.data.ruleVersion, requirements, digest: createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex') });
}
