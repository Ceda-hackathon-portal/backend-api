import type { Principal } from '../../shared/authorization.js';
import type { DraftFields } from './service.js';
/** A supplies trusted reads; B owns the typed policy mapping and rule interpretation. */
export interface SubmissionContext<PublishedRules> {
    readonly applicationId: string;
    readonly submissionVersionId: string;
    readonly programmeId: string;
    readonly programmeVersionId: string;
    readonly fields: Readonly<DraftFields>;
    readonly rules: PublishedRules;
}
export interface SubmissionReader<PublishedRules> {
    readAuthorized(principal: Principal, submissionVersionId: string): Promise<SubmissionContext<PublishedRules> | null>;
}
/** No implementation until eligibility/review schema and B's result types are approved. */
export interface EligibilityWriteTransaction<Assessment, OfficerDecision> {
    requireOfficer(principal: Principal, programmeId: string, submissionVersionId: string): Promise<void>;
    recordPreliminary(context: SubmissionContext<unknown>, assessment: Assessment): Promise<string>;
    recordOfficerDecision(principal: Principal, checkId: string, decision: OfficerDecision): Promise<string>;
    audit(principal: Principal, action: string, targetId: string, requestId: string): Promise<void>;
}
