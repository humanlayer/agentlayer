export interface IdTokenClaims {
	chatgpt_account_id?: string
	organizations?: Array<{ id: string }>
	email?: string
	'https://api.openai.com/auth'?: { chatgpt_account_id?: string }
	[key: string]: unknown
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
	const parts = token.split('.')
	if (parts.length !== 3) return undefined
	try {
		return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString())
	} catch {
		return undefined
	}
}

function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
	return (
		claims.chatgpt_account_id ??
		claims['https://api.openai.com/auth']?.chatgpt_account_id ??
		claims.organizations?.[0]?.id
	)
}

export function extractAccountId(tokens: { id_token?: string; access_token?: string }): string | undefined {
	if (tokens.id_token) {
		const claims = parseJwtClaims(tokens.id_token)
		if (claims) {
			const id = extractAccountIdFromClaims(claims)
			if (id) return id
		}
	}
	if (tokens.access_token) {
		const claims = parseJwtClaims(tokens.access_token)
		if (claims) return extractAccountIdFromClaims(claims)
	}
	return undefined
}
