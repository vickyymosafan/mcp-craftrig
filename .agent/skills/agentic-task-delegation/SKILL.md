---
name: agentic-task-delegation
description: Coordinate dependency-aware work across specialist agents. Use this when planning parallel tasks, spawning subagents, handing off context, or resolving file ownership conflicts.
compatibility: Works with Agent Skills-compatible hosts. Host-native subagent execution is required for true parallel delegation; MCP tools persist task state and evidence.
---

# Agentic Task Delegation

## Task graph
Represent work as a directed acyclic graph. A task may start only when all dependency tasks are completed. Claim tasks before delegation.

## Delegation process
1. Read the task and project context, or fetch the task packet via `craftrig://plans/{planId}/tasks/{taskId}/packet`.
2. Decompose by independently verifiable outcomes, not by arbitrary file count.
3. Identify dependencies and shared-file conflicts (`craftrig_list_file_locks`).
4. Assign one owner role per task and lock explicit write ownership via `craftrig_claim_task` (`ownedPaths`), `craftrig_claim_ready_batch`, or `craftrig_acquire_file_locks`.
5. Group independent tasks with disjoint owned paths into parallel batches (e.g. `qa-wave` fan-out after integration).
6. Send each subagent a bounded context packet listing its locked paths and lease duration.
7. Long-running subagents send periodic heartbeats via `craftrig_heartbeat_task` to prevent lease expiration.
8. Collect structured results and evidence; locks release automatically on `craftrig_complete_task` or `craftrig_reopen_task` (or explicitly via `craftrig_release_file_locks`).
9. Run integration and regression checks.

## Parallel QA Wave
Following the `integrate-and-build` milestone, UI tasks fan out into a parallel QA wave (`parallelGroup: 'qa-wave'`). The Orchestrator can batch-claim (`craftrig_claim_ready_batch`) or spawn simultaneous subagents for:
- Responsive Viewport QA
- Layout Defect QA
- Functional Interaction QA
- Visual & Color Contrast QA (with light-dark() and WCAG audit)
- 3D WebGL / Shader QA (with frame verification and multi-context leak guard)
- Accessibility Semantics QA (with axe-core findings)

All QA subagents share the crash-proof `SharedBrowserPool` with concurrent context limiting and automatic CDP forensic trace capture on failures.

## Subagent output contract
Return JSON or a clearly structured message with `taskId`, `status`, `summary`, `changedFiles`, `decisions`, `testsRun`, `evidenceIds`, `risks`, and `nextDependencies`.

## Do not
- spawn an agent for work that takes less effort than coordination;
- duplicate tasks already claimed or completed;
- allow multiple writers to edit shared architecture or token files concurrently;
- ask an implementation agent to approve its own patch;
- treat a subagent's verbal claim as evidence.
