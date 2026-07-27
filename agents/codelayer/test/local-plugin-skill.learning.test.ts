/**
 * Learning test: AgentLayer loads a skill from a local plugin bundle when its skill root is supplied.
 *
 * This test does not prove native plugin manifest or marketplace discovery. AgentLayer does not parse
 * plugin manifests today; the fixture's skills root is passed through the existing SkillDirEntry API.
 *
 * Run with: bun test --conditions=source ./test/local-plugin-skill.learning.test.ts
 * Requires valid Codex auth in ~/.humanlayer/agent-sdk/auth.json.
 */
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startState } from '@humanlayer/agentlayer-core'
import { createSkillToolFromDirs } from '@humanlayer/agentlayer-filesystem/tools'
import { createFileAuthStore } from '@humanlayer/agentlayer-provider-auth'
import { createCodelayerAgent, resolveModel } from '../src'

setDefaultTimeout(120_000)

const helloMarker = 'AGENTLAYER_LOCAL_PLUGIN_HELLO_7F3A9C'
const authStore = createFileAuthStore()
const hasCodexAuth = await authStore
	.get('codex')
	.then((auth) => Boolean(auth))
	.catch(() => false)

describe.skipIf(!hasCodexAuth)('local plugin skill learning test', () => {
	test('AgentLayer loads and invokes a skill from a local plugin bundle when its skill root is supplied', async () => {
		const pluginDir = await mkdtemp(join(tmpdir(), 'agentlayer-local-plugin-'))
		const skillsRoot = join(pluginDir, 'skills')
		const skillDir = join(skillsRoot, 'hello-world')

		try {
			await mkdir(join(pluginDir, '.codex-plugin'), { recursive: true })
			await mkdir(skillDir, { recursive: true })
			await writeFile(
				join(pluginDir, '.codex-plugin', 'plugin.json'),
				JSON.stringify({ name: 'agentlayer-learning-plugin', version: '1.0.0' }),
			)
			await writeFile(
				join(skillDir, 'SKILL.md'),
				`---\ndescription: Return the local plugin learning-test greeting\n---\n\n# Hello World\n\nReply with exactly: ${helloMarker}\n`,
			)

			const skillTool = await createSkillToolFromDirs({
				dirs: [{ path: skillsRoot, namespace: 'learning-plugin' }],
			})
			const model = await resolveModel('codex', 'gpt-5.5')
			const agent = await createCodelayerAgent({
				model,
				cwd: pluginDir,
				skillTool,
				providerOptionOverrides: { codex: { reasoningEffort: 'low' } },
				tools: {
					bash: false,
					read: false,
					write: false,
					edit: false,
					applyPatch: false,
					list: false,
					grep: false,
					glob: false,
					webFetch: false,
				},
			})
			const run = agent.run({
				state: startState([
					{
						role: 'user',
						content:
							'Invoke the skill tool for learning-plugin:hello-world, follow its instructions, and return its exact greeting.',
					},
				]),
			})
			for await (const _event of run) {
				// Consume the real Codex-backed agent run through completion.
			}
			const result = await run.result
			const assistantMessages = result.state.messages.filter((message) => message.role === 'assistant')
			const assistantConversation = JSON.stringify(assistantMessages)

			expect(assistantConversation).toContain('"toolName":"skill"')
			expect(assistantConversation).toContain('learning-plugin:hello-world')
			expect(assistantConversation).toContain(helloMarker)
		} finally {
			await rm(pluginDir, { recursive: true, force: true })
		}
	})
})
