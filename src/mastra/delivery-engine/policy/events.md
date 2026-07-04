# Event Vocabulary — `.delivery/events.jsonl`

The trajectory surface. One JSON object per line. Written by Mastra workspace hooks,
delivery workflow steps, and delivery tools; read by the trajectory checks in `checks/`
and the trajectory rubric judges.

Every event carries:

- `ts` — ISO 8601 timestamp
- `source` — usually `"mastra"`, with optional tool/workflow-specific context in the event body
- `type` — one of the types below

## Workspace-emitted events

| type | fields | meaning |
|---|---|---|
| `tool_use` | `tool`, `paths[]?`, `command?`, `ok` | Any tool call observed by the Mastra workspace afterToolCall hook. `paths` for file writes/edits; `command` for sandbox command execution. |

## Workflow/tool-emitted events

| type | fields | meaning |
|---|---|---|
| `stage_start` | `stage`, `role` | A pipeline stage began (e.g. `"build:T2"`, role `"engineer"`). |
| `stage_end` | `stage`, `reason` | Stage ended. `reason`: `complete_stage`, `escalation`, or `max_turns`. |
| `artifact_write` | `artifact_type`, `path` | A pipeline artifact was produced (types match `schemas/`). |
| `artifact_read` | `artifact_type`, `path` | A pipeline artifact was read. |
| `run_code` | `ref`, `ok` | A test/harness/verification execution. |
| `deploy` | `target`, `revision` | A deployment was executed. |
| `live_verify` | `target`, `ok` | A direct probe against the deployed target. |
| `escalate` | `question`, `why_blocking` | A blocking question was raised to the user. |

## Stage slicing

Trajectory checks evaluate the slice of events between a `stage_start` and its matching
`stage_end` (matched by `stage`). With no stage argument, they evaluate the whole log.

## Conventions

- Writes under `.delivery/**` are artifact bookkeeping, exempt from boundary checks.
- A `tool_use` for sandbox command execution counts as code execution for
  `ran_code_before_complete` and `harness_run_before_findings` — explicit `run_code`
  events are the preferred signal when a delivery step can provide one.
- Events are append-only. Nothing rewrites history; corrections are new events.
