import TurndownService from "turndown"

// Reuse instance for performance
const turndown = new TurndownService({
	headingStyle: "atx",
	bulletListMarker: "-",
	codeBlockStyle: "fenced",
})

/**
 * Detect if content type is HTML
 */
export function isHtmlContentType(contentType: string | null): boolean {
	if (!contentType) return false
	const lower = contentType.toLowerCase()
	return lower.includes("text/html") || lower.includes("application/xhtml+xml")
}

/**
 * Convert HTML to Markdown
 */
export function htmlToMarkdown(html: string): string {
	return turndown.turndown(html)
}
