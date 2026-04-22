---
title: Motivation
description: Why AgentLayer separates the core loop from runtime implementations and keeps state serializable.
---

# Motivation

We've been building coding agents, human-in-the-loop agents, and background/outer-loop agents for a while now. Existing frameworks get you moving fast, but they tend to fall apart on the last 20%: swapping execution backends, owning control flow, rewriting the context window, or resuming state across long-running approval workflows.

So we built `AgentLayer` -- the harness, designed for harness engineering.

## Own Everything

Your prompts, your context window, your control flow, your state, your tool interfaces. In code. Type-safe. Imperative.

Not hidden framework conventions. Not configuration files where you cannot tell what the runtime is really doing. Code.

## Separate The Brain From The Hands

This is the key architectural idea.

The model should see a stable tool interface. The runtime should decide how the work actually happens.

The brain sees:

- schema
- description
- serialization

The hands do:

- local filesystem access
- sandboxed shell execution
- custom service calls
- database-backed or remote storage-backed implementations

That means the same interface can be implemented multiple ways without changing what the model is told.

## Stateless And Serializable

This is the other big differentiator.

`AgentState` is a JSON-serializable object with:

- messages
- pending tool calls
- approval history
- tool KV state
- sub-agent trees

You can persist it anywhere, shut the process down, and resume later after a human approves something hours or days later.

## The Harness

The quality of a coding agent is determined by its harness -- prompts, tools, hooks, context shaping, and control flow around the model.

AgentLayer exposes that harness directly in code.

- approval hooks
- pre-tool hooks
- post-tool hooks
- pre-request hooks
- stop conditions
- sub-agents

The goal is not to hide the harness. The goal is to let you engineer it.
