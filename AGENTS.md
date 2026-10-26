# Working agreement

## Plan before implementation (non-trivial work)

A task is non-trivial when it is a new feature, touches more than two files, changes an architecture/data model/API contract, or has an uncertain approach.

1. Write a short plan: goal, approach, files to touch, how it will be verified.
2. Save it to `.pi/plans/<slug>.md` when the work spans sessions; otherwise present it in chat.
3. **Wait for explicit user approval before spawning `worker` or editing code.** The user owns the design decision.
4. Then implement in **vertical slices**: each slice names one testable result, the files it touches, and the check that proves it. Verify each slice per the gate below.
5. Skip the plan for small fixes (one or two files, obvious approach) — say that you skipped it.

## Verification gate

Verification happens per **coherent unit of work** — not after every edit, and not once at the end of a long project.

A unit is a feature, a bug fix, a refactor step, or a milestone named in the plan. For a small task, the unit is the whole task.

Cadence:

1. Implement the unit (worker agent, or directly for small changes). Batch related edits inside it.
2. At the unit boundary — before claiming it done, and before building the next unit on top of it — spawn the `verifier` agent with the original task, the claimed result, the changed files, and the exact commands that should prove it. The verifier must run the tests/repro itself.
3. Report the unit as done only after `PASS`. On `FAIL`, fix and re-verify that unit before moving on.
4. For multi-step projects: verify each milestone, then run a **final end-to-end verification** of the whole goal before declaring it complete. Do not batch hours of work into a single verification.
5. Include the verifier's decisive evidence (command + key output) in the final answer.

Rules:

- Do not verify after every edit; group related edits into a unit first.
- Do not let the implementer grade its own work. `worker` cannot spawn `verifier` by design; the orchestrator owns the gate.
- If a milestone is skipped because it is trivial, say so explicitly.

Skip verification for pure questions, read-only exploration, docs/comments-only edits, and one-line changes covered by an obvious existing test — but say that you skipped it and why.

## Permission gate

Consequential actions (recursive deletes outside build dirs, `sudo`, force-push, `git reset --hard`, `git clean -fd`, publish, deploy, `curl | sh`, credential exfiltration, writes outside the project or to sensitive paths) prompt for approval. In headless subagents they are denied by default. Do not try to work around a denial; ask the user or use a safer command. Policy: `~/.pi/agent/permissions.json`; decisions: `~/.pi/agent/permissions-audit.jsonl`.
