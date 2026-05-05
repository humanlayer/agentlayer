import { Agent, defineTool, doomLoop, maxSteps, toolCalled } from '@humanlayer/agentlayer-core'
import type { JSONContent } from '@tiptap/core'
import dedent from 'dedent'
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror'
import type * as Y from 'yjs'
import z from 'zod/v4'
import { tiptapJsonToMarkdown } from '../markdown'
import { createCodeModeYXmlEditorTool } from '../tools/codemode-yxml-editor'
import { YXML_PROXY_AGENT_PROMPT } from '../yxml-proxy-prompt'

const doneTool = defineTool({
	name: 'done',
	description: 'Call this tool when you complete your edits',
	input: z.object({}),
	execute: async () => {
		console.log('Done tool called')
	},
})

const stuckTool = defineTool({
	name: 'i_am_stuck',
	description: 'Call this tool if you are stuck and unable to complete your edits',
	input: z.object({
		message: z.string().describe('Indicate why you are stuck and unable to complete the requested edit'),
	}),
	execute: async ({ message }) => {
		console.error('Agent declared it is stuck:', message)
	},
})

export const createYXmlFragmentEditorAgent = (agentConfig: {
	modelConfig: ConstructorParameters<typeof Agent>[0]['model']
	fragment: Y.XmlFragment
	oldString: string
	newString: string
	replaceAll?: boolean
}) => {
	const { modelConfig, fragment, oldString, newString, replaceAll } = agentConfig

	const intructions = editorPrompt(fragment, oldString, newString, !!replaceAll)

	console.log('Editor Propmt:\n\n', editorPrompt)
	return new Agent({
		system: [YXML_PROXY_AGENT_PROMPT, intructions],
		model: modelConfig,
		tools: {
			edit_y_xml_fragment: createCodeModeYXmlEditorTool({ fragment }),
			done: doneTool,
			i_am_stuck: stuckTool,
		},
		stopWhen: [
			doomLoop(),
			maxSteps(30), // probably too many but we will see.
			toolCalled(doneTool.name),
			toolCalled(stuckTool.name),
		],
	})
}

const editorPrompt = (fragment: Y.XmlFragment, oldString: string, newString: string, replaceAll: boolean) => dedent`

    The document you are editing is a live Y.XMLFragment. Other users may be editing it in live time. 
    The information you see below is a point-in-time snapshot that may be out of date after 1+ edits.
    **IMPORTANT**: If you are unable to complete an edit because the document has changed, use the bindings API to inspect the document.

    This is how the document is currently represented in XML:
    <DOCUMENT_XML>  
        ${fragment.toJSON()}
    </DOCUMENT_XML>

    The document is rendered to the following markdown format, which is what the user can see. The user cannot see the raw Y.XMLFragment or the derived TipTap JSON.
    The markdown is NOT the raw form of the document. 
    The TipTap document, which is in TipTap's JSON protocol but translated to Y.XMLFragment for collaboration, is the canonical source of the document's state.
    This is the document:

    <DOCUMENT_MARKDOWN>
        ${tiptapJsonToMarkdown(yXmlFragmentToProsemirrorJSON(fragment) as JSONContent)}
    </DOCUMENT_MARKDOWN>

    The user has requested the following edit to the document, based on the markdown that the user is able to see:
    <EDIT_INSTRUCTION>
        Replace the Following old string with the new string. 

        <OLD_STRING>${oldString}</OLD_STRING>
        <NEW_STRING>${newString}</NEW_STRING>

        ${replaceAll ?? '<IMPORTANT>Make sure to replace ALL occurrences of old string with new string</IMPORTANT>'}

    </EDIT_INSTRUCTION>

    Your job is to interpret this edit instruction in the context of the markdown which the user can see and has requested the edit, and to use the DSL and code execution tool to apply the edit to the Y XML Fragment.

    <SYSTEM_REMINDERS>
        Important system reminder: 
        1. Use your tools to inspect and edit the document, to indicate when you are finished, or to indicate that you are stuck
        2. Your job is NOT to insert markdown into the XML fragment - rather, it is to use the fragment and the DSL to add the XML Elements, attributes, and text to apply the markdown-requested edit to the document.
        3. You should NOT include literal <OLD_STRING> / <NEW_STRING> XML tags in the document.
        4. The document may change over time, the bindings API will allow you to inspect it as needed.
        5. The console API in the edit tool will help you to inspect as needed.
        6. If an edit attempt fails, think about how you can apply the edit in a different way. Do not give up easily.
    </SYSTEM_REMINDERS>

`
