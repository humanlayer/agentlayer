import { z } from 'zod'
import type { AgentEvent } from '..'
import type { Agent, RunResult } from '../agent'
import { defineTool } from '../define-tool'
import { extractLastAssistantText } from '../messages'
import { SUBAGENT_DESCRIPTION_TEMPLATE } from '../prompts'
import type { AgentState, TerminalChildOutcome, TerminalChildRecord, TerminalChildRuntime } from '../state'
import { startState } from '../state'
import { createForkState, type ForkTurns } from './subagent-fork'

export const subagentInputBase = z
	.object({
		description: z.string().describe('A short (3-5 words) description of the task'),
		prompt: z.string().describe('The task for the agent to perform'),
		subagent_type: z.string().describe('The type of specialized agent to use for this task'),
	})
	.strict()

export const subagentInputResumable = subagentInputBase.extend({
	agent_id: z
		.string()
		.optional()
		.describe(
			'This should only be set if you mean to resume a previous task ' +
				'(you can pass a prior agent_id and the task will continue the same ' +
				'subagent session as before instead of creating a fresh one)',
		),
})

export const forkingSubagentInput = z
	.object({
		description: z.string().optional().describe('Short description of the subagent task.'),
		prompt: z
			.string()
			.describe(
				'Task for the subagent. Custom-role tasks must be self-contained because they do not inherit the conversation.',
			),
		agent_id: z
			.string()
			.optional()
			.describe(
				'Continue an existing subagent using an ID from an earlier result. Do not combine with fork_turns or subagent_type.',
			),
		fork_turns: z
			.string()
			.optional()
			.describe(
				'Conversation to inherit: "all", "none", or a positive integer string such as "3". Omitted means "all". Do not combine with agent_id or subagent_type.',
			),
		subagent_type: z
			.string()
			.optional()
			.describe(
				'Start a registered specialist without inheriting the calling agent conversation. Do not combine with agent_id or fork_turns.',
			),
		skill: z.string().optional().describe('Optional skill to preload into the subagent.'),
	})
	.strict()

export type SubagentInputBase = z.infer<typeof subagentInputBase>
export type SubagentInputResumable = z.infer<typeof subagentInputResumable>
export type ForkingSubagentInput = z.infer<typeof forkingSubagentInput>
export type SubagentInput = SubagentInputBase | SubagentInputResumable | ForkingSubagentInput

export type SubagentCommand =
	| { type: 'fork'; prompt: string; turns: ForkTurns; description?: string; skill?: string }
	| { type: 'dispatch-role'; prompt: string; subagentType: string; description?: string; skill?: string }
	| { type: 'resume'; prompt: string; agentId: string; skill?: string }

// GPT-family models fill every schema property and send "" for fields they mean
// to omit, so a blank optional must parse as absent rather than error.
function normalizeOptional(value: string | undefined): string | undefined {
	if (value === undefined) return undefined
	const trimmed = value.trim()
	return trimmed === '' ? undefined : trimmed
}

function parseForkTurns(value: string | undefined): ForkTurns {
	if (value === undefined) return 'all'
	const normalized = value.trim().toLowerCase()
	if (normalized === 'all' || normalized === 'none') return normalized
	if (/^[1-9]\d*$/.test(normalized)) return Number(normalized)
	throw new Error('fork_turns must be "all", "none", or a positive integer string such as "3".')
}

export function parseSubagentCommand(input: ForkingSubagentInput): SubagentCommand {
	const prompt = input.prompt.trim()
	if (!prompt) throw new Error('prompt must not be blank.')

	const agentId = normalizeOptional(input.agent_id)
	const subagentType = normalizeOptional(input.subagent_type)
	const description = normalizeOptional(input.description)
	const skill = normalizeOptional(input.skill)
	const forkTurns = normalizeOptional(input.fork_turns)
	const selectorCount =
		Number(agentId !== undefined) + Number(subagentType !== undefined) + Number(forkTurns !== undefined)
	if (selectorCount > 1) {
		throw new Error('agent_id, fork_turns, and subagent_type are mutually exclusive; pass at most one.')
	}

	if (agentId) return { type: 'resume', prompt, agentId, ...(skill ? { skill } : {}) }
	if (subagentType) {
		return {
			type: 'dispatch-role',
			prompt,
			subagentType,
			...(description ? { description } : {}),
			...(skill ? { skill } : {}),
		}
	}
	return {
		type: 'fork',
		prompt,
		turns: parseForkTurns(forkTurns),
		...(description ? { description } : {}),
		...(skill ? { skill } : {}),
	}
}

interface BaseSubAgentConfig {
	name: string
	description: string
	agent: Agent
}

export interface ResumableSubAgentConfig extends BaseSubAgentConfig {
	resumable: true
}

export interface EphemeralSubAgentConfig extends BaseSubAgentConfig {
	resumable?: false
}

export type SubAgentConfig = ResumableSubAgentConfig | EphemeralSubAgentConfig

const subagentStateSchema = z.record(z.string(), z.any())
type LegacySubagentStateMap = Record<string, AgentState>

const CHILD_CACHE_SUFFIX_LENGTH = 28
const MAX_PROMPT_CACHE_KEY_LENGTH = 64

async function sha256Base64Url(value: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
	let binary = ''
	for (const byte of digest) binary += String.fromCharCode(byte)
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export async function deriveChildPromptCacheKey(parentKey: string, toolCallId: string): Promise<string> {
	const maxParentLength = MAX_PROMPT_CACHE_KEY_LENGTH - CHILD_CACHE_SUFFIX_LENGTH
	const safeParent =
		parentKey.length <= maxParentLength ? parentKey : (await sha256Base64Url(parentKey)).slice(0, maxParentLength)
	const suffix = (await sha256Base64Url(toolCallId)).slice(0, CHILD_CACHE_SUFFIX_LENGTH)
	return `${safeParent}${suffix}`
}

function expandedDescription(agentList: string, instructions?: string): string {
	return `Launch an isolated subagent.

${
	instructions
		? `${instructions}

`
		: ''
}Omit agent_id, fork_turns, and subagent_type to fork all eligible calling-agent conversation into a new child. Set fork_turns to "all", "none", or a positive integer string to control inherited conversation. Set subagent_type to start a fresh registered specialist with no inherited conversation. Every terminal result returns an agent_id; pass it with a follow-up prompt to continue that exact child after completion, error, or interruption.

Using fork_turns or omitting subagent_type spawns a subagent with the same tools as you and the ability to spawn its own subagents.

Registered specialists:
${agentList}`
}

interface CreateSubagentsToolOptions {
	agents: SubAgentConfig[]
	onChildEvent?: (event: AgentEvent) => void
	instructions?: string
}

/**
 * Creates the original specialist-only subagent tool. This remains available
 * for generic AgentLayer callers that require every new child to name a
 * registered specialist.
 */
export function createSubagentsTool(opts: CreateSubagentsToolOptions) {
	return createSubagentsToolImplementation(opts, false)
}

/**
 * Creates a subagent tool that defaults to an isolated caller fork and also
 * supports explicit fork selection, fresh specialists, and terminal resume.
 */
export function createForkingSubagentsTool(opts: CreateSubagentsToolOptions) {
	return createSubagentsToolImplementation(opts, true)
}

function createSubagentsToolImplementation(opts: CreateSubagentsToolOptions, supportsForking: boolean) {
	const agentMap = new Map(opts.agents.map((agent) => [agent.name, agent]))
	const hasAnyResumable = opts.agents.some((agent) => agent.resumable === true)
	const agentList = opts.agents
		.map((agent) => `- ${agent.name}: ${agent.description}${agent.resumable ? ' (resumable)' : ''}`)
		.join('\n')
	const description = supportsForking
		? expandedDescription(agentList, opts.instructions)
		: SUBAGENT_DESCRIPTION_TEMPLATE.replace('{agents}', agentList)
	const inputSchema = supportsForking
		? forkingSubagentInput
		: hasAnyResumable
			? subagentInputResumable
			: subagentInputBase

	return defineTool({
		name: 'subagent',
		description,
		input: inputSchema as z.ZodType<any>,
		stateKey: 'subagents',
		stateSchema: subagentStateSchema,
		execute: async (rawInput, ctx) => {
			let config: SubAgentConfig | undefined
			let childAgent: Agent
			let childState: AgentState
			let agentId: string
			let resumable = false
			let childRuntime: TerminalChildRuntime | undefined
			let priorTerminalRecord: TerminalChildRecord | undefined

			if (supportsForking) {
				let command: SubagentCommand
				try {
					command = parseSubagentCommand(rawInput as ForkingSubagentInput)
				} catch (error) {
					return `Error: ${error instanceof Error ? error.message : String(error)}`
				}

				if (command.type === 'dispatch-role') {
					config = agentMap.get(command.subagentType)
					if (!config) {
						return `Error: Unknown agent type "${command.subagentType}". Available types: ${opts.agents.map((agent) => agent.name).join(', ')}`
					}
					agentId = ctx.toolCallId ?? crypto.randomUUID()
					childAgent = config.agent
					childState =
						ctx.getSubAgentState?.(agentId) ?? startState([{ role: 'user', content: command.prompt }])
					resumable = true
					childRuntime = { type: 'specialist', subagentType: command.subagentType }
				} else if (command.type === 'resume') {
					priorTerminalRecord = ctx.getTerminalChild?.(command.agentId)
					if (!priorTerminalRecord) {
						return `Error: No terminal subagent found for agent_id "${command.agentId}". Start a new subagent by omitting agent_id.`
					}
					agentId = command.agentId
					childRuntime = priorTerminalRecord.runtime
					if (childRuntime.type === 'fork') {
						if (!ctx.createSubAgentForkAgent)
							return 'Error: Fork runtime is unavailable in this tool context.'
						childAgent = ctx.createSubAgentForkAgent()
					} else {
						config = agentMap.get(childRuntime.subagentType)
						if (!config) {
							return `Error: Registered specialist "${childRuntime.subagentType}" for agent_id "${agentId}" is unavailable.`
						}
						childAgent = config.agent
					}
					childState = {
						...priorTerminalRecord.state,
						messages: [...priorTerminalRecord.state.messages, { role: 'user', content: command.prompt }],
					}
					resumable = true
				} else {
					agentId = ctx.toolCallId ?? crypto.randomUUID()
					const pausedState = ctx.getSubAgentState?.(agentId)
					if (pausedState) {
						if (!ctx.createSubAgentForkAgent)
							return 'Error: Fork runtime is unavailable in this tool context.'
						childAgent = ctx.createSubAgentForkAgent()
						childState = pausedState
						childRuntime = { type: 'fork' }
					} else {
						if (!ctx.createSubAgentFork || !ctx.toolCallId) {
							return 'Error: Forking is unavailable in this tool context.'
						}
						const fork = ctx.createSubAgentFork()
						childAgent = fork.agent
						childState = createForkState(fork.state, command.turns, ctx.toolCallId, command.prompt)
						childRuntime = { type: 'fork' }
					}
					resumable = true
				}
			} else {
				const input = rawInput as SubagentInputResumable
				config = agentMap.get(input.subagent_type)
				if (!config) {
					return `Error: Unknown agent type "${input.subagent_type}". Available types: ${opts.agents.map((agent) => agent.name).join(', ')}`
				}
				const requestedAgentId = input.agent_id
				if (requestedAgentId && !config.resumable) {
					return `Error: Agent "${config.name}" does not support resumption. Do not pass agent_id for this agent type.`
				}
				agentId = requestedAgentId ?? ctx.toolCallId ?? crypto.randomUUID()
				childAgent = config.agent
				resumable = config.resumable === true
				childRuntime = { type: 'specialist', subagentType: config.name }
				const pausedState = ctx.getSubAgentState?.(agentId)
				if (pausedState) {
					childState = pausedState
				} else if (requestedAgentId && resumable) {
					priorTerminalRecord = ctx.getTerminalChild?.(requestedAgentId)
					const legacyStateMap = (ctx.getToolState() as LegacySubagentStateMap | undefined) ?? {}
					const stored = priorTerminalRecord?.state ?? legacyStateMap[requestedAgentId]
					if (!stored) {
						return `Error: No previous session found for agent_id "${requestedAgentId}". Start a new session by omitting agent_id.`
					}
					childState = {
						...stored,
						messages: [...stored.messages, { role: 'user', content: input.prompt }],
					}
				} else {
					childState = startState([{ role: 'user', content: input.prompt }])
				}
			}

			const promptCacheKey = ctx.promptCacheKey
				? await deriveChildPromptCacheKey(ctx.promptCacheKey, agentId)
				: undefined
			const childRun = childAgent.run({
				state: childState,
				signal: ctx.signal,
				stream: ctx.stream,
				promptCacheKey,
			})
			let result: RunResult

			if (ctx.awaitSubAgent && ctx.toolCallId) {
				result = (await ctx.awaitSubAgent(childRun, agentId, ctx.toolCallId)) as RunResult
			} else if (opts.onChildEvent) {
				for await (const event of childRun) opts.onChildEvent(event)
				result = await childRun.result
			} else {
				result = await childRun.result
			}

			if (result.finishReason === 'approvalRequired' && ctx.pauseForSubAgent) {
				return ctx.pauseForSubAgent(agentId, result.state)
			}

			const terminalOutcome: TerminalChildOutcome | undefined =
				result.finishReason === 'complete' ||
				result.finishReason === 'error' ||
				result.finishReason === 'interrupted'
					? result.finishReason
					: undefined
			const completedTurns =
				(priorTerminalRecord?.completedTurns ?? 0) + (result.finishReason === 'complete' ? 1 : 0)

			if (resumable && terminalOutcome && childRuntime) {
				ctx.setTerminalChild?.(agentId, {
					state: result.state,
					lastOutcome: terminalOutcome,
					completedTurns,
					runtime: childRuntime,
				})
			}

			const outputParts: string[] = []
			if (resumable && terminalOutcome) {
				outputParts.push(
					`agent_id: ${agentId}`,
					`outcome: ${terminalOutcome}`,
					`completed_turns: ${completedTurns}`,
					'Pass agent_id with a follow-up prompt to continue this exact subagent.',
					'',
				)
			}
			outputParts.push('<agent_result>', extractLastAssistantText(result), '</agent_result>')
			if (result.finishReason === 'error') {
				outputParts.push(
					'',
					`<agent_error>Agent finished with error: ${result.error?.message ?? 'unknown'}</agent_error>`,
				)
			}
			return outputParts.join('\n')
		},
	})
}
