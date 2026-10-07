<!-- User-supplied reference copied 2026-10-07 from /Users/neonwatty/Desktop/extensible-agent-system-plan.md. This is design input, not a description of current implementation. -->

# Extensible tool-using agent system

Build a TypeScript appointment agent that can create and update calendar events, then add other domains without rewriting its runtime. **Code owns durable state and authorizes transitions; the model proposes routes, next actions, and user-facing replies.** One model may perform both routing and planning; these are separate contracts, not necessarily separate agents.

## Layout

```text
src/
  app/
    handleMessage.ts          # Reconcile each user turn with the active task
    dispatch.ts               # Determine profiles enabled for this user/agent
    presentResult.ts          # Render verified facts; optional agent wording
  harness/
    run.ts                    # Model/tool loop; run bounded child workflows
    router.ts                 # Select a workflow from eligible candidates
    planner.ts                # Propose one action within the selected workflow
    context.ts                # Assemble relevant task state and history
    prompts/
      router.ts               # Versioned routing instructions and schema
      planner.ts              # Versioned action and reply instructions
    toolGateway.ts            # Validate, authorize, execute, and trace tools
    taskStore.ts              # Persist task/child state, revision, session
    profiles/
      index.ts                # Registry of profiles and composite workflows
      calendar.ts             # Register create/update workflows and tools
      orders.ts               # Example future profile
  workflows/
    appointments/
      create.ts               # Create states, guards, and transitions
      update.ts               # Update states, guards, and transitions
    orders/
      lookup.ts               # Example future workflow
      return.ts
    composites/
      orderToCalendar.ts       # Example known cross-domain combination
  integrations/
    calendarClient.ts         # Calendar API adapter
    notificationClient.ts     # Notification API adapter
    orderClient.ts            # Example future adapter
tests/                       # Deterministic transition and gateway tests
evals/                       # Multi-turn scenarios, runner, and graders
```

## Contracts and execution

- A **profile** registers workflow IDs, typed tool handlers, and policy scope. `dispatch.ts` intersects profile access with current user/agent permissions, including on resume.
- A **workflow** exposes `id`, `requiredProfiles`, `routeDescription`, `start(input)`, `userEventSchema`, `allowedActions(state)`, `transition(state, event)`, and `isComplete(state)`. Its code owns business state and invariants.
- On every user turn, `router.ts` proposes `continue`, `change`, `cancel`, `newTask`, or `clarify` against any active task. For a new task it selects an eligible workflow; for a continuation it extracts a typed user event (such as `selectSlot`). `handleMessage.ts` validates the proposal and event, then calls `workflow.transition()` before planning.
- `planner.ts` receives only the selected workflow, current state, and `allowedActions(state)`. It proposes one typed action (`callTool`, `invokeWorkflow`, `askUser`, or `finish`) with arguments; it cannot advance state or execute actions directly.
- `run.ts` sends only `callTool` through `toolGateway.ts`, where its action ID must resolve to a profile-registered handler allowed in the current state. For `invokeWorkflow`, it runs an allowed child workflow and returns its verified outcome as a parent event. It handles `askUser` as a persisted pause and accepts `finish` only in a complete or terminal state. Save parent/child state with optimistic revisions; bound steps and retries.
- Every side effect requires schema and permission checks, workflow preconditions, and an idempotency key where applicable. A verified readback event must set `updateVerified` before `allowedActions()` can expose `notifyAttendees`; `transition()` enforces the same rule. Keep credentials and vendor API details in `integrations/`.

**Appointment trace:** `IDLE → UPDATE.LOOKUP → UPDATE.SEARCH_SLOTS → UPDATE.WAITING_FOR_SELECTION → UPDATE.READY_TO_WRITE → UPDATE.VERIFY → UPDATE.READY_TO_NOTIFY → COMPLETE`. The agent may ask the user to choose a slot; code saves the pause and validates the reply against offered slots. Only code applying validated events moves the state machine.

**State and turns:** Each `workflows/` file owns its business state machine; `integrations/` returns results, not transitions. The harness owns run/pause mechanics, and `taskStore.ts` persists workflow state across user turns. `profiles/*.ts` sets per-turn model/tool limits for `run.ts` to enforce; workflow code sets any clarification-turn or task-expiration limits across turns.

**Prompts and presentation:** `context.ts` combines versioned prompts with profile guidance and task state. Integration results pass through `toolGateway.ts` and workflow transitions before `presentResult.ts` renders exact facts from verified state; the agent may phrase the surrounding reply.

## Extension and evaluation

Add a workflow by implementing its contract, registering it in a profile, defining guarded tool handlers, and adding tests and eval cases. An agent may be enabled for one or several profiles. For a known combination, register a composite workflow (such as order lookup followed by calendar creation) only when every required profile is authorized. The router selects its single ID; its parent state exposes only the next permitted child via `allowedActions()`. The planner proposes that child, and `run.ts` executes it through the same bounded loop.

Run evals through the same router, workflow, and harness with isolated calendar/notification fakes. Grade the final stored outcome first, plus route choice, tool arguments, required ordering, forbidden side effects, recovery, user-facing truthfulness, latency, and cost. Include ambiguous slots, no availability, unauthorized access, resume/task switches, multi-turn corrections, timeouts, and version conflicts. Repeat model-driven cases and inspect traces; avoid requiring one exact harmless lookup sequence.
