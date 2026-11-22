# Project context — CEDA Innovation Platform

## Goal
Blue Hogs Inc. is building a hackathon prototype for Botswana's Citizen Entrepreneurial Development Agency (CEDA): one portal to receive innovation ideas, support fair independent evaluation, track decisions and return meaningful feedback. The official hackathon brief requires a browser-accessible repository and evaluation workflow, roles/security, progress updates, iteration, dashboards, online chat, FAQs and future extensibility.

## Deadline and scope
Plan covers six development days, **Tue 17 Nov–Sun 22 Nov 2026**, with a protected submission/rehearsal period **Mon 23 Nov 2026 before 17:00 CAT**. Scope is a defensible working prototype—not the 26-week production rollout described in the Blue Hogs proposal. The PDF proposal favors a multi-service future architecture, hosting in Botswana, audit isolation, local AI and richer infrastructure; do not claim those are implemented unless proven. Deploy temporary demo infrastructure only with approval, synthetic data and accurate region/cost disclosure.

## Required demo narrative
1. Publish a configured programme with rules/criteria and intake window.
2. Register/login an applicant; manage own draft and submit an idea with mandatory fields.
3. Generate reference number, lock a submission version and show stage history.
4. Have a scoped officer review eligibility and request evidence/correction if needed.
5. Manager assigns independent reviewers; conflict declaration blocks access before scoring.
6. Two reviewers score configured criteria and finalize locked evaluations privately.
7. Authorized adjudicator records reason; authorized manager releases result and feedback.
8. Applicant views only own status/released feedback; management sees safe aggregate results; audit/event trail demonstrates accountability.
9. If time: working basic in-app notifications, FAQ and multi-agent chat with 09:00–16:00 working day availability and no-agent message. Mark anything unimplemented as deferred.

## Roles and audiences
Frontend UI `src/data/portal.js` declares: `submitter`, `evaluator`, `adjudicator`, `administrator`, `management`, `system-administrator`. Server grants must be verified, programme/record scoped, and deny by default. An eligibility officer capability may be a scoped grant under programme operations until a dedicated UI role is agreed; no automatic staff signups. Technical administrator must not inherit idea/score access. Evaluators see only assigned versions and their own scores until scoring closure. Feedback visible only after authorized release.

## Functional caveats
Frontend currently has illustrative themes `digital`, `sustainable`, `inclusive`, four unweighted criteria, and sample stage strings. They are demos. CEDA must approve actual programme rules, eligibility, score scales, review rounds, reason codes, privacy conditions and data retention. No live CIPA/Omang or external AI integration without authorization. AI must not score or decide eligibility/funding.

## Nonnegotiable quality
Server-side validation, ownership checks, conflict of interest restrictions, immutable version snapshots, versioned programme criteria, idempotency, audit records, transactions and controlled release. Real PostgreSQL integration tests and authorization-denial tests are required for P0 endpoints. Each feature is demonstrable via API even if frontend integration is deferred.
