/**
 * Inert parts of a commit chain: a project formatter and a read-only output
 * filter.
 *
 * These parts change files or read stdin, but each runs a known program with
 * no program of the caller's choice. The doctrine therefore lets them stand
 * beside a history command without a prompt. The shell gate still decides
 * whether a part is wrapped, redirected, or substituted; a part that is any of
 * those is not inert.
 *
 * The tables are an allow-list. A shape they do not read is not inert, so the
 * command keeps its prompt.
 */

/** A formatter and the subcommand or flag that makes it one. */
const FORMATTERS: Record<string, (args: string[]) => boolean> = {
	cargo: (args) => args[0] === "fmt",
	rustfmt: () => true,
	ruff: (args) => args[0] === "format",
	black: () => true,
	prettier: (args) => hasWriteFlag(args),
	gofmt: (args) => hasWriteFlag(args),
};

/** True when the arguments hold the write flag (`--write`, `-w`, `-lw`). */
function hasWriteFlag(args: string[]): boolean {
	return args.some((arg) => arg === "--write" || /^-[a-zA-Z]*w[a-zA-Z]*$/.test(arg));
}

/** True when the words run a formatter from the table. */
export function isFormatter(command: string, args: string[]): boolean {
	const entry = FORMATTERS[command];
	return entry !== undefined && entry(args);
}

/** One filter's option grammar. */
interface FilterSpec {
	/** Short option letters that take a value. */
	shortValues: string;
	/** Short option letters that name a file to read or write. */
	shortFiles: string;
	/** Long options that take a value. */
	longValues: Set<string>;
	/** Long options that name a file or run a program. */
	longFiles: Set<string>;
	/** Non-option words that are not files (grep: its pattern). */
	words: number;
	/** The short letter that supplies the pattern instead (`-e`). */
	patternShort?: string;
	/** The long option that supplies the pattern instead (`--regexp`). */
	patternLong?: string;
}

const FILTERS: Record<string, FilterSpec> = {
	grep: {
		shortValues: "ABCdem",
		shortFiles: "frR",
		longValues: new Set([
			"after-context", "before-context", "context", "max-count", "regexp", "devices",
			"label", "binary-files", "include", "exclude", "exclude-dir",
		]),
		longFiles: new Set(["file", "exclude-from", "recursive", "dereference-recursive", "directories"]),
		words: 1,
		patternShort: "e",
		patternLong: "regexp",
	},
	head: {
		shortValues: "nc",
		shortFiles: "",
		longValues: new Set(["lines", "bytes"]),
		longFiles: new Set(),
		words: 0,
	},
	tail: {
		shortValues: "ncs",
		shortFiles: "",
		longValues: new Set(["lines", "bytes", "sleep-interval", "pid", "max-unchanged-stats"]),
		longFiles: new Set(),
		words: 0,
	},
	wc: {
		shortValues: "",
		shortFiles: "",
		longValues: new Set(),
		longFiles: new Set(["files0-from"]),
		words: 0,
	},
	sort: {
		shortValues: "ktST",
		shortFiles: "o",
		longValues: new Set(["key", "field-separator", "buffer-size", "temporary-directory", "parallel", "sort", "batch-size"]),
		// A file to read or write, and a program the filter runs.
		longFiles: new Set(["output", "files0-from", "compress-program", "random-source"]),
		words: 0,
	},
	uniq: {
		shortValues: "fsw",
		shortFiles: "",
		longValues: new Set(["skip-fields", "skip-chars", "check-chars"]),
		longFiles: new Set(),
		words: 0,
	},
};

/**
 * True when the arguments keep the filter on its pipe: no `--`, no file
 * argument, and no value that names a file or a program. A value-taking
 * option consumes the next token (or the rest of its cluster).
 */
function filterArgsOk(args: string[], spec: FilterSpec): boolean {
	let words = 0;
	let patternConsumed = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") return false;
		if (arg.startsWith("--")) {
			const name = arg.slice(2).split("=")[0];
			if (spec.longFiles.has(name)) return false;
			if (spec.longValues.has(name)) {
				if (!arg.includes("=")) i += 1;
				if (name === spec.patternLong) patternConsumed = true;
			}
			continue;
		}
		if (arg.startsWith("-") && arg.length > 1) {
			const letters = arg.slice(1);
			for (let j = 0; j < letters.length; j++) {
				const letter = letters[j];
				if (spec.shortFiles.includes(letter)) return false;
				if (spec.shortValues.includes(letter)) {
					if (letter === spec.patternShort) patternConsumed = true;
					if (j === letters.length - 1) i += 1;
					break;
				}
			}
			continue;
		}
		words += 1;
	}
	return words <= (patternConsumed ? 0 : spec.words);
}

/** True when the words run a read-only filter whose only input is its pipe. */
export function isInertFilter(command: string, args: string[]): boolean {
	const spec = FILTERS[command];
	return spec !== undefined && filterArgsOk(args, spec);
}
