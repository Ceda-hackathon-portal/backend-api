/** Rules come from a published programme version; this module contains no CEDA criteria. */
export type EligibilityRule =
  | { kind: 'attestation' }
  | { kind: 'number'; operator: 'gte' | 'lte'; threshold: number; unit: string }

export interface EligibilityRequirement {
  id: string
  rule: EligibilityRule
  mandatory?: boolean
  applicable?: boolean
  waivable?: boolean
}

export interface EligibilityEvidence {
  id: string
  requirementId: string
  value?: boolean | number | null
  /** Retained as entered after the trusted adapter confirms exact rule-unit match. */
  unit?: string
  /** Trusted verification fact; applicant screening ignores this flag. */
  verified?: boolean
  /** Server-generated trace to the immutable applicant submission field. */
  provenance?: { kind: 'SUBMISSION_VERSION'; submissionVersionId: string; path: string }
}

export type EligibilityStatus = 'MET' | 'NOT_MET' | 'UNKNOWN'
export type UnknownReason = 'MISSING' | 'CONFLICT' | 'UNVERIFIED' | 'WAIVER_REVIEW'

export interface RequirementFinding {
  requirementId: string
  status: EligibilityStatus
  unknownReason?: UnknownReason
}

export interface EligibilityAssessment {
  /** A verified mandatory non-waivable failure takes precedence; never a final decision. */
  status: EligibilityStatus
  findings: RequirementFinding[]
}

function validate(requirements: readonly EligibilityRequirement[], evidence: readonly EligibilityEvidence[]): void {
  if (requirements.length === 0) throw new Error('At least one requirement is required')
  const requirementIds = new Set<string>()
  for (const requirement of requirements) {
    if (!requirement.id.trim() || requirementIds.has(requirement.id)) {
      throw new Error('Requirement IDs must be nonempty and unique')
    }
    requirementIds.add(requirement.id)
    const rule = requirement.rule
    if (!rule || typeof rule !== 'object') throw new Error('Invalid eligibility rule')
    if (rule.kind === 'number') {
      if (!['gte', 'lte'].includes(rule.operator) || !Number.isFinite(rule.threshold) || !rule.unit.trim()) {
        throw new Error('Invalid numerical eligibility rule')
      }
    } else if (rule.kind !== 'attestation') {
      throw new Error('Invalid eligibility rule')
    }
  }

  const evidenceIds = new Set<string>()
  for (const item of evidence) {
    if (!item.id.trim() || evidenceIds.has(item.id)) throw new Error('Evidence IDs must be nonempty and unique')
    evidenceIds.add(item.id)
    const requirement = requirements.find(({ id }) => id === item.requirementId)
    if (!requirement) throw new Error('Evidence references an unconfigured requirement')
    if (item.value != null && (requirement.rule.kind === 'attestation'
      ? typeof item.value !== 'boolean'
      : typeof item.value !== 'number' || !Number.isFinite(item.value))) {
      throw new Error('Evidence value does not match its rule')
    }
    if (item.value != null && requirement.rule.kind === 'number' && item.unit !== requirement.rule.unit) {
      throw new Error('Evidence unit does not match its rule')
    }
    if (requirement.rule.kind === 'attestation' && item.unit !== undefined) {
      throw new Error('Attestation evidence cannot include a numerical unit')
    }
  }
}

function evaluate(requirement: EligibilityRequirement, value: boolean | number): 'MET' | 'NOT_MET' {
  if (requirement.rule.kind === 'attestation') return value === true ? 'MET' : 'NOT_MET'
  const met = requirement.rule.operator === 'gte'
    ? (value as number) >= requirement.rule.threshold
    : (value as number) <= requirement.rule.threshold
  return met ? 'MET' : 'NOT_MET'
}

function assess(requirements: readonly EligibilityRequirement[], evidence: readonly EligibilityEvidence[], trusted: boolean): EligibilityAssessment {
  validate(requirements, evidence)
  const findings = requirements.map((requirement): RequirementFinding => {
    const values = evidence.filter((item) => item.requirementId === requirement.id && item.value != null)
    const first = values[0]
    if (!first || first.value == null) return { requirementId: requirement.id, status: 'UNKNOWN', unknownReason: 'MISSING' }
    const distinctValues = new Set(values.map((item) => item.value))
    if (distinctValues.size > 1) return { requirementId: requirement.id, status: 'UNKNOWN', unknownReason: 'CONFLICT' }
    if (trusted && !values.every(item => item.verified === true)) {
      return { requirementId: requirement.id, status: 'UNKNOWN', unknownReason: 'UNVERIFIED' }
    }
    const status = evaluate(requirement, first.value)
    if (status === 'NOT_MET') {
      if (!trusted || !values.every(item => item.verified === true)) return { requirementId: requirement.id, status: 'UNKNOWN', unknownReason: 'UNVERIFIED' }
      if (requirement.waivable !== false) return { requirementId: requirement.id, status: 'UNKNOWN', unknownReason: 'WAIVER_REVIEW' }
    }
    return { requirementId: requirement.id, status }
  })
  const applicableMandatoryIds = new Set(requirements
    .filter(requirement => requirement.applicable !== false && requirement.mandatory !== false)
    .map(requirement => requirement.id))
  const aggregateFindings = findings.filter(finding => applicableMandatoryIds.has(finding.requirementId))
  const status = aggregateFindings.some(({ status }) => status === 'NOT_MET') ? 'NOT_MET'
    : aggregateFindings.some(({ status }) => status === 'UNKNOWN') ? 'UNKNOWN' : 'MET'
  return { status, findings }
}

/** Applicant supplied evidence is preliminary and cannot complete officer verification. */
export function screenEligibility(
  requirements: readonly EligibilityRequirement[],
  applicantEvidence: readonly EligibilityEvidence[],
): EligibilityAssessment {
  return assess(requirements, applicantEvidence, false)
}

/** This is a finding only; authenticated authorization and completion belong to the workflow service. */
export function assessOfficerEvidence(
  requirements: readonly EligibilityRequirement[],
  officerEvidence: readonly EligibilityEvidence[],
): EligibilityAssessment {
  return assess(requirements, officerEvidence, true)
}
