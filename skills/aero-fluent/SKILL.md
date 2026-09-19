# aero-fluent skill（L3 流程层）

> 角色：把"journal 模板库 + 参数填充规则 + 错误决策表 + 人工关口"约束住，
> 让 LLM **只填参数、不写 journal 语法**（调研报告 6.5 / 6.8.1）。

## 触发场景

用户要求：跑 Fluent 算例 / 批量扫参 / 自动调参 / 网格自动化 / 分析失败的仿真日志。

## 铁律（违反即停下）

1. **只改 config（configs/*.json）里的参数，绝不手写/手改 journal 语法**。
   journal 由 `run_pipeline.py`/harness 从模板生成；要改行为先看模板与 `config.tui.*`。
2. **启动任何批量计算前，先向用户展示执行计划并等待确认**：
   参数范围、目标函数、trial 数、预计单次耗时与总时长（hfss-harness 同款关口）。
3. **失败先读诊断包再动手**：`runs/<case>/<run>/failpack/diagnosis.md`，
   不要对着原始 transcript 猜。
4. **解析器报"受力解析失败/STEP-OK 缺失"时，禁止改代码硬绕**，
   走下面决策表；多数是 TUI 应答序列问题，按
   `references/prompt_calibration.md` 校准 `config.tui.*`。

## 常用命令

```bash
python run_pipeline.py doctor                                  # M0 自检（永远先跑）
python run_pipeline.py run --config configs/case_airplane.json --real
python run_pipeline.py optimize --config configs/case_airplane.json --trials 10 --real
python run_pipeline.py journal --config configs/case_airplane.json --out out/  # L1 只出脚本
python run_pipeline.py inspect runs/<case>/<run_dir>           # 看某次运行摘要
python tools/selftest.py                                       # 离线全链路自测
```

## 报错知识库（Q3：解析→解释→修复）

`aeroharness/error_kb.py` 沉淀了全部真机排错史。失败时：
1. 打开 `runs/<case>/<run>/failpack/diagnosis.md` —— **"知识库命中"小节直接给出
   根因解释、具体修复指令（含 config 键名）、验证方法**；
2. 按"修复指令"改 config（不是改模板/代码），重跑后用"验证方法"确认；
3. 遇到知识库未覆盖的新错误 → 排错后把条目追加进 `error_kb.py`（项目记忆）。

## 后处理反馈闭环（Q4：看懂结果→回头调参）

真跑后 summary.json 的 `tuning_hints` 是机器生成的调参建议（每条含触发证据）：
- **阻力分解** `force_decomposition`：压差阻力占比高 → 加密尾流 BOI/加大下游域；
  粘性占比高 → 核对 y+/边界层参数（官方 Boundary Layers 14 层/Rate 1.15 起步）；
- `reversed_flow_warnings` > 0 → 下游域 ×1.5 + 真实 backflow 湍流量；
- `residual_history.csv`：残差趋势平台 → 查网格质量与松弛；
- 建议 → agent/人确认 → 改 config → 下一轮 `optimize`。云图等视觉反馈按
  `journals/translations/` 的官方 datamodel 路线导出（数值通道为主线的决策见报告 4.2）。

## 失败决策表（6.9 第 4 层配套）

| diagnosis.md 类别 | 处置 |
|---|---|
| `config` | 看 transcript_tail 里最后一个 Error 所在 TUI 行 → 对照 `prompt_calibration.md` 改 `config.tui.*`；**不要盲目重试** |
| `divergence` | runner 已自动降松弛重试 ≤2 次；仍失败 → 检查初始化/网格质量（`quality_*` 指标） |
| `mesh` | 调整网格参数（meshing 模板）或反馈上游几何；runner 自动重试 1 次 |
| `license` | runner 等待后重试 ≤2 次；仍失败 → 检查许可证服务器/排队 |
| `crash_timeout` | runner 重试 1 次；复现 → 降并行核数 / 加大 timeout_s / 查内存 |
| `step_incomplete` | STEP-OK 缺失：对照 transcript 找第一个报错命令，同 config 处置 |

修复后重跑；若修改了 `config.tui.*` 应答序列，把 `template.verified` 保持/改为 `live`
并记录版本（v222/v231…），这就是模板库的反哺机制。

## 优化闭环的分工（6.6）

- **"试"（数值搜索）**：optuna 两级（粗筛 fast trial → 精修 top-k），代码在 `aeroharness/optimize.py`；
  LLM 不做数值寻优，不要自行发明"试几组参数"。
- **"调"（策略决策）**：LLM/人工——定目标与范围、读 `optimize_*/report.md` 摘要、
  判断物理合理性（如 y+、残差走势）、必要时收窄范围再开新一轮。
- **验收**：数值判据（loss/残差/质量指标）机器自动判定；语义判据人工关口。

## 上手检查单

1. `python run_pipeline.py doctor` → 确认 fluent.exe 发现、模板渲染、mock 冒烟三项 OK；
2. 确认配置里 `mesh_file`、区域名（inlet/outlet/wall_zone）与网格一致；
3. 首跑单次 `run` 验证模板 → 通过后再 `optimize`；
4. 真跑前确认 `template.verified`（false=未校准，批量优化会被人工关口拦下）。
