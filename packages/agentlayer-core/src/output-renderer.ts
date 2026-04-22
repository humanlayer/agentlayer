import type { ModelMessage } from 'ai'
import type { AgentEvent } from './agent-run'
import type { ToolProgressData } from './define-tool'
import type { TokenUsageEvent } from './token-usage'

export interface OutputRendererOptions {
	writeLine: (line: string) => void
	includeTokenUsage?: boolean
}

export interface OutputRenderer {
	onEvent(event: AgentEvent): void
	onToolProgress(toolCallId: string, toolName: string, data: ToolProgressData): void
	flush(): void
}

type ToolProgressState = {
	toolName: string
	sawOutput: boolean
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

export function createOutputRenderer(options: OutputRendererOptions): OutputRenderer {
	const textBuffers = new Map<string, string>()
	const thinkingBuffers = new Map<string, string>()
	const toolOutputBuffers = new Map<string, string>()
	const toolProgressState = new Map<string, ToolProgressState>()
	const sawLiveAssistantContentByScope = new Set<string>()

	const writeLine = (line: string): void => {
		options.writeLine(line)
	}

	const streamKey = (parts: { id?: string; agentId?: string; parentToolCallId?: string }): string => {
		return [parts.agentId ?? 'root', parts.parentToolCallId ?? 'root', parts.id ?? ''].join(':')
	}

	const scopeKey = (parts: { agentId?: string; parentToolCallId?: string }): string => {
		return [parts.agentId ?? 'root', parts.parentToolCallId ?? 'root'].join(':')
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
		writeLine(`${prefix}${remainder.replace(/\r$/, '')}`)
		buffers.delete(key)
	}

	const flushAllBuffers = (): void => {
		for (const [key] of textBuffers) flushBuffer(textBuffers, key, '')
		for (const [key] of thinkingBuffers) flushBuffer(thinkingBuffers, key, 'thinking: ')
		for (const [toolCallId, buffer] of toolOutputBuffers) {
			const toolName = toolProgressState.get(toolCallId)?.toolName ?? 'tool'
			if (buffer.length > 0) {
				writeLine(`tool ${toolName}: ${buffer.replace(/\r$/, '')}`)
			}
			toolOutputBuffers.delete(toolCallId)
		}
	}

	const emitMessage = (message: ModelMessage, event: AgentEvent): void => {
		const currentScope = scopeKey(event)
		for (const [key] of thinkingBuffers) {
			if (key.startsWith(`${currentScope}:`)) {
				flushBuffer(thinkingBuffers, key, 'thinking: ')
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
			sawLiveAssistantContentByScope.delete(currentScope)

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
							writeLine(`thinking: ${line.replace(/\r$/, '')}`)
						}
					}
					continue
				}

				if (part.type === 'tool-call') {
					writeLine(`tool ${part.toolName}`)
				}
			}
			return
		}

		if (message.role === 'tool' && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part.type !== 'tool-result') continue
				const toolState = toolProgressState.get(part.toolCallId)
				if (toolState?.sawOutput) continue

				const output = renderToolResultOutput(part.output)
				for (const line of output.split('\n')) {
					writeLine(`tool ${part.toolName}: ${line.replace(/\r$/, '')}`)
				}
			}
		}
	}

	const emitTokenUsage = (usage: TokenUsageEvent): void => {
		if (!options.includeTokenUsage) return
		writeLine(`tokens ${usage.model}: in=${usage.usage.inputTokens} out=${usage.usage.outputTokens}`)
	}

	return {
		onEvent(event) {
			switch (event.type) {
				case 'textStart':
					for (const [key] of thinkingBuffers) {
						if (key.startsWith(`${scopeKey(event)}:`)) {
							flushBuffer(thinkingBuffers, key, 'thinking: ')
						}
					}
					sawLiveAssistantContentByScope.add(scopeKey(event))
					return
				case 'textDelta':
					sawLiveAssistantContentByScope.add(scopeKey(event))
					emitBufferedLines(textBuffers, streamKey(event), event.text, '')
					return
				case 'textEnd':
					flushBuffer(textBuffers, streamKey(event), '')
					return
				case 'reasoningDelta':
					sawLiveAssistantContentByScope.add(scopeKey(event))
					emitBufferedLines(thinkingBuffers, streamKey(event), event.text, 'thinking: ')
					return
				case 'reasoningStart':
					return
				case 'reasoningEnd':
					flushBuffer(thinkingBuffers, streamKey(event), 'thinking: ')
					return
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
					for (const [key] of textBuffers) {
						if (key.startsWith(`${scopeKey(event)}:`)) {
							flushBuffer(textBuffers, key, '')
						}
					}
					for (const [key] of thinkingBuffers) {
						if (key.startsWith(`${scopeKey(event)}:`)) {
							flushBuffer(thinkingBuffers, key, 'thinking: ')
						}
					}
					return
				case 'stepStart':
					return
			}
		},
		onToolProgress(toolCallId, toolName, data) {
			const current = toolProgressState.get(toolCallId) ?? { toolName, sawOutput: false }
			current.toolName = toolName

			if (data.type === 'status') {
				toolProgressState.set(toolCallId, current)
				writeLine(`tool ${toolName}: ${data.message}`)
				return
			}

			if (data.type === 'output') {
				current.sawOutput = true
				toolProgressState.set(toolCallId, current)
				emitBufferedLines(toolOutputBuffers, toolCallId, data.content, `tool ${toolName}: `)
				return
			}

			toolProgressState.set(toolCallId, current)
		},
		flush() {
			flushAllBuffers()
		},
	}
}
