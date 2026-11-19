/**
 * A small tokenizer for the languages this owner reads.
 *
 * Display only: it returns styled spans, never ANSI, so the renderer applies the
 * theme last and a test can check the tokens without a terminal. An unknown
 * language, or a line the scanner cannot finish, comes back plain.
 */

/** What a span is, for the renderer to colour. */
export type SpanKind = "plain" | "keyword" | "string" | "comment" | "number" | "fn" | "type";

/** A run of text that shares one style. */
export interface Span {
	text: string;
	kind: SpanKind;
}

/** The languages with a tokenizer, by the name the extension writes. */
export type Language = "ts" | "rust" | "python" | "json" | "markdown" | "shell" | "plain";

/** The keywords worth colouring: short on purpose, so nothing surprises a reader. */
const KEYWORDS: Record<Language, Set<string>> = {
	ts: new Set([
		"const", "let", "var", "function", "return", "if", "else", "for", "while", "of", "in", "new", "class", "extends",
		"interface", "type", "import", "export", "from", "as", "async", "await", "try", "catch", "throw", "switch", "case",
		"default", "null", "undefined", "true", "false", "void", "typeof", "delete",
	]),
	rust: new Set([
		"fn", "let", "mut", "pub", "use", "mod", "impl", "trait", "struct", "enum", "match", "if", "else", "for", "while",
		"loop", "return", "self", "Self", "crate", "super", "where", "as", "const", "static", "unsafe", "async", "await",
		"move", "ref", "dyn", "in", "true", "false",
	]),
	python: new Set([
		"def", "class", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or", "import", "from", "as",
		"with", "try", "except", "finally", "raise", "lambda", "yield", "pass", "break", "continue", "None", "True",
		"False", "self", "async", "await",
	]),
	json: new Set(["true", "false", "null"]),
	markdown: new Set(),
	shell: new Set([
		"if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "return", "export",
		"local", "in",
	]),
	plain: new Set(),
};

/** The comment marker of a language, or "". */
function commentMarker(language: Language): string {
	if (language === "python" || language === "shell") return "#";
	if (language === "ts" || language === "rust") return "//";
	return "";
}

/** The string delimiters of a language. */
function delimiters(language: Language): string[] {
	if (language === "json") return ['"'];
	if (language === "python") return ['"', "'"];
	if (language === "shell") return ['"', "'"];
	return ['"', "'", "`"];
}

/** The language of a path, by its extension. */
export function languageOf(path: string): Language {
	const lower = path.toLowerCase();
	if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(lower)) return "ts";
	if (lower.endsWith(".rs")) return "rust";
	if (lower.endsWith(".py")) return "python";
	if (lower.endsWith(".json")) return "json";
	if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
	if (/\.(sh|bash|zsh)$/.test(lower)) return "shell";
	return "plain";
}

/** True for a token that starts a keyword. */
function isKeyword(language: Language, word: string): boolean {
	return KEYWORDS[language].has(word);
}

/** Fold neighbouring spans of one kind, so a row costs one style call per run. */
function merge(spans: Span[]): Span[] {
	const merged: Span[] = [];
	for (const span of spans) {
		const last = merged[merged.length - 1];
		if (last && last.kind === span.kind) {
			last.text += span.text;
			continue;
		}
		merged.push({ text: span.text, kind: span.kind });
	}
	return merged;
}

/** One line of text as spans. Never throws: an unfinished string ends the line. */
function scan(language: Language, line: string): Span[] {
	const spans: Span[] = [];
	const marker = commentMarker(language);
	const quotes = delimiters(language);
	let index = 0;
	let plain = "";

	const flush = (): void => {
		if (plain !== "") spans.push({ text: plain, kind: "plain" });
		plain = "";
	};

	while (index < line.length) {
		const rest = line.slice(index);

		if (language === "markdown" && rest.startsWith("#")) {
			flush();
			spans.push({ text: rest, kind: "keyword" });
			return spans;
		}

		if (marker !== "" && rest.startsWith(marker)) {
			flush();
			spans.push({ text: rest, kind: "comment" });
			return spans;
		}

		const char = line[index] ?? "";
		const quote = quotes.find((candidate) => rest.startsWith(candidate));
		if (quote !== undefined) {
			flush();
			let end = index + quote.length;
			while (end < line.length) {
				if (line[end] === "\\") {
					end += 2;
					continue;
				}
				if (line.startsWith(quote, end)) {
					end += quote.length;
					break;
				}
				end += 1;
			}
			spans.push({ text: line.slice(index, Math.min(end, line.length)), kind: "string" });
			index = Math.min(end, line.length);
			continue;
		}

		if (/[0-9]/.test(char) && (index === 0 || !/[A-Za-z_]/.test(line[index - 1] ?? ""))) {
			flush();
			let end = index;
			while (end < line.length && /[0-9_.x]/.test(line[end] ?? "")) end += 1;
			spans.push({ text: line.slice(index, end), kind: "number" });
			index = end;
			continue;
		}

		if (/[A-Za-z_]/.test(char)) {
			let end = index;
			while (end < line.length && /[A-Za-z0-9_]/.test(line[end] ?? "")) end += 1;
			const word = line.slice(index, end);
			flush();
			spans.push({ text: word, kind: isKeyword(language, word) ? "keyword" : "plain" });
			index = end;
			continue;
		}

		plain += char;
		index += 1;
	}
	flush();
	return spans;
}

/**
 * The spans of a whole file, one array per line.
 *
 * An unknown language returns one plain span per line; the caller keeps line
 * numbering either way.
 */
export function highlightLines(path: string, text: string): Span[][] {
	const language = languageOf(path);
	const lines = text.split("\n");
	if (language === "plain") return lines.map((line) => [{ text: line, kind: "plain" }]);
	return lines.map((line) => merge(scan(language, line)));
}
