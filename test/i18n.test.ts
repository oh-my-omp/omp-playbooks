import { describe, expect, test } from "bun:test";
import { resolveLanguage } from "../src/i18n";

describe("process language", () => {
	test("OMP_PLAYBOOKS_LANG en or zh wins over the locale", () => {
		expect(resolveLanguage({ OMP_PLAYBOOKS_LANG: "zh", LANG: "en_US.UTF-8" })).toBe("zh");
		expect(resolveLanguage({ OMP_PLAYBOOKS_LANG: " EN ", LC_ALL: "zh_CN.UTF-8" })).toBe("en");
	});
	test("any other OMP_PLAYBOOKS_LANG value is ignored, locale style included", () => {
		expect(resolveLanguage({ OMP_PLAYBOOKS_LANG: "zh_CN", LANG: "en_US.UTF-8" })).toBe("en");
		expect(resolveLanguage({ OMP_PLAYBOOKS_LANG: "fr", LANG: "zh_TW.UTF-8" })).toBe("zh");
	});
	test("the first non-empty of LC_ALL, LC_MESSAGES, LANG decides; only zh locales are Chinese", () => {
		expect(resolveLanguage({ LC_ALL: "", LC_MESSAGES: "zh_CN.UTF-8", LANG: "en_US.UTF-8" })).toBe("zh");
		expect(resolveLanguage({ LC_ALL: "C.UTF-8", LANG: "zh_CN.UTF-8" })).toBe("en");
		expect(resolveLanguage({ LANG: "ZH-tw" })).toBe("zh");
		for (const value of ["en_US.UTF-8", "C", "POSIX", "ja_JP.UTF-8"]) expect(resolveLanguage({ LANG: value })).toBe("en");
	});
	test("no setting at all is English", () => {
		expect(resolveLanguage({})).toBe("en");
	});
});
