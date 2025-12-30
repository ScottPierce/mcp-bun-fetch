import { describe, expect, test } from "bun:test"
import { htmlToMarkdown, isHtmlContentType } from "./content"

describe("isHtmlContentType", () => {
	test("should return true for text/html", () => {
		expect(isHtmlContentType("text/html")).toBe(true)
	})

	test("should return true for text/html with charset", () => {
		expect(isHtmlContentType("text/html; charset=utf-8")).toBe(true)
	})

	test("should return true for application/xhtml+xml", () => {
		expect(isHtmlContentType("application/xhtml+xml")).toBe(true)
	})

	test("should return false for application/json", () => {
		expect(isHtmlContentType("application/json")).toBe(false)
	})

	test("should return false for text/plain", () => {
		expect(isHtmlContentType("text/plain")).toBe(false)
	})

	test("should return false for null", () => {
		expect(isHtmlContentType(null)).toBe(false)
	})

	test("should be case insensitive", () => {
		expect(isHtmlContentType("TEXT/HTML")).toBe(true)
		expect(isHtmlContentType("Text/Html")).toBe(true)
	})
})

describe("htmlToMarkdown", () => {
	test("should convert heading", () => {
		const html = "<h1>Title</h1>"
		const markdown = htmlToMarkdown(html)
		expect(markdown).toContain("# Title")
	})

	test("should convert paragraph", () => {
		const html = "<p>Hello world</p>"
		const markdown = htmlToMarkdown(html)
		expect(markdown).toContain("Hello world")
	})

	test("should convert links", () => {
		const html = '<a href="https://example.com">Example</a>'
		const markdown = htmlToMarkdown(html)
		expect(markdown).toContain("[Example](https://example.com)")
	})

	test("should convert bold text", () => {
		const html = "<strong>bold</strong>"
		const markdown = htmlToMarkdown(html)
		expect(markdown).toContain("**bold**")
	})

	test("should convert italic text", () => {
		const html = "<em>italic</em>"
		const markdown = htmlToMarkdown(html)
		expect(markdown).toContain("_italic_")
	})

	test("should convert unordered list", () => {
		const html = "<ul><li>One</li><li>Two</li></ul>"
		const markdown = htmlToMarkdown(html)
		expect(markdown).toMatch(/-\s+One/)
		expect(markdown).toMatch(/-\s+Two/)
	})

	test("should convert code blocks", () => {
		const html = "<pre><code>const x = 1;</code></pre>"
		const markdown = htmlToMarkdown(html)
		expect(markdown).toContain("```")
		expect(markdown).toContain("const x = 1;")
	})

	test("should handle complex HTML", () => {
		const html = `
			<html>
			<head><title>Test Page</title></head>
			<body>
				<h1>Welcome</h1>
				<p>This is a <a href="https://example.com">link</a> with <strong>bold</strong> text.</p>
				<ul>
					<li>Item 1</li>
					<li>Item 2</li>
				</ul>
			</body>
			</html>
		`
		const markdown = htmlToMarkdown(html)
		expect(markdown).toContain("# Welcome")
		expect(markdown).toContain("[link](https://example.com)")
		expect(markdown).toContain("**bold**")
		expect(markdown).toMatch(/-\s+Item 1/)
	})

	test("should handle empty HTML", () => {
		const html = ""
		const markdown = htmlToMarkdown(html)
		expect(markdown).toBe("")
	})
})
