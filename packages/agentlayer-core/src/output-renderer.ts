import type { ModelMessage } from 'ai'
import type { AgentEvent } from './agent-run'
import * as color from './color'
import type { TokenUsageEvent } from './token-usage'

export interface OutputRendererOptions {
	output?: NodeJS.WritableStream
	writeLine?: (line: string) => void
	includeTokenUsage?: boolean
	includeToolResults?: boolean
	streamToolArgs?: boolean
}

export interface OutputRenderer {
	onEvent(event: AgentEvent): void
	flush(): void
}

type LiveToolInputState = {
	toolCallId: string
	toolName: string
	lineOpen: boolean
	hasWrittenArgs: boolean
	hasRenderedInvocation: boolean
	rawInput: string
	agentId?: string
	parentToolCallId?: string
}

type AgentIdentity = Pick<AgentEvent, 'agentId' | 'parentToolCallId'>

const MAX_INPUT_VAL = 120

const TOOL_COLORS: Record<string, (text: string) => string> = {
	read: color.blue,
	grep: color.blue,
	glob: color.blue,
	list: color.blue,
	write: color.yellow,
	edit: color.orange,
	multiedit: color.orange,
	'apply-patch': color.orange,
	apply_patch: color.orange,
	bash: color.red,
	webfetch: color.teal,
	websearch: color.teal,
	'web-fetch': color.teal,
	'web-search': color.teal,
	web_fetch: color.teal,
	web_search: color.teal,
	structured_output: color.green,
	done: color.green,
	todowrite: color.amber,
	todo_write: color.amber,
	agent: color.fuchsia,
	subagent: color.fuchsia,
	skill: color.pink,
}

function renderToolResultOutput(output: unknown): string {
	if (typeof output === 'string') return output
	if (!output || typeof output !== 'object') return ''

	if ('value' in output && typeof (output as { value?: unknown }).value === 'string') {
		return (output as { value: string }).value
	}

	if ('reason' in output && typeof (output as { reason?: unknown }).reason === 'string') {
		return (output as { reason: string }).reason
	}

	return JSON.stringify(output)
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s
	return `${s.slice(0, max)}${color.dim('...')}`
}

function shortPath(s: string): string {
	const parts = s.split('/')
	if (parts.length <= 3) return s
	return `.../${parts.slice(-2).join('/')}`
}

function visibleWhitespace(s: string): string {
	return s.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
}

function compactText(s: string, max: number): string {
	return truncate(visibleWhitespace(s.trim()), max)
}

function compactVal(v: unknown): string {
	if (v === undefined || v === null) return ''
	if (typeof v === 'string') {
		if (v.startsWith('/') && v.includes('/')) return shortPath(v)
		return compactText(v, 60)
	}
	return truncate(JSON.stringify(v), 60)
}

function compactInput(rawInput: unknown): string {
	if (rawInput == null) return ''
	let input: unknown = rawInput
	if (typeof rawInput === 'string') {
		try {
			input = JSON.parse(rawInput)
		} catch {
			return ` ${compactText(rawInput, MAX_INPUT_VAL)}`
		}
	}
	if (typeof input !== 'object') return ` ${compactText(String(input), MAX_INPUT_VAL)}`
	const obj = input as Record<string, unknown>
	const parts: string[] = []
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null) continue
		parts.push(`${color.dim(`${k}=`)}${compactVal(v)}`)
	}
	return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}

export function createOutputRenderer(options: OutputRendererOptions): OutputRenderer {
	const textBuffers = new Map<string, string>()
	const thinkingBuffers = new Map<string, string>()
	const liveToolInputs = new Map<string, LiveToolInputState>()
	const startedTextBlocks = new Set<string>()
	const startedThinkingBlocks = new Set<string>()
	const sawLiveAssistantContentByScope = new Set<string>()
	const renderedToolCallIds = new Set<string>()
	const toolCallDepths = new Map<string, number>()
	const output = options.output
	const includeToolResults = options.includeToolResults ?? false
	const includeTokenUsage = options.includeTokenUsage ?? false
	const streamToolArgs = options.streamToolArgs ?? false

	let activeToolLineId: string | undefined

	const write = (chunk: string): void => {
		if (output) {
			output.write(chunk)
			return
		}
		options.writeLine?.(chunk)
	}

	const formatThinkingLine = (line: string): string => {
		return `${color.purple('[Thinking]')} ${color.dim(color.italic(line.replace(/\r$/, '')))}`
	}

	const formatThinkingContinuationLine = (line: string): string => {
		return color.dim(color.italic(line.replace(/\r$/, '')))
	}

	const getAgentDepth = (event: AgentIdentity): number => {
		if (!event.agentId) return 0
		return event.parentToolCallId === undefined ? 1 : (toolCallDepths.get(event.parentToolCallId) ?? 0) + 1
	}

	const recordToolCallDepth = (toolCallId: string, event: AgentIdentity): void => {
		toolCallDepths.set(toolCallId, getAgentDepth(event))
	}

	const formatAgentIdentity = (event: AgentIdentity): string => {
		if (!event.agentId) return 'agent=root depth=0'
		return `agent=child:${event.agentId} depth=${getAgentDepth(event)}${event.parentToolCallId ? ` parent_call=${event.parentToolCallId}` : ''}`
	}

	const formatToolLabel = (toolName: string, toolCallId: string, event: AgentIdentity): string => {
		const colorFn = TOOL_COLORS[toolName.toLowerCase()] ?? color.blue
		return colorFn(`[Tool] ${toolName} call_id=${toolCallId} ${formatAgentIdentity(event)}`)
	}

	const formatToolCall = (toolName: string, toolCallId: string, input: unknown, event: AgentIdentity): string => {
		return `${formatToolLabel(toolName, toolCallId, event)}${compactInput(input)}`
	}

	const formatToolResultLabel = (
		toolName: string,
		toolCallId: string,
		isError: boolean,
		event: AgentIdentity,
	): string =>
		`${color.dim('[Tool Result]')} ${toolName} call_id=${toolCallId} ${formatAgentIdentity(event)} status=${isError ? 'error' : 'ok'}`

	const formatAssistantStartLine = (line: string): string => {
		return `${color.green('[Assistant]')} ${line.replace(/\r$/, '')}`
	}

	const formatAssistantContinuationLine = (line: string): string => {
		return line.replace(/\r$/, '')
	}

	const streamKey = (parts: { id?: string; agentId?: string; parentToolCallId?: string }): string => {
		return [parts.agentId ?? 'root', parts.parentToolCallId ?? 'root', parts.id ?? ''].join(':')
	}

	const scopeKey = (parts: { agentId?: string; parentToolCallId?: string }): string => {
		return [parts.agentId ?? 'root', parts.parentToolCallId ?? 'root'].join(':')
	}

	const ensureToolInputState = (toolCallId: string, toolName: string, event: AgentIdentity): LiveToolInputState => {
		recordToolCallDepth(toolCallId, event)
		const existing = liveToolInputs.get(toolCallId)
		if (existing) {
			existing.toolName = toolName
			existing.agentId = event.agentId
			existing.parentToolCallId = event.parentToolCallId
			return existing
		}
		const created: LiveToolInputState = {
			toolCallId,
			toolName,
			lineOpen: false,
			hasWrittenArgs: false,
			hasRenderedInvocation: false,
			rawInput: '',
			agentId: event.agentId,
			parentToolCallId: event.parentToolCallId,
		}
		liveToolInputs.set(toolCallId, created)
		return created
	}

	const activateToolLine = (toolCallId: string, toolName: string, event: AgentIdentity): LiveToolInputState => {
		if (activeToolLineId && activeToolLineId !== toolCallId) {
			flushActiveToolLine()
		}
		const state = ensureToolInputState(toolCallId, toolName, event)
		if (!state.lineOpen) {
			write(
				state.hasRenderedInvocation
					? color.dim(`[Tool Args] id=${toolCallId}`)
					: formatToolLabel(toolName, toolCallId, event),
			)
			state.hasRenderedInvocation = true
			renderedToolCallIds.add(toolCallId)
			state.lineOpen = true
			activeToolLineId = toolCallId
		}
		return state
	}

	function flushActiveToolLine(): void {
		if (!activeToolLineId) return
		const state = liveToolInputs.get(activeToolLineId)
		if (!state?.lineOpen) {
			activeToolLineId = undefined
			return
		}
		if (!streamToolArgs && state.rawInput.length > 0 && !state.hasWrittenArgs) {
			write(compactInput(state.rawInput))
			state.hasWrittenArgs = true
		}
		write('\n')
		state.lineOpen = false
		activeToolLineId = undefined
	}

	const flushToolInputLine = (toolCallId: string): void => {
		const state = liveToolInputs.get(toolCallId)
		if (!state) return
		if (!streamToolArgs) {
			if (!renderedToolCallIds.has(toolCallId)) {
				writeLine(formatToolCall(state.toolName, toolCallId, state.rawInput, state))
				renderedToolCallIds.add(toolCallId)
			}
			return
		}
		activateToolLine(toolCallId, state.toolName, state)
		flushActiveToolLine()
	}

	const writeLine = (line: string): void => {
		flushActiveToolLine()
		if (output) {
			output.write(`${line}\n`)
			return
		}
		options.writeLine?.(line)
	}

	const emitBufferedBlockLines = (
		buffers: Map<string, string>,
		key: string,
		chunk: string,
		formatStart: (line: string) => string,
		formatContinuation: (line: string) => string,
		startedBlocks: Set<string>,
	): void => {
		const next = `${buffers.get(key) ?? ''}${chunk}`
		const lines = next.split('\n')
		const remainder = lines.pop() ?? ''

		lines.forEach((line, index) => {
			const formatter = !startedBlocks.has(key) && index === 0 ? formatStart : formatContinuation
			writeLine(formatter(line))
			startedBlocks.add(key)
		})

		if (remainder.length > 0) {
			buffers.set(key, remainder)
		} else {
			buffers.delete(key)
		}
	}

	const flushBlockBuffer = (
		buffers: Map<string, string>,
		key: string,
		formatStart: (line: string) => string,
		formatContinuation: (line: string) => string,
		startedBlocks: Set<string>,
	): void => {
		const remainder = buffers.get(key)
		if (!remainder) return
		const formatter = startedBlocks.has(key) ? formatContinuation : formatStart
		writeLine(formatter(remainder))
		startedBlocks.add(key)
		buffers.delete(key)
	}

	const emitToolInputDelta = (toolCallId: string, delta: string, event: AgentIdentity): void => {
		const state = streamToolArgs
			? activateToolLine(toolCallId, liveToolInputs.get(toolCallId)?.toolName ?? 'tool', event)
			: ensureToolInputState(toolCallId, liveToolInputs.get(toolCallId)?.toolName ?? 'tool', event)
		state.rawInput += delta
		if (!streamToolArgs) return
		if (!state.hasWrittenArgs) {
			write(' ')
			state.hasWrittenArgs = true
		}
		write(color.dim(visibleWhitespace(delta)))
	}

	const flushAllBuffers = (): void => {
		for (const [key] of textBuffers)
			flushBlockBuffer(
				textBuffers,
				key,
				formatAssistantStartLine,
				formatAssistantContinuationLine,
				startedTextBlocks,
			)
		for (const [key] of thinkingBuffers) {
			const remainder = thinkingBuffers.get(key)
			if (!remainder) continue
			writeLine(
				startedThinkingBlocks.has(key)
					? formatThinkingContinuationLine(remainder)
					: formatThinkingLine(remainder),
			)
			startedThinkingBlocks.add(key)
			thinkingBuffers.delete(key)
		}
		for (const [toolCallId] of liveToolInputs) flushToolInputLine(toolCallId)
	}

	const emitMessage = (message: ModelMessage, event: AgentEvent): void => {
		const currentScope = scopeKey(event)
		for (const [key] of thinkingBuffers) {
			if (key.startsWith(`${currentScope}:`)) {
				const remainder = thinkingBuffers.get(key)
				if (remainder) {
					writeLine(formatThinkingLine(remainder))
					thinkingBuffers.delete(key)
				}
			}
		}

		if (message.role === 'assistant' && typeof message.content === 'string') {
			for (const [index, line] of message.content.split('\n').entries()) {
				writeLine(index === 0 ? formatAssistantStartLine(line) : formatAssistantContinuationLine(line))
			}
			return
		}

		if (message.role === 'assistant' && Array.isArray(message.content)) {
			const skipFinalAssistantText = sawLiveAssistantContentByScope.has(currentScope)
			sawLiveAssistantContentByScope.delete(currentScope)

			for (const part of message.content) {
				if (part.type === 'text') {
					if (!skipFinalAssistantText) {
						for (const [index, line] of part.text.split('\n').entries()) {
							writeLine(
								index === 0 ? formatAssistantStartLine(line) : formatAssistantContinuationLine(line),
							)
						}
					}
					continue
				}

				if (part.type === 'reasoning') {
					if (!skipFinalAssistantText) {
						for (const [index, line] of part.text.split('\n').entries()) {
							writeLine(index === 0 ? formatThinkingLine(line) : formatThinkingContinuationLine(line))
						}
					}
					continue
				}

				if (part.type === 'tool-call') {
					recordToolCallDepth(part.toolCallId, event)
					if (!renderedToolCallIds.has(part.toolCallId)) {
						writeLine(formatToolCall(part.toolName, part.toolCallId, part.input, event))
						renderedToolCallIds.add(part.toolCallId)
					}
				}
			}
			return
		}

		if (message.role === 'tool' && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part.type !== 'tool-result') continue
				writeLine(
					formatToolResultLabel(
						part.toolName,
						part.toolCallId,
						(part as typeof part & { isError?: boolean }).isError === true,
						event,
					),
				)
				if (!includeToolResults) continue

				const outputText = renderToolResultOutput(part.output)
				for (const line of outputText.split('\n')) {
					writeLine(`  ${line.replace(/\r$/, '')}`)
				}
			}
		}
	}

	const emitTokenUsage = (usage: TokenUsageEvent): void => {
		if (!includeTokenUsage) return
		writeLine(`tokens ${usage.model}: in=${usage.usage.inputTokens} out=${usage.usage.outputTokens}`)
	}

	return {
		onEvent(event) {
			switch (event.type) {
				case 'textStart': {
					for (const [key] of thinkingBuffers) {
						if (key.startsWith(`${scopeKey(event)}:`)) {
							const remainder = thinkingBuffers.get(key)
							if (remainder) {
								writeLine(formatThinkingLine(remainder))
								thinkingBuffers.delete(key)
							}
						}
					}
					sawLiveAssistantContentByScope.add(scopeKey(event))
					return
				}
				case 'textDelta':
					sawLiveAssistantContentByScope.add(scopeKey(event))
					emitBufferedBlockLines(
						textBuffers,
						streamKey(event),
						event.text,
						formatAssistantStartLine,
						formatAssistantContinuationLine,
						startedTextBlocks,
					)
					return
				case 'textEnd':
					flushBlockBuffer(
						textBuffers,
						streamKey(event),
						formatAssistantStartLine,
						formatAssistantContinuationLine,
						startedTextBlocks,
					)
					startedTextBlocks.delete(streamKey(event))
					return
				case 'toolInputStart':
					if (streamToolArgs) activateToolLine(event.id, event.toolName, event)
					else ensureToolInputState(event.id, event.toolName, event)
					return
				case 'toolInputDelta':
					emitToolInputDelta(event.id, event.delta, event)
					return
				case 'toolInputEnd':
					flushToolInputLine(event.id)
					liveToolInputs.delete(event.id)
					return
				case 'reasoningDelta': {
					sawLiveAssistantContentByScope.add(scopeKey(event))
					const key = streamKey(event)
					const next = `${thinkingBuffers.get(key) ?? ''}${event.text}`
					const lines = next.split('\n')
					const remainder = lines.pop() ?? ''
					for (const [index, line] of lines.entries()) {
						writeLine(
							!startedThinkingBlocks.has(key) && index === 0
								? formatThinkingLine(line)
								: formatThinkingContinuationLine(line),
						)
						startedThinkingBlocks.add(key)
					}
					if (remainder.length > 0) {
						thinkingBuffers.set(key, remainder)
					} else {
						thinkingBuffers.delete(key)
					}
					return
				}
				case 'reasoningStart':
					return
				case 'reasoningEnd': {
					const key = streamKey(event)
					const remainder = thinkingBuffers.get(key)
					if (remainder) {
						writeLine(
							startedThinkingBlocks.has(key)
								? formatThinkingContinuationLine(remainder)
								: formatThinkingLine(remainder),
						)
						thinkingBuffers.delete(key)
					}
					startedThinkingBlocks.delete(key)
					return
				}
				case 'message':
					emitMessage(event.message, event)
					return
				case 'approvalRequested':
					writeLine(`approval needed for ${event.toolName}: ${event.approval.message ?? 'approval required'}`)
					return
				case 'tokenUsage':
					emitTokenUsage(event.usage)
					return
				case 'stepFinish':
					for (const [toolCallId] of liveToolInputs) {
						flushToolInputLine(toolCallId)
					}
					for (const [key] of textBuffers) {
						if (key.startsWith(`${scopeKey(event)}:`)) {
							flushBlockBuffer(
								textBuffers,
								key,
								formatAssistantStartLine,
								formatAssistantContinuationLine,
								startedTextBlocks,
							)
							startedTextBlocks.delete(key)
						}
					}
					for (const [key] of thinkingBuffers) {
						if (key.startsWith(`${scopeKey(event)}:`)) {
							const remainder = thinkingBuffers.get(key)
							if (remainder) {
								writeLine(formatThinkingLine(remainder))
								thinkingBuffers.delete(key)
							}
						}
					}
					return
				case 'stepStart':
					return
			}
		},
		flush() {
			flushAllBuffers()
		},
	}
}
