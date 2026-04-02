import { describe, expect, test } from 'bun:test'
import { extractAccountId, parseJwtClaims } from '../../src/providers/codex-jwt'

// Helper to create a JWT with given payload
function makeJwt(payload: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
	const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
	const sig = Buffer.from('fake-signature').toString('base64url')
	return `${header}.${body}.${sig}`
}

describe('parseJwtClaims', () => {
	test('decodes valid JWT', () => {
		const jwt = makeJwt({ sub: 'user123', email: 'test@example.com' })
		const claims = parseJwtClaims(jwt)
		expect(claims).toEqual({ sub: 'user123', email: 'test@example.com' })
	})

	test('returns undefined for malformed JWT', () => {
		expect(parseJwtClaims('not-a-jwt')).toBeUndefined()
		expect(parseJwtClaims('')).toBeUndefined()
		expect(parseJwtClaims('a.b')).toBeUndefined()
	})

	test('returns undefined for invalid base64 payload', () => {
		expect(parseJwtClaims('header.!!!invalid!!!.sig')).toBeUndefined()
	})
})

describe('extractAccountId', () => {
	test('extracts from chatgpt_account_id in id_token', () => {
		const id_token = makeJwt({ chatgpt_account_id: 'acct-123' })
		expect(extractAccountId({ id_token })).toBe('acct-123')
	})

	test('extracts from nested claim path', () => {
		const id_token = makeJwt({
			'https://api.openai.com/auth': { chatgpt_account_id: 'acct-456' },
		})
		expect(extractAccountId({ id_token })).toBe('acct-456')
	})

	test('extracts from organizations array', () => {
		const id_token = makeJwt({ organizations: [{ id: 'org-789' }] })
		expect(extractAccountId({ id_token })).toBe('org-789')
	})

	test('falls back to access_token when id_token has no account', () => {
		const id_token = makeJwt({ email: 'test@example.com' })
		const access_token = makeJwt({ chatgpt_account_id: 'acct-from-access' })
		expect(extractAccountId({ id_token, access_token })).toBe('acct-from-access')
	})

	test('returns undefined when no account ID found', () => {
		const id_token = makeJwt({ email: 'test@example.com' })
		expect(extractAccountId({ id_token })).toBeUndefined()
	})
})
