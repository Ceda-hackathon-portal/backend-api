# Provisional eligibility MVP

This supersedes the previous UNKNOWN-first aggregate rule for this prototype.
It is platform behavior authorized on 20 November 2026, not official CEDA criteria.

- MET: all applicable mandatory requirements are satisfied.
- NOT_MET: at least one mandatory, applicable, verified and explicitly non-waivable
  requirement is confirmed unsatisfied. This takes precedence over other unknowns.
- UNKNOWN: no such confirmed failure exists, but evidence is missing, inconsistent,
  unverified for an adverse finding, or requires waiver review.

Existing requirements default to applicable and mandatory for compatibility.
Waiver status must explicitly be false before an adverse finding is conclusive.
Evidence verification is a trusted server fact passed to assessOfficerEvidence;
screenEligibility never trusts applicant verification flags. Optional/inapplicable
requirements do not affect the aggregate, but their individual findings are retained.
All findings remain preliminary outputs;
no status directly rejects or terminates an application. Route to officer verification
and controlled decision processing.

The original six canonical tests remain with revised provisional expectations;
additional tests cover confirmed failure precedence and waiver/verification behavior.
No persistence schema, routes or official eligibility thresholds are introduced.
