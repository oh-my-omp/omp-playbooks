import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ptree } from "@oh-my-pi/pi-utils";
import type { ExternalTarget, FetchOutcome, IssueComment, IssueValue } from "../domain/model";
import { tr } from "../i18n";
import type { Fetcher } from "../domain/ports";

const TIMEOUT_MS = 30_000;

type GhResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string };

async function gh(args: readonly string[]): Promise<GhResult> {
	using child = ptree.spawn(["gh", "api", ...args], { timeout: TIMEOUT_MS, stderr: "full" });
	const { stdout: text, stderr, exitCode: code, exitError } = await child.wait({ allowNonZero: true, allowAbort: true, stderr: "full" });
	const timedOut = exitError instanceof ptree.TimeoutError;
	if (timedOut || code !== 0) {
		return {
			ok: false,
			error: tr(`gh api ${args.join(" ")}: ${timedOut ? "timed out after 30 s; " : ""}exit code ${code}${child.proc.signalCode ? `; signal ${child.proc.signalCode}` : ""}; stderr: ${stderr}`, `gh api ${args.join(" ")}：${timedOut ? "30 秒后超时；" : ""}退出码 ${code}${child.proc.signalCode ? `；信号 ${child.proc.signalCode}` : ""}；标准错误：${stderr}`),
		};
	}
	return { ok: true, text };
}

function stringField(value: unknown, field: string): string {
	if (typeof value !== "string") throw new Error(tr(`Invalid GitHub JSON: ${field} must be a string`, `GitHub JSON 无效：${field} 必须是字符串`));
	return value;
}

function parseIssue(issueText: string, commentsText: string): IssueValue {
	const issue: unknown = JSON.parse(issueText);
	if (typeof issue !== "object" || issue === null || !("title" in issue) || !("body" in issue)) {
		throw new Error(tr("Invalid GitHub JSON: issue must have title and body", "GitHub JSON 无效：issue 必须有 title 和 body"));
	}
	const title = stringField(issue.title, "title");
	// GitHub represents an absent issue body as null, not an empty string.
	const body = issue.body === null ? "" : stringField(issue.body, "body");
	const pages: unknown = JSON.parse(commentsText);
	if (!Array.isArray(pages)) throw new Error(tr("Invalid GitHub JSON: comments pages must be an array", "GitHub JSON 无效：comments pages 必须是数组"));
	const comments: IssueComment[] = [];
	for (const page of pages) {
		if (!Array.isArray(page)) throw new Error(tr("Invalid GitHub JSON: comments page must be an array", "GitHub JSON 无效：comments page 必须是数组"));
		for (const value of page) {
			const comment: unknown = value;
			if (typeof comment !== "object" || comment === null || !("user" in comment)
				|| !("created_at" in comment) || !("body" in comment)
				|| typeof comment.user !== "object" || comment.user === null || !("login" in comment.user)) {
				throw new Error(tr("Invalid GitHub JSON: comment must have user.login, created_at, and body", "GitHub JSON 无效：comment 必须有 user.login、created_at 和 body"));
			}
			comments.push({
				author: stringField(comment.user.login, "comment.user.login"),
				createdAt: stringField(comment.created_at, "comment.created_at"),
				body: comment.body === null ? "" : stringField(comment.body, "comment.body"),
			});
		}
	}
	return { title, body, comments };
}

export const fetcher: Fetcher = {
	async fetch(target: ExternalTarget, baseDir: string): Promise<FetchOutcome> {
		try {
			switch (target.kind) {
				case "file": {
					const text = await readFile(resolve(baseDir, target.path), "utf8");
					return { ok: true, at: Date.now(), value: { kind: "file", text } };
				}
				case "issue":
				case "pull": {
					const endpoint = `repos/${target.owner}/${target.repo}/issues/${target.number}`;
					const issue = await gh([endpoint]);
					if (!issue.ok) return { ok: false, at: Date.now(), error: issue.error };
					// --slurp gives one JSON value containing the ordered pagination arrays.
					const comments = await gh(["--paginate", "--slurp", `${endpoint}/comments`]);
					if (!comments.ok) return { ok: false, at: Date.now(), error: comments.error };
					return { ok: true, at: Date.now(), value: { kind: "issue", issue: parseIssue(issue.text, comments.text) } };
				}
			}
		} catch (error: unknown) {
			return { ok: false, at: Date.now(), error: error instanceof Error ? error.message : String(error) };
		}
	},
};
