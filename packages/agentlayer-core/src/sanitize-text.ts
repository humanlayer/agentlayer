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
		let changed = false
		const sanitized = value.map((nested) => {
			const next = sanitizeValue(nested)
			changed ||= next !== nested
			return next
		})
		return changed ? sanitized : value
	}

	if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
		return value
	}

	if (typeof value === 'object' && value !== null) {
		let changed = false
		const sanitizedEntries = Object.entries(value).map(([key, nested]) => {
			const next = sanitizeValue(nested)
			changed ||= next !== nested
			return [key, next]
		})
		return changed ? Object.fromEntries(sanitizedEntries) : value
	}

	return value
}
