# 安装指南（给 AI / agent）

本文件供 AI / agent 阅读：按用户的操作系统执行对应步骤，即可把 `ccu` 命令装到用户电脑。命令可直接复制运行，把 `<REPO>` 替换成实际的克隆路径。

**前置**：用户已装 Node.js（终端能 `node -v` 输出版本即可，任意版本，含 node14+）。

---

## 1. 克隆仓库

选一个目录克隆（示例放 `~/tools`，可自定）：

```bash
git clone git@github.com:Auroka/ccusage-lite.git
# 没有 SSH 权限就用 HTTPS：
# git clone https://github.com/Auroka/ccusage-lite.git
```

记下克隆后的**绝对路径**作为 `<REPO>`，例如：
- macOS：`/Users/me/tools/ccusage-lite`
- Windows：`C:\Users\me\tools\ccusage-lite`

---

## 2. 建 `ccu` 命令（按系统二选一）

### macOS / Linux

`bin/ccu.js` 自带 shebang，加可执行权限后软链到 PATH 目录即可：

```bash
chmod +x "<REPO>/bin/ccu.js"
sudo ln -sf "<REPO>/bin/ccu.js" /usr/local/bin/ccu
```

没有 sudo 权限就用用户目录（并确保它在 PATH）：

```bash
mkdir -p "$HOME/.local/bin"
ln -sf "<REPO>/bin/ccu.js" "$HOME/.local/bin/ccu"
# 若 PATH 不含它，追加到 shell 配置（zsh 用 ~/.zshrc，bash 用 ~/.bashrc）后重开终端：
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

### Windows

需要两个 shim，放进一个**已在 Windows PATH 上**的目录（推荐 `%USERPROFILE%\.local\bin`，没有就建它并加进用户 PATH）：
- `ccu.cmd` —— 给 PowerShell / cmd 用，**必须 CRLF 行尾**；
- `ccu`（无扩展名）—— 给 Git Bash / WSL 用，这些 shell 不认 `.cmd`。

**用 Git Bash 一键生成**（装 Git 时自带 Git Bash，行尾自动正确）。把 `repo` / `win_repo` / `dest` 换成实际值：

```bash
repo="/c/Users/me/tools/ccusage-lite"          # Git Bash 风格路径
win_repo="C:\\Users\\me\\tools\\ccusage-lite"   # Windows 反斜杠路径（注意双写 \\）
dest="$HOME/.local/bin"
mkdir -p "$dest"
printf '@echo off\r\nnode "%s\\bin\\ccu.js" %%*\r\n' "$win_repo" > "$dest/ccu.cmd"
printf '#!/usr/bin/env bash\nexec node "%s/bin/ccu.js" "$@"\n' "$repo" > "$dest/ccu"
chmod +x "$dest/ccu"
```

把 `dest` 加进用户 PATH（PowerShell 执行一次，重开终端生效）：

```powershell
$dest = "$env:USERPROFILE\.local\bin"
[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";$dest", "User")
```

> **为什么两个文件**：cmd / PowerShell 靠 PATHEXT 把裸名 `ccu` 解析到 `ccu.cmd`；Git Bash 不套用 PATHEXT，必须有无扩展名的 `ccu` 脚本，否则在对应终端里报 `command not found`。缺一不可。

---

## 3. 接入状态栏（可选）

在 Claude Code 的 `settings.json` 加（路径换成 `<REPO>`，Windows 也用正斜杠 `/`）：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"<REPO>/bin/ccu.js\" statusline"
  }
}
```

状态栏出任何错都会降级成一行 `🤖 Claude`，不会崩。

---

## 4. 验证

**新开一个终端**运行：

```
ccu
```

能打印近一周用量表格即安装成功。若失败，依次检查：
1. `node -v` 是否可用；
2. shim / 软链所在目录是否真的在 PATH（Windows 用 `powershell.exe -NoProfile -Command "$env:Path"` 看，别只信 bash 的 `$PATH`）；
3. `<REPO>/bin/ccu.js` 路径是否正确。
