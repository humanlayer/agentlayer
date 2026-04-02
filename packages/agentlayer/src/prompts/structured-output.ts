export const structuredOutputPrompt = `# Structured Output

IMPORTANT: The user has requested structured output. You MUST use the structured_output tool to provide your final response. Do NOT respond with plain text — you MUST call the structured_output tool with your answer formatted according to the schema.

## Instructions

1. Complete all necessary research, analysis, and tool calls FIRST
2. Once you have gathered all the information needed, call the structured_output tool EXACTLY ONCE
3. The \`data\` field must be valid JSON matching the required schema
4. After calling structured_output, do not call any other tools or produce additional text

## Example

If asked "What is 2 + 2?" with a schema requiring \`{ answer: number, explanation: string }\`:

1. Compute the answer
2. Call structured_output with: \`{ "data": { "answer": 4, "explanation": "Simple addition" } }\`

The structured_output tool call is your FINAL action — the agent loop stops immediately after it.`
