import type { ModelMessage, UserModelMessage } from 'ai'

export const COMPACTION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`

export const DEFAULT_COMPACTION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

export const DEFAULT_COMPACTION_UPDATE_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

export const TURN_PREFIX_COMPACTION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`

export interface CompactionRequestTextInput {
	conversationText: string
	previousSummary?: string
	/** Replaces the default initial-checkpoint instruction. */
	compactionPrompt?: string
	/** Replaces the default incremental-checkpoint instruction. */
	compactionUpdatePrompt?: string
	additionalInstructions?: string
}

export function compactionInstruction(input: CompactionRequestTextInput): string {
	return input.previousSummary === undefined
		? (input.compactionPrompt ?? DEFAULT_COMPACTION_PROMPT)
		: (input.compactionUpdatePrompt ?? DEFAULT_COMPACTION_UPDATE_PROMPT)
}

/** Build the fixed conversation/previous-summary/instruction request framing. */
export function buildCompactionRequestText(input: CompactionRequestTextInput): string {
	const previousBlock =
		input.previousSummary === undefined
			? ''
			: `<previous-summary>\n${input.previousSummary}\n</previous-summary>\n\n`
	const guidance = input.additionalInstructions?.trim()
	const guidanceBlock = guidance ? `\n\nAdditional user guidance for this summary:\n${guidance}` : ''
	return `<conversation>\n${input.conversationText}\n</conversation>\n\n${previousBlock}${compactionInstruction(input)}${guidanceBlock}`
}

/** Build the concise request used only for a discarded prefix of an oversized current turn. */
export function buildTurnPrefixCompactionRequestText(conversationText: string): string {
	return `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_COMPACTION_PROMPT}`
}

/** Canonical provider-neutral message that replaces a compacted prefix in AgentState. */
export function compactionSummaryMessage(summary: string): UserModelMessage {
	return { role: 'user', content: `<conversation-summary>\n${summary}\n</conversation-summary>` }
}

/** Identify the canonical summary message associated with checkpoint metadata. */
export function isCompactionSummaryMessage(message: ModelMessage, summary: string): boolean {
	return message.role === 'user' && message.content === compactionSummaryMessage(summary).content
}
