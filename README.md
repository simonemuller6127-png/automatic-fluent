# automatic_fluent —— Fluent 自动化调参程序（aeroharness）

> 依据《AI 仿真调参调研报告》第 6 节 v2 方案落地：**journal 主路线 + 分层保底 + 6.9 错误反馈增强协议**。
> 演示算例对齐 E10《Fluent 2023 外流场及其计算实例》（飞机 200 m/s，Cd≈0.0386 / Cl≈-0.0393）。
> **状态：真实 Fluent 2022 R2（v222）全链路已验证跑通**（读网格→模型→边界→初始化→迭代→受力报告→解析落盘），离线自测 36/36 通过。

---

## 安装到你的 Agent（Codex / zcode / Claude Code / Cline）

见 [integrations/README.md](integrations/README.md)：仓库即 Claude Code 插件市场（marketplace add 一条命令）、
Codex 一条命令注册 MCP、zcode/Cline 配置片段。

## 快速开始

```bash
cd D:\Ansys-2023R1\automatic_fluent

python run_pipeline.py doctor        # ① 环境自检：发现 fluent.exe / 模板渲染 / mock 冒烟
python tools/selftest.py             # ② 离线全链路自测（失败注入 + 重试 + 优化闭环），43 项
python run_pipeline.py run --config configs/demo_channel.json            # ③ mock 单次运行
python run_pipeline.py optimize --config configs/demo_channel.json --trials 16   # ④ mock 试参闭环
python run_pipeline.py pipeline --config configs/demo_channel.json        # ⑤ M7 一键管线（几何→网格→求解）
python tools/baseline_check.py       # ⑥ M1.5 基线真跑（质量守恒 + 解析压降对比）
python tools/degradation_drill.py    # ⑦ M7 降级梯度演练（L3→L2→L1→L0），5 项
```

零硬依赖（纯标准库可跑）。可选增强：`pip install -r requirements.txt`（optuna TPE 引擎 / yaml / mcp）。

## 真实 Fluent 运行（已验证）

```bash
# 2D 通道真跑（本机已验证通过，约 1 分钟）
python run_pipeline.py run --config configs/demo_channel.json --real ^
  --set case.mesh_file=meshes/channel2d.msh --set case.dim=2d ^
  --set fluent.parallel=1 --set run.n_iter=100 ^
  --set bc.inlet.set_type=true --set bc.outlet.set_type=true
```

输出：`fx/fy（受力）、cd/cl（换算系数）、残差、converged 判定` 落盘到
`runs/demo_channel/<时间戳>_single-a1/`（summary.json / results.csv / transcript.log / journal.jou）。

### 飞机算例（case_airplane.json）首跑清单

1. 把 E10 生成的飞机网格填入 `case.mesh_file`（.msh/.cas.h5 均可），确认区域名
   `inlet / outlet / wall.feiiji` 与网格一致；
2. `run.n_iter=500`、`fluent.parallel=10`（CPU 线程数的一半，E10 建议）已按 E10 预置；
3. 目标参考值已按 E10 第 53 页填好（Cd=0.038623359 / Cl=-0.039298652）；A1 参考面积按
   试验/文献确定后改 `run.reference.area`；
4. `methods.*`（二阶离散、松弛因子）与 `physics.gravity=[0,0,-9.81]` 已按 E10 预置，
   但**首次真跑属于校准性质**：跑一次单次 `run --real`，若某步骤报错，按
   `skills/aero-fluent/references/prompt_calibration.md` 处置（failpack 诊断包会直接指出哪一行）；
5. 通过后再跑 `optimize --real`（两级 optuna 预算：粗筛 25% 迭代数快筛 + top-k 全保真精修）。

## 架构（调研报告 6.1 三层）

```
L3 接入层  tools/mcp_server.py（stdio MCP：aero_doctor/aero_run/aero_optimize/aero_results）
          + skills/aero-fluent（流程 skill：只填参数不写语法 + 失败决策表 + 人工关口）
             ↑ agent（VSCode/Codex/zcode/Claude Code）自然语言驱动
L2 自动化层 run_pipeline.py CLI（doctor/run/optimize/journal/inspect）
          + aeroharness/{runner, optimize, post, journal_gen, transcript_parser,
            error_rules, fluent_slot, adapters}
             ↓
L0 底座    journals/templates/*.jou.tmpl（模板+{{占位符}}+哨兵协议）
          + configs/*.json（参数表） + tools/mock_fluent.py（离线仿真器）
          + tools/make_demo_msh.py（2D 验证网格生成器）
```

降级梯度（6.0）：L3 MCP 异常 → 直接跑 L2 CLI → `journal` 子命令只出脚本交人工
`fluent.exe -i journal.jou`（L1）→ Fluent GUI 手工（L0，TUI 录制反哺模板库）。

## 6.9 错误反馈增强协议（全部实现）

| 层 | 实现 |
|---|---|
| ① 哨兵标记 | journal 内 `(display "; STEP-OK x")` 埋点；`@EXPECTED-STEPS` 声明预期；错误行自动归属到"第一个未完成步骤" |
| ② 结果握手 | journal 末尾写 `result.ok`；超时/崩溃=无握手=明确失败信号（与进程退出码解耦） |
| ③ 错误分类器 | transcript 尾部 → `{step, category, evidence, auto_retryable, suggestion}`；规则库 `error_rules.py`（divergence/license/mesh/config/crash_timeout） |
| ④ 失败打包 | `runs/<case>/<run>/failpack/diagnosis.md`：失败步骤+哨兵状态表+transcript 尾 200 行+决策表 |
| ⑤ 分级重试 | divergence（松弛因子×0.85，≤2 次）/ license（等待重试）/ mesh、crash_timeout（原样重试）；config 类不自动重试直接给诊断 |

## 试参闭环（6.6）

`optimize.py`：optuna TPE 两级预算（粗筛 = 25% 迭代数快 trial → top-k 精修，重复参数去重不重跑）
+ 内置 pattern-search 零依赖降级引擎；执行走 runner（含 6.9 重试）；产出
`trials.csv / best.json / report.md`。目标函数 `coefficient_match`（加权相对误差，
demo 对齐 E10 的 Cd/Cl）。

## 真机校准重要发现（2026-09-20，Fluent 2022 R2 / v222）

完整记录见 `skills/aero-fluent/references/prompt_calibration.md` 第 5 节，要点：

- journal 哨兵必须 `display`/`newline` 分两行；求解器读网格用 `read-case`；
- `set velocity-inlet` 字段应答**不对称**（vmag 有 "Use Profile?" 前置问句，湍流字段没有）；
  **laminar 选择也要答 `yes`**；
- `report forces` 新提示序与矢量三元组输出表（解析器新增格式 C）；
- `surface-integrals`（mass-flow-rate / area-weighted-avg pressure）序列已校准（M1.5 基线用）；
- **.msh 整数字段全是十六进制**；面数据 c0=(n0→n1) 左侧单元（用真实网格 1300 面统计实证）；
  区域名 `wall` 是保留字会被改名 `wall-3`；exit 前要应答"放弃未保存"；
- **meshing 模式**：工作流走 datamodel（`workflow.InitializeWorkflow` / `TaskObject[...]`），
  v222 的 WTM 导入**不支持 STL**（官方报错），CAD 输入须 .scdoc/.x_t/.step；
- 本机 Fluent 实际目录为 **v222（2022 R2）**；调研报告中"v232"的目录号写法有误（v232=2023R2），
  版本结论（2022 R2）不受影响；
- **mcp 2.x 兼容**：FastMCP 已更名 MCPServer，桥接代码双版本自适应。

## 目录结构

```
run_pipeline.py            # L2 CLI 入口
aeroharness/               # 核心包（config/journal_gen/transcript_parser/error_rules/
                           #   error_kb 报错知识库/feedback 反馈引擎/domain_sizing 域计算器/
                           #   geometry SpaceClaim/meshing watertight/fluent_slot/post/
                           #   runner/optimize/adapters）
docs/                      # external_flow_domain_and_mesh.md（域尺寸/回流/加密/破面官方引文）
                           # official_examples_translation.md（Q2 官方示例翻译对照表）
journals/translations/     # external_compressible_flow / ahmed_body_watertight 官方示例翻译件
refs/official_examples/    # 官方示例源码存档（pyfluent）
journals/templates/        # solve_channel（verified=live）/ solve_airplane（E10 映射，待首跑校准）
                           #   / mesh_watertight（M3 预置骨架）
configs/                   # demo_channel.json（已验证）/ case_airplane.json（E10 参数）
meshes/                    # channel2d.msh（生成器产物）、channel_box.stl、ref_elbow.msh（真实样例，
                           #   取自 OpenFOAM 教程，仅本地校准参考；开源发布前应剔除）
tools/                     # mock_fluent.py / selftest.py / make_demo_msh.py / mcp_server.py
scripts/                   # spaceclaim_box_domain.py（M2 示例骨架）
skills/aero-fluent/        # SKILL.md + references/prompt_calibration.md
runs/                      # 运行产物（含真跑日志与诊断包，可直接查看）
```

## 里程碑对照（调研报告 6.3）

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M0 环境与自检 | ✅ | doctor：fluent.exe 发现（v222）/模板渲染/mock 冒烟 |
| M1 journal 最小闭环 | ✅ | 一条命令无人工出结果；哨兵/握手/分类器全部真跑验证；失败注入自测 |
| M1.5 基线校验 | ✅ | 真跑通过：质量不平衡 **0.002%**（≤0.5% 官方判据）、Δp 与二维泊肃叶解析解偏差 **0.6%**（<5% 闸门）；`tools/baseline_check.py` |
| M2 SpaceClaim 自动化 | ◐ | 代码全就绪（CPython 外层参数管线 + domain_sizing 自动域计算 + IronPython 内层脚本 + manifest 验证）；**环境门控**：本机 SCDM 对 /RunScript 无响应（疑脚本安全设置/许可对话框），需人工在 GUI 里确认一次脚本执行后即可无人化 |
| M3 网格自动化 | ◐ | datamodel 路线骨架**真机验证**（InitializeWorkflow/TaskObject 可用）；**v222 版本边界实证**：WTM 导入不支持 STL（官方报错），需 .scdoc/.x_t/.step CAD 输入（与 M2 产物衔接）；演示管线用参数化网格生成器替代（meshes/channel2d*.msh）；STL 支持升版后解锁 |
| M4 求解+后处理 | ✅ | 求解→CSV/JSON；受力解析三格式；残差/收敛/质量/流量守恒/回流告警解析 |
| M5 优化闭环 | ✅ | optuna 两级 + 去重 + 内置降级引擎；mock 响应面实证收敛 |
| M6 接入层完善 | ✅ | 自研 fluent-mcp 5 工具（doctor/run/optimize/pipeline/results，兼容 mcp 1.x/2.x）+ aero-fluent skill（含报错知识库与反馈闭环指引）+ 校准记录 |
| —— Q2 官方示例翻译 | ✅ | external_compressible_flow（跨音速机翼）与 ahmed_body_watertight（官方网格工作流）翻译件 + 对照表；far-field BC/BOI/边界层参数已进生成器；**官方任务链语法与本机探针骨架互证一致** |
| —— Q3 报错知识库 | ✅ | error_kb.py 13 条真机排错条目（根因/修复指令/验证方法）；failpack 诊断包自动命中输出 |
| —— Q4 反馈闭环 | ✅ | 真跑实证：阻力分解（压差/粘性）→ tuning_hints 调参建议；残差历史 CSV；回流告警检测 |
| M7 全流程打通/降级演练 | ✅ | `run_pipeline.py pipeline` 一键（几何→网格→求解→汇总报告）；降级演练 5/5（L3 MCP→L2 CLI→L1 手工 journal→L0 指引）；汇总 `runs/<case>/pipeline_summary.json` |

## M6 后续：接入 ANSYS-Workbench-mcp（可选）

```bash
git clone https://github.com/hongwenwang36-eng/ANSYS-Workbench-mcp
# 按其 README 修改环境变量版本号 v251→v232 后实测 thermal_bar demo
# 或直接注册本项目的 MCP 桥：
codex mcp add aero-fluent -- python D:\Ansys-2023R1\automatic_fluent\tools\mcp_server.py
```

## 已知限制

- `case_airplane` 模板设置按 E10 映射且标注 `verified=false`：飞机网格首次真跑属校准性质
  （重力/离散格式/松弛因子菜单序列未经真机验证，channel 已验证部分均已固化）；
- demo mock 的响应面是**合成**的（最优解 turb_intensity=5, turb_viscosity_ratio=10, relax=0.9），
  用于验证优化器闭环，不代表真实物理；真跑时目标请改 `objective.targets`；
- `ref_elbow.msh` 来自 OpenFOAM（GPL）仓库，仅作本地格式参考，开源发布前应剔除；
- Windows 下 transcript 里中文注释显示为乱码（Fluent 按 ANSI 读 journal），纯外观不影响解析。
