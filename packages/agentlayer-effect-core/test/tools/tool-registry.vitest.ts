import { describe, it } from '@effect/vitest'
import { Cause, Chunk, Effect, Exit } from 'effect'
import * as z from 'zod'
import type { Tool } from '../../src/tools'
import { ToolNotFoundError, ToolRegistrationError, ToolRegistry, ToolRegistryLive } from '../../src/tools'

const makeMockTool = (name: string): Tool => ({
	name,
	description: `Mock tool ${name}`,
	inputSchema: z.object({ value: z.string() }),
	execute: () => Effect.succeed('ok'),
})

describe('ToolRegistry', () => {
	it.effect('creates an empty registry', ({ expect }) =>
		Effect.gen(function* () {
			const registry = yield* ToolRegistry
			const tools = yield* registry.list
			expect(tools).toHaveLength(0)
		}).pipe(Effect.provide(ToolRegistryLive([]))),
	)

	it.effect('creates a registry with initial tools', ({ expect }) =>
		Effect.gen(function* () {
			const registry = yield* ToolRegistry
			const tools = yield* registry.list
			expect(tools).toHaveLength(2)
			expect(tools.map((t) => t.name)).toEqual(['foo', 'bar'])
		}).pipe(Effect.provide(ToolRegistryLive([makeMockTool('foo'), makeMockTool('bar')]))),
	)

	it.effect('gets a tool by name', ({ expect }) =>
		Effect.gen(function* () {
			const registry = yield* ToolRegistry
			const tool = yield* registry.get('foo')
			expect(tool.name).toBe('foo')
		}).pipe(Effect.provide(ToolRegistryLive([makeMockTool('foo')]))),
	)

	it.effect('fails with ToolNotFoundError for unknown tool', ({ expect }) =>
		Effect.gen(function* () {
			const registry = yield* ToolRegistry
			const exit = yield* Effect.exit(registry.get('unknown'))
			expect(Exit.isFailure(exit)).toBe(true)
			if (Exit.isFailure(exit)) {
				const error = Chunk.toArray(Cause.failures(exit.cause))[0]
				expect(error).toBeInstanceOf(ToolNotFoundError)
				expect((error as ToolNotFoundError).toolName).toBe('unknown')
			}
		}).pipe(Effect.provide(ToolRegistryLive([makeMockTool('foo')]))),
	)

	it.effect('fails on duplicate tools at creation', ({ expect }) =>
		Effect.gen(function* () {
			const registry = yield* ToolRegistry
			yield* registry.list
		}).pipe(
			Effect.provide(ToolRegistryLive([makeMockTool('foo'), makeMockTool('foo')])),
			Effect.exit,
			Effect.map((exit) => {
				expect(Exit.isFailure(exit)).toBe(true)
			}),
		),
	)

	it.effect('registers a new tool', ({ expect }) =>
		Effect.gen(function* () {
			const registry = yield* ToolRegistry
			yield* registry.register(makeMockTool('bar'))
			const tools = yield* registry.list
			expect(tools).toHaveLength(2)
			expect(tools.map((t) => t.name)).toContain('bar')
		}).pipe(Effect.provide(ToolRegistryLive([makeMockTool('foo')]))),
	)

	it.effect('fails to register duplicate tool', ({ expect }) =>
		Effect.gen(function* () {
			const registry = yield* ToolRegistry
			const exit = yield* Effect.exit(registry.register(makeMockTool('foo')))
			expect(Exit.isFailure(exit)).toBe(true)
			if (Exit.isFailure(exit)) {
				const error = Chunk.toArray(Cause.failures(exit.cause))[0]
				expect(error).toBeInstanceOf(ToolRegistrationError)
			}
		}).pipe(Effect.provide(ToolRegistryLive([makeMockTool('foo')]))),
	)

	it.effect('unregisters a tool', ({ expect }) =>
		Effect.gen(function* () {
			const registry = yield* ToolRegistry
			yield* registry.unregister('foo')
			const tools = yield* registry.list
			expect(tools).toHaveLength(0)
		}).pipe(Effect.provide(ToolRegistryLive([makeMockTool('foo')]))),
	)

	it.effect('snapshot returns immutable map', ({ expect }) =>
		Effect.gen(function* () {
			const registry = yield* ToolRegistry
			const snapshot = yield* registry.snapshot
			expect(snapshot.size).toBe(1)
			expect(snapshot.get('foo')?.name).toBe('foo')
		}).pipe(Effect.provide(ToolRegistryLive([makeMockTool('foo')]))),
	)
})
