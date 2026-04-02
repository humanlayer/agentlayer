import { z } from 'zod'
import { defineToolInterface } from '../../core/define-tool'

export interface Skill {
	name: string
	description: string
	content: string
}

export const skillInput = z.object({
	name: z.string().describe('The name of the skill to activate'),
	args: z.string().optional().describe('Optional arguments for the skill'),
})

export type SkillInput = z.infer<typeof skillInput>

export const SkillTool = defineToolInterface({
	name: 'skill',
	description: 'Activate a skill by name',
	input: skillInput,
})

export function createSkillTool(opts: { skills: Skill[] }) {
	const skillMap = new Map(opts.skills.map((s) => [s.name, s]))
	const skillList = opts.skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')

	return SkillTool.define(
		async (input, ctx) => {
			const skill = skillMap.get(input.name)
			if (!skill) {
				return `Error: Skill "${input.name}" not found. Available skills:\n${skillList}`
			}

			// Queue injection — runs after tool result is committed to messages
			ctx.updateContextWindow((messages) => [
				...messages,
				{
					role: 'user' as const,
					content: `<skill name="${skill.name}"${input.args ? ` args="${input.args}"` : ''}>\n${skill.content}\n</skill>`,
				},
			])

			return `Skill "${skill.name}" activated successfully. Follow the instructions above.`
		},
		{
			description: `Activate a skill. Available skills:\n${skillList}`,
		},
	)
}
