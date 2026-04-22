export interface RepoInstructionsPromptOptions {
	path: string
	contents: string
}

export function repoInstructionsPrompt(opts: RepoInstructionsPromptOptions): string {
	return [
		'# Repository Instructions',
		`Use the following repository-specific instructions from ${opts.path}.`,
		'',
		opts.contents,
	].join('\n')
}
