# 分享给新主机（部署清单）

本仓库是一个**可迁移的 Fluent 自动化管线**：`git clone` 到任何满足前置条件的
Windows 主机即可跑通“飞机模型 → 网格 → 求解 → 升阻力”全流程。本文档是对方
主机的部署步骤 + 本机的机器相关项清单。

## 对方主机前置条件（不满足则跑不通）

| 项 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows | Fluent 与 harness 仅支持 Windows |
| ANSYS Fluent | 2022 R2（v222） | 本机在 v222 上全链路验证；其他版本需按 calibration 指南重新探针 |
| 许可证 | licence server 可达 | 本机是 `1055@localhost`；对方主机确认自己的许可服务器地址/配置 |
| Python | 3.10+ | 开发用 3.12 |
| 磁盘 | ≥ 10 GB | 网格/求解临时文件 |

## 部署步骤（在对方主机执行）

```bash
git clone https://github.com/simonemuller6127-png/automatic-fluent.git
cd automatic-fluent

# 1) Python 依赖（cadquery/OCCT 是几何环节核心，必须装）
pip install -r requirements.txt

# 2) 自检
python run_pipeline.py doctor            # 环境自检：fluent.exe 发现 / 模板渲染 / mock 冒烟
python tools/selftest.py                 # 离线自测 78 项，应 ALL PASS

# 3) 通道算例冒烟（真机，验证本机 Fluent + 许可证）
python run_pipeline.py run --config configs/demo_channel.json --real ^
  --set fluent.exe=D:/你机器上的/fluent.exe --set fluent.parallel=1 ^
  --set run.n_iter=100

# 4) 飞机全流程（约 60-70 分钟，含 2000 迭代）
python run_pipeline.py pipeline --config configs/case_jigefeiji.json ^
  --set fluent.exe=D:/你机器上的/fluent.exe
```

fluent.exe 不传也行：`doctor` 会用内置 `discover_fluent_exe()` 扫描常见安装路径。

## 机器相关项一览（只需改配置或 --set）

| 项 | 本机默认值 | 改法 |
|---|---|---|
| `fluent.exe` | `D:/Ansys-2023R1/ANSYS Inc/v222/...` | `--set fluent.exe=...` 或改 config |
| `fluent.parallel` | 4 | 按 CPU 核数调 |
| `run.n_iter` | 2000 | 首次校准可先 500 |
| 源构型 `geometry.cad_step` | `examples/jigefeiji.STEP`（仓库内置） | 换成自己的机型：放一个 STEP 进去改路径 |

## 仓库自带内容 vs 运行时生成

- **入库**：代码、配置、`examples/jigefeiji.STEP`（示例机型）、`geom_baseline/`（已验证的干净域基线）、模板、文档。
- **不入库（新主机自动生成）**：`runs/`、`meshes/*.msh.h5`、`meshes/*_split.cas.h5` 等网格产物、Fluent 会话日志。.gitignore 已全部覆盖。

## 遇到问题的标准动作

1. 求解失败 → 看 `runs/<case>/<run>/failpack/diagnosis.md`（机器生成的诊断：失败步骤 + 知识库命中 + transcript 尾部）。
2. 报错文本 → 对照 `aeroharness/error_kb.py`（29 条真机排错条目）。
3. 版本差异 → 按 `skills/aero-fluent/references/prompt_calibration.md` 的探针流程重新校准应答序列。