import { describe, expect, test } from 'bun:test'
import { createCodingSubagentTool } from '../src/coding-subagent-tool'
import { OUTLINE_IMPLEMENTER_AGENT_NAME } from '../src/rpi-agents'

describe('createCodingSubagentTool', () => {
	test('includes the outline implementer sub-agent once', async () => {
		const tool = await createCodingSubagentTool({
			cwd: process.cwd(),
			model: 'claude-test' as any,
			system: 'test system prompt',
		})

		const subagents = tool.subagents.filter((agent) => agent.name === OUTLINE_IMPLEMENTER_AGENT_NAME)

		expect(OUTLINE_IMPLEMENTER_AGENT_NAME).toBe('rpi:outline-implementer-agent')
		expect(subagents).toHaveLength(1)
		expect(subagents[0]?.description).toContain('Implements structure outlines')
	})
})
