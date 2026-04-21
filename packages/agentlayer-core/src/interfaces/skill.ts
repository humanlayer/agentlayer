import { z } from 'zod'
import { defineToolInterface } from '../define-tool'

export interface Skill {
	name: string
	description: string
	content: string
	baseDir?: string
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
