import { expect, test } from "bun:test";
import { coordinatorPicker } from "../src/service/coordinators";

test("missing-pane errors resolve language at each operation, not picker construction", async () => {
	const previous = process.env.OMOMP_LANG;
	try {
		process.env.OMOMP_LANG = "en";
		const picker = coordinatorPicker("/book.yaml", "/tmp", null);
		for (const lang of ["zh", "en"] as const) {
			process.env.OMOMP_LANG = lang;
			const expected = lang === "zh" ? "这个 Playbook 面板" : "This Playbook pane";
			const listed = await picker.list();
			expect(listed.ok).toBe(false);
			if (!listed.ok) expect(listed.error).toContain(expected);
			const chosen = await picker.choose("1");
			expect(chosen.kind).toBe("attachFailed");
			if (chosen.kind === "attachFailed") expect(chosen.error).toContain(expected);
			const started = await picker.newSession();
			expect(started.ok).toBe(false);
			if (!started.ok) expect(started.error).toContain(expected);
		}
	} finally {
		if (previous === undefined) delete process.env.OMOMP_LANG;
		else process.env.OMOMP_LANG = previous;
	}
});
