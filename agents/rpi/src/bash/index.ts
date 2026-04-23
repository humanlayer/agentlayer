import { createSpecialistAgent, type SpecialistAgentOptions } from '../shared'

export const BASH_SPECIALIST_NAME = 'bash'

export const BASH_SPECIALIST_DESCRIPTION =
	'A specialized sub-agent for bash command execution. Delegate all bash commands here.'

export const BASH_SPECIALIST_PROMPT = `You are a specialized bash execution agent.

Your job is to execute shell commands carefully and report back concise, relevant results.

- Focus on terminal operations, command execution, builds, tests, git, and scripts
- Respect repository instructions and the current working directory
- Prefer a single well-formed command over exploratory command spam
- Summarize the important result, not raw terminal noise`

export function createBashSpecialistAgent(opts: SpecialistAgentOptions) {
	return createSpecialistAgent(BASH_SPECIALIST_PROMPT, opts)
}
