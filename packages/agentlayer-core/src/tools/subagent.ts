import { z } from 'zod'
import type { AgentEvent } from '..'
import type { Agent, RunResult } from '../agent'
import { defineTool } from '../define-tool'
import { extractLastAssistantText } from '../messages'
import { SUBAGENT_DESCRIPTION_TEMPLATE } from '../prompts'
import type { AgentState } from '../state'
import { startState } from '../state'

// ── Input schemas ────────────────────────────────────────────────────────────

/** Base input fields shared by all subagent invocations. */
export const subagentInputBase = z.object({
	description: z.string().describe('A short (3-5 words) description of the task'),
	prompt: z.string().describe('The task for the agent to perform'),
	subagent_type: z.string().describe('The type of specialized agent to use for this task'),
})

/** Extended input that includes task_id for resumable agents. */
export const subagentInputResumable = subagentInputBase.extend({
	task_id: z
		.string()
		.optional()
		.describe(
			'This should only be set if you mean to resume a previous task ' +
				'(you can pass a prior task_id and the task will continue the same ' +
				'subagent session as before instead of creating a fresh one)',
		),
})

export type SubagentInputBase = z.infer<typeof subagentInputBase>
export type SubagentInputResumable = z.infer<typeof subagentInputResumable>
export type SubagentInput = SubagentInputBase | SubagentInputResumable

// ── Sub-agent config types ───────────────────────────────────────────────────

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

// ── State schema for resumable agents ────────────────────────────────────────

/** Maps task_id → serialized AgentState for resumable sub-agents. */
const subagentStateSchema = z.record(z.string(), z.any())
type SubagentStateMap = Record<string, AgentState>

// ── Factory ──────────────────────────────────────────────────────────────────

export function createSubagentsTool(opts: { agents: SubAgentConfig[]; onChildEvent?: (event: AgentEvent) => void }) {
	const agentMap = new Map(opts.agents.map((a) => [a.name, a]))
	const hasAnyResumable = opts.agents.some((a) => a.resumable === true)

	// Build agent list for description
	const agentList = opts.agents
		.map((a) => `- ${a.name}: ${a.description}${a.resumable ? ' (resumable)' : ''}`)
		.join('\n')

	const description = SUBAGENT_DESCRIPTION_TEMPLATE.replace('{agents}', agentList)

	// Pick schema based on whether any agents support resumption.
	const inputSchema = hasAnyResumable ? subagentInputResumable : subagentInputBase

	return defineTool({
		name: 'subagent',
		description,
		input: inputSchema as typeof subagentInputResumable,
		stateKey: 'subagents',
		stateSchema: subagentStateSchema,
		execute: async (input, ctx) => {
			const config = agentMap.get(input.subagent_type)
			if (!config) {
				const available = opts.agents.map((a) => a.name).join(', ')
				return `Error: Unknown agent type "${input.subagent_type}". Available types: ${available}`
			}

			// Handle task_id for resumption
			const taskId = input.task_id

			if (taskId && !config.resumable) {
				return `Error: Agent "${config.name}" does not support resumption. Do not pass task_id for this agent type.`
			}

			// Use toolCallId as the agentId for ephemeral agents — this is stable across
			// re-executions (executeDanglingToolCalls replays the same tool call), so
			// getSubAgentState can find the paused child state on resume.
			const agentId = taskId ?? ctx.toolCallId ?? crypto.randomUUID()

			// Resolve child state: check pause/resume state first, then tool state, then start fresh
			let childState: AgentState
			const pausedState = ctx.getSubAgentState?.(agentId)
			if (pausedState) {
				// Resuming from a paused sub-agent (approval was resolved)
				childState = pausedState
			} else if (taskId && config.resumable) {
				const stateMap = (ctx.getToolState() as SubagentStateMap | undefined) ?? {}
				const stored = stateMap[taskId]
				if (!stored) {
					return `Error: No previous session found for task_id "${taskId}". Start a new session by omitting task_id.`
				}
				// Append the new prompt as a user message to continue the conversation
				childState = {
					...stored,
					messages: [...stored.messages, { role: 'user' as const, content: input.prompt }],
				}
			} else {
				childState = startState([{ role: 'user' as const, content: input.prompt }])
			}

			// Run the child agent
			const childRun = config.agent.run({ state: childState, signal: ctx.signal })
			let result: RunResult

			// Use awaitSubAgent for event forwarding if available, otherwise fallback
			if (ctx.awaitSubAgent && ctx.toolCallId) {
				const subResult = await ctx.awaitSubAgent(childRun, agentId, ctx.toolCallId)
				result = subResult as RunResult
			} else if (opts.onChildEvent) {
				for await (const event of childRun) {
					opts.onChildEvent(event)
				}
				result = await childRun.result
			} else {
				result = await childRun.result
			}

			// If the child paused for approval, pause the parent too
			if (result.finishReason === 'approvalRequired' && ctx.pauseForSubAgent) {
				return ctx.pauseForSubAgent(agentId, result.state)
			}

			// Persist state for resumable agents
			if (config.resumable) {
				ctx.updateToolState((current: SubagentStateMap | undefined) => ({
					...(current ?? {}),
					[agentId]: result.state,
				}))
			}

			// Extract the last text output from the child
			const lastText = extractLastAssistantText(result)

			// Build output
			const outputParts: string[] = []

			if (config.resumable) {
				outputParts.push(`task_id: ${agentId} (for resuming to continue this agent's work if needed)`)
				outputParts.push('')
			}

			outputParts.push('<agent_result>')
			outputParts.push(lastText)
			outputParts.push('</agent_result>')

			if (result.finishReason === 'error') {
				outputParts.push('')
				outputParts.push(
					`<agent_error>Agent finished with error: ${result.error?.message ?? 'unknown'}</agent_error>`,
				)
			}

			return outputParts.join('\n')
		},
	})
}
