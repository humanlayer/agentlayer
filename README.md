# @humanlayer/agent-sdk

A model-agnostic agent loop with tool interfaces, cooperative hooks, stop conditions, and resumable state. Works with any [Vercel AI SDK](https://sdk.vercel.ai/) compatible model.

## Philosophy

- **Model-agnostic** -- works with any Vercel AI SDK compatible model: Anthropic, OpenAI, Google, or any `LanguageModelV3` implementation.
- **Interface/implementation separation** -- tool schemas are decoupled from their backends via `defineToolInterface`. Define once, implement for local disk, S3, remote sandbox, or anything else.
- **Two-tier tool architecture** -- _interfaces_ (pure schema + transforms) with parallel _implementations_: server (Bun-native) and just-bash (sandboxed virtual bash). Implement any interface with your own backend.
- **Resumable state** -- `AgentState` is a plain serializable object. Store it in a database, pass it across processes, resume with approval workflows. The agent loop is stateless between runs.
- **Cooperative hooks** -- three-tier hook system: _approval_ (gating) -> _preToolUse_ (mutation/interception) -> _postToolUse_ (observation/truncation). Each tier has type-safe factories scoped to specific tools.
- **Streaming-first** -- `AgentRun` is an `AsyncIterable<AgentEvent>` that yields events as they happen. Consume via `for await` for streaming UIs, or `await run.result` for batch workflows.

## Quick Start

```ts
import { anthropic } from "@ai-sdk/anthropic";
import {
  Agent,
  defineTool,
  maxSteps,
  startState,
  toolCompleted,
  userMessage,
} from "@humanlayer/agent-sdk";
import {
  createBashTool,
  createReadTool,
} from "@humanlayer/agent-sdk/tools/server";
import { z } from "zod";

const done = defineTool({
  name: "done",
  description: "Call when finished.",
  input: z.object({ summary: z.string() }),
  execute: async (input) => `Done: ${input.summary}`,
});

const agent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  system: "You are a helpful coding assistant.",
  tools: {
    bash: createBashTool({ cwd: "/my/project" }),
    read: createReadTool(),
    done,
  },
  stopWhen: [maxSteps(10), toolCompleted("done")],
});

const run = agent.run({
  state: startState([userMessage("Read package.json and summarize it.")]),
});

const output = await run.result;
console.log(output.finishReason); // 'stopCondition'
```

## Installation

This is an internal workspace package. Add it as a dependency from within the monorepo:

```bash
cd apps/your-app && bun add @humanlayer/agent-sdk
```

You will also need at least one AI SDK model provider:

```bash
bun add @ai-sdk/anthropic   # or @ai-sdk/openai, @ai-sdk/google, etc.
```

## Package Exports

| Import Path | Purpose |
| --- | --- |
| `@humanlayer/agent-sdk` | Everything: core + tools + test mocks |
| `@humanlayer/agent-sdk/core` | `Agent` class, hooks, state, stop conditions, `defineTool` |
| `@humanlayer/agent-sdk/tools` | All tool interfaces + implementations |
| `@humanlayer/agent-sdk/tools/interfaces` | Schema-only tool definitions (no I/O, safe for any environment) |
| `@humanlayer/agent-sdk/tools/server` | Bun-native server implementations (disk, shell, ripgrep) |
| `@humanlayer/agent-sdk/tools/just-bash` | Remote bash-based implementations (sandbox/container execution) |
| `@humanlayer/agent-sdk/prompts` | System prompt presets per model family |
| `@humanlayer/agent-sdk/testing` | State helpers re-exported for test convenience |

## Agent Configuration

The `AgentConfig` interface controls every aspect of the agent loop:

```ts
interface AgentConfig {
  // Required
  model: LanguageModel; // any Vercel AI SDK v3 model

  // Prompt
  system?: string | string[]; // joined with \n\n when array

  // Tools
  tools: Record<string, Tool>; // tool name -> Tool
  toolChoice?: ToolChoice; // 'auto' | 'required' | 'none' | { type: 'tool', toolName }

  // Provider-specific
  providerOptions?: ProviderOptions; // e.g. cacheControl for Anthropic

  // Limits
  maxSteps?: number; // default: 50, hard cap on loop iterations
  stopWhen?: StopWhen; // StopConditionDef or StopConditionDef[]

  // Callbacks (observe-only, errors swallowed)
  onToolProgress?: (toolCallId: string, toolName: string, data: ToolProgressData) => void;
  onError?: (error: AgentError, result: RunResult) => void | Promise<void>;
  onStop?: (result: RunResult) => void | Promise<void>;
  onApprovalRequested?: (
    approval: ApprovalRequest,
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>
  ) => void | Promise<void>;

  // Hook pipelines
  hooks?: {
    approval?: ApprovalHook[]; // gating: next / deny / ask
    preToolUse?: PreToolUseHook[]; // mutation: next(updatedInput) / toolResult / stop
    postToolUse?: PostToolUseHook[]; // observation: done(mutatedResult?)
    preRequest?: PreRequestHook[]; // context transforms: next / transform(messages)
  };
}
```

## Running an Agent

### Run Options

```ts
const run = agent.run({
  state: startState([userMessage("do stuff")]), // AgentState (messages + pending + history)
  signal: abortController.signal, // cooperative cancellation
});
```

The `state` parameter is an `AgentState` object. Use `startState()` to create one from a message array, or pass a previously returned `result.state` to resume.

### Consuming Results

**Batch** -- await the final result:

```ts
const result = await run.result;
// result.state       -- full AgentState for resumption
// result.newMessages -- only the messages added during this run
// result.finishReason -- 'complete' | 'maxSteps' | 'stopCondition' | 'interrupted' | 'approvalRequired' | 'error'
// result.stopCondition -- { name, message } when finishReason is 'stopCondition'
// result.error       -- AgentError when finishReason is 'error'
```

**Streaming** -- consume events as they happen:

```ts
for await (const event of run) {
  if (event.type === "message") {
    console.log(event.message.role, event.message);
  }
  if (event.type === "approvalRequested") {
    console.log("Needs approval:", event.approval.message);
  }
}
// After iteration completes, run.result is already resolved
```

Both patterns can be used together. `AgentRun` implements `AsyncIterable<AgentEvent>`.

## Defining Tools

### `defineTool` -- inline, one-off tools

For tools that are self-contained and do not need multiple backends:

```ts
import { defineTool } from "@humanlayer/agent-sdk";
import { z } from "zod";

const done = defineTool({
  name: "done",
  description: "Call when finished.",
  input: z.object({ summary: z.string() }),
  execute: async (input, ctx) => {
    ctx.progress({ type: "status", message: "Wrapping up..." });
    return `Done: ${input.summary}`;
  },
});
```

**Stateful tools** can persist data across invocations via `stateKey` and `stateSchema`:

```ts
const counter = defineTool({
  name: "increment",
  description: "Increment and return the counter.",
  input: z.object({}),
  stateKey: "counter",
  stateSchema: z.number(),
  execute: async (_input, ctx) => {
    const current = ctx.getToolState() ?? 0;
    ctx.updateToolState(() => current + 1);
    return String(current + 1);
  },
});
```

### `defineToolInterface` -- reusable interfaces

Separates the tool's schema and transforms from its execution. Call `.define()` to create concrete tools with different backends.

**Defining an interface:**

```ts
import { defineToolInterface } from "@humanlayer/agent-sdk";

const ReadTool = defineToolInterface<ReadInput, string>({
  name: "read",
  description: "Read a file with line numbers",
  input: readInput,
  output: z.string(),
  // Optional: preprocess input before the executor sees it
  beforeExecutionTransform: (input) => ({
    ...input,
    filePath: input.filePath.replace(/^~/, os.homedir()),
  }),
  // Optional: serialize raw output to a model-friendly string
  serialize: (rawContent, input) => {
    return addLineNumbers(rawContent, input.offset, input.limit);
  },
});
```

**Creating multiple backends from one interface:**

```ts
// Local disk (Bun-native)
const diskRead = ReadTool.define(async (input) => {
  return await Bun.file(input.filePath).text();
});

// S3
const s3Read = ReadTool.define(async (input) => {
  const obj = await s3.getObject({ Bucket: "my-bucket", Key: input.filePath });
  return await obj.Body!.transformToString();
});

// Remote sandbox via bash
const sandboxRead = ReadTool.define(async (input) => {
  const result = await bash.exec(`cat "${input.filePath}"`);
  return result.stdout;
});
```

All three share the same schema, description, and transforms. Only the data source differs. Pass any of them to `Agent.tools` interchangeably.

The key insight: both `defineTool(...)` and `defineToolInterface(...)` results satisfy the `ToolRef` interface (`{ name, input }`), so you can pass either to hook factories like `createPreToolUseHook`.

## Built-in Tool Interfaces

All interfaces live in `@humanlayer/agent-sdk/tools/interfaces`. They define schema + transforms only, with no I/O.

| Interface | Input Fields | Output Type | Key Transforms |
| --- | --- | --- | --- |
| `BashTool` | `command`, `timeout?`, `workdir?`, `description?` | `string` | -- |
| `ReadTool` | `filePath`, `offset?`, `limit?` | `string` | Line numbering, offset/limit slicing |
| `EditTool` | `filePath`, `oldString`, `newString`, `replaceAll?` | `{ content, matchCount }` | `~` expansion, match count validation |
| `WriteTool` | `filePath`, `content` | `string` | `~` expansion |
| `GlobTool` | `pattern`, `path?` | `string[]` | One-per-line formatting, truncation at 100 |
| `GrepTool` | `pattern`, `path?`, `glob?`, `type?`, `output_mode?`, etc. | `GrepMatch[]` | Group by file, truncation at 100 |
| `ListTool` | `path` | `ListEntry[]` | Folder icons formatting |
| `MultiEditTool` | `filePath`, `edits[]` | `string` | `~` expansion, batch edit application |
| `ApplyPatchTool` | `patch`, `path?` | `string` | -- |
| `WebFetchTool` | `url`, `prompt?` | `string` | -- |
| `WebSearchTool` | `query`, `allowed_domains?`, `blocked_domains?` | `WebSearchResult` | JSON serialization of results |
| `SkillTool` | `skill`, `args?` | `string` | Injects skill content via `updateContextWindow` |
| `CodeSearchTool` | `query`, `path?` | `string` | -- |
| `StructuredOutputTool` | `data` | `string` | JSON serialization |
| `TodoWriteTool` | `todos[]` | `string` | Markdown rendering of todo items |

## Server Tools

Bun-native implementations that talk directly to the local filesystem and shell. Import from `@humanlayer/agent-sdk/tools/server`.

| Factory | Interface | Options |
| --- | --- | --- |
| `createBashTool(opts?)` | `BashTool` | `{ cwd?: string }` |
| `createReadTool()` | `ReadTool` | -- |
| `createEditTool()` | `EditTool` | -- |
| `createWriteTool()` | `WriteTool` | -- |
| `createGlobTool()` | `GlobTool` | -- |
| `createGrepTool()` | `GrepTool` | -- |
| `createListTool()` | `ListTool` | -- |
| `createMultiEditTool()` | `MultiEditTool` | -- |
| `createApplyPatchTool()` | `ApplyPatchTool` | -- |
| `createWebFetchTool()` | `WebFetchTool` | -- |
| `createWebSearchTool(opts?)` | `WebSearchTool` | `WebSearchOptions` |
| `createCodeSearchTool(opts?)` | `CodeSearchTool` | `CodeSearchOptions` |
| `createSkillToolFromDirs(opts)` | `SkillTool` | `{ dirs: string[] }` |

```ts
import {
  createBashTool,
  createReadTool,
  createGrepTool,
  createSkillToolFromDirs,
} from "@humanlayer/agent-sdk/tools/server";

const tools = {
  bash: createBashTool({ cwd: "/my/project" }),
  read: createReadTool(),
  grep: createGrepTool(),
  skill: await createSkillToolFromDirs({ dirs: ["./skills"] }),
};
```

## Just-Bash Tools

Just-bash tools sit at the same level as server tools -- both implement the same tool interfaces. Where server tools use Bun-native APIs, just-bash tools use [just-bash](https://github.com/vercel-labs/just-bash) by Vercel Labs, an in-process TypeScript bash reimplementation with a virtual filesystem. This makes them suitable for sandboxed environments, containers, or any context where you want isolated execution without direct filesystem access.

Import from `@humanlayer/agent-sdk/tools/just-bash`:

| Factory | Interface | Notes |
| --- | --- | --- |
| `createJustBashTool()` | `BashTool` | Direct command execution |
| `createJustBashReadTool()` | `ReadTool` | `cat` + line numbering |
| `createEditTool()` | `EditTool` | `sed`-based editing |
| `createWriteTool()` | `WriteTool` | Writes via bash |
| `createGlobTool()` | `GlobTool` | `find`-based globbing |
| `createGrepTool()` | `GrepTool` | `grep`/`rg` search |
| `createListTool()` | `ListTool` | `ls`-based listing |
| `createApplyPatchTool()` | `ApplyPatchTool` | `patch` command |
| `createWebFetchTool()` | `WebFetchTool` | `curl`-based fetch |
| `createWebSearchTool(opts?)` | `WebSearchTool` | Configurable search |
| `createCodeSearchTool(opts?)` | `CodeSearchTool` | Code-specific search |
| `createSkillToolFromVFS(opts)` | `SkillTool` | VFS-backed skills |

## Hook System

Hooks form a pipeline that intercepts tool execution and model requests:

```
preRequest hooks -> generateText -> approval hooks -> preToolUse hooks -> [tool execution] -> postToolUse hooks
```

Pre-request hooks run before each model call. Tool hooks (approval, preToolUse, postToolUse) run on every tool call in array order. The first non-pass-through result short-circuits the tool hook chain.

### Approval Hooks

Approval hooks gate whether a tool call should proceed. They cannot mutate input.

**Context methods:**
- `ctx.next()` -- allow execution to proceed
- `ctx.deny(reason?)` -- block execution; model sees an error result with the reason
- `ctx.ask(approvalData)` -- pause the run and request external approval

```ts
import { createApprovalHook } from "@humanlayer/agent-sdk";
import { BashTool } from "@humanlayer/agent-sdk/tools/interfaces";

const requireBashApproval = createApprovalHook(BashTool, async (ctx) => {
  if (ctx.input.command.includes("rm")) {
    return ctx.ask({ message: `Approve destructive command: ${ctx.input.command}?` });
  }
  return ctx.next();
});

// Scope to multiple tools:
const auditDangerous = createApprovalHook([BashTool, deployTool], async (ctx) => {
  return ctx.ask({ message: `Approve ${ctx.toolName}?` });
});
```

When `ctx.ask()` is returned, the run pauses with `finishReason: 'approvalRequired'`. The pending approval is stored in `result.state.pendingToolCalls`. Resume with `withApprovals()`.

### PreToolUse Hooks

PreToolUse hooks run after approval passes. They can mutate input, short-circuit with a cached result, or stop the loop.

**Context methods:**
- `ctx.next(updatedInput?, opts?)` -- proceed, optionally with mutated input
- `ctx.toolResult(output)` -- skip execution and return this string as the tool result
- `ctx.stop(options?)` -- stop the agent loop

**Input mutation options** (second argument to `ctx.next()`):
- `updateContextWindow: true` -- patch the tool-call input in the assistant message so the model sees the mutation
- `notifyModel: true` -- inject a system notification informing the model that inputs were modified

Input mutations are threaded: if hook A mutates the input, hook B sees the mutated version.

```ts
import { createPreToolUseHook } from "@humanlayer/agent-sdk";
import { BashTool } from "@humanlayer/agent-sdk/tools/interfaces";

const sandboxBash = createPreToolUseHook(BashTool, async (ctx) => {
  if (ctx.input.command.includes("rm -rf /")) {
    return ctx.toolResult("Error: command blocked by safety policy");
  }
  // Force all commands into a specific directory
  return ctx.next(
    { ...ctx.input, workdir: "/sandbox" },
    { updateContextWindow: true }
  );
});
```

### PostToolUse Hooks

PostToolUse hooks run after a tool executes successfully. They can observe or mutate the output string.

**Context methods:**
- `ctx.done(mutatedResult?)` -- accept the result, optionally replacing the output string

PostToolUse hooks do NOT run when:
- The tool errored
- An approval hook denied execution
- A preToolUse hook short-circuited with `toolResult()` or `stop()`

```ts
import { createPostToolUseHook } from "@humanlayer/agent-sdk";
import { BashTool } from "@humanlayer/agent-sdk/tools/interfaces";

const truncateBash = createPostToolUseHook(BashTool, async (ctx) => {
  if (ctx.output.length > 50_000) {
    return ctx.done(ctx.output.slice(-50_000) + "\n[truncated to last 50KB]");
  }
  return ctx.done();
});
```

### PreRequest Hooks

Pre-request hooks run before each `generateText()` call and can transform the messages the model sees:
- `ctx.next()` -- pass through unchanged
- `ctx.transform(messages)` -- view-only transform (state unchanged)
- `ctx.transform(messages, { persist: true })` -- transform and update state

Built-in context transforms: `stripThinkingTokens()`, `deduplicateReads()`, `truncateOldBashResults()`

```ts
import { stripThinkingTokens, deduplicateReads, truncateOldBashResults } from "@humanlayer/agent-sdk/hooks";

const agent = new Agent({
  hooks: {
    preRequest: [
      stripThinkingTokens(),
      deduplicateReads(),
      truncateOldBashResults({ keep: 5 }),
    ],
  },
});
```

### Output Truncation Hooks

The SDK ships with pre-built output truncation hooks that prevent tools from flooding the context window:

```ts
import { saneDefaultOutputTruncationHooks } from "@humanlayer/agent-sdk/hooks";

const agent = new Agent({
  tools: { read, bash, glob, grep, list },
  hooks: {
    postToolUse: saneDefaultOutputTruncationHooks,
  },
});
```

`saneDefaultOutputTruncationHooks` includes truncation for:

| Tool | Default Direction | Behavior |
| --- | --- | --- |
| `ReadTool` | head | Caps lines/bytes, appends continuation hint with `offset` |
| `BashTool` | tail | Saves full output to temp file, keeps last N lines |
| `GlobTool` | head | Saves full output to temp file |
| `GrepTool` | head | Saves full output to temp file |
| `ListTool` | head | Saves full output to temp file |

Each has a configurable factory (e.g., `createBashOutputTruncationHook(opts)`) accepting `maxLines`, `maxBytes`, `direction`, and a custom `hint` generator.

**Built-in hooks shipped with the SDK:**
- `saneDefaultOutputTruncationHooks` — pre-composed array with truncation for Read (head, 2000 lines), Bash (tail, 2000 lines), Glob, Grep, and List outputs
- Individual truncation hook factories: `createReadTruncationHook`, `createBashOutputTruncationHook`, `createGlobOutputTruncationHook`, `createGrepOutputTruncationHook`, `createListOutputTruncationHook`
- Context transform hooks (pre-request): `stripThinkingTokens` (filters structured `type: 'reasoning'` parts), `deduplicateReads`, `truncateOldBashResults`

## Stop Conditions

Stop conditions control when the agent loop exits. They are evaluated at specific timings within each iteration.

| Factory | Timing | Description |
| --- | --- | --- |
| `maxSteps(n)` | afterExecution | Stop after `n` completed iterations |
| `toolCalled(name)` | **beforeExecution** | Stop when tool is called, before it runs |
| `toolCompleted(name)` | afterExecution | Stop after tool executes successfully |
| `totalToolFailures(n, name?)` | afterExecution | Stop after `n` cumulative failures |
| `consecutiveToolFailures(n, name?)` | afterExecution | Stop after `n` failures in a row |
| `doomLoop(n?)` | afterExecution | Stop when same tool+input repeats `n` times (default 3) |
| `structuredOutputCalled()` | **beforeExecution** | Alias for `toolCalled('structured_output')` |

`beforeExecution` conditions are useful for approval gates: the model's intent is visible but no side effects have occurred. Extract the pending tool call input from the run result's messages.

```ts
import {
  maxSteps,
  toolCalled,
  toolCompleted,
  doomLoop,
} from "@humanlayer/agent-sdk";

const agent = new Agent({
  // ...
  stopWhen: [
    maxSteps(20),
    toolCompleted("done"),
    doomLoop(3),
  ],
});
```

You can also define custom stop conditions:

```ts
const customStop: StopConditionDef = {
  name: "tokenBudget",
  timing: "afterExecution",
  message: "Token budget exceeded",
  check: (steps) => steps.length > 10, // your logic here
  onTriggered: () => console.log("Budget hit!"),
};
```

## ToolContext

Every tool's `execute` function receives a `ToolContext` as its second argument:

```ts
interface ToolContext {
  // -- Conversation access --

  /** Frozen, read-only snapshot of messages before this tool's result. */
  contextWindow: ReadonlyArray<ModelMessage>;

  /** Queue a deferred mutation applied after this tool's result is committed. */
  updateContextWindow(cb: (messages: ModelMessage[]) => ModelMessage[]): void;

  // -- Lifecycle --

  /** AbortSignal tied to the run. Tools run to completion; checked between iterations. */
  signal: AbortSignal;

  /** Push live progress updates (forwarded to onToolProgress if configured). */
  progress(data: ToolProgressData): void;

  /** Request the loop to stop after this tool call completes. */
  stop(options?: StopOptions): HookStopResult;

  /** The ID of this tool call (for sub-agent grouping). */
  toolCallId?: string;

  // -- Sub-agent integration (only present when sub-agent support is configured) --

  /** Pause because a child agent needs approval. */
  pauseForSubAgent?(agentId: string, childState: AgentState): SubAgentPauseResult;

  /** Retrieve saved state for a previously-paused sub-agent. */
  getSubAgentState?(agentId: string): AgentState | undefined;

  /** Await a child agent run, forwarding events and registering activeChildren. */
  awaitSubAgent?(
    childRun: SubAgentRunHandle,
    agentId: string,
    parentToolCallId: string
  ): Promise<SubAgentResult>;
}
```

**Stateful tools** additionally receive `ToolStateAccessors<TState>`:

```ts
interface ToolStateAccessors<TState> {
  getToolState(): TState | undefined;
  updateToolState(updater: (current: TState | undefined) => TState): void;
}
```

### ToolProgressData

```ts
type ToolProgressData =
  | { type: "output"; content: string }
  | { type: "status"; message: string }
  | { type: "custom"; data: Record<string, unknown> };
```

## State & Resumability

`AgentState` is a plain, JSON-serializable object that captures everything needed to resume a conversation:

```ts
interface AgentState {
  messages: ModelMessage[];
  pendingToolCalls?: PendingToolCall[];   // awaiting approval or stopped
  approvalHistory?: ApprovalHistoryEntry[];
  toolState?: Record<string, unknown>;   // persistent tool state, keyed by stateKey
  subAgents?: Record<string, AgentState>; // nested sub-agent states
}
```

### State Helpers

```ts
import {
  startState,
  withApprovals,
  getAgentState,
  getAllPendingApprovals,
} from "@humanlayer/agent-sdk";

// Create initial state from messages
const state = startState([userMessage("hello")]);

// Resume with approval decisions
const resumed = withApprovals(result.state, [
  { toolCallId: "abc", approved: true },
  { toolCallId: "def", approved: false, denialReason: "Too risky" },
]);

// Navigate sub-agent tree
const childState = getAgentState(rootState, ["worker-1"]);
const grandchild = getAgentState(rootState, ["worker-1", "subworker-a"]);

// Collect all pending approvals across the tree
const allPending = getAllPendingApprovals(rootState);
```

### JSON Round-Trip

```ts
// Serialize
const json = JSON.stringify(result.state);

// Store in database, send over network, etc.

// Deserialize and resume
const restored = JSON.parse(json) as AgentState;
const run = agent.run({ state: restored });
```

### Approval Flow

```ts
// Run 1: agent hits an approval gate
const run1 = agent.run({ state: startState([userMessage("deploy to prod")]) });
const result1 = await run1.result;
// result1.finishReason === 'approvalRequired'

// Extract pending approvals
const pending = result1.state.pendingToolCalls?.filter((p) => p.type === "approval");
const toolCallId = pending[0].toolCallId;

// Run 2: resume with approval
const resumedState = withApprovals(result1.state, [{ toolCallId, approved: true }]);
const result2 = await agent.run({ state: resumedState }).result;
```

### Live Approval Resolution

For interactive UIs, you can resolve approvals on a running agent without stopping:

```ts
const run = agent.run({ state });

// In an event handler (e.g., WebSocket message, button click):
const delivered = run.resolveApproval("tool-call-id", "approve");
if (!delivered) {
  // Fall back to cold path: withApprovals() + new run
}
```

## Subagent Orchestration

The `createSubagentsTool` factory creates a tool that delegates tasks to specialized child agents:

```ts
import { createSubagentsTool } from "@humanlayer/agent-sdk/tools/interfaces";

const subagent = createSubagentsTool({
  agents: [
    {
      name: "researcher",
      description: "Searches documentation and summarizes findings",
      agent: researcherAgent,
    },
    {
      name: "coder",
      description: "Writes and edits code",
      agent: coderAgent,
      resumable: true, // state persists across invocations
    },
  ],
  onChildEvent: (event) => {
    // Forward child events to your UI
    console.log("Child event:", event);
  },
});
```

**Ephemeral agents** (`resumable: false`, the default) start fresh on each invocation.

**Resumable agents** (`resumable: true`) persist their `AgentState` in the parent's `toolState` under a `task_id` key. The orchestrating model can pass a prior `task_id` to continue a previous session.

Sub-agent states are nested in the parent's `AgentState.subAgents`, enabling tree-wide traversal with `getAgentState()` and `getAllPendingApprovals()`.

## Structured Output

Extract typed, validated data from agent runs using the structured output pattern:

```ts
import { structuredOutput, structuredOutputCalled } from "@humanlayer/agent-sdk/tools/interfaces";
import { structuredOutputPrompt } from "@humanlayer/agent-sdk/prompts";

const { tool, parse } = structuredOutput(
  z.object({
    answer: z.number(),
    explanation: z.string(),
  })
);

const agent = new Agent({
  model,
  system: [defaultPrompt, structuredOutputPrompt],
  tools: { structured_output: tool, read: createReadTool() },
  stopWhen: structuredOutputCalled(),
});

const result = await agent.run({ state }).result;
const data = parse(result);
// data: { answer: number, explanation: string } | undefined
```

`structuredOutputCalled()` stops the loop _before_ the tool executes (timing: `beforeExecution`), so the structured data is extracted from the tool call input, not from execution output.

You can also use `extractStructuredOutput(messages)` to manually extract the raw data from any message array.

## System Prompt Presets

```ts
import { systemPrompts } from "@humanlayer/agent-sdk/prompts";

const agent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  system: systemPrompts.claude,
  tools: { bash, read },
});
```

**Presets in `systemPrompts`:**
- `default` -- model-agnostic baseline
- `claude` -- tuned for Anthropic Claude models
- `codex` -- tuned for OpenAI Codex/o-series models
- `gemini` -- tuned for Google Gemini models
- `openai` -- tuned for OpenAI GPT models

**Additional prompt functions** (not in the `systemPrompts` map, imported individually):
- `orchestratorPrompt` -- for multi-agent orchestration
- `structuredOutputPrompt` -- instructions for structured output extraction
- `todoWritePrompt` -- instructions for the TodoWrite tool
- `environmentPrompt(options)` -- generates environment context (cwd, OS, shell, etc.)
- `tarsPrompt` -- alternative agent personality

Compose prompts by passing an array to `system`:

```ts
const agent = new Agent({
  system: [
    systemPrompts.claude,
    environmentPrompt({ cwd: "/my/project", shell: "zsh" }),
    "Additional project-specific instructions.",
  ],
});
```

## Testing

### Mock Model

The `mockModel` utility creates a deterministic `LanguageModelV3` that returns pre-configured responses in order:

```ts
import {
  mockModel,
  assistantText,
  assistantWithToolCall,
  assistantWithToolCalls,
  userMessage,
} from "@humanlayer/agent-sdk";

const model = mockModel([
  assistantWithToolCall("read", { filePath: "/tmp/test.txt" }),
  assistantText("The file contains hello world."),
]);

const agent = new Agent({
  model,
  tools: { read: createReadTool() },
  stopWhen: maxSteps(5),
});
```

### Mock Helpers

| Helper | Description |
| --- | --- |
| `mockModel(responses)` | Create a deterministic model from an array of responses |
| `assistantText(text)` | A response containing only text (no tool calls) |
| `assistantWithToolCall(name, input)` | A response with a single tool call |
| `assistantWithToolCalls(...calls)` | A response with multiple parallel tool calls |
| `userMessage(content)` | Create a `UserModelMessage` |
| `toolResultMessage(id, name, output)` | Create a `ToolModelMessage` (for injecting synthetic results) |
| `getToolResults(messages, opts?)` | Extract all tool-result parts, optionally filtered by `toolName` |
| `outputValue(part)` | Extract the string value from a tool result's polymorphic output |
| `extractToolCallId(messages, toolName)` | Find the most recent tool call ID for a given tool name |

### State Helpers (from `@humanlayer/agent-sdk/testing`)

Re-exports for test convenience:

| Helper | Description |
| --- | --- |
| `startState(messages, toolState?)` | Create an initial `AgentState` |
| `withApprovals(state, decisions)` | Apply approval decisions to pending tool calls |
| `getAgentState(state, path)` | Navigate the sub-agent state tree |
| `getAllPendingApprovals(state)` | Collect all pending approvals across the tree |

### Example Test

```ts
import { test, expect } from "bun:test";
import {
  Agent,
  defineTool,
  mockModel,
  assistantWithToolCall,
  assistantText,
  startState,
  toolCompleted,
  userMessage,
} from "@humanlayer/agent-sdk";
import { z } from "zod";

test("agent calls done tool and stops", async () => {
  const done = defineTool({
    name: "done",
    description: "Finish",
    input: z.object({ summary: z.string() }),
    execute: async (input) => input.summary,
  });

  const model = mockModel([
    assistantWithToolCall("done", { summary: "all good" }),
    assistantText("finished"),
  ]);

  const agent = new Agent({
    model,
    tools: { done },
    stopWhen: toolCompleted("done"),
  });

  const result = await agent.run({
    state: startState([userMessage("do it")]),
  }).result;

  expect(result.finishReason).toBe("stopCondition");
  expect(result.stopCondition?.name).toBe("toolCompleted:done");
});
```

## Development

```bash
# Run tests (concurrent by default)
cd apps/agent-sdk && bun --bun run test

# Run tests in watch mode
cd apps/agent-sdk && bun --bun test --watch

# Type checking
bun --bun typecheck --filter @humanlayer/agent-sdk

# Integration tests (requires API key)
ANTHROPIC_API_KEY=sk-... bun test test/providers.test.ts
```

## Credits & Inspiration

- [12 Factor Agents](https://github.com/humanlayer/12-factor-agents) by Dex Horthy (HumanLayer) — the thesis we built on: own your prompts, own your context, own your control flow
- Viv Trivedy's [harness engineering framework](https://www.vtrivedy.com/posts/claude-code-sdk-haas-harness-as-a-service) and [anatomy of an agent harness](https://blog.langchain.com/the-anatomy-of-an-agent-harness/) — the four-lever model we extended with hooks and skills
- [opencode](https://opencode.ai) by Anomaly — tool interface patterns and the principle of separating tool shape from execution
- [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents) by Anthropic — tool definition patterns
- [just-bash](https://github.com/vercel-labs/just-bash) and [bash-tool](https://github.com/vercel-labs/bash-tool) by Vercel Labs — the sandbox abstraction pattern
- [Vercel AI SDK](https://sdk.vercel.ai) — the model abstraction layer we build on
