export function strictifySchema(schema: Record<string, unknown>): void {
	delete schema.format
	const props = schema.properties as Record<string, Record<string, unknown>> | undefined
	if (props) {
		schema.additionalProperties = false
		for (const prop of Object.values(props)) {
			strictifySchema(prop)
		}
	}
	const items = schema.items as Record<string, unknown> | undefined
	if (items) strictifySchema(items)
	const anyOf = schema.anyOf as Record<string, unknown>[] | undefined
	if (anyOf) for (const s of anyOf) strictifySchema(s)
	const oneOf = schema.oneOf as Record<string, unknown>[] | undefined
	if (oneOf) for (const s of oneOf) strictifySchema(s)
}
