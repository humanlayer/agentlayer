#!/usr/bin/env bun
import readline from 'node:readline/promises'
import { anthropic } from '@ai-sdk/anthropic'
import { YjsProvider } from '@durable-streams/y-durable-streams'
import {
	Agent,
	claudePrompt,
	createOutputRenderer,
	doomLoop,
	maxSteps,
	renderFinish,
	startState,
	type Tool,
} from '@humanlayer/agentlayer-core'
import { readTruncationHook } from '@humanlayer/agentlayer-core/hooks'
import { createYjsFsPresenceHooks } from '@humanlayer/agentlayer-yjs-fs/hooks'
import { createYjsFsBashPresenceHooks } from '@humanlayer/agentlayer-yjs-fs-justbash/hooks'
import { createYjsFsSecureExecPresenceHooks } from '@humanlayer/agentlayer-yjs-fs-secure-exec/hooks'
import {
	createYjsFsApplyPatchTool,
	createYjsFsEditTool,
	createYjsFsGlobTool,
	createYjsFsGrepTool,
	createYjsFsListTool,
	createYjsFsReadTool,
	createYjsFsWriteTool,
} from '@humanlayer/agentlayer-yjs-fs/tools'
import { createYjsFsBashTool } from '@humanlayer/agentlayer-yjs-fs-justbash/tools'
import { createYjsFsSecureExecTool } from '@humanlayer/agentlayer-yjs-fs-secure-exec/tools'
import { colorFromId, YjsFilesystem } from '@humanlayer/yjs-fs'
import { Awareness } from 'y-protocols/awareness.js'
import * as Y from 'yjs'

// Caddy serves HTTPS with a local CA cert; set NODE_USE_SYSTEM_CA=1 so Bun/Node
// trusts the durable streams connection, e.g. NODE_USE_SYSTEM_CA=1 bun run dev.

const serviceName = process.env.YJS_SERVICE_NAME ?? 'yjs-fs-editor'
const docId = process.env.YJS_DOC_ID ?? 'default-workspace'
const yServerOrigin = process.env.Y_SERVER_ORIGIN ?? 'https://localhost:4000'
const providerBaseUrl = `${yServerOrigin}/v1/yjs/${serviceName}`
const agentId = process.env.AGENT_ID ?? crypto.randomUUID()
const prompt = getPromptArg()
const mode = getModeArg()

const doc = new Y.Doc()
const awareness = new Awareness(doc)
const localUser = {
	id: agentId,
	name: process.env.AGENT_NAME ?? 'Yjs FS Agent',
	color: colorFromId(agentId),
}

awareness.setLocalStateField('presence', { user: localUser, action: 'connecting' })
awareness.setLocalStateField('user', localUser)

const provider = new YjsProvider({
	doc,
	awareness,
	baseUrl: providerBaseUrl,
	docId,
	connect: false,
	liveMode: 'long-poll',
})

console.log(`Connecting to Yjs provider: baseUrl=${providerBaseUrl} docId=${docId} liveMode=long-poll`)
await provider.connect()
await waitForProviderSync(provider)
const fs = new YjsFilesystem({ doc, awareness })
fs.updateLocalPresence({ action: 'idle' })
console.log(`Connected. Agent mode=${mode}. Type /exit to quit.`)

const tools = {
	read: createYjsFsReadTool(fs),
	write: createYjsFsWriteTool(fs),
	edit: createYjsFsEditTool(fs),
	apply_patch: createYjsFsApplyPatchTool(fs, {}),
	list: createYjsFsListTool(fs),
	glob: createYjsFsGlobTool(fs),
	grep: createYjsFsGrepTool(fs),
}

const modeTools: Record<string, Tool<any, any>> =
	mode === 'secure-exec'
		? { secure_exec: createYjsFsSecureExecTool(fs, { enableNetwork: true, moduleAccessCwd: process.cwd() }) }
		: mode === 'justbash'
			? { bash: createYjsFsBashTool(fs) }
			: {
					bash: createYjsFsBashTool(fs),
					secure_exec: createYjsFsSecureExecTool(fs, { enableNetwork: true, moduleAccessCwd: process.cwd() }),
				}

const modePresenceHooks =
	mode === 'secure-exec'
		? createYjsFsSecureExecPresenceHooks(fs)
		: mode === 'justbash'
			? createYjsFsBashPresenceHooks(fs)
			: [...createYjsFsBashPresenceHooks(fs), ...createYjsFsSecureExecPresenceHooks(fs)]

const agent = new Agent({
	model: anthropic(process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6'),
	system: [claudePrompt],
	tools: {
		...tools,
		...modeTools,
	},
	hooks: {
		postToolUse: [readTruncationHook, ...createYjsFsPresenceHooks(fs), ...modePresenceHooks],
	},
	stopWhen: [doomLoop(3), maxSteps(40)],
})

let state = startState([])
const renderer = createOutputRenderer({ output: process.stdout })

try {
	if (prompt) {
		state = await runPrompt(prompt, state)
	} else {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
		try {
			for (;;) {
				const line = await rl.question('> ')
				const text = line.trim()
				if (!text) continue
				if (text === 'exit' || text === '/exit') break

				state = await runPrompt(text, state)
			}
		} finally {
			rl.close()
		}
	}
} finally {
	fs.updateLocalPresence({ action: 'offline' })
	await provider.flush()
	await provider.disconnect()
	provider.destroy()
}

async function runPrompt(text: string, currentState: typeof state): Promise<typeof state> {
	currentState.messages.push({ role: 'user', content: text })
	const run = agent.run({ state: currentState, stream: true })
	for await (const event of run) {
		renderer.onEvent(event)
	}
	const result = await run.result
	renderer.flush()
	renderFinish(result)
	return result.state
}

function getPromptArg(): string | undefined {
	const index = Bun.argv.indexOf('--prompt')
	if (index === -1) return undefined
	const value = Bun.argv[index + 1]
	if (!value) throw new Error('Missing value for --prompt')
	return value
}

function getModeArg(): 'all' | 'justbash' | 'secure-exec' {
	const index = Bun.argv.indexOf('--mode')
	if (index === -1) return 'all'
	const value = Bun.argv[index + 1]
	if (value === 'all' || value === 'justbash' || value === 'secure-exec') return value
	throw new Error('Invalid --mode. Expected one of: all, justbash, secure-exec')
}

async function waitForProviderSync(provider: YjsProvider, timeoutMs = 10_000): Promise<void> {
	const start = Date.now()
	while (!provider.synced) {
		if (Date.now() - start > timeoutMs) {
			throw new Error('Timed out waiting for Yjs provider initial sync')
		}
		await Bun.sleep(50)
	}
}
