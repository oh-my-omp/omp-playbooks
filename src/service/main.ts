#!/usr/bin/env bun
// Document service entry, run inside a Tern pane:
//   omp-playbook <playbook.yaml>                    serve the document (one live service per document)
//   omp-playbook --reveal <playbook.yaml>           show the running service's pane; exit 4 when none runs
//   omp-playbook --open <playbook.yaml> <pane id>  show the running service's pane, else start the
//                                                   service in a new pane right of <pane id>
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { documentEndpoint } from "../domain/protocol";
import { tr } from "../i18n";
import { checks } from "./checks";
import { readClipboardImage } from "./clipboard";
import { coordinatorPicker } from "./coordinators";
import { Core } from "./core";
import { fetcher } from "./fetch";
import { focusPane, openServicePane, ownPane } from "./panes";
import { references } from "./references";
import { revealService, serveK1, ServiceRunning } from "./socket";
import { createStore } from "./store";
import { createTspSession } from "./tsp";
import { startUi } from "./ui";

type Invocation =
	/** Serve the document in this pane. */
	| { readonly kind: "serve"; readonly file: string }
	/** Show the running service's pane; exit 4 when none runs. */
	| { readonly kind: "reveal"; readonly file: string }
	/** Show the running service's pane, else start the service beside `pane`. */
	| { readonly kind: "open"; readonly file: string; readonly pane: string };

const USAGE = tr(
	"Usage: omp-playbook [--reveal] <playbook.yaml> | omp-playbook --open <playbook.yaml> <pane id>",
	"用法：omp-playbook [--reveal] <playbook.yaml> | omp-playbook --open <playbook.yaml> <面板 ID>",
);
/** No service listens for the document (K6). */
const ABSENT = 4;
/** Asking the running service to show its pane failed, or the service could not be started. */
const FAILED = 5;

/** The command line this process was started with; null when it asks for none of the three modes. */
function invocation(argv: readonly string[]): Invocation | null {
	const [mode, doc, pane] = argv;
	switch (mode) {
		case undefined: return null;
		case "--reveal": return doc === undefined ? null : { kind: "reveal", file: doc };
		case "--open": return doc === undefined || pane === undefined ? null : { kind: "open", file: doc, pane };
		default: return { kind: "serve", file: mode };
	}
}

const launch = invocation(process.argv.slice(2));
if (launch === null) {
	process.stderr.write(`${USAGE}\n`);
	process.exit(2);
}
const templatePath = realpathSync(resolve(launch.file));
const endpoint = documentEndpoint(templatePath);
switch (launch.kind) {
	case "serve": break;
	case "reveal": {
		const outcome = await revealService(endpoint);
		switch (outcome.kind) {
			case "revealed": process.exit(0);
			case "absent": process.exit(ABSENT);
			case "failed": process.stderr.write(`${outcome.message}\n`); process.exit(FAILED);
		}
	}
	case "open": {
		const outcome = await revealService(endpoint);
		switch (outcome.kind) {
			case "revealed": process.exit(0);
			case "failed": process.stderr.write(`${outcome.message}\n`); process.exit(FAILED);
			case "absent": {
				const split = await openServicePane(launch.pane, templatePath);
				if (!split.ok) {
					process.stderr.write(`${split.error}\n`);
					process.exit(FAILED);
				}
				process.exit(0);
			}
		}
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
	process.stderr.write(`${tr(`Playbook file cannot be parsed: ${loadError}`, `Playbook 文件不能解析：${loadError}`)}\n`);
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
	process.stderr.write(`${tr(`The document service for this Playbook is already running: ${templatePath}`, `这个 Playbook 的文档服务已在运行：${templatePath}`)}\n${outcome.kind === "failed" ? `${outcome.message}\n` : ""}`);
	process.exit(3);
}
startUi(core, createTspSession(), dirname(templatePath), coordinatorPicker(templatePath, dirname(templatePath), ownPane()), readClipboardImage);

const shutdown = (): void => {
	core.stop();
	server.close();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
