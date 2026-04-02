#!/usr/bin/env bun
import { Command } from 'commander'
import { readAllAuth, removeAuth, writeAuth } from '../providers/auth'
import { copilotDeviceFlow } from '../providers/copilot-oauth'

const program = new Command().name('agent-sdk').description('HumanLayer Agent SDK CLI')

const auth = program.command('auth').description('Manage provider authentication')

auth.command('anthropic')
	.description('Store an Anthropic API key')
	.action(async () => {
		process.stdout.write('  Enter your Anthropic API key: ')
		const key = await new Promise<string>((resolve) => {
			process.stdin.once('data', (data) => resolve(data.toString().trim()))
		})
		if (!key) {
			console.error('  API key is required.')
			process.exit(1)
		}
		await writeAuth('anthropic', { type: 'api', key })
		console.log('  Anthropic API key saved.')
		process.exit(0)
	})

auth.command('copilot')
	.description('Authenticate with GitHub Copilot')
	.action(async () => {
		console.log('  Authenticating with GitHub Copilot...')
		console.log()
		await copilotDeviceFlow({
			onUserCode: (code, uri) => {
				console.log('  Open this URL to authenticate:')
				console.log(`    ${uri}`)
				console.log()
				console.log(`  Enter code: ${code}`)
				console.log()
				console.log('  Waiting for authentication...')
			},
		})
		console.log('  Authenticated successfully.')
		process.exit(0)
	})

auth.command('copilot-enterprise')
	.description('Authenticate with GitHub Copilot Enterprise')
	.action(async () => {
		process.stdout.write('  Enter your GitHub Enterprise domain (e.g. company.ghe.com): ')
		const domain = await new Promise<string>((resolve) => {
			process.stdin.once('data', (data) => resolve(data.toString().trim()))
		})
		if (!domain) {
			console.error('  Domain is required.')
			process.exit(1)
		}

		console.log()
		console.log(`  Authenticating with GitHub Copilot Enterprise (${domain})...`)
		console.log()
		await copilotDeviceFlow({
			enterprise: domain,
			onUserCode: (code, uri) => {
				console.log('  Open this URL to authenticate:')
				console.log(`    ${uri}`)
				console.log()
				console.log(`  Enter code: ${code}`)
				console.log()
				console.log('  Waiting for authentication...')
			},
		})
		console.log('  Authenticated successfully.')
		process.exit(0)
	})

auth.command('codex')
	.description('Authenticate with OpenAI Codex')
	.action(async () => {
		console.log('  Select authentication method:')
		console.log()
		console.log('    1. Browser (PKCE) — opens browser for login')
		console.log('    2. Device code (headless) — enter code at URL')
		console.log()

		process.stdout.write('  Enter number (1 or 2): ')
		const choice = await new Promise<string>((resolve) => {
			process.stdin.once('data', (data) => resolve(data.toString().trim()))
		})

		if (choice === '1') {
			const { codexPkceFlow } = await import('../providers/codex-oauth')
			console.log()
			console.log('  Opening browser for authentication...')
			await codexPkceFlow({
				onOpenUrl: (url) => {
					console.log(`  If browser does not open, visit: ${url}`)
					import('node:child_process').then((cp) => cp.exec(`open "${url}"`)).catch(() => {})
				},
			})
		} else if (choice === '2') {
			const { codexDeviceFlow } = await import('../providers/codex-oauth')
			console.log()
			await codexDeviceFlow({
				onUserCode: (code, uri) => {
					console.log('  Open this URL to authenticate:')
					console.log(`    ${uri}`)
					console.log()
					console.log(`  Enter code: ${code}`)
					console.log()
					console.log('  Waiting for authentication...')
				},
			})
		} else {
			console.error('  Invalid selection.')
			process.exit(1)
		}

		console.log('  Authenticated successfully.')
		process.exit(0)
	})

auth.command('firepass')
	.description('Store a Fireworks AI API key')
	.action(async () => {
		process.stdout.write('  Enter your Fireworks API key: ')
		const key = await new Promise<string>((resolve) => {
			process.stdin.once('data', (data) => resolve(data.toString().trim()))
		})
		if (!key) {
			console.error('  API key is required.')
			process.exit(1)
		}
		await writeAuth('fireworks', { type: 'api', key })
		console.log('  Fireworks API key saved.')
		process.exit(0)
	})

auth.command('exa')
	.description('Store an Exa AI API key for web search')
	.action(async () => {
		process.stdout.write('  Enter your Exa AI API key: ')
		const key = await new Promise<string>((resolve) => {
			process.stdin.once('data', (data) => resolve(data.toString().trim()))
		})
		if (!key) {
			console.error('  API key is required.')
			process.exit(1)
		}
		await writeAuth('exa', { type: 'api', key })
		console.log('  Exa AI API key saved.')
		process.exit(0)
	})

auth.command('status')
	.description('Show current authentication status')
	.action(async () => {
		const all = await readAllAuth()
		const entries = Object.entries(all)
		if (entries.length === 0) {
			console.log('  No credentials stored.')
			return
		}
		for (const [id, info] of entries) {
			console.log(`  ${id}: ${info.type === 'oauth' ? 'authenticated' : 'api-key'}`)
		}
	})

auth.command('logout')
	.description('Clear stored credentials')
	.argument('[provider]', 'Provider to logout from (e.g. github-copilot, openai)')
	.action(async (provider?: string) => {
		if (provider) {
			await removeAuth(provider)
			console.log(`  Removed credentials for ${provider}.`)
		} else {
			const all = await readAllAuth()
			for (const id of Object.keys(all)) {
				await removeAuth(id)
			}
			console.log('  All credentials removed.')
		}
	})

program.parse()
