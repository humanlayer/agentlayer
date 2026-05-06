import { defineTool } from '@humanlayer/agentlayer-core'
import {
	type QuickJsRunWithConsoleResult,
	type QuickJsSerializedError,
	withQuickJsMode,
} from '@humanlayer/quickjs-exec'
import dedent from 'dedent'
import type * as Y from 'yjs'
import z from 'zod/v4'
import { YXmlProxyBindings } from '../yxml-proxy'

/**
 * Given a Y.XMLFragment create a tool that allows an agent to edit it in a sandboxed QuickJS runtime using code mode and a proxy bindings object to wrap the Y doc
 * @param options
 * @returns
 */
export const createCodeModeYXmlEditorTool = (options: { fragment: Y.XmlFragment }) => {
	return defineTool({
		name: 'edit_yjs_xml_fragment',
		description: 'Edit Y.js XML Fragments using a JavaScript sandbox with binding APIs',
		input: z.object({
			code: z
				.string()
				.describe(
					`'Javascript code to edit the Y.js XML Fragment using the 'bindings' API for mutation and 'console' API for debugging. Only allows pure JavaScript and bindings and console. No Node.js or browser APIs are allowed, and no packages are provided.`,
				),
		}),
		execute: async ({ code }, ctx) => {
			try {
				const proxy = new YXmlProxyBindings(options.fragment)
				return await withQuickJsMode(proxy.bindings, (qjs) => {
					const sandboxedExecutionResult = qjs.runWithConsole<unknown>(code)
					return formatQuickJsResult(sandboxedExecutionResult)
				})
			} catch (error: any) {
				console.error('Error with quickJS Execution against proxy:', error)
				throw error
			}
		},
	})
}

function formatQuickJsResult<T = unknown>(result: QuickJsRunWithConsoleResult<T>) {
	return dedent`
    Executing code...

    Log:
    <log>
    ${result.console.map((consoleLog) => `[${consoleLog.level}] ${JSON.stringify(consoleLog.args)}`).join('\n')}
    </log>

    ${result.ok ? `Execution succeeded. Result:\n<result>${JSON.stringify(result.value)}</result>` : `\n\nExecution failed:\n${formatQuickJsError(result.error)}`}
    `
}

function formatQuickJsError(error: QuickJsSerializedError) {
	return dedent`
        <error>
            <name>${error.name}</name>
            <message>${error.message}</message>
            <line_number>${error.lineNumber}</line_number>
            <column_number>${error.columnNumber}</column_number>
        </error>
    `
}
