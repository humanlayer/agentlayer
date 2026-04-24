import { describe, expect, test } from 'bun:test'
import { extractAccountId, extractAccountIdFromClaims, type IdTokenClaims, parseJwtClaims } from '../src/codex-jwt'

function createJwt(payload: Record<string, unknown>): string {
	const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
	return `header.${encoded}.signature`
}

describe('codex jwt helpers', () => {
	test('parseJwtClaims returns claims for valid jwt payloads', () => {
		const claims = parseJwtClaims(createJwt({ chatgpt_account_id: 'acct_123' }))
		expect(claims).toEqual({ chatgpt_account_id: 'acct_123' })
	})

	test('parseJwtClaims returns undefined for invalid tokens', () => {
		expect(parseJwtClaims('not-a-jwt')).toBeUndefined()
	})

	test('extractAccountIdFromClaims prefers direct account id, then auth claims, then organizations', () => {
		const directClaims: IdTokenClaims = { chatgpt_account_id: 'acct_direct' }
		const nestedClaims: IdTokenClaims = {
			'https://api.openai.com/auth': { chatgpt_account_id: 'acct_nested' },
		}
		const organizationClaims: IdTokenClaims = { organizations: [{ id: 'org_123' }] }

		expect(extractAccountIdFromClaims(directClaims)).toBe('acct_direct')
		expect(extractAccountIdFromClaims(nestedClaims)).toBe('acct_nested')
		expect(extractAccountIdFromClaims(organizationClaims)).toBe('org_123')
	})

	test('extractAccountId prefers id token before access token', () => {
		const idToken = createJwt({ chatgpt_account_id: 'acct_from_id' })
		const accessToken = createJwt({ chatgpt_account_id: 'acct_from_access' })

		expect(extractAccountId({ id_token: idToken, access_token: accessToken })).toBe('acct_from_id')
	})

	test('extractAccountId falls back to access token claims', () => {
		const accessToken = createJwt({ organizations: [{ id: 'org_from_access' }] })
		expect(extractAccountId({ access_token: accessToken })).toBe('org_from_access')
	})
})
