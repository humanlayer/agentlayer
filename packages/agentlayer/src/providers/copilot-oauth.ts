import { writeAuth } from './auth'

// OpenCode's GitHub OAuth App client ID — reused for compatibility
const COPILOT_CLIENT_ID = 'Ov23li8tweQw6odWQebz'

export interface CopilotDeviceFlowOptions {
	enterprise?: string
	onUserCode?: (code: string, uri: string) => void
}

export async function copilotDeviceFlow(opts?: CopilotDeviceFlowOptions): Promise<void> {
	const host = opts?.enterprise ? `https://${opts.enterprise}` : 'https://github.com'

	// 1. Initiate device flow
	const deviceResponse = await fetch(`${host}/login/device/code`, {
		method: 'POST',
		headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ client_id: COPILOT_CLIENT_ID, scope: 'read:user' }),
	})
	if (!deviceResponse.ok) throw new Error(`Device flow initiation failed: ${deviceResponse.status}`)

	const { device_code, user_code, verification_uri, interval } = (await deviceResponse.json()) as {
		device_code: string
		user_code: string
		verification_uri: string
		interval: number
	}

	// 2. Notify caller of user code
	if (opts?.onUserCode) {
		opts.onUserCode(user_code, verification_uri)
	}

	// 3. Poll for token
	while (true) {
		await new Promise((r) => setTimeout(r, (interval || 5) * 1000))

		const tokenResponse = await fetch(`${host}/login/oauth/access_token`, {
			method: 'POST',
			headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: COPILOT_CLIENT_ID,
				device_code,
				grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
			}),
		})

		const result = (await tokenResponse.json()) as {
			access_token?: string
			error?: string
		}

		if (result.access_token) {
			const authId = opts?.enterprise ? 'github-copilot-enterprise' : 'github-copilot'
			await writeAuth(authId, {
				type: 'oauth',
				access: result.access_token,
				refresh: result.access_token, // same for Copilot (long-lived)
				expires: 0,
				...(opts?.enterprise ? { enterpriseUrl: opts.enterprise } : {}),
			})
			return
		}

		if (result.error === 'authorization_pending' || result.error === 'slow_down') {
			continue
		}

		throw new Error(`Device flow failed: ${result.error || 'unknown error'}`)
	}
}
