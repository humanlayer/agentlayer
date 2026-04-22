export interface EnvironmentPromptOptions {
	cwd: string
	isGitRepo: boolean
	platform?: string
	date?: Date
}

export function environmentPrompt(opts: EnvironmentPromptOptions): string {
	const today = opts.date ?? new Date()
	return [
		'# Environment',
		`- Working directory: ${opts.cwd}`,
		`- Is git repo: ${opts.isGitRepo ? 'yes' : 'no'}`,
		`- Platform: ${opts.platform ?? process.platform}`,
		`- Today's date: ${today.toDateString()}`,
	].join('\n')
}
