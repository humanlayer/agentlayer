import type { Skill } from '@humanlayer/agentlayer-core/interfaces'
import { createSkillTool } from '@humanlayer/agentlayer-core/interfaces'
import type { Bash } from 'just-bash'

function parseFrontmatterDescription(content: string): string | null {
	const match = content.match(/^---\n([\s\S]*?)\n---/)
	if (!match) return null
	const fmMatch = match[1]?.match(/description:\s*(.+)/)
	return fmMatch?.[1]?.trim() ?? null
}

function parseFirstHeading(content: string): string | null {
	const match = content.match(/^#\s+(.+)/m)
	return match?.[1]?.trim() ?? null
}

export async function createSkillToolFromVFS(bash: Bash, opts: { dirs: string | string[]; skills?: Skill[] }) {
	const directories = Array.isArray(opts.dirs) ? opts.dirs : [opts.dirs]
	const resolved: Skill[] = []

	for (const dir of directories) {
		let lsResult: { stdout: string; exitCode: number }
		try {
			lsResult = await bash.exec(`ls "${dir}"/*.md 2>/dev/null`)
		} catch {
			continue
		}
		if (lsResult.exitCode !== 0) continue

		const files = lsResult.stdout.trim().split('\n').filter(Boolean)
		for (const filePath of files) {
			const catResult = await bash.exec(`cat "${filePath}"`)
			if (catResult.exitCode !== 0) continue

			const content = catResult.stdout
			const name = filePath.split('/').pop()?.replace('.md', '') ?? filePath
			const description = parseFrontmatterDescription(content) ?? parseFirstHeading(content) ?? name

			resolved.push({ name, description, content })
		}
	}

	const mergedMap = new Map(resolved.map((s) => [s.name, s]))
	for (const skill of opts.skills ?? []) {
		mergedMap.set(skill.name, skill)
	}

	return createSkillTool({ skills: [...mergedMap.values()] })
}
