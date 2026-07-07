import { describe, expect, test } from 'bun:test'
import { createBashTool } from '../src/tools/bash'
import { makeToolContext } from './mocks'

describe('bash tool env injection', () => {
	test('injects opts.env into the bash child process', async () => {
		const bash = createBashTool({ env: { CODELAYER_TEST_VAR: 'bar' } })
		const output = await bash.execute({ command: 'echo "$CODELAYER_TEST_VAR"', timeout: 5_000 }, makeToolContext())
		expect(output).toContain('bar')
	})

	test('merges over process.env rather than replacing it (HOME survives)', async () => {
		// node's spawn() REPLACES the child env when `env` is set. Without merging over
		// process.env the child would lose HOME (and PATH, tokens, etc.), which breaks git.
		const bash = createBashTool({ env: { CODELAYER_TEST_VAR: 'bar' } })
		const output = await bash.execute({ command: 'echo "HOME=$HOME"', timeout: 5_000 }, makeToolContext())
		expect(output).toContain(`HOME=${process.env.HOME}`)
	})

	test('leaves the shell env untouched when no env is passed (back-compat)', async () => {
		const bash = createBashTool({})
		const output = await bash.execute(
			{ command: 'echo "[$CODELAYER_TEST_VAR]"', timeout: 5_000 },
			makeToolContext(),
		)
		expect(output).toContain('[]')
	})
})
