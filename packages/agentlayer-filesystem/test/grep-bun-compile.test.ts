import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

describe('ripgrep in a Bun single-file executable', () => {
	test('uses the ripgrep programmatic API after bun build --compile', async () => {
		const dir = await mkdtemp(join(import.meta.dirname, '.tmp-grep-bun-compile-'))

		try {
			const fixtureDir = join(dir, 'fixture')
			await mkdir(fixtureDir)
			await writeFile(join(fixtureDir, 'target.ts'), 'const COMPILED_GREP_MARKER = 1\n')
			await writeFile(join(fixtureDir, 'other.txt'), 'COMPILED_GREP_MARKER should be filtered out\n')

			const entrypoint = join(dir, 'entry.ts')
			const outfile = join(dir, 'grep-compiled')

			await writeFile(
				entrypoint,
				`
import { ripgrep } from 'ripgrep'

const { code, stdout, stderr } = await ripgrep(
	['-nH', '--hidden', '--regexp', 'COMPILED_GREP_MARKER', '--glob', '*.ts', process.argv[2]],
	{ buffer: true },
)

if (code !== 0) {
	console.error(stderr)
	process.exit(1)
}

console.log(stdout)
`,
			)

			const build = await Bun.build({
				entrypoints: [entrypoint],
				conditions: ['source'],
				compile: {
					outfile,
				},
			})

			expect(build.success, build.logs.map((log) => log.message).join('\n')).toBe(true)

			const proc = Bun.spawn([outfile, fixtureDir], {
				stdout: 'pipe',
				stderr: 'pipe',
			})

			const [stdout, stderr, exitCode] = await Promise.all([
				Bun.readableStreamToText(proc.stdout),
				Bun.readableStreamToText(proc.stderr),
				proc.exited,
			])

			expect(stderr).toBe('')
			expect(exitCode).toBe(0)

			expect(stdout).toContain('target.ts:1:const COMPILED_GREP_MARKER = 1')
			expect(stdout).not.toContain('other.txt')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
