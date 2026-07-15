import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { createClaudeCodingAgentToolset, createCodexCodingAgentToolset } from '../src/coding-agent'
import { createBashTool } from '../src/tools/bash'
import { makeToolContext } from './mocks'

// Unique to this file so concurrent tests can't collide on it.
const INHERITED_SENTINEL = 'CODELAYER_BASH_ENV_MERGE_SENTINEL'

describe('bash tool env injection', () => {
	test('injects opts.env into the bash child process', async () => {
		const bash = createBashTool({ env: { CODELAYER_TEST_VAR: 'bar' } })
		const output = await bash.execute({ command: 'echo "$CODELAYER_TEST_VAR"', timeout: 5_000 }, makeToolContext())
		expect(output).toContain('bar')
	})

	test('merges over process.env rather than replacing it', async () => {
		// node's spawn() REPLACES the child env when `env` is set (it does not merge), so a
		// bare override would drop everything inherited (PATH/HOME/tokens) and break git.
		// Prove the merge by seeding an ambient var and asserting the child sees BOTH it and
		// the injected one.
		process.env[INHERITED_SENTINEL] = 'inherited'
		try {
			const bash = createBashTool({ env: { CODELAYER_TEST_VAR: 'injected' } })
			const output = await bash.execute(
				{ command: `echo "sentinel=$${INHERITED_SENTINEL} var=$CODELAYER_TEST_VAR"`, timeout: 5_000 },
				makeToolContext(),
			)
			expect(output).toContain('sentinel=inherited') // ambient process.env survived the merge
			expect(output).toContain('var=injected') // opts.env was applied
		} finally {
			delete process.env[INHERITED_SENTINEL]
		}
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

describe('coding-agent toolset threads env to its bash tool', () => {
	test('createClaudeCodingAgentToolset forwards env', async () => {
		const toolset = await createClaudeCodingAgentToolset({ cwd: tmpdir(), env: { CODELAYER_TEST_VAR: 'threaded' } })
		const output = await toolset.bash.execute(
			{ command: 'echo "$CODELAYER_TEST_VAR"', timeout: 5_000 },
			makeToolContext(),
		)
		expect(output).toContain('threaded')
	})

	test('createCodexCodingAgentToolset forwards env', async () => {
		const toolset = await createCodexCodingAgentToolset({ cwd: tmpdir(), env: { CODELAYER_TEST_VAR: 'threaded' } })
		const output = await toolset.bash.execute(
			{ command: 'echo "$CODELAYER_TEST_VAR"', timeout: 5_000 },
			makeToolContext(),
		)
		expect(output).toContain('threaded')
	})
})
