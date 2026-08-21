# Repository Coding Guidelines

These instructions apply to every human or automated coding agent working in this repository.
They supplement the repository's public [contributing guidance](README.md#contributing); they do not replace it.

## Core standard

- Treat a proof of concept (PoC) as an evidence package, not as permission to lower engineering standards.
- Open contribution pull requests as draft PoCs for feasibility and directional review unless a maintainer explicitly requests a merge-ready patch.
- A draft label changes the review posture. It does not waive scope, testing, provenance, licensing, or review-budget requirements.
- Submit only code you understand, have run, and can explain. The author owns every generated or adapted line.
- Preserve existing behavior unless the agreed scope explicitly changes it.

## Before coding

1. Read the repository's contributing guidance, relevant architecture, nearby implementations, and tests.
2. Open an issue or otherwise obtain maintainer alignment before substantial implementation. State the problem, intended approach, and likely integration points.
3. Map every affected integration point before editing. Include configuration, UI, storage, network boundaries, cleanup, tests, and documentation where relevant.
4. Identify hidden invariants by tracing callers, error paths, and adjacent features. Missing documentation is not evidence that no convention exists.
5. Record the origin and license of borrowed or adapted code. Do not use code whose license is unclear or incompatible with the repository.
6. Estimate the hand-written review diff. If it cannot fit the review budget below, split the design before implementation grows further.

## Implementation discipline

- Keep the change focused. Avoid drive-by refactors, formatting churn, renamed concepts, and unrelated dependency updates.
- Follow existing patterns unless the PoC is explicitly testing a replacement. Explain deliberate departures.
- Prefer small modules, explicit interfaces, and bounded responsibilities over a single large implementation.
- Write or update a failing test before changing behavior when practical, then make the smallest change that passes it.
- Preserve readable code, useful tests, and necessary documentation. Never remove them merely to reduce the line count.
- Make network calls, processes, temporary configuration, and remote resources time-bounded and cancellable.
- Define cleanup before the happy path. Cleanup must run after partial setup and must not hide the primary failure.
- Do not leave temporary chats, files, credentials, proxy settings, processes, or remote resources behind.
- Keep credentials and account data out of source, fixtures, logs, screenshots, commits, and PR descriptions.

## Review budget

- Aim for no more than about 1,500 hand-written changed lines in one PR.
- If the projected hand-written diff exceeds 4,000 lines, stop and split it into independently useful, testable PRs unless a maintainer explicitly approves the larger review unit.
- Report generated files, vendored assets, lockfiles, and mechanical snapshots separately from hand-written changes.
- Split by coherent seams: interfaces before implementations, core behavior before optional UI, or provider-independent logic before integrations.
- Each split should be understandable and verifiable on its own. Do not create arbitrary slices that cannot run or be reviewed meaningfully.
- Do not upload an oversized code diff merely to ask for architectural feedback. Use an issue, design note, or small spike first.
- Sunk effort, a deadline, passing tests, or a draft/PoC label does not make an oversized diff reviewable.

## Testing and verification

Test the behavior end to end where the change crosses a real integration boundary. Cover, as applicable:

- the normal success path;
- empty, missing, malformed, or partial responses;
- expired, rejected, or missing credentials;
- timeouts, cancellation, retries, and unreachable services;
- partial setup followed by failure;
- cleanup failure and preservation of the primary error;
- process shutdown deadlines and leaked-resource checks;
- repeated execution and restoration of prior state.

Before claiming completion:

1. Inspect the final diff for scope, secrets, accidental files, and provenance.
2. Run focused tests plus the relevant full suite against the exact final tree.
3. Run the repository's applicable lint, type, syntax, build, and formatting checks.
4. Record the commands and outcomes. Do not rely on yesterday's run or a pre-edit result.
5. Obtain an independent review for substantial or lifecycle-sensitive changes, and address blocking findings.
6. State failed, skipped, unavailable, or untested checks plainly. Evidence comes before a success claim.

## Branches and commits

- Use a dedicated branch for each focused change.
- Make milestone commits that describe coherent outcomes, not agent activity or vague progress.
- Keep the branch reviewable throughout development; do not wait until the end to discover that it cannot be split safely.
- Keep private scratch notes, prompts, transcripts, and agent planning files out of the submitted diff unless a maintainer requests them.

## Draft PoC pull request contract

A draft PoC should help a maintainer decide whether and how the approach belongs in the project. Its description must include:

- the problem and PoC goal;
- the related issue or maintainer alignment;
- the chosen design and affected integration points;
- what is implemented and intentionally excluded;
- verification commands and concrete evidence;
- tested failure and cleanup paths;
- known risks, limitations, and unresolved decisions;
- borrowed-code provenance and license compatibility;
- the hand-written diff size, with generated changes reported separately;
- follow-up splits required before merge readiness.

Do not present a draft PoC as merge-ready. Do not ask the maintainer to discover basic architecture, licensing, failure modes, or sensible split boundaries on the author's behalf.

## Stop conditions

Stop implementation or submission and resolve the issue when any of these is true:

- substantial work lacks an issue or maintainer alignment;
- the author cannot explain an important code path or design choice;
- borrowed code has unclear provenance or incompatible licensing;
- the projected hand-written diff exceeds 4,000 lines without explicit maintainer approval;
- only the happy path has been exercised for a stateful or external integration;
- cleanup, timeout, or partial-failure behavior is undefined;
- verification is stale or does not cover the exact final tree;
- secrets or private account data may be present.

## Common rationalizations

| Rationalization | Required response |
| --- | --- |
| "It is only a PoC." | A PoC changes merge expectations, not the need for credible evidence, safe scope, and provenance. |
| "The maintainer can tell us what to cut." | Do the architecture work first; submit a design note or small spike, then split at coherent seams. |
| "We can split the 4,000+ lines after review." | Split before submitting the code PR unless the maintainer explicitly approves the larger unit. |
| "We already spent too much time to split it." | Sunk effort does not transfer review cost to maintainers or make the diff safer. |
| "Tests pass, so the size is fine." | Passing tests support correctness; they do not make an oversized diff understandable. |
| "Dropping tests or docs gets us under budget." | Never game the budget. Preserve quality and reduce implementation scope instead. |
| "The happy path proves feasibility." | Stateful and external integrations also require bounded failure and cleanup evidence. |
| "An AI wrote it, so detailed understanding is optional." | The submitting author remains responsible for understanding, explaining, and verifying every change. |
