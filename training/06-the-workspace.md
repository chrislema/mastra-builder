# Part 6: The Workspace — Hands, With Tripwires

*From: Learning Mastra by Watching a Software Factory Run — a plain-language introduction to Mastra, taught through the Delivery Engine project.*

### What a workspace is

Agents that build software need to read files, write files, and run commands. Mastra's **Workspace** provides exactly that: a filesystem interface and a **sandbox** (a controlled environment for running terminal commands), exposed to agents as tools. The critical feature isn't the access — it's the *control*.

The Delivery Engine's workspace is built dynamically per request:

```ts
export const deliveryWorkspace = new Workspace({
  id: 'delivery-workspace',
  filesystem: ({ requestContext }) =>
    new LocalFilesystem({ basePath: repoPathFromContext(requestContext), contained: true }),
  sandbox: ({ requestContext }) =>
    new LocalSandbox({ workingDirectory: repoPathFromContext(requestContext), timeout: 120_000 }),
  ...
});
```

Note `contained: true` and that `basePath`. This introduces **request context** — a small bundle of information that travels with every request through the system. The Delivery Engine puts one crucial fact in it: `repoPath`, the folder of the project being built. The workspace roots itself there, *contained*, meaning agents physically cannot read or write outside that folder. Point the same system at a different folder and the same agents operate there instead — the workspace is a template, instantiated per target.

An **input processor** (Part 8) enforces that no delivery agent can even be called without `repoPath` present. No context, no hands.

### Hooks: intercepting every action

Here's where the harness gets teeth. Mastra workspaces support **hooks** — functions that run *before* and *after* every workspace tool call. `beforeToolCall` can veto the action entirely. The Delivery Engine's hooks implement five tripwires:

**1. Dangerous command blocking.** Before any terminal command runs, a blocklist checks for known footguns: recursive force-deletes (`rm -rf`), destructive git operations (`git reset`, `git checkout`), `sudo`, recursive permission changes, and the classic "download a script from the internet and pipe it straight into a shell." Each is refused with a reason: *"recursive force delete requires human review."* The agent sees the refusal and must find another way.

**2. File ownership boundaries.** Remember `boundary.json`? When a stage starts, the system writes down which role is active and which file patterns that role owns and is forbidden from. The rules come from one source-of-truth file, `policy/boundaries.json`:

- Engineer owns `src/**`, `workers/**`, `migrations/**`, config files... and is *forbidden* from `public/**` (the UI) and framework files like `*.tsx`.
- Designer owns `public/**`, styles, and static assets... and is forbidden from server code, database files, and Wrangler configs.
- Planner, architect, deployer, judge own **nothing** — forbidden from everything. They think; they don't touch.

The `beforeToolCall` hook checks every attempted write against the active boundary *and* against the current task's declared surfaces (each task lists the exact files it owns). A designer trying to edit a database migration is blocked mid-keystroke, with a reason, and the blocked attempt is logged as an event. This is Rule 3 of the project's constitution — "small blast radius" — implemented as a mechanism instead of a plea.

**3. The read budget.** A known failure mode of AI coders: instead of writing code, they wander — listing directories, reading file after file, "investigating" while the token bill climbs. The hook counts read/list calls during build stages. Six reads before any write, and further reads are refused: *"Stop investigating and write or edit the task's owned surfaces."* A tripwire against expensive dithering.

**4. Dependency-read blocking.** Reading `node_modules/` (the folder of third-party library code, often enormous) is blocked during delivery stages. Agents are told to rely on the project's type checking instead of spelunking through libraries. Again: token discipline enforced by code, not by hoping.

**5. Content policy.** Even the *content* being written gets screened. If a write contains `bcrypt` (a password-hashing library banned by this project's security policy in favor of a specific alternative) or MD5, the write is refused: *"Crypto policy violation."* The wrong security primitive can't even reach the disk.

And after every tool call, `afterToolCall` appends a `tool_use` event to the log — tool name, paths touched, command, success or failure. The paper trail writes itself.

Step back and appreciate the shape of this. None of these five protections asks the model to behave. They *make misbehavior mechanically impossible or immediately visible*. That's the essential harness move: whenever a rule can be enforced deterministically, enforce it in code, and save the model's obedience budget for the rules only judgment can uphold.
