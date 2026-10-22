// The Tern side of an `omp plugin install` (contracts.md K6 安装). omp runs the extension
// factory once while installing and rolls the install back when it throws, so this is
// where a missing Tern refuses the install and where the Tern plugin gets linked.
//
// The link points Tern at this package's own `tern-plugin/`. The daemon reloads files
// edited in place, but an upgrade replaces the whole package directory, which leaves the
// daemon on a missing link target or the old script. The daemon reports the version it
// loaded; when that differs from `tern-plugin/plugin.toml` on disk, the daemon reloads
// its plugins. A reload that leaves the versions apart is reported, never thrown:
// the failure may belong to another plugin, and the next extension load compares again.
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

/** The Tern plugin directory shipped inside this package. */
const TERN_PLUGIN_DIR = resolve(import.meta.dir, "../../tern-plugin");
const TERN_PLUGIN_ID = "omp-playbooks";

/** What the Tern side looked like after setup; only the last two need the operator's attention. */
export type TernPluginState =
	| { readonly kind: "current"; readonly version: string }
	| { readonly kind: "reloaded"; readonly from: string | null; readonly to: string }
	| { readonly kind: "stale"; readonly loaded: string | null; readonly wanted: string; readonly detail: string };

type Exec = { readonly exit: number; readonly stdout: string; readonly stderr: string };

async function exec(args: readonly string[]): Promise<Exec> {
	const child = Bun.spawn(["tern", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { exit, stdout, stderr };
}

async function tern(args: readonly string[]): Promise<string> {
	const result = await exec(args);
	if (result.exit !== 0) throw new Error(`tern ${args.join(" ")} exited ${result.exit}: ${result.stderr.trim()}`);
	return result.stdout;
}

async function linkedDir(pluginsDir: string): Promise<string | null> {
	const file = Bun.file(join(pluginsDir, `${TERN_PLUGIN_ID}.path`));
	if (!(await file.exists())) return null;
	return (await file.text()).trim();
}

async function diskVersion(dir: string): Promise<string> {
	const manifest: unknown = Bun.TOML.parse(await Bun.file(join(dir, "plugin.toml")).text());
	const version = typeof manifest === "object" && manifest !== null && "version" in manifest ? manifest.version : undefined;
	if (typeof version !== "string") throw new Error(`${join(dir, "plugin.toml")} has no string version`);
	return version;
}

/**
 * The version of this plugin the running daemon loaded (the plugins directory's when no
 * daemon runs), null when the listing has no entry for it, or the reason it could not be read.
 */
async function loadedVersion(): Promise<{ readonly ok: true; readonly version: string | null } | { readonly ok: false; readonly detail: string }> {
	const result = await exec(["plugin", "list", "--json"]);
	let listing: unknown;
	try {
		listing = JSON.parse(result.stdout);
	} catch {
		return { ok: false, detail: `tern plugin list exited ${result.exit}: ${result.stderr.trim() || result.stdout.trim()}` };
	}
	const plugins = typeof listing === "object" && listing !== null && "plugins" in listing ? listing.plugins : undefined;
	if (!Array.isArray(plugins)) return { ok: false, detail: "tern plugin list --json has no plugins array" };
	for (const plugin of plugins as unknown[]) {
		if (typeof plugin !== "object" || plugin === null || !("id" in plugin) || plugin.id !== TERN_PLUGIN_ID) continue;
		return { ok: true, version: "version" in plugin && typeof plugin.version === "string" ? plugin.version : null };
	}
	return { ok: true, version: null };
}

async function setup(): Promise<TernPluginState> {
	if (Bun.which("tern") === null) {
		throw new Error("omp-playbooks needs Tern: no `tern` command on PATH. Install Tern (https://docs.stencil.so/tern/) and run the install again.");
	}
	const wanted = await realpath(TERN_PLUGIN_DIR);
	const pluginsDir = (await tern(["plugin", "dir"])).trim();
	if ((await linkedDir(pluginsDir)) !== wanted) await tern(["plugin", "link", wanted, "--json"]);

	const version = await diskVersion(wanted);
	const before = await loadedVersion();
	if (!before.ok) return { kind: "stale", loaded: null, wanted: version, detail: before.detail };
	if (before.version === version) return { kind: "current", version };

	const reload = await exec(["plugin", "reload", "--json"]);
	const after = await loadedVersion();
	if (after.ok && after.version === version) return { kind: "reloaded", from: before.version, to: version };
	const detail = [after.ok ? "" : after.detail, `tern plugin reload exited ${reload.exit}: ${reload.stderr.trim() || reload.stdout.trim()}`].filter(Boolean).join("\n");
	return { kind: "stale", loaded: after.ok ? after.version : before.version, wanted: version, detail };
}

let done: Promise<TernPluginState> | undefined;

/** Once per process: the factory is rebound for every subagent session. */
export function ensureTernPlugin(): Promise<TernPluginState> {
	done ??= setup();
	return done;
}
