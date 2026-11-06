import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * Activates exactly `names` in a canonical order that depends only on the set of names and on the
 * registry's builtin tools, never on the order in which tools were registered. Builtins come first in
 * `pi.getAllTools()` order; every other requested name follows, sorted by code point and deduplicated.
 */
export async function applyActiveTools(pi: ExtensionAPI, names: Iterable<string>): Promise<void> {
	const requested = new Set(names);
	const builtins = new Set<string>();
	for (const tool of pi.getAllTools()) {
		if (tool.sourceInfo.source === "builtin" && requested.has(tool.name)) builtins.add(tool.name);
	}
	const others = [...requested].filter(name => !builtins.has(name)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	await pi.setActiveTools([...builtins, ...others]);
}
