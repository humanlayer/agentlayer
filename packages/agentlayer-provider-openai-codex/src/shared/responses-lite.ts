import { isResponsesLiteModel } from '@humanlayer/opencode-llm-vendor/protocols/openai-responses'

export const CODEX_RESPONSES_LITE_VERSION = '0.144.0'
export const CODEX_RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite'

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export { isResponsesLiteModel }

export function createUuidV7(now = Date.now()): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16))
	bytes[0] = Math.floor(now / 2 ** 40) & 0xff
	bytes[1] = Math.floor(now / 2 ** 32) & 0xff
	bytes[2] = Math.floor(now / 2 ** 24) & 0xff
	bytes[3] = Math.floor(now / 2 ** 16) & 0xff
	bytes[4] = Math.floor(now / 2 ** 8) & 0xff
	bytes[5] = now & 0xff
	bytes[6] = (bytes[6]! & 0x0f) | 0x70
	bytes[8] = (bytes[8]! & 0x3f) | 0x80

	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function resolveResponsesLiteSessionId(sessionId?: string): string {
	return sessionId && UUID_V7_PATTERN.test(sessionId) ? sessionId : createUuidV7()
}

export function responsesLiteHeaderRecord(sessionId: string): Record<string, string> {
	return {
		'session-id': sessionId,
		'thread-id': sessionId,
		'x-session-affinity': sessionId,
		version: CODEX_RESPONSES_LITE_VERSION,
		[CODEX_RESPONSES_LITE_HEADER]: 'true',
	}
}
