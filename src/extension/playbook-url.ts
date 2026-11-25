import { basename } from "node:path";
import type {
	InternalResource,
	InternalUrl,
	InternalWriteResult,
	ProtocolHandler,
	SchemeSpec,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { tr } from "../../omomp-shared/i18n";
import { type BlockId, type LaunchId, parseBlockId, parseLaunchId, parseRunId, type RecordKind, type RunId } from "../domain/model";
import type { Request } from "../domain/protocol";
import type { Reply } from "./client";

export interface PlaybookUrlBridge {
	connectedDocs(): readonly string[];
	resolveDoc(file: string | undefined): Promise<string>;
	request(doc: string, payload: Request): Promise<Reply>;
}

type ParsedRoute =
	| { readonly kind: "runs"; readonly doc: string | undefined }
	| { readonly kind: "read"; readonly doc: string | undefined; readonly run?: RunId; readonly block?: BlockId }
	| { readonly kind: "revisions"; readonly doc: string | undefined; readonly run?: RunId }
	| { readonly kind: "timeline"; readonly doc: string | undefined; readonly run?: RunId }
	| { readonly kind: "launch"; readonly doc: string | undefined; readonly run?: RunId; readonly launch: LaunchId }
	| { readonly kind: "checks"; readonly doc: string | undefined; readonly run?: RunId };

const RESERVED_HEADS = new Set(["runs", "revisions", "timeline", "checks", "launches"]);
const DEFAULT_ALIASES = new Set(["current", "default"]);

function safeDecode(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

function docStem(filePath: string): string {
	const name = basename(filePath);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(0, dot) : name;
}

export function docHostSlug(absolute: string, connected: readonly string[]): string {
	const name = basename(absolute);
	const collisions = connected.filter((candidate) => candidate !== absolute && basename(candidate) === name);
	if (collisions.length === 0 && !RESERVED_HEADS.has(name) && !DEFAULT_ALIASES.has(name) && !parseRunId(name) && !parseBlockId(name)) {
		return name;
	}
	return encodeURIComponent(absolute);
}

export function formatPlaybookUrl(
	absolute: string,
	connected: readonly string[],
	parts: { readonly run?: RunId; readonly path?: string; readonly query?: Readonly<Record<string, string | number | undefined>> } = {},
): string {
	const host = docHostSlug(absolute, connected);
	const segments: string[] = [];
	if (parts.run) segments.push(parts.run);
	if (parts.path) segments.push(parts.path.replace(/^\/+/, ""));
	const pathname = segments.length > 0 ? `/${segments.join("/")}` : "";
	const search = new URLSearchParams();
	if (parts.query) {
		for (const [key, value] of Object.entries(parts.query)) {
			if (value !== undefined) search.set(key, String(value));
		}
	}
	const qs = search.toString();
	return `playbook://${host}${pathname}${qs ? `?${qs}` : ""}`;
}

function parseTail(doc: string | undefined, tail: readonly string[], href: string): ParsedRoute {
	if (tail.length === 0) {
		return { kind: "read", doc };
	}
	let index = 0;
	let run: RunId | undefined;
	const firstRun = parseRunId(tail[0]!);
	if (firstRun !== null) {
		run = firstRun;
		index = 1;
	}
	const rest = tail.slice(index);
	if (rest.length === 0) {
		return { kind: "read", doc, ...(run ? { run } : {}) };
	}
	const head = rest[0]!;
	if (head === "runs" && rest.length === 1 && run === undefined) {
		return { kind: "runs", doc };
	}
	if (head === "revisions" && rest.length === 1) {
		return { kind: "revisions", doc, ...(run ? { run } : {}) };
	}
	if (head === "timeline" && rest.length === 1) {
		return { kind: "timeline", doc, ...(run ? { run } : {}) };
	}
	if (head === "checks" && rest.length === 1) {
		return { kind: "checks", doc, ...(run ? { run } : {}) };
	}
	if (head === "launches" && rest.length === 2) {
		const launch = parseLaunchId(rest[1]!);
		if (launch === null) throw new ToolError(tr(`Invalid Launch id in ${href}: ${rest[1]}`, `${href} 中的 Launch id 无效：${rest[1]}`));
		return { kind: "launch", doc, ...(run ? { run } : {}), launch };
	}
	if (rest.length === 1) {
		const block = parseBlockId(head);
		if (block !== null) {
			return { kind: "read", doc, ...(run ? { run } : {}), block };
		}
	}
	throw new ToolError(
		tr(
			`Invalid playbook:// URL: ${href}. Expected playbook://, playbook://<doc>[/<run>][/<block>], .../revisions, .../timeline, .../launches/<id>, or .../checks.`,
			`无效的 playbook:// URL：${href}。支持 playbook://、playbook://<doc>[/<run>][/<block>]、.../revisions、.../timeline、.../launches/<id> 或 .../checks。`,
		),
	);
}

function peelAbsolutePath(
	pathSegs: readonly string[],
	connected: readonly string[],
): { readonly doc: string; readonly tail: readonly string[] } {
	const full = `/${pathSegs.join("/")}`;
	const sorted = [...connected].sort((a, b) => b.length - a.length);
	for (const candidate of sorted) {
		if (full === candidate) return { doc: candidate, tail: [] };
		if (full.startsWith(`${candidate}/`)) {
			const remaining = full
				.slice(candidate.length + 1)
				.split("/")
				.filter(Boolean);
			return { doc: candidate, tail: remaining };
		}
	}
	const tail: string[] = [];
	const head = [...pathSegs];
	// Peel recognized suffixes from the right
	if (head.length >= 2 && head.at(-2) === "launches" && parseLaunchId(head.at(-1)!) !== null) {
		tail.unshift(head.pop()!);
		tail.unshift(head.pop()!);
	} else if (head.length >= 1 && (RESERVED_HEADS.has(head.at(-1)!) || parseBlockId(head.at(-1)!) !== null)) {
		tail.unshift(head.pop()!);
	}
	if (head.length >= 1 && parseRunId(head.at(-1)!) !== null) {
		tail.unshift(head.pop()!);
	}
	return { doc: `/${head.join("/")}`, tail };
}

function resolveDocHost(host: string, connected: readonly string[]): string | undefined {
	if (DEFAULT_ALIASES.has(host)) return undefined;
	if (connected.includes(host)) return host;
	const byBase = connected.filter((candidate) => basename(candidate) === host);
	if (byBase.length === 1) return byBase[0]!;
	if (byBase.length > 1) {
		throw new ToolError(
			tr(
				`Ambiguous Playbook name "${host}" (${byBase.join(", ")}); use the full path (encoded or playbook:///...)`,
				`Playbook 名称 "${host}" 有歧义（${byBase.join("、")}）；请使用完整路径`,
			),
		);
	}
	const byStem = connected.filter((candidate) => docStem(candidate) === host);
	if (byStem.length === 1) return byStem[0]!;
	if (byStem.length > 1) {
		throw new ToolError(
			tr(
				`Ambiguous Playbook name "${host}" (${byStem.join(", ")}); use the full path (encoded or playbook:///...)`,
				`Playbook 名称 "${host}" 有歧义（${byStem.join("、")}）；请使用完整路径`,
			),
		);
	}
	return host;
}

function parsePlaybookUrl(url: InternalUrl, connected: readonly string[]): ParsedRoute {
	const host = url.rawHost;
	const rawPath = url.rawPathname ?? url.pathname;
	const pathSegs = rawPath
		.split("/")
		.filter((segment) => segment.length > 0)
		.map(safeDecode);

	if (!host) {
		if (pathSegs.length === 0) return { kind: "runs", doc: undefined };
		const peeled = peelAbsolutePath(pathSegs, connected);
		return parseTail(peeled.doc, peeled.tail, url.href);
	}

	if (DEFAULT_ALIASES.has(host)) {
		return parseTail(undefined, pathSegs, url.href);
	}

	const matchedConnected =
		connected.includes(host) || connected.some((candidate) => basename(candidate) === host || docStem(candidate) === host);
	if (!matchedConnected && (RESERVED_HEADS.has(host) || parseRunId(host) !== null || parseBlockId(host) !== null)) {
		return parseTail(undefined, [host, ...pathSegs], url.href);
	}

	const doc = resolveDocHost(host, connected);
	return parseTail(doc, pathSegs, url.href);
}

function parseQueryInt(params: URLSearchParams, name: string, min: number): number | undefined {
	const raw = params.get(name);
	if (raw === null || raw === "") return undefined;
	if (!/^[0-9]+$/.test(raw)) {
		throw new ToolError(tr(`Query parameter ${name} must be an integer >= ${min}`, `查询参数 ${name} 必须是 >= ${min} 的整数`));
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < min) {
		throw new ToolError(tr(`Query parameter ${name} must be an integer >= ${min}`, `查询参数 ${name} 必须是 >= ${min} 的整数`));
	}
	return value;
}

function parseTimelineKind(raw: string | null): RecordKind {
	if (raw === null || raw === "" || raw === "note") return "update";
	if (raw === "update" || raw === "result" || raw === "failure" || raw === "retrospective") return raw;
	throw new ToolError(
		tr(
			`Invalid timeline kind "${raw}". Expected update (or note), result, failure, or retrospective.`,
			`无效的时间线 kind "${raw}"。允许 update（或 note）、result、failure 或 retrospective。`,
		),
	);
}

function unwrapReply(reply: Reply): { readonly text: string; readonly value: unknown } {
	if (!reply.ok) {
		throw new ToolError(`${reply.error.code}: ${reply.error.message}`);
	}
	const text = reply.raw ?? JSON.stringify(reply.result ?? null);
	return { text, value: reply.result };
}

function textResource(url: string, content: string, contentType: string): InternalResource {
	return {
		url,
		content,
		contentType,
		size: Buffer.byteLength(content, "utf-8"),
		immutable: true,
	};
}

function extractBlockIds(value: unknown): BlockId[] {
	if (typeof value !== "object" || value === null || !("blocks" in value) || !Array.isArray(value.blocks)) return [];
	const ids: BlockId[] = [];
	for (const item of value.blocks) {
		if (typeof item === "object" && item !== null && "id" in item && typeof item.id === "string") {
			const id = parseBlockId(item.id);
			if (id !== null) ids.push(id);
		}
	}
	return ids;
}

export function createPlaybookProtocolHandler(bridge: PlaybookUrlBridge): ProtocolHandler {
	const spec: SchemeSpec = {
		backing: "virtual",
		selectors: "lines",
		immutable: true,
		write: {
			via: "handler",
			payload: "verbatim",
			scope: "coordination",
			tier: () => "read",
		},
	};

	const scoped = (run: RunId | undefined): { run?: RunId } => (run === undefined ? {} : { run });

	return {
		scheme: "playbook",
		spec,
		async resolve(url: InternalUrl): Promise<InternalResource> {
			const connected = bridge.connectedDocs();
			const route = parsePlaybookUrl(url, connected);
			const params = url.searchParams;

			switch (route.kind) {
				case "runs": {
					if (route.doc === undefined && connected.length > 1) {
						const playbooks = await Promise.all(
							connected.map(async (doc) => {
								const { value } = unwrapReply(await bridge.request(doc, { op: "runs", args: {} }));
								const runs = typeof value === "object" && value !== null && "runs" in value ? value.runs : [];
								return { doc, url: formatPlaybookUrl(doc, connected), runs };
							}),
						);
						return textResource(url.href, JSON.stringify({ playbooks }, null, 2), "application/json");
					}
					const absolute = await bridge.resolveDoc(route.doc);
					const { text } = unwrapReply(await bridge.request(absolute, { op: "runs", args: {} }));
					return textResource(url.href, text, "application/json");
				}
				case "read": {
					const absolute = await bridge.resolveDoc(route.doc);
					const { text } = unwrapReply(
						await bridge.request(absolute, {
							op: "read",
							args: { ...scoped(route.run), ...(route.block ? { block: route.block } : {}) },
						}),
					);
					return textResource(url.href, text, "application/json");
				}
				case "revisions": {
					const absolute = await bridge.resolveDoc(route.doc);
					const after = parseQueryInt(params, "after", 0);
					const rawBlock = params.get("block");
					let block: BlockId | undefined;
					if (rawBlock !== null && rawBlock !== "") {
						const parsed = parseBlockId(rawBlock);
						if (parsed === null) throw new ToolError(tr(`Invalid block id: ${rawBlock}`, `无效的块 id：${rawBlock}`));
						block = parsed;
					}
					const { text } = unwrapReply(
						await bridge.request(absolute, {
							op: "revisions",
							args: {
								...scoped(route.run),
								...(block ? { block } : {}),
								...(after !== undefined ? { after } : {}),
							},
						}),
					);
					return textResource(url.href, text, "application/json");
				}
				case "timeline": {
					const absolute = await bridge.resolveDoc(route.doc);
					const after = parseQueryInt(params, "after", 0);
					const limit = parseQueryInt(params, "limit", 1);
					const { text } = unwrapReply(
						await bridge.request(absolute, {
							op: "timeline",
							args: {
								...scoped(route.run),
								...(after !== undefined ? { after } : {}),
								...(limit !== undefined ? { limit } : {}),
							},
						}),
					);
					return textResource(url.href, text, "application/json");
				}
				case "launch": {
					const absolute = await bridge.resolveDoc(route.doc);
					const { text } = unwrapReply(await bridge.request(absolute, { op: "launch_info", args: { launch: route.launch } }));
					return textResource(url.href, text, "application/json");
				}
				case "checks": {
					const absolute = await bridge.resolveDoc(route.doc);
					const rawBlocks = params.get("blocks");
					let blocks: BlockId[];
					if (rawBlocks !== null && rawBlocks.trim() !== "") {
						blocks = rawBlocks.split(",").map((part) => {
							const trimmed = part.trim();
							const id = parseBlockId(trimmed);
							if (id === null)
								throw new ToolError(tr(`Invalid block id in blocks query: ${trimmed}`, `blocks 参数中的块 id 无效：${trimmed}`));
							return id;
						});
					} else {
						const readReply = unwrapReply(await bridge.request(absolute, { op: "read", args: scoped(route.run) }));
						blocks = extractBlockIds(readReply.value);
					}
					const { value } = unwrapReply(await bridge.request(absolute, { op: "inspect", args: { ...scoped(route.run), blocks } }));
					const version =
						typeof value === "object" && value !== null && "version" in value && typeof value.version === "string"
							? value.version
							: "<version>";
					const hintPayload = {
						...(route.run ? { run: route.run } : {}),
						blocks,
						version,
						result: "pass",
					};
					const body = [
						JSON.stringify(value, null, 2),
						"",
						"---",
						`To submit a judge check report for this version, call \`playbook_check\` (e.g. \`${JSON.stringify(hintPayload)}\`, or \`result: "answers"\` with \`answers: { "<question>": <0..1> }\`, or \`result: "fail"\` / \`"judge_unavailable"\`).`,
						"",
					].join("\n");
					return textResource(url.href, body, "text/markdown");
				}
			}
		},
		async write(url: InternalUrl, content: string): Promise<InternalWriteResult> {
			const connected = bridge.connectedDocs();
			const route = parsePlaybookUrl(url, connected);
			if (route.kind !== "timeline") {
				throw new ToolError(
					tr(
						`Only playbook://<doc>[/<run>]/timeline supports write; use playbook_edit_content or playbook_edit_structure to edit blocks.`,
						`只有 playbook://<doc>[/<run>]/timeline 支持 write；编辑块请使用 playbook_edit_content 或 playbook_edit_structure。`,
					),
				);
			}
			const params = url.searchParams;
			const kind = parseTimelineKind(params.get("kind"));
			const rawBlock = params.get("block");
			let block: BlockId | undefined;
			if (rawBlock !== null && rawBlock !== "") {
				const parsed = parseBlockId(rawBlock);
				if (parsed === null) throw new ToolError(tr(`Invalid block id: ${rawBlock}`, `无效的块 id：${rawBlock}`));
				block = parsed;
			}
			const rawLaunch = params.get("launch");
			let launch: LaunchId | undefined;
			if (rawLaunch !== null && rawLaunch !== "") {
				const parsed = parseLaunchId(rawLaunch);
				if (parsed === null) throw new ToolError(tr(`Invalid Launch id: ${rawLaunch}`, `无效的 Launch id：${rawLaunch}`));
				launch = parsed;
			}
			const next = parseQueryInt(params, "next", 1);
			const rawQuote = params.get("quote");
			const quote = rawQuote !== null && rawQuote !== "" ? rawQuote : undefined;

			const absolute = await bridge.resolveDoc(route.doc);
			const { text } = unwrapReply(
				await bridge.request(absolute, {
					op: "post",
					args: {
						...scoped(route.run),
						kind,
						text: content,
						...(block ? { block } : {}),
						...(launch ? { launch } : {}),
						...(next !== undefined ? { next } : {}),
						...(quote !== undefined ? { quote } : {}),
					},
				}),
			);
			return {
				content: [{ type: "text", text }],
				details: { touchesNoFiles: true },
			};
		},
	};
}
