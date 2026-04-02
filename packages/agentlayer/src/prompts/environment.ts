import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface EnvironmentPromptOptions {
	cwd: string
	platform?: string
}

function isGitRepo(dir: string): boolean {
	let current = dir
	while (true) {
		if (existsSync(join(current, '.git'))) return true
		const parent = dirname(current)
		if (parent === current) return false
		current = parent
	}
}

export function environmentPrompt(opts: EnvironmentPromptOptions): string {
	const lines = [
		'# Environment',
		`- Working directory: ${opts.cwd}`,
		`- Is git repo: ${isGitRepo(opts.cwd) ? 'yes' : 'no'}`,
		`- Platform: ${opts.platform ?? process.platform}`,
		`- Today's date: ${new Date().toDateString()}`,
	]
	return lines.join('\n')
}
