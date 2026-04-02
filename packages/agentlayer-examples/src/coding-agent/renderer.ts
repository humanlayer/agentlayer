import { color, Renderer } from '@humanlayer/agentlayer/render'

// Lowercase tool name -> color function
const TOOL_COLORS: Record<string, (text: string) => string> = {
	// Search / read (blue group)
	read: color.blue,
	grep: color.blue,
	glob: color.blue,
	list: color.blue,

	// Write (yellow)
	write: color.yellow,

	// Edit (orange)
	edit: color.orange,
	multiedit: color.orange,
	'apply-patch': color.orange,

	// Shell (red)
	bash: color.red,

	// Web (teal/cyan)
	webfetch: color.teal,
	websearch: color.teal,
	'web-fetch': color.teal,
	'web-search': color.teal,

	// Structured output / done (green)
	structured_output: color.green,
	done: color.green,

	// Planning (amber)
	todowrite: color.amber,

	// Subagent (fuchsia)
	agent: color.fuchsia,
}

export class CodingRenderer extends Renderer {
	protected override renderToolCall(toolName: string, input: unknown, indent: string): void {
		const colorFn = TOOL_COLORS[toolName.toLowerCase()] ?? color.blue
		if (this.toolLabelStyle === 'compact') {
			process.stdout.write(`${indent}${colorFn(`[Tool] ${toolName}`)}${this.formatInput(input)}\n`)
		} else {
			process.stdout.write(`${indent}${colorFn('[Tool]')} ${toolName}${this.formatInput(input)}\n`)
		}
	}
}
