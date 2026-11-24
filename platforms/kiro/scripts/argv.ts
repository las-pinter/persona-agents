/** Command-line helpers shared by the Kiro scripts. */

/** The value of a `--name=value` argument, or undefined. */
export function option(name: string, argv: string[]): string | undefined {
	const arg = argv.find((value) => value.startsWith(`--${name}=`));
	return arg ? arg.slice(name.length + 3) : undefined;
}
