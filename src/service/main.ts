#!/usr/bin/env bun
// Document service entry, run inside a Tern pane:
//   omp-playbook <playbook.yaml>           serve the document (one live service per document)
//   omp-playbook --reveal <playbook.yaml>  show the running service's pane; exit 4 when none runs
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { socketPath } from "../domain/protocol";
import { checks } from "./checks";
import { Core } from "./core";
import { fetcher } from "./fetch";
import { focusPane, ownPane } from "./panes";
import { references } from "./references";
import { revealService, serveK1, ServiceRunning } from "./socket";
import { createStore } from "./store";
import { createTspSession } from "./tsp";
import { startUi } from "./ui";

const reveal = process.argv[2] === "--reveal";
const file = reveal ? process.argv[3] : process.argv[2];
if (!file) {
	process.stderr.write("用法：omp-playbook [--reveal] <playbook.yaml>\n");
	process.exit(2);
}
const templatePath = realpathSync(resolve(file));
const endpoint = socketPath(tmpdir(), templatePath);
if (reveal) {
	const outcome = await revealService(endpoint);
	switch (outcome.kind) {
		case "revealed": process.exit(0);
		case "absent": process.exit(4);
		case "failed": process.stderr.write(`${outcome.message}\n`); process.exit(5);
	}
}
const core = new Core({
	store: createStore(templatePath),
	references,
	fetcher,
	checks,
	panes: { ownPane, focusPane },
});
const loadError = core.load();
if (loadError !== null) {
	process.stderr.write(`Playbook 文件不能解析：${loadError}\n`);
	process.exit(1);
}
let server: { close(): void };
try {
	server = await serveK1(endpoint, core);
} catch (error) {
	core.stop();
	if (!(error instanceof ServiceRunning)) throw error;
	// The document already has its service: show that pane and leave, so this pane closes.
	const outcome = await revealService(endpoint);
	if (outcome.kind === "revealed") process.exit(0);
	process.stderr.write(`这个 Playbook 的文档服务已在运行：${templatePath}\n${outcome.kind === "failed" ? `${outcome.message}\n` : ""}`);
	process.exit(3);
}
startUi(core, createTspSession(), dirname(templatePath));

const shutdown = (): void => {
	core.stop();
	server.close();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
