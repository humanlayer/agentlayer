export interface CopilotModelDefinition {
	id: string
	providerID: string
	api: {
		id: string
		url: string
		npm: string
	}
	status: 'active'
	limit: {
		context: number
		input: number
		output: number
	}
	capabilities: {
		temperature: boolean
		reasoning: boolean
		attachment: boolean
		toolcall: boolean
		input: {
			text: boolean
			audio: boolean
			image: boolean
			video: boolean
			pdf: boolean
		}
		output: {
			text: boolean
			audio: boolean
			image: boolean
			video: boolean
			pdf: boolean
		}
		interleaved: boolean
	}
	family: string
	name: string
	cost: {
		input: number
		output: number
		cache: {
			read: number
			write: number
		}
	}
	options: Record<string, unknown>
	headers: Record<string, string>
	release_date: string
	variants: Record<string, unknown>
}

export type CopilotModelMap = Record<string, CopilotModelDefinition>
