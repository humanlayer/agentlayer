import { Context, Effect, Layer, SynchronizedRef } from 'effect'
import { ToolNotFoundError, ToolRegistrationError } from './errors'
import type { Tool } from './types'

/**
 * responsible for executing tools
 */
export class ToolRegistry extends Context.Tag('ToolRegistry')<
	ToolRegistry,
	{
		readonly snapshot: Effect.Effect<ReadonlyMap<string, Tool>>
		readonly list: Effect.Effect<ReadonlyArray<Tool>>
		readonly get: (name: string) => Effect.Effect<Tool, ToolNotFoundError>
		readonly register: (tool: Tool) => Effect.Effect<void, ToolRegistrationError>
		readonly unregister: (name: string) => Effect.Effect<void>
	}
>() {}

/**
 * Create a live layer based on a list of tools, throws an error if duplicate names are provided
 * @param tools
 * @returns
 */
export const ToolRegistryLive = (tools: ReadonlyArray<Tool>) =>
	Layer.effect(
		ToolRegistry,
		Effect.gen(function* () {
			const initialMap = new Map<string, Tool>()

			for (const tool of tools) {
				if (initialMap.has(tool.name)) {
					return yield* new ToolRegistrationError({
						toolName: tool.name,
						reason: `Duplicate tool name: ${tool.name}`,
					})
				}
				initialMap.set(tool.name, tool)
			}

			const ref = yield* SynchronizedRef.make<ReadonlyMap<string, Tool>>(initialMap)
			const snapshot = SynchronizedRef.get(ref)

			return {
				snapshot,
				list: Effect.gen(function* () {
					const current = yield* snapshot
					return [...current.values()]
				}),
				get: (name) =>
					Effect.gen(function* () {
						const current = yield* snapshot
						const tool = current.get(name)

						if (!tool) {
							yield* Effect.logError('tool not found').pipe(
								Effect.annotateLogs({
									'tool.name': name,
									'tool.available.count': current.size,
								}),
							)

							return yield* new ToolNotFoundError({
								toolName: name,
								availableTools: [...current.keys()],
							})
						}

						return tool
					}),
				register: (tool) =>
					SynchronizedRef.updateEffect(ref, (current) =>
						Effect.gen(function* () {
							if (current.has(tool.name)) {
								return yield* new ToolRegistrationError({
									toolName: tool.name,
									reason: `Duplicate tool name: ${tool.name}`,
								})
							}

							const next = new Map(current)
							next.set(tool.name, tool)
							return next
						}),
					),
				unregister: (name) =>
					SynchronizedRef.update(ref, (current) => {
						const next = new Map(current)
						next.delete(name)
						return next
					}),
			}
		}),
	)
