import type { CompileError, CompileResult, Source } from "../domain/model";
import type { ChecksModule } from "../domain/ports";
import { draftDiagnostics } from "./draft/components";

function unreachable(value: never): never {
	throw new Error(`Unexpected checks variant: ${JSON.stringify(value)}`);
}

function normalizedSource(source: Source) {
	switch (source.kind) {
		case "block":
			return [source.kind, source.target, source.expression];
		case "result":
			return [source.kind, source.target, source.expression, source.seq, source.origin, source.launch];
		case "external":
			return [source.kind, source.target, source.expression, source.fetchedAt];
	}
	return unreachable(source);
}

function normalizedError(error: CompileError) {
	const site = [error.at.block, error.at.reference];
	switch (error.kind) {
		case "UnknownBlock":
		case "NoResult":
			return [error.kind, site, error.block];
		case "UnknownTarget":
		case "TooDeep":
			return [error.kind, site];
		case "BadExpression":
			return [error.kind, site, error.reason];
		case "Cycle":
			return [error.kind, site, error.path];
		case "FetchFailed":
			return [error.kind, site, error.target, error.error];
	}
	return unreachable(error);
}

function normalizedCompile(compiled: CompileResult) {
	switch (compiled.kind) {
		case "Ok":
			return [compiled.kind, compiled.text, compiled.sources.map(normalizedSource)];
		case "Err":
			return [compiled.kind, normalizedError(compiled.error)];
	}
	return unreachable(compiled);
}

const questions: ChecksModule["questions"] = [
	{
		id: "missing",
		type: "bool",
		instructions:
			"`compiled` is the entire prompt a subagent receives; it can see nothing else. Does `compiled` mention material (logs, discussion, files, earlier results) whose content is absent from `compiled`?",
		threshold: 0.5,
	},
];

export const checks: ChecksModule = {
	questions,
	findings({ compiled, expansions, content, render }) {
		const common = { compile: compiled.kind === "Err", render_error: render.blockError || render.documentError, render_pending: render.pendingOverdue };
		// Task bodies and designs are drawn by the same component renderer, so both are checked for its syntax.
		const text = content.kind === "task" ? content.body : content.design;
		return {
			...common,
			empty_expansion: content.kind === "task" && expansions.some(expansion => expansion.kind === "Ok" && expansion.text.trim() === ""),
			draft: render.draftErrors > 0 || draftDiagnostics(text).some(found => found.severity === "error"),
		};
	},
	version({ closure, results, compiled }) {
		// Preserve meaningful occurrence/path order, but not Map insertion order
		// or the order of the referenced results. Tuples fix field ordering and
		// distinguish a missing block (null) from a present, empty block ("").
		const normalized = [
			[...closure].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
			results.map(result => JSON.stringify([result.text, result.at, result.seq, result.origin, result.launch])).sort(),
			normalizedCompile(compiled),
		];
		return new Bun.CryptoHasher("sha256").update(JSON.stringify(normalized)).digest("hex");
	},
	validateReport(result) {
		switch (result.kind) {
			case "judge_unavailable":
				return true;
			case "answers": {
				const answers = result.answers;
				if (answers === null || typeof answers !== "object" || Array.isArray(answers)) return false;
				const ids = Object.keys(answers);
				return (
					ids.length === questions.length &&
					questions.every(question => {
						const value = answers[question.id];
						return ids.includes(question.id) && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
					})
				);
			}
		}
		return unreachable(result);
	},
};
