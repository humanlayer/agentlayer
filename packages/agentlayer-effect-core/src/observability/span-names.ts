/**
 * Span names to normalize this
 */
export const SpanName = {
	toolRegistryBuild: () => 'tool.registry.build',
	toolResolve: (name: string) => `tool.resolve["${name}"]`,
	toolValidateInput: (name: string) => `tool.validateInput["${name}"]`,
	toolExecute: (name: string) => `tool.execute["${name}"]`,
	toolCommit: (name: string) => `tool.commit["${name}"]`,
	agentStateUpdate: () => 'agent.state.update',
	eventPublish: () => 'agent.events.publish',
} as const
