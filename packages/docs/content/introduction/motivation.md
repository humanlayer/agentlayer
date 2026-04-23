---
title: Why AgentLayer?
description: Why we built a framework for coding agents instead of another coding agent.
---

# We have opinions about coding agents

We've been building agents for a while now: coding agents, human-in-the-loop agents, and outer-loop background agents. It's safe to say that we have [a lot of opinions about agents](https://github.com/humanlayer/12-factor-agents) — from [creating research/plan/implement](https://github.com/humanlayer/humanlayer) to talking about [Advanced Context Engineering](https://www.youtube.com/watch?v=VvkhYWFWaKI).

To build good agents, you need good abstractions, but also deep low-level control over the execution flow, the agent's internal state, and most importantly, the **context window**.

## The Problem with Existing Coding Agents

Existing coding agents are opinionated about everything:

- **Tools** — You get the tools they ship. Adding a first-class tool means writing an MCP server or forking the codebase.
- **Storage** — State lives in SQLite files, local JSON, or process-local stores. That's fine for interactive local use.
- **Context** — You can configure auto-compact or mute tools, but you can't do surgery on the context window mid-run.
- **Control flow** — You can write plugins or hooks, but getting into the execution loop itself is hard.

**State is the biggest problem.** When you need to run an agent in one process, save its state, and resume in a different process after a human approves something hours later — most agents can't do that. Their state isn't portable.

And if you're building production agents, using an SDK that ships a compiled binary doesn't cut it. You need to see and control the code.

## This Is a Framework, Not a Coding Agent

So instead of building another coding agent, we built a framework for building coding agents.

You bring:
- Your prompts
- Your model provider
- Your tools
- Your control flow

We provide:
- A stateful, resumable agent loop
- JSON-serializable state that travels anywhere
- A hook system for intercepting and transforming behavior
- Tool interfaces separated from implementations

## Bring Your Own Opinions

We have [lots of opinions about coding agents](https://humanlayer.com/blog), but AgentLayer doesn't force them on you.

| Feature | Our Opinion | Your Choice |
|---------|-------------|-------------|
| Auto-compact | Love it | Use the hook, or don't |
| Sub-agents | Infinite-depth with recursive state | Use ours, build your own, or skip them |
| Retrieval | `grep` is great | Write your own search tool |
| Forking | Claude Code-style undo/rewind | State is serializable — fork trivially |

## The Key Insight: Interface ≠ Implementation

This is the architectural insight that makes everything else work.

A tool has two parts:
1. **Interface** — What the model sees: input schema, description, and how results are serialized
2. **Implementation** — What actually runs: the executor that does the work

The interface owns the **model contract**. The implementation owns the **runtime behavior**.

### What Lives in the Interface

Take `ReadTool`. The interface defines:

```ts
const ReadTool = defineToolInterface({
  name: 'read',
  description: 'Read a file with line numbers',
  input: z.object({
    file_path: z.string(),
    offset: z.number().optional(),
    limit: z.number().optional().default(2000),
  }),
  output: z.string(),
  serialize: (raw: string, input: ReadInput) => {
    // Add line numbers to each line
    const lines = raw.split('\n')
    const offset = input.offset ?? 1
    const limit = input.limit ?? 2000
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const totalLines = lines.length
    const numbered = slice
      .map((line, i) => `${offset + i}→${line}`)
      .join('\n')
    
    // Add continuation hint if truncated
    if (slice.length < totalLines) {
      return `${numbered}\n\n(Showing lines ${offset}-${offset + slice.length - 1} of ${totalLines}. Use offset=${offset + slice.length} to continue.)`
    }
    return `${numbered}\n\n(End of file - total ${totalLines} lines)`
  },
})
```

The `serialize` function is the key. It transforms raw executor output into what the model actually sees. Every implementation of `ReadTool` — whether backed by the local filesystem, S3, a database, or a sandbox — produces the same model-visible format: line-numbered content with continuation hints.

### What Lives in the Implementation

The implementation just returns raw content. It doesn't know about line numbers or pagination hints:

```ts
// Local disk — just read the file
const localRead = ReadTool.define(async (input) => {
  return await Bun.file(input.file_path).text()
})

// S3 — same interface, different storage
const s3Read = ReadTool.define(async (input) => {
  const obj = await s3.getObject({ Key: input.file_path })
  return await obj.Body!.transformToString()
})

// Sandboxed bash — same interface, isolated environment
const sandboxRead = ReadTool.define(async (input) => {
  return await sandbox.exec(`cat "${input.file_path}"`)
})

// Database — same interface, structured storage
const dbRead = ReadTool.define(async (input) => {
  const row = await db.query('SELECT content FROM files WHERE path = ?', [input.file_path])
  return row.content
})
```

The model doesn't know the difference. Swap backends without changing what the model sees.

### Another Example: Grep

`GrepTool` returns structured data but serializes it as a human-readable format:

```ts
const GrepTool = defineToolInterface({
  name: 'grep',
  input: z.object({ pattern: z.string(), path: z.string().optional() }),
  output: z.array(z.object({ file: z.string(), line: z.number(), content: z.string() })),
  serialize: (matches: GrepMatch[]) => {
    if (matches.length === 0) return 'No matches found.'
    
    // Group by file for readability
    const grouped = new Map<string, GrepMatch[]>()
    for (const m of matches) {
      const existing = grouped.get(m.file) ?? []
      existing.push(m)
      grouped.set(m.file, existing)
    }
    
    const lines: string[] = []
    for (const [file, fileMatches] of grouped) {
      lines.push(file)
      for (const m of fileMatches) {
        lines.push(`  ${m.line}: ${m.content}`)
      }
    }
    return lines.join('\n')
  },
})
```

The executor returns `GrepMatch[]`. The serializer turns it into:

```
src/agent.ts
  42: const result = await run.result
  87: if (result.finishReason === 'error') {
src/hooks.ts
  15: return ctx.next()
```

Every grep implementation — ripgrep, git grep, custom AST search — produces the same model-visible output.

### Why This Matters

This split means you can:

- **Swap backends** without touching prompts or agent logic
- **Share serialization** across all implementations automatically
- **Test implementations** against the same interface contract
- **Build new backends** (sandbox, remote, mock) without changing what the model sees

## Stateless and Serializable

This is the differentiator.

`AgentState` is a JSON blob containing messages, pending tool calls, approval history, tool-specific state, and sub-agent trees. No SQLite. No JSON files on disk. It's a plain object you can `JSON.stringify()` and store anywhere.

```ts
// Agent needs approval — serialize and shut down
const result = await run.result
if (result.finishReason === 'approvalRequired') {
  await db.save(JSON.stringify(result.state))
  process.exit(0)
}

// Hours later, after approval
const state = JSON.parse(await db.load())
const resumed = withApprovals(state, [
  { toolCallId: 'xyz', approved: true },
])
const run = agent.run({ state: resumed })
```

This matters because:
- Run in a serverless function, save to Postgres, resume in a different process
- No expensive process sitting idle waiting for human approval
- State is portable across machines and environments

## Hooks: The Control Flow API

Hooks let you change behavior without rewriting the loop:

- **Approval hooks** — Gate execution, deny, or escalate to a human
- **PreToolUse hooks** — Mutate inputs, short-circuit with cached results, stop the loop
- **PostToolUse hooks** — Transform outputs, truncate, log
- **PreRequest hooks** — Reshape the context window before the next model call

Everything is imperative TypeScript. Not hidden runtime behavior. Not configuration-by-convention. Code.

## Three Primitives for Composition

There are three primitives that matter for building agents:

1. **Tool modules** — Which tools each agent and sub-agent gets
2. **Instruction modules** — System prompts, skills, per-run addendums
3. **Context windows** — Sub-agents as context firewalls, truncation hooks, context transforms

AgentLayer keeps these orthogonal. You compose them in code: this agent gets these tools, these instructions, and manages its context this way.

## When to Use AgentLayer

Use AgentLayer when you need:

- **Portable, resumable state** — Pause in one process, resume in another
- **Custom tool backends** — Same interface, different implementations
- **Fine-grained control** — Hooks at every stage of execution
- **Human-in-the-loop** — Built-in approval flows that survive process restarts
- **Sub-agents** — Recursive delegation with nested pause/resume

## When Not to Use AgentLayer

If you just want to run Claude Code or Cursor on your codebase, use those. They're great tools.

AgentLayer is for when you're building your own agent and need more control than those tools provide.
