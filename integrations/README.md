# 安装到你的 Agent（Codex / zcode / Claude Code / Cline）

> 仓库即分发：所有物料都在本仓库内，按 agent 选择下面的安装方式。
> 共同前提：本机已装 ANSYS Fluent（本仓库真机验证版本 2022 R2 / v222）与 Python ≥3.10；
> `pip install -r requirements.txt`（仅 optuna/yaml/mcp 三个可选增强）。

## Codex（优先级 1）

1. MCP 桥（能力层）：
   ```bash
   codex mcp add aero-fluent -- python <仓库绝对路径>/tools/mcp_server.py
   ```
2. Skill（流程层）：把 `.codex/skills/aero-fluent/` 保留在仓库内即可被识别；
   仓库级使用无需复制，全局使用复制到 `~/.codex/skills/`。
3. 验证：让 Codex 调用 `aero_doctor`，应返回 fluent.exe 发现与 mock 冒烟结果。

## zcode（优先级 2）

- MCP：在 zcode 配置中注册 stdio server：
  ```json
  { "command": "python", "args": ["<仓库绝对路径>/tools/mcp_server.py"], "name": "aero-fluent" }
  ```
- Skill：把 `skills/aero-fluent/` 目录复制/链接到 zcode 的技能目录。
- 验证：对话中说"跑一下 fluent doctor"，应触发 aero_doctor 或对应 CLI。

## Claude Code（优先级 3）

- 本仓库即插件市场（`.claude-plugin/marketplace.json`）：
  ```bash
  claude plugin marketplace add simonemuller6127-png/automatic-fluent
  claude plugin install automatic-fluent
  ```
- 插件自带 `.mcp.json`（自动注册 aero-fluent MCP 桥）与 `skills/aero-fluent`。

## Cline（优先级 4）

- 仓库含 `.cline/marketplace.json`（MCP server + skill 声明）；
- 手动方式：Cline MCP 面板添加 stdio server `python tools/mcp_server.py`（cwd=仓库根）。

## 通用兜底（任何 agent 都可用）

不接 MCP/skill 也能全功能使用——CLI 即是 L2 主入口：

```bash
python run_pipeline.py doctor
python run_pipeline.py run --config configs/demo_channel.json
python run_pipeline.py optimize --config configs/demo_channel.json --trials 16
python run_pipeline.py pipeline --config configs/demo_channel.json
```
