import type { ApplyAttemptAbort, SecureApplyInput } from './types'

export const APPLY_AGENT_SYSTEM_PROMPT = `You are the Yjs Markdown apply agent.

Your job is to generate JavaScript that applies one requested Markdown oldString/newString edit to a disconnected Yjs document snapshot. The host will run your generated code in a secure executor and will reject any unsafe or invalid result.

Stable contract:
- Reconstruct a disconnected Y.Doc from input.snapshotBase64.
- Open only input.artifactFragmentName as the target Y.XmlFragment.
- Apply the requested edit structurally with Y.XmlFragment, Y.XmlElement, and Y.XmlText operations.
- Validate the result before returning.
- Return a SecureApplyResult JSON object with proposedUpdateBase64 computed from Y.encodeStateAsUpdate(doc, baseStateVector).
- Do not access network, filesystem, process, environment, shell, provider, or the live document.
- Do not import arbitrary packages. Use only host-allowlisted dependencies and helpers.
- If the target document changed and the host provides a <system-information> block, regenerate against the latest snapshot in that message.

Prompt caching requirement:
- Treat this system prompt and tool definitions as stable.
- Dynamic document state appears only in user messages.`

export function buildApplyUserMessage(input: SecureApplyInput): string {
	const systemInformation = input.systemInformation ? `${input.systemInformation}\n\n` : ''

	return `${systemInformation}Apply this Markdown edit to the target Yjs XML fragment.

path: ${input.path}
artifactFragmentName: ${input.artifactFragmentName}
baseArtifactRevision: ${input.baseArtifactRevision}

oldString:
${fence(input.oldString)}

newString:
${fence(input.newString)}

currentMarkdown:
${fence(input.currentMarkdown)}

currentXml:
${fence(input.currentXml)}

snapshotBase64:
${input.snapshotBase64}

baseStateVectorBase64:
${input.baseStateVectorBase64}`
}

export function buildAbortSystemInformation(abort: ApplyAttemptAbort): string {
	const summary = abort.changeSummary.map((line) => `- ${line}`).join('\n')

	return `<system-information>
The previous secure apply attempt was aborted because the target artifact changed while generated code was running.

path: ${abort.path}
revision: ${abort.previousRevision} -> ${abort.currentRevision}
changeSummary:
${summary || '- target fragment changed'}

updatedMarkdown:
${fence(abort.updatedMarkdown)}

updatedXml:
${fence(abort.updatedXml)}

The edit intent is unchanged. Apply the same requested oldString/newString transformation to this latest document state.
</system-information>`
}

function fence(value: string): string {
	return `\`\`\`txt\n${value}\n\`\`\``
}
