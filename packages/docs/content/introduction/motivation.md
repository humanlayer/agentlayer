---
title: Motivation
description: Why `@humanlayer/agentlayer-core` separates tool interfaces from their implementations and keeps state serializable.
---

## We have opinions about coding agents
We've been building agents for a while now: coding agents, human-in-the-loop agents, and outer-loop background agents. 
It's safe to say that we have [a lot of opinions about coding agents](https://humanlayer.com/blog) - from [creating research/plan/implement](https://github.com/humanlayer/humanlayer) to  talking about [Advanced Context Engineering](https://www.youtube.com/watch?v=VvkhYWFWaKI)

If you've come across our content, you know we have strong opinions both about coding agents and about agent frameworks in general. To build good agents, you need good abstractions, but also deep low-level control over the execution flow, the agent's internal state, and most importantly, the **context window**.


## But this is not a coding agent
Existing coding agents are usually opinionated about execution, storage, and control flow. You can write plugins or hooks, but it is much harder to get in and mess with the control flow, do surgery on the context window, swap a tool backend, or replace a runtime without forking the entire project.

State is the other big problem. Existing coding agents tend to store state in on-disk databases, session files, or process-local stores. That's fine for interactive local use. It's not fine when you need to run an agent in one process, save its state to a store, and resume it in a different process after a human approves something hours or days later. It's not fine when you need to treat the filesystem as an API, but when you need a different storage backend. And if you're building production agents, using an agent SDK that ships you a compiled, closed-source binary doesn't cut it. 

## This is not a coding agent


## This is a framework for building coding agents


So we built `@humanlayer/agentlayer-core` -- the framework for building your own coding agent. 

## Own Everything

Your prompts, your context window, your control flow, your state, your tool interfaces. In code. Type-safe. Imperative.

Not hidden framework conventions. Not config files where you cannot tell what the runtime is actually doing. Code.

## Interface != Implementation

This is the key architectural insight: separate what the model sees from where the data comes from.

`ReadTool` defines the interface -- the schema, the description, the serialization format. The executor defines the implementation. Same interface, different backends:

```ts
// Local disk
ReadTool.define(async (input) => readFile(input.filePath, 'utf8'))

// S3
ReadTool.define(async (input) => s3.getObject({ Key: input.filePath }).then(r => r.Body.transformToString()))

// Sandboxed just-bash
ReadTool.define(async (input) => bash.exec(`cat "${input.filePath}"`))

// Database-as-filesystem
ReadTool.define(async (input) => db.query('SELECT content FROM files WHERE path = ?', [input.filePath]))
```

The model doesn't know the difference. The serialization comes from the interface. You do not need to fork the loop to change the backend. Just implement the interface.

Separate the brain from the hands.

## Stateless & Serializable

This is the differentiator.

State is a JSON blob -- `AgentState` with messages, pending tool calls, approval history, tool-specific state, and sub-agent trees. No SQLite required. No JSON files on disk required. It's a plain object you can `JSON.stringify()` and store wherever you want.

An agent can ask for approval, shut down before the tool call executes, then come back minutes, hours, days, or weeks later with an approval and resume. The state is portable -- run in a serverless function, save to Postgres, resume in a different process. Run in CI. No expensive process sitting idle waiting for a human response.

```ts
// Agent hits an approval gate -- serialize and shut down
const result = await run.result
if (result.finishReason === 'approvalRequired') {
  await db.save(result.state)
}

// Later, after a human approves
const state = await db.load()
const resumed = withApprovals(state, [
  { toolCallId: 'xyz', approved: true },
])
const run = agent.run({ state: resumed })
```

This matters because many coding agents are only resumable while their process and local state store are still alive. Here the state is just data.

## The Harness, Designed for Harness Engineering

The quality of a coding agent is determined by its harness -- the tools, prompts, hooks, and control flow surrounding the model. The toolkit is that harness.

Lightweight opinions with eject hatches:

- tool interfaces define schemas and serialization, but you can swap implementations freely
- hook pipelines let you gate, mutate, or transform tool behavior
- stop conditions let you control when and why the loop halts
- sub-agents let you build context firewalls and specialized execution paths

Hooks at every stage of the tool resolution pipeline:

- **Approval hooks** -- gate execution, deny, or escalate to a human
- **PreToolUse hooks** -- mutate inputs, short-circuit with synthetic results, stop the loop
- **PostToolUse hooks** -- transform outputs, truncate, log
- **PreRequest hooks** -- mutate the context window before it goes to the model

Everything is imperative, type-safe TypeScript. Not hidden runtime behavior. Not configuration-by-convention. Code.

## Tool Modules x Instruction Modules x Context Windows

There are three primitives that matter for agent composition:

- **Tool modules** -- configure which tools each agent and sub-agent gets
- **Instruction modules** -- system prompts, skills, per-run addendums
- **Context windows** -- sub-agents as context firewalls, truncation hooks, context transforms

The toolkit makes these concerns orthogonal. You compose them in code: this agent gets these tools, these instructions, and manages its context this way.
