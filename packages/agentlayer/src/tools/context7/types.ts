export interface Context7Library {
	id: string
	title: string
	description?: string
	trustScore?: number
}

export interface Context7SearchResponse {
	results: Context7Library[]
}

export interface Context7ContextSegment {
	content: string
	sourceUrl?: string
}

export interface Context7ContextResponse {
	segments: Context7ContextSegment[]
}
