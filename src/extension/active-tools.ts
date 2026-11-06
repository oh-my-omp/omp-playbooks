import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * Activates exactly `names` via `pi.setActiveTools`, in a canonical order. Requested builtin tools
 * (`sourceInfo.source === "builtin"`) come first, in `pi.getAllTools()` order. Every other requested
 * name (extension tools and names unknown to the registry) follows, sorted with JavaScript string
 * comparison (`a < b`, code-point order) and deduplicated. Extension registration order therefore
 * cannot change the array.
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
