# Architecture

## 1. System model

The harness is a host-neutral control and evidence layer for agentic software engineering. The MCP host owns the model loop and native subagent spawning. This repository owns the task graph, capability metadata, local browser adapter, persistent evidence, workspace safety, and quality checkpoints.

## 2. Clean Architecture

```text
Host-native Agent Runtime
          |
          v
MCP Interface (tools, prompt, read-only resources)
          |
          v
Application Use Cases
          |
          v
Domain Models + Ports
          ^
          |
Infrastructure Adapters
(JSON state, Playwright, local process, Skill registry, module registry)
```

Dependency rules:
- Domain does not import MCP SDK, Playwright, filesystem, process, or provider libraries.
- Application depends on domain models and ports.
- Infrastructure implements ports.
- MCP interface validates untrusted inputs and invokes application services.
- Skills are instruction packages and never become a second implementation of domain rules.

## 3. Agent hierarchy

- Principal Orchestrator: owns plan, DAG, budgets, delegation, synthesis and gate evaluation.
- Agent Leads: discovery, governance, architecture, design, implementation, assurance, release.
- Dynamic subagents: frontend, backend, 3D, motion, responsive QA, visual QA, functional QA, accessibility, performance and security.
- MCP: tools and evidence operations. It does not create LLM instances by itself.
- Skills: portable operating procedures selected by the orchestrator.

## 4. Task graph, file ownership locking, and task leases

Tasks are persisted with UUIDs, explicit dependencies, owner role, Skill IDs, module IDs, explicit `ownedPaths`, status, evidence IDs, lease expiration timestamps (`leaseExpiresAt`), and attempt counters. 

- `get_ready_tasks` returns tasks whose dependencies are completed, automatically recovering abandoned tasks whose leases expired.
- `claim_task` and `claim_ready_batch` prevent duplicate task ownership and enforce path-level write locking across active tasks (detecting exact matches and parent/child directory overlaps) with atomic transactions.
- Long-running agents keep their claims active using `heartbeat_task`.
- Additional paths can be acquired or inspected mid-task with `acquire_file_locks`, `release_file_locks`, and `list_file_locks`; active locks and leases are released automatically when a task completes, fails, blocks, or reopens.

State persistence supports both atomic JSON file swapping and high-performance transactional SQLite in WAL mode (`PRAGMA journal_mode = WAL`) using Node 22's native `node:sqlite` engine (`SqliteStateRepository`), eliminating multi-process race conditions.

## 5. QA loop and parallel QA wave

For UI work:
1. Frontend and styling tasks execute, converging on an `integrate-and-build` milestone task.
2. Once the build integrates, the task graph fans out into a **Parallel QA Wave** (`parallelGroup: 'qa-wave'`), allowing specialized subagents to run concurrently:
   - Responsive-first inspection across every relevant route and supported viewport profile.
   - Layout defect inspection.
   - Functional interaction tests.
   - Visual and color contrast audit (light/dark themes, WCAG AA/AAA).
   - 3D WebGL / Three.js canvas inspection (frame verification, context leak detection).
   - Accessibility and assistive tech audit.
3. Browser automation uses `SharedBrowserPool` with an asynchronous semaphore (max 4 concurrent contexts) to prevent system memory/GPU crashes when multiple agents test simultaneously.
4. On assertion or interaction failure, Playwright exports an execution trace (`trace.zip`) alongside CDP Chrome performance metrics (heap size, DOM nodes, layout count) for post-mortem forensics.
5. If defects are found, repair cycles increment repair counters and re-verify.
6. Evidence-backed quality gate verifies all required checkpoints before release.

A later patch invalidates any affected evidence and reopens affected checkpoints.

## 6. Evidence model

Evidence records capture plan/task, kind, title, description, relative path or URI, metadata, creator and timestamp. Browser evidence includes the report path, run identifier, viewport results, screenshots, and failure details.

`PASS` requires at least one evidence record. `NOT_APPLICABLE` requires a rationale. A final release gate cannot pass while required checkpoints are pending, failed or blocked.

## 7. Development rules and project contracts

`docs/PRINCIPAL_DEVELOPMENT.md` is the engineering policy source. Project-specific contracts can be initialized from `docs/templates/project-contracts/`; only applicable templates should be copied and completed. The MCP server exposes the rulebook as the read-only resource `harness://development-principles`.

## 8. Extensibility

Add new providers through ports and infrastructure adapters. Do not place provider-specific API calls in domain or application services. Add a host adapter only when the target host has a concrete API for native subagent spawning. Add MCP tools only for operations that need model-accessible execution; static knowledge belongs in Skills or read-only Resources.
