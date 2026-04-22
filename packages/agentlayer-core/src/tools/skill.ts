import { type Skill, SkillTool } from '../interfaces'
import { SKILL_DESCRIPTION } from '../prompts'

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
			const baseDirAttr = skill.baseDir ? ` baseDir="${skill.baseDir}"` : ''
			ctx.updateContextWindow((messages) => [
				...messages,
				{
					role: 'user' as const,
					content: `<skill name="${skill.name}"${baseDirAttr}${input.args ? ` args="${input.args}"` : ''}>\n${skill.content}\n</skill>`,
				},
			])

			return `Skill "${skill.name}" activated successfully. Follow the instructions above.`
		},
		{
			description: `${SKILL_DESCRIPTION}\n\nAvailable skills:\n${skillList}`,
		},
	)
}
