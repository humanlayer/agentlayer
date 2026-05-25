import * as z from 'zod'
import { defineToolInterface } from '../define-tool'

const DEFAULT_TIMEOUT_MS = 120_000

export const bashInput = z.object({
	command: z.string().describe('The command to execute'),
	timeout: z.number().describe('Optional timeout in milliseconds').default(DEFAULT_TIMEOUT_MS),
	workdir: z.string().describe('Working directory for the command. Use this instead of cd.').optional(),
	description: z.string().describe('Short (5-10 word) description of what this command does').optional(),
})

export type BashInput = z.infer<typeof bashInput>

export const BashTool = defineToolInterface({
	name: 'bash',
	description: 'Execute a bash command',
	input: bashInput,
})
