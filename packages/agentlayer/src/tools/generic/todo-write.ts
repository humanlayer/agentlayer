// Re-export everything from the original location for now
// The tool is already fully implemented in interfaces/todo-write.ts
// Alias for consistency with other tool factories
export {
	type TodoItem,
	type TodoWriteInput,
	TodoWriteTool,
	TodoWriteTool as createTodoWriteTool,
	todoItemSchema,
	todoWriteInput,
} from '../interfaces/todo-write'
