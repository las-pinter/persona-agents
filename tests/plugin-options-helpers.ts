/**
 * The one settings file body both plugin-options test files write.
 *
 * A reader case and a hook case plant the same file shape, so the shape lives
 * here once. No case reads or writes the real settings files.
 *
 * Run: npm test
 */

/** A settings file body that selects a subagent model, the way /config writes it. */
export function modelSettings(model: string): string {
	return JSON.stringify({
		pluginConfigs: { "persona-agents@persona-agents": { options: { subagent_model: model } } },
	});
}
