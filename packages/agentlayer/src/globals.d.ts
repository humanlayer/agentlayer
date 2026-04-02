/** Allow importing plain-text files as string modules */
declare module '*.txt' {
	const content: string
	export default content
}
