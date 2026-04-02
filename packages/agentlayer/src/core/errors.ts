export type AgentErrorType = 'invalid_messages_error' | 'unexpected_error'

export class AgentError extends Error {
	readonly type: AgentErrorType
	constructor(type: AgentErrorType, message: string) {
		super(message)
		this.name = 'AgentError'
		this.type = type
	}
}

export class InvalidMessagesError extends AgentError {
	override readonly type = 'invalid_messages_error' as const

	constructor(message: string) {
		super('invalid_messages_error', message)
		this.name = 'InvalidMessagesError'
	}
}
