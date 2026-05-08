import { beforeEach, describe, expect, test } from 'bun:test'
import type { ToolContext } from '@humanlayer/agentlayer-core'
import dedent from 'dedent'
import * as Y from 'yjs'
import { createCodeModeYXmlEditorTool } from '../src/tools'

describe('QuickJS Code Mode Tool Tests', async () => {
	let doc: Y.Doc
	let fragment: Y.XmlFragment
	let root: Y.XmlElement

	beforeEach(() => {
		doc = new Y.Doc()
		fragment = doc.getXmlFragment('fragment')
		root = new Y.XmlElement('root')
		fragment.insert(0, [root])
		expect(fragment.toJSON()).toEqual('<root></root>')
	})
	test('Edits made through the tool should pass', async () => {
		const tool = createCodeModeYXmlEditorTool({ fragment })

		const toolExecution = tool.execute(
			{
				code: dedent`
                    const fragmentRef = bindings.root()
					const rootRef = bindings.get({ node: fragmentRef, index: 0 })
					bindings.append({
						parent: rootRef,
						content: [{ kind: 'element', nodeName: 'parent' }],
					})`,
			},
			{} as ToolContext,
		)

		await expect(toolExecution).resolves.toContain('Execution succeeded')
		expect(fragment.toJSON()).toEqual('<root><parent></parent></root>')

		const secondToolExecution = tool.execute(
			{
				code: dedent`
                const fragmentRef = bindings.root()
                const rootRef = bindings.get({ node: fragmentRef, index: 0 })
                const parentRef = bindings.get({ node: rootRef, index: 0 })
                bindings.append({
                    parent: parentRef,
                    content: [{ kind: 'element', nodeName: 'child' }],
                })	
            `,
			},
			{} as ToolContext,
		)

		await expect(secondToolExecution).resolves.toContain('Execution succeeded')
		expect(fragment.toJSON()).toEqual('<root><parent><child></child></parent></root>')
	})
})
