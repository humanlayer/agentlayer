import type { ModelMessage } from 'ai'
import type { AgentEvent } from './agent-run'
import type { ToolProgressData } from './define-tool'
import type { TokenUsageEvent } from './token-usage'
import * as color from './color'

export interface OutputRendererOptions {
	output?: NodeJS.WritableStream
	writeLine?: (line: string) => void
	includeTokenUsage?: boolean
	includeToolResults?: boolean
	streamToolArgs?: boolean
}

export interface OutputRenderer {
	onEvent(event: AgentEvent): void
	onToolProgress(toolCallId: string, toolName: string, data: ToolProgressData): void
	flush(): void
}

type ToolProgressState = {
	toolName: string
	sawLabel: boolean
	sawOutput: boolean
}

type LiveToolInputState = {
	toolName: string
	lineOpen: boolean
	hasWrittenArgs: boolean
	rawInput: string
}

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
	const toolOutputBuffers = new Map<string, string>()
	const toolProgressState = new Map<string, ToolProgressState>()
	const liveToolInputs = new Map<string, LiveToolInputState>()
	const sawLiveAssistantContentByScope = new Set<string>()
	const sawLiveToolInputByScope = new Set<string>()
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

	const formatToolLabel = (toolName: string): string => {
		const colorFn = TOOL_COLORS[toolName.toLowerCase()] ?? color.blue
		return colorFn(`[Tool] ${toolName}`)
	}

	const formatToolCall = (toolName: string, input: unknown): string => {
		return `${formatToolLabel(toolName)}${compactInput(input)}`
	}

	const streamKey = (parts: { id?: string; agentId?: string; parentToolCallId?: string }): string => {
		return [parts.agentId ?? 'root', parts.parentToolCallId ?? 'root', parts.id ?? ''].join(':')
	}

	const scopeKey = (parts: { agentId?: string; parentToolCallId?: string }): string => {
		return [parts.agentId ?? 'root', parts.parentToolCallId ?? 'root'].join(':')
	}

	const ensureToolProgressState = (toolCallId: string, toolName: string): ToolProgressState => {
		const existing = toolProgressState.get(toolCallId)
		if (existing) {
			existing.toolName = toolName
			return existing
		}
		const created: ToolProgressState = { toolName, sawLabel: false, sawOutput: false }
		toolProgressState.set(toolCallId, created)
		return created
	}

	const ensureToolLabel = (toolCallId: string, toolName: string): ToolProgressState => {
		const state = ensureToolProgressState(toolCallId, toolName)
		if (!state.sawLabel) {
			flushActiveToolLine()
			write(`${formatToolLabel(toolName)}\n`)
			state.sawLabel = true
		}
		return state
	}

	const ensureToolInputState = (toolCallId: string, toolName: string): LiveToolInputState => {
		const existing = liveToolInputs.get(toolCallId)
		if (existing) {
			existing.toolName = toolName
			return existing
		}
		const created: LiveToolInputState = {
			toolName,
			lineOpen: false,
			hasWrittenArgs: false,
			rawInput: '',
		}
		liveToolInputs.set(toolCallId, created)
		return created
	}

	const activateToolLine = (toolCallId: string, toolName: string): LiveToolInputState => {
		if (activeToolLineId && activeToolLineId !== toolCallId) {
			flushActiveToolLine()
		}
		const state = ensureToolInputState(toolCallId, toolName)
		if (!state.lineOpen) {
			write(formatToolLabel(toolName))
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
		activateToolLine(toolCallId, state.toolName)
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

	const emitBufferedLines = (buffers: Map<string, string>, key: string, chunk: string, prefix: string): void => {
		const next = `${buffers.get(key) ?? ''}${chunk}`
		const lines = next.split('\n')
		const remainder = lines.pop() ?? ''

		for (const line of lines) {
			writeLine(`${prefix}${line.replace(/\r$/, '')}`)
		}

		if (remainder.length > 0) {
			buffers.set(key, remainder)
		} else {
			buffers.delete(key)
		}
	}

	const flushBuffer = (buffers: Map<string, string>, key: string, prefix: string): void => {
		const remainder = buffers.get(key)
		if (!remainder) return
		writeLine(prefix.length > 0 ? `${prefix}${remainder.replace(/\r$/, '')}` : remainder.replace(/\r$/, ''))
		buffers.delete(key)
	}

	const emitToolInputDelta = (toolCallId: string, delta: string): void => {
		const state = activateToolLine(toolCallId, liveToolInputs.get(toolCallId)?.toolName ?? 'tool')
		state.rawInput += delta
		if (!streamToolArgs) return
		if (!state.hasWrittenArgs) {
			write(' ')
			state.hasWrittenArgs = true
		}
		write(color.dim(visibleWhitespace(delta)))
	}

	const flushAllBuffers = (): void => {
		for (const [key] of textBuffers) flushBuffer(textBuffers, key, '')
		for (const [key] of thinkingBuffers) {
			const remainder = thinkingBuffers.get(key)
			if (!remainder) continue
			writeLine(formatThinkingLine(remainder))
			thinkingBuffers.delete(key)
		}
		for (const [toolCallId] of liveToolInputs) flushToolInputLine(toolCallId)
		for (const [toolCallId, buffer] of toolOutputBuffers) {
			const toolName = toolProgressState.get(toolCallId)?.toolName ?? 'tool'
			ensureToolLabel(toolCallId, toolName)
			if (buffer.length > 0) {
				writeLine(`  ${buffer.replace(/\r$/, '')}`)
			}
			toolOutputBuffers.delete(toolCallId)
		}
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
			for (const line of message.content.split('\n')) {
				writeLine(line.replace(/\r$/, ''))
			}
			return
		}

		if (message.role === 'assistant' && Array.isArray(message.content)) {
			const skipFinalAssistantText = sawLiveAssistantContentByScope.has(currentScope)
			const skipFinalToolCalls = sawLiveToolInputByScope.has(currentScope)
			sawLiveAssistantContentByScope.delete(currentScope)
			sawLiveToolInputByScope.delete(currentScope)

			for (const part of message.content) {
				if (part.type === 'text') {
					if (!skipFinalAssistantText) {
						for (const line of part.text.split('\n')) {
							writeLine(line.replace(/\r$/, ''))
						}
					}
					continue
				}

				if (part.type === 'reasoning') {
					if (!skipFinalAssistantText) {
						for (const line of part.text.split('\n')) {
							writeLine(formatThinkingLine(line))
						}
					}
					continue
				}

				if (part.type === 'tool-call') {
					if (!skipFinalToolCalls) {
						writeLine(formatToolCall(part.toolName, part.input))
					}
				}
			}
			return
		}

		if (message.role === 'tool' && Array.isArray(message.content)) {
			if (!includeToolResults) return
			for (const part of message.content) {
				if (part.type !== 'tool-result') continue
				const toolState = toolProgressState.get(part.toolCallId)
				if (toolState?.sawOutput) continue
				ensureToolLabel(part.toolCallId, part.toolName)

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
					emitBufferedLines(textBuffers, streamKey(event), event.text, '')
					return
				case 'textEnd':
					flushBuffer(textBuffers, streamKey(event), '')
					return
				case 'toolInputStart':
					activateToolLine(event.id, event.toolName)
					sawLiveToolInputByScope.add(scopeKey(event))
					return
				case 'toolInputDelta':
					sawLiveToolInputByScope.add(scopeKey(event))
					emitToolInputDelta(event.id, event.delta)
					return
				case 'toolInputEnd':
					sawLiveToolInputByScope.add(scopeKey(event))
					flushToolInputLine(event.id)
					liveToolInputs.delete(event.id)
					return
				case 'reasoningDelta': {
					sawLiveAssistantContentByScope.add(scopeKey(event))
					const key = streamKey(event)
					const next = `${thinkingBuffers.get(key) ?? ''}${event.text}`
					const lines = next.split('\n')
					const remainder = lines.pop() ?? ''
					for (const line of lines) {
						writeLine(formatThinkingLine(line))
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
					const remainder = thinkingBuffers.get(streamKey(event))
					if (remainder) {
						writeLine(formatThinkingLine(remainder))
						thinkingBuffers.delete(streamKey(event))
					}
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
							flushBuffer(textBuffers, key, '')
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
		onToolProgress(toolCallId, toolName, data) {
			if (!includeToolResults) return
			const current = ensureToolLabel(toolCallId, toolName)

			if (data.type === 'status') {
				toolProgressState.set(toolCallId, current)
				writeLine(`  ${data.message}`)
				return
			}

			if (data.type === 'output') {
				current.sawOutput = true
				toolProgressState.set(toolCallId, current)
				emitBufferedLines(toolOutputBuffers, toolCallId, data.content, '  ')
				return
			}

			toolProgressState.set(toolCallId, current)
		},
		flush() {
			flushAllBuffers()
		},
	}
}
