# Translation coordinator production runbook

Follow this runbook for every project. The goal's runtime envelope supplies the authoritative project ID, project root, SQLite ledger path, immutable source receipt, manifest path, output path, report path, pinned model, quality policy, execution policy, instruction version, and plan fingerprint. Never guess a missing identity or path.

## Safe tool entrypoint

The Bash tool uses a POSIX shell even on Windows. Resolve the packaged executable once with `BT="${BATCH_TRANSLATING_CLI:-batch-translating}"`, quote `"$BT"` on every call, and never invoke pnpm, tsx, source files, or a second installation. Start by reading the machine contracts with `"$BT" translation ledger help` and `"$BT" translation tools contracts`.

Write JSON request bodies to private files below the project's state directory, then pass those files with `--input`. Never interpolate book text, user instructions, paths, model output, or other untrusted data into shell code. Never modify the immutable source.

## Recovery before scheduling

On every initial turn, resume, and compaction recovery:

1. Read the goal envelope, manifest, ledger project record, ledger summary, budget status, instruction events, and task list.
2. Inspect expired leases before claiming new work. Recover one only after the prior worker and paid provider request are confirmed stopped; otherwise preserve it as `UNCERTAIN` and block duplicate dispatch. Reuse verified `SUCCEEDED` tasks and immutable artifacts. Never replay a paid request merely because its response is absent.
3. Confirm the ledger's source hash, pinned provider/model, instruction version, prompt version, context hash, and plan fingerprint match the goal. Block on a mismatch instead of silently adopting it.
4. Enforce the hard budget before every paid dispatch, the soft-budget warning, the configured retry ceiling, and the configured concurrency ceiling. Record real usage receipts with `cost record-usage`; never invent token counts, prices, request IDs, or costs.

Create or reuse a dependency-aware task graph in the ledger. Stable tasks normally cover bounded memory extraction, memory consolidation, translation, fidelity review, naturalness review, continuity review, repair, conflict arbitration, consistency audit, merge, render, validation, and report evidence. Every task and artifact must carry its exact project, source, prompt, instruction, context, model, and decoding identities. Claim a task with `leaseDurationMs` of at least `7500000` (the default two-hour worker limit plus a five-minute shutdown margin), record its exact task/attempt/worker identities, and mark the attempt running before dispatch. If an active attempt must remain owned beyond its current expiry, use `translation ledger task renew` with those same identities before dispatch; never infer them from session state. Accept a worker result only after its schema, hashes, scope, and provenance match that claim; then complete or fail that exact attempt in the ledger.

## Semantic work

Use only the allowlisted translation profiles, with the project's pinned provider and model. Give each worker one bounded immutable input and one private output path. Workers propose artifacts only; they do not mutate the ledger, canonical state, accepted translation, EPUB, or shared output. The Coordinator alone validates and publishes results.

For each translated scope, run independent fidelity, naturalness, and continuity review evidence as required by the quality policy. Reviewers emit issues rather than silently rewriting. Repairs must reference the accepted issue and exact old-translation hash. If patches conflict, use the conflict-arbitrator and the fenced merger lease; never use last-write-wins.

## BGE-M3 and no-BGE policy

Treat RAG as available only when the local runtime reports a verified BGE-M3 fingerprint, dense retrieval capability, and a healthy current project index. Use `translation rag` commands only through the authenticated local runtime descriptor. Apply chapter and spoiler filters to every search and retain consumed memory IDs in provenance.

When verified RAG is unavailable, continue in the explicit degraded policy rather than pretending retrieval succeeded:

- The first review Swarm for a chapter receives the current chapter plus the next chapter as read-only evidence. Future revelations may become ambiguity constraints only; they must not leak into the current translation.
- For the final chapter, use the current chapter plus a spoiler-safe summary of relevant prior context because no next chapter exists.
- A second independent review round is mandatory and cannot be waived. Apply a hash-guarded repair after the first round, run the second round against the repaired text, and perform a second repair for its accepted issues before merge.
- Record the degraded capability and extra review evidence in the ledger and final provenance. Never claim that RAG or BGE quality gates passed.

When verified RAG is available, index only project-isolated source, approved memory, canonical state, and approved/final translation memory. Retrieval is supporting evidence, not authority; source text and explicit user instructions win.

## Live instructions and completion

Treat new user messages as durable instruction events. Analyze and apply their affected scope through the ledger, stop assigning affected work, invalidate only impacted artifacts, preserve unrelated valid work, explain cost impact, and continue unless the user explicitly stops or cancels.

Before requesting native goal completion, acquire the fenced merger lease, validate every accepted artifact, resolve all blocking issues and conflicts, run the sole deterministic merge, render to a new output path, validate the rebuilt source, verify files in the ledger completion snapshot, and leave exact final-artifact receipt evidence for the authenticated host completion/report gate. Release the merger lease on both success and failure. If any required task, byte hash, source identity, integrity check, budget gate, or report prerequisite fails, mark the goal blocked with the concrete reason. Do not describe the product as completed merely because a worker or native goal finished.
