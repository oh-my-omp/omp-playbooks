--!strict
-- Tern-side entry for omp-playbooks (design/README.md S14, contracts.md K6).
-- It shows a Playbook's document service, starting the service beside the focused pane
-- when none runs. It never starts omp or any agent: the coordinator is the omp main
-- session that calls the `playbook_*` tools.

-- The omp plugin `omp-playbooks` links this directory into Tern when it is installed, so the
-- document service entry sits next to it in the same omp plugin package.
local MAIN = tern.plugin.dir .. "/../src/service/main.ts"
-- `main.ts --reveal` exits 4 when no service listens for the document (contracts.md K6).
local ABSENT = 4

-- The language rule of src/i18n.ts, read from the Tern app's environment: OMOMP_LANG
-- when it is en or zh, else the first non-empty of LC_ALL, LC_MESSAGES and LANG (Chinese when
-- it starts with zh), else English.
local function chinese(): boolean
	local explicit = tern.getenv("OMOMP_LANG")
	if explicit ~= nil then
		local named = string.lower((string.gsub(explicit, "^%s*(.-)%s*$", "%1")))
		if named == "zh" or named == "en" then
			return named == "zh"
		end
	end
	for _, key in { "LC_ALL", "LC_MESSAGES", "LANG" } do
		local value = tern.getenv(key)
		if value ~= nil and string.match(value, "%S") ~= nil then
			return string.match(string.lower(value), "^%s*zh") ~= nil
		end
	end
	return false
end
local ZH = chinese()

local function tr(en: string, zh: string): string
	return if ZH then zh else en
end

local function quote(text: string): string
	return "'" .. (string.gsub(text, "'", "'\\''")) .. "'"
end

local function dirname(path: string): string
	return string.match(path, "^(.*)/[^/]*$") or "/"
end

-- Tern windows started from the GUI may not have the user's PATH, so `bun` resolves
-- through the login shell, as pane launches do.
local function shell_command(args: string): { string }
	return { tern.getenv("SHELL") or "/bin/zsh", "-lc", "exec bun " .. quote(MAIN) .. " " .. args }
end

local function show(path: string)
	tern.process.run(shell_command("--reveal " .. quote(path)), function(result, cx)
		if cx == nil or result.status == 0 then
			return
		end
		if result.status ~= ABSENT then
			cx:toast("error", tr("Playbook cannot be shown", "Playbook 无法显示"), result.stderr)
			return
		end
		local target = cx.session:focused()
		if target == nil then
			cx:toast("error", tr("No focused pane to open the Playbook beside", "没有可以在旁边打开 Playbook 的 pane"))
			return
		end
		local launch = { cwd = dirname(path), command = "exec bun " .. quote(MAIN) .. " " .. quote(path) }
		if cx.layout:split(target, "right", launch) == nil then
			cx:toast("error", tr("Cannot create the Playbook pane", "无法建立 Playbook pane"), path)
		end
	end)
end

-- The focused file pane's YAML path, or nil. `available` runs under the palette's 4 ms
-- budget, so this stays to table lookups and never reads the file.
local function focused_yaml(cx): string?
	local id = cx.session:focused()
	local pane = if id == nil then nil else cx.session:pane(id)
	if pane == nil or pane.kind ~= "file" or pane.path == nil then
		return nil
	end
	local path = pane.path
	if string.match(path, "%.ya?ml$") == nil then
		return nil
	end
	return path
end

tern.command({
	id = "open",
	title = tr("Playbook: open", "Playbook: 打开"),
	icon = "file",
	available = function(cx)
		return focused_yaml(cx) ~= nil
	end,
	run = function(cx)
		local path = focused_yaml(cx)
		if path == nil then
			return
		end
		if not tern.fs.exists(MAIN) then
			cx:toast("error", tr("The document service entry is missing; reinstall the omp plugin omp-playbooks", "找不到文档服务入口；请重新安装 omp 插件 omp-playbooks"), MAIN)
			return
		end
		show(path)
	end,
})
