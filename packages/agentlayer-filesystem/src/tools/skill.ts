import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

function execCommand(command: string, args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
		let stdout = ''
		proc.stdout.on('data', (data: Buffer) => {
			stdout += data.toString()
		})
		proc.on('close', (code) => {
			if (code === 0) resolve(stdout)
			else reject(new Error(`Command failed with code ${code}`))
		})
		proc.on('error', reject)
	})
}

import { createSkillTool } from '@humanlayer/agentlayer-core'
import type { Skill } from '@humanlayer/agentlayer-core/interfaces'

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
	/** Working directory to search from. Defaults to process.cwd(). */
	cwd?: string
	/** Custom candidate directories relative to search roots (default: ['.claude/skills', '.agents/skills']) */
	candidates?: string[]
	/** Additional inline skills that override directory skills */
	skills?: Skill[]
	/** Allow missing directories (return empty skills). If false (default), throws error when no directories found */
	allowMissing?: boolean
}

async function getRepoRoot(cwd: string): Promise<string | undefined> {
	try {
		const stdout = await execCommand('git', ['rev-parse', '--show-toplevel'], cwd)
		return stdout.trim()
	} catch {
		return undefined
	}
}

async function dirExists(dir: string): Promise<boolean> {
	try {
		await access(dir, constants.F_OK)
		return true
	} catch {
		return false
	}
}

async function filterExistingDirs(dirs: string[]): Promise<string[]> {
	const results = await Promise.all(dirs.map(async (dir) => ({ dir, exists: await dirExists(dir) })))
	return results.filter((r) => r.exists).map((r) => r.dir)
}

async function resolveSkillsDirs(opts: {
	cwd: string
	candidates: string[]
}): Promise<{ dirs: string[]; searched: string[] }> {
	const cwd = opts.cwd
	const candidates = opts.candidates

	const cwdCandidates = candidates.map((dir) => join(cwd, dir))
	const cwdDirs = await filterExistingDirs(cwdCandidates)
	if (cwdDirs.length > 0) {
		return { dirs: cwdDirs, searched: cwdDirs }
	}

	const repoRoot = await getRepoRoot(cwd)
	if (repoRoot && repoRoot !== cwd) {
		const rootCandidates = candidates.map((dir) => join(repoRoot, dir))
		const rootDirs = await filterExistingDirs(rootCandidates)
		if (rootDirs.length > 0) {
			return { dirs: rootDirs, searched: [cwd, ...rootDirs] }
		}
	}

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
	const cwd = opts.cwd ?? process.cwd()
	const candidates = opts.candidates ?? ['.claude/skills', '.agents/skills']
	const { dirs, searched } = await resolveSkillsDirs({ cwd, candidates })

	if (dirs.length === 0) {
		if (opts.allowMissing) {
			return createSkillTool({ skills: opts.skills ?? [] })
		}
		throw new Error(`No skills directories found. Searched for ${candidates.join(', ')} in: ${searched.join(', ')}`)
	}

	return createSkillToolFromDirs({ dirs, skills: opts.skills })
}

/** Directory entry with optional namespace prefix for skill names */
export interface SkillDirEntry {
	/** Path to the skills directory */
	path: string
	/** Optional namespace prefix (e.g. 'rpi' -> skills load as 'rpi:skill-name') */
	namespace?: string
}

export async function createSkillToolFromDirs(opts: { dirs: string | string[] | SkillDirEntry[]; skills?: Skill[] }) {
	const directories: SkillDirEntry[] = (Array.isArray(opts.dirs) ? opts.dirs : [opts.dirs]).map((d) =>
		typeof d === 'string' ? { path: expandTilde(d) } : { ...d, path: expandTilde(d.path) },
	)
	const resolved: Skill[] = []

	for (const dirEntry of directories) {
		const dir = dirEntry.path
		const namespace = dirEntry.namespace
		let entries: string[]
		try {
			entries = await readdir(dir)
		} catch {
			continue
		}

		for (const entry of entries) {
			const entryPath = join(dir, entry)
			const skillMdPath = join(entryPath, 'SKILL.md')
			try {
				const s = await stat(skillMdPath)
				if (s.isFile()) {
					const content = await readFile(skillMdPath, 'utf8')
					const baseName = entry
					const name = namespace ? `${namespace}:${baseName}` : baseName
					const description = parseFrontmatterDescription(content) ?? parseFirstHeading(content) ?? baseName
					resolved.push({ name, description, content, baseDir: entryPath })
					continue
				}
			} catch {
				// no SKILL.md in this entry
			}

			if (entry.endsWith('.md')) {
				const content = await readFile(entryPath, 'utf8')
				const baseName = basename(entry, '.md')
				const name = namespace ? `${namespace}:${baseName}` : baseName
				const description = parseFrontmatterDescription(content) ?? parseFirstHeading(content) ?? baseName
				resolved.push({ name, description, content, baseDir: dir })
			}
		}
	}

	const mergedMap = new Map<string, Skill>()
	for (const skill of resolved) {
		if (!mergedMap.has(skill.name)) {
			mergedMap.set(skill.name, skill)
		}
	}
	for (const skill of opts.skills ?? []) {
		mergedMap.set(skill.name, skill)
	}

	return createSkillTool({ skills: [...mergedMap.values()] })
}
