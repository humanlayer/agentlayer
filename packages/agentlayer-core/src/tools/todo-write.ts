import z from 'zod'
import { defineTool } from '../define-tool'
import { TODO_WRITE_DESCRIPTION } from '../prompts'
export const todoItemSchema = z.object({
	content: z.string().min(1),
	status: z.enum(['pending', 'in_progress', 'completed']),
	activeForm: z.string().min(1),
})

export type TodoItem = z.infer<typeof todoItemSchema>

export const todoWriteInput = z.object({
	todos: z.array(todoItemSchema),
})

export type TodoWriteInput = z.infer<typeof todoWriteInput>

const todoStateSchema = z.array(todoItemSchema)

export const TodoWriteTool = defineTool({
	name: 'todo_write',
	description: TODO_WRITE_DESCRIPTION,
	input: todoWriteInput,
	stateKey: 'todos',
	stateSchema: todoStateSchema,
	execute: async (input, ctx) => {
		ctx.updateToolState(() => input.todos)
		const _pending = input.todos.filter((t) => t.status === 'pending').length
		const _inProgress = input.todos.filter((t) => t.status === 'in_progress').length
		const _completed = input.todos.filter((t) => t.status === 'completed').length
		return `Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable`
	},
})
