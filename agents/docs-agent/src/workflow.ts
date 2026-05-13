#!/usr/bin/env bun
import { resolve } from 'node:path'
import { $ } from 'bun'
import { Command } from 'commander'
import { runDocsEditor } from './editor'
import { loadAgentComment, upsertAgentComment } from './github'
import { runDocsReviewer } from './reviewer'

const repoRoot = resolve(import.meta.dir, '..', '..', '..')
const sourceFilePattern = /^(packages|agents)\/[^/]+\/src\//
const docsFilePattern = /^packages\/docs\/content\/.*\.md$/

const program = new Command()
	.name('docs-agent-workflow')
	.description('Run the docs reviewer/editor workflow for AgentLayer pull requests')
	.requiredOption('--mode <mode>', 'review or apply')
	.requiredOption('--pr-number <number>', 'Pull request number')
	.requiredOption('--sha <sha>', 'Head commit SHA used in comment markers')
	.requiredOption('--repo <owner/repo>', 'GitHub repository in owner/repo format')
	.requiredOption('--base-ref <ref>', 'Base branch used for the diff')
	.option('--gh-token <token>', 'GitHub token', process.env.GH_TOKEN)
	.option('--dry-run', 'Skip GitHub writes and git commit/push', false)
	.parse()

const opts = program.opts<{
	mode: string
	prNumber: string
	sha: string
	repo: string
	baseRef: string
	ghToken?: string
	dryRun: boolean
}>()

if (opts.mode !== 'review' && opts.mode !== 'apply') {
	throw new Error(`Unsupported mode ${opts.mode}. Expected review or apply.`)
}

if (!opts.ghToken && !opts.dryRun) {
	throw new Error('GH_TOKEN or --gh-token is required unless --dry-run is set.')
}

const prNumber = Number.parseInt(opts.prNumber, 10)
if (Number.isNaN(prNumber)) {
	throw new Error(`Invalid PR number: ${opts.prNumber}`)
}

async function gitText(args: string[]) {
	for (const range of args) {
		try {
			return await $`git -C ${repoRoot} diff ${range} -- packages agents`.text()
		} catch {
			continue
		}
	}
	throw new Error(`Unable to diff against ${opts.baseRef}. Make sure the base ref is available locally.`)
}

async function gitNameOnly(args: string[]) {
	for (const range of args) {
		try {
			return await $`git -C ${repoRoot} diff --name-only ${range} -- packages agents`.text()
		} catch {
			continue
		}
	}
	throw new Error(`Unable to list changed files against ${opts.baseRef}. Make sure the base ref is available locally.`)
}

function parseLines(text: string) {
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
}

async function getSourceChanges(baseRef: string) {
	const ranges = [`origin/${baseRef}...HEAD`, `${baseRef}...HEAD`, 'FETCH_HEAD...HEAD']
	const diff = await gitText(ranges)
	const changedFiles = parseLines(await gitNameOnly(ranges)).filter((file) => sourceFilePattern.test(file))
	return { diff, changedFiles }
}

async function getDocsStatusPorcelain() {
	return await $`git -C ${repoRoot} status --porcelain -- packages/docs/content`.text()
}

async function getChangedDocsFiles() {
	const tracked = parseLines(await $`git -C ${repoRoot} diff --name-only -- packages/docs/content`.text())
	const untracked = parseLines(await $`git -C ${repoRoot} ls-files --others --exclude-standard -- packages/docs/content`.text())
	return [...new Set([...tracked, ...untracked].filter((file) => docsFilePattern.test(file)))]
}

function buildReviewComment(review: string) {
	return `## Docs Agent Review\n\n${review}\n\n---\nTo apply these recommendations, comment: \`@docs-agent apply\``
}

function buildNoChangesComment() {
	return '## Docs Agent Review\n\nNo source changes under `packages/*/src` or `agents/*/src` were detected, so docs review was skipped.'
}

function buildApplyComment(changedDocsFiles: string[]) {
	if (changedDocsFiles.length === 0) {
		return '## Docs Agent Apply\n\nThe editor ran, the docs build passed, and no markdown updates were needed.'
	}

	return ['## Docs Agent Apply', '', 'Applied markdown updates and validated the docs build.', '', ...changedDocsFiles.map((file) => `- ${file}`)].join('\n')
}

const { diff, changedFiles } = await getSourceChanges(opts.baseRef)

if (opts.mode === 'review') {
	const review =
		changedFiles.length === 0
			? buildNoChangesComment()
			: buildReviewComment(
					await runDocsReviewer({
						cwd: repoRoot,
						diff,
						changedFiles,
						dryRun: opts.dryRun,
					}),
				)

	if (opts.dryRun) {
		console.log(review)
	} else {
		await upsertAgentComment({
			token: opts.ghToken!,
			repo: opts.repo,
			prNumber,
			agentName: 'docs-reviewer',
			sha: opts.sha,
			body: review,
		})
	}
	process.exit(0)
}

const preexistingDocsChanges = parseLines(await getDocsStatusPorcelain())
if (preexistingDocsChanges.length > 0) {
	throw new Error(
		`Refusing to apply docs updates with existing changes under packages/docs/content/: ${preexistingDocsChanges.join(', ')}`,
	)
}

let recommendations: string
const existingReview = opts.dryRun
	? undefined
	: await loadAgentComment({
			token: opts.ghToken!,
			repo: opts.repo,
			prNumber,
			agentName: 'docs-reviewer',
		})

if (existingReview) {
	recommendations = existingReview.body
} else {
	recommendations = await runDocsReviewer({
		cwd: repoRoot,
		diff,
		changedFiles,
		dryRun: opts.dryRun,
	})
}

await runDocsEditor({
	cwd: repoRoot,
	diff,
	recommendations,
	dryRun: opts.dryRun,
})

await $`bun --cwd ${repoRoot}/packages/docs run docs:build`

const changedDocsFiles = await getChangedDocsFiles()
if (!opts.dryRun && changedDocsFiles.length > 0) {
	for (const file of changedDocsFiles) {
		await $`git -C ${repoRoot} add -- ${file}`
	}
	await $`git -C ${repoRoot} commit -m ${'docs: apply docs-agent updates'}`
	await $`git -C ${repoRoot} push`
}

const applyComment = buildApplyComment(changedDocsFiles)
if (opts.dryRun) {
	console.log(applyComment)
} else {
	await upsertAgentComment({
		token: opts.ghToken!,
		repo: opts.repo,
		prNumber,
		agentName: 'docs-editor',
		sha: opts.sha,
		body: applyComment,
	})
}
