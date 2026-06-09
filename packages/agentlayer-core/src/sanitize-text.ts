import type { AgentLayerToolOutput } from './messages'

export function sanitizeTextForModelState(text: string): string {
	return text.replaceAll('\0', '\uFFFD').toWellFormed()
}

export function sanitizeToolOutputForModelState(output: AgentLayerToolOutput): AgentLayerToolOutput {
	return sanitizeValue(output) as AgentLayerToolOutput
}

function sanitizeValue(value: unknown): unknown {
	if (typeof value === 'string') {
		return sanitizeTextForModelState(value)
	}

	if (Array.isArray(value)) {
		return value.map(sanitizeValue)
	}

	if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
		return value
	}

	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, sanitizeValue(nested)]))
	}

	return value
}
