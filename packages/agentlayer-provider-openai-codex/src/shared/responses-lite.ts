import { isResponsesLiteModel } from '@humanlayer/opencode-llm-vendor/protocols/openai-responses'
import { v7 as uuidv7, validate as validateUuid, version as uuidVersion } from 'uuid'

export const CODEX_RESPONSES_LITE_VERSION = '0.144.0'
export const CODEX_RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite'

export { isResponsesLiteModel }

export function resolveResponsesLiteSessionId(sessionId?: string): string {
	return sessionId && validateUuid(sessionId) && uuidVersion(sessionId) === 7 ? sessionId : uuidv7()
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
