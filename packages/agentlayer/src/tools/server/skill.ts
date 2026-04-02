import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Skill } from '../interfaces/skill'
import { createSkillTool } from '../interfaces/skill'

function expandTilde(p: string): string {
	if (p === '~') return homedir()
	if (p.startsWith('~/')) return join(homedir(), p.slice(2))
	return p
}

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

export interface CreateSkillToolFromRepoDirsOptions {
	/** Custom candidate directories relative to search roots (default: ['.claude/skills', '.agents/skills']) */
	candidates?: string[]
	/** Additional inline skills that override directory skills */
	skills?: Skill[]
	/** Allow missing directories (return empty skills). If false (default), throws error when no directories found */
	allowMissing?: boolean
}

function getRepoRoot(): string | undefined {
	try {
		return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim()
	} catch {
		return undefined
	}
}

function resolveSkillsDirs(opts: { candidates: string[] }): { dirs: string[]; searched: string[] } {
	const cwd = process.cwd()
	const candidates = opts.candidates

	// Check cwd first
	const cwdDirs = candidates.map((dir) => join(cwd, dir)).filter((dir) => existsSync(dir))
	if (cwdDirs.length > 0) {
		return { dirs: cwdDirs, searched: cwdDirs }
	}

	// Fall back to git root
	const repoRoot = getRepoRoot()
	if (repoRoot && repoRoot !== cwd) {
		const rootDirs = candidates.map((dir) => join(repoRoot, dir)).filter((dir) => existsSync(dir))
		if (rootDirs.length > 0) {
			return { dirs: rootDirs, searched: [cwd, ...rootDirs] }
		}
	}

	// Nothing found
	const searched = repoRoot && repoRoot !== cwd ? [cwd, repoRoot] : [cwd]
	return { dirs: [], searched }
}

/**
 * Create a skill tool that loads skills from repository skill directories.
 * Searches for skills in cwd first, then falls back to git repo root.
 *
 * Default candidate directories: ['.claude/skills', '.agents/skills']
 *
 * Supports two conventions per directory:
 * - <dir>/<name>/SKILL.md (Claude Code convention - preferred)
 * - <dir>/<name>.md (flat fallback)
 */
export async function createSkillToolFromRepoDirs(opts: CreateSkillToolFromRepoDirsOptions = {}) {
	const candidates = opts.candidates ?? ['.claude/skills', '.agents/skills']
	const { dirs, searched } = resolveSkillsDirs({ candidates })

	if (dirs.length === 0) {
		if (opts.allowMissing) {
			return createSkillTool({ skills: opts.skills ?? [] })
		}
		throw new Error(`No skills directories found. Searched for ${candidates.join(', ')} in: ${searched.join(', ')}`)
	}

	return createSkillToolFromDirs({ dirs, skills: opts.skills })
}

export async function createSkillToolFromDirs(opts: { dirs: string | string[]; skills?: Skill[] }) {
	const directories = (Array.isArray(opts.dirs) ? opts.dirs : [opts.dirs]).map(expandTilde)
	const resolved: Skill[] = []

	for (const dir of directories) {
		let entries: string[]
		try {
			entries = await readdir(dir)
		} catch {
			continue // skip missing directories silently
		}

		for (const entry of entries) {
			const entryPath = join(dir, entry)

			// Check for <dir>/<name>/SKILL.md (Claude Code convention)
			const skillMdPath = join(entryPath, 'SKILL.md')
			try {
				const s = await stat(skillMdPath)
				if (s.isFile()) {
					const content = await Bun.file(skillMdPath).text()
					const name = entry
					const description = parseFrontmatterDescription(content) ?? parseFirstHeading(content) ?? name
					resolved.push({ name, description, content })
					continue
				}
			} catch {
				// no SKILL.md in this entry
			}

			// Fallback: <dir>/<name>.md (flat convention)
			if (entry.endsWith('.md')) {
				const content = await Bun.file(entryPath).text()
				const name = basename(entry, '.md')
				const description = parseFrontmatterDescription(content) ?? parseFirstHeading(content) ?? name
				resolved.push({ name, description, content })
			}
		}
	}

	// Inline skills override directory skills with the same name
	const mergedMap = new Map(resolved.map((s) => [s.name, s]))
	for (const skill of opts.skills ?? []) {
		mergedMap.set(skill.name, skill)
	}

	return createSkillTool({ skills: [...mergedMap.values()] })
}
