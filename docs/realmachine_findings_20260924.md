# 真机调试成果记录 —— jigefeiji.STEP 全链路（2026-09-24）

> 本文件是 2026-09-24 对真实飞机干净构型（jigefeiji.STEP）做端到端自动化调试的
> 一手记录。所有结论均为本机 Fluent 2022R2 (v222) 实测，非推断。
> 存放于 docs/ 以避免 aeroharness/ 被外部进程回滚时丢失。

## 1. 构型参数（实测）

| 项目 | 值 |
|---|---|
| 来源 | jigefeiji.STEP（SolidWorks 2025 导出，AP214） |
| STEP 单位声明 | `SI_UNIT(.MILLI., .METRE.)`（毫米） |
| 实体数 | 7（机身-1/-2、放样-1/-2/-4、外壳-1、水斗-4） |
| 包围盒（mm） | X 0~2951.6, Y -235~610, Z -2085~2085 |
| 实际尺寸 | L=3.112m W=0.845m H=4.170m（含垂尾），体积 0.3671 m³ |
| 特征 | 教练机/小型无人机量级，带垂尾 |

## 2. 关键发现（均为真机实证）

### 2.1 SpaceClaim /RunScript 门控（无法无头）
- `SpaceClaim.exe /RunScript=... /ExitAfterScript=True`（v222/scdm）在本机**挂起**：
  150s 与 600s 两次探针，脚本均未执行（无 probe.log），进程卡在启动阶段反复加载资源 DLL。
- 根因：首次运行的许可/协议对话框，需要 GUI 人工确认一次。无 GUI 自动化环境无法代劳。
- **规避方案**：几何环节改用 cadquery/OCCT 纯无头（见 §3），完全绕开 SCDM。

### 2.2 Fluent Meshing 能直接读 SolidWorks BREP STEP
- 原始 `jigefeiji.STEP`（SolidWorks BREP 格式）导入 watertight workflow **成功**：
  660 边界节点 / 660 边界面 / 7 面区。
- 关键：CAD 文件**不能带只读属性**。微信/邮件下载的文件常带 `-r--r--r--`，
  Fluent 的 CAD 内核会以读写方式打开，失败时报错伪装成
  `File "xxx.step" not found`（极具误导性）。需 `chmod u+w` 后再导入。

### 2.3 v222 Import Geometry 任务参数名
- 正确参数名是 **`FileName`（无空格）**，且**不接受**独立的 `'Length Unit'` / `'File Name'`。
- 传 `'File Name'` 报：`Failed to update task "Import Geometry" ... File Name`。
- 传 `FileName: 'path;m'` 报文件 `path;m` not found（单位不能这样拼）。
- 单位由 CAD 文件自身声明决定（v222 自动识别 mm）。

### 2.4 Size Functions 合法值（v222）
- 只有 `Curvature` / `Proximity` / `Curvature & Proximity`。
- **没有 `Basic`**（传 Basic 报 `Argument Name: Size Functions / Allowed value(s): ...`）。
- 性能旋钮不是换尺寸函数，而是调 MinSize/MaxSize/GrowthRate。

### 2.5 【已更正】TGrid "Out of Memory / 20 分钟不完成" = 单位错配，不是内存或环境问题

**初判（10:00，已推翻）**："v222 TGrid 在本机必崩，16 节点盒子也 OOM，无 GUI 环境导致"。

**根因（14:00 定位，实证）**：**单位错配三个数量级**。
- v222 watertight 工作流的**会话长度单位跟随导入 CAD 的声明单位**。
  我们的域由 cadquery/OCCT 导出 → 声明 `SI_UNIT(.MILLI.,.METRE.)` → 工作流按**毫米**解释一切尺寸。
- 而 `meshing.py` 原来把 config 里的**米**（MinSize=0.02、MaxSize=0.1）原样写进 journal
  → 被当成 0.02mm/0.1mm，曲率细分比预期小 1000 倍。
- 证据链：journal 写米 → options XML 记成 `0.02[mm]` 且 `length unit = [mm]` →
  尺寸场构建 150.7s、`.sf` 文件 **1.43GB**（真机域同样配置只要 0.038s）。
- 修复：`render_meshing_journal(size_unit='m')` 内用单一 `_s()` 把
  min_size/max_size/vol_max/local_sizing[].size 统一 ×1000 转 mm。
- **验收**：同一个 200mm 盒子，**20 分钟 → 17.9 秒**（约 100 倍）。

> 附带确认：OCCT **不能导出米制 STEP**（`write.step.unit='M'` 静默回落 MM），
> 所以"全程 mm + 求解器侧 `/mesh/scale 0.001` 缩放"是唯一正确路线。
> 另：v222 的 `/file/write-mesh x.msh` 实际写出 **x.msh.h5**，判存在时要一并匹配。

### 2.6 TGrid 内存（部分成立，非主因）
- `Generate the Surface Mesh` 会起子进程 `Ansys/TGrid/CADReaders.py`（ANSYS 内置 Python 3.7，
  任务管理器里显示为普通 `python.exe`）。
- **单次干净运行仅占 0.9~1.5GB，能跑完**；20 秒采样 CPU 增量 19.2s（单核满载，非死锁）。
- **异常退出会留孤儿进程**（本机观测到单个涨到 10.28GB），多次实验叠加会污染后续实验 →
  表现为"什么都 OOM"。已提供 `meshing.kill_stale_meshing()`（按 `python*` + 命令行含
  `CADReaders.py` 双特征匹配；**只按字符串匹配会误伤自己的 shell 进程**，本机踩过）。
- 结论：内存累积是**放大器**，单位错配才是**根因**。两者叠加才产生"OOM+20分钟"的假象。
- 待查方向：TGrid 许可/环境变量/GUI 依赖；或改用 Workbench 链接的 Meshing 进程；
  或用求解器模式 Mosaic；或外部网格器（gmsh）生成 msh 再读入。

## 3. 已打通的几何自动化（cadquery 路线，绕开 SCDM）

用 cadquery 2.8.0（OCCT 内核）纯无头完成，0.5 秒：
- 读干净构型 STEP → 包围盒外流场域（按 domain_sizing aircraft 规则，默认
  upstream 2L / downstream 3L / lateral 1W / vertical 0.75H）
- 布尔挖空成流体域（1 solid，48 面，域体积 493 m³，堵塞比 <3%）
- 导出 Fluent 可读 STEP。

**导出关键设置**（踩坑记录）：
- 必须设 `write.step.assembly=0`（单实体模式），否则 Fluent 报
  `Error in CAD Import / attaching to assembly`。
- OCCT 默认写 `ORIENTED_CLOSED_SHELL`（非 SolidWorks 的 `MANIFOLD_SOLID_BREP`），
  这本身 Fluent 可接受；assembly=0 才是让 shape representation 变成单实体引用的关键。
- 改 schema（AP203/AP214CD/AP242DIS）无效，OCCT 就是写 oriented shell。
- cadquery 不能导出 Parasolid(x_t/x_b)。

参考实现见提交历史或重建 `aeroharness/geom_cadquery.py`
（`build_fluid_domain(src, out_dir, margin, ...)`）。

### 2.5 TGrid 转换器：根因是"内存累积"而非单次超限（2026-09-24 14:00 修正）

初判（10:00 版，已被推翻）："v222 TGrid 在本机必崩，16 节点盒子也 OOM"。

**修正后的真因**（用 psutil 抓进程 + 内存轨迹证实）：
- `Generate the Surface Mesh` 会启动子进程
  `ANSYS Inc/v222/commonfiles/CPython/3_7/.../Ansys/TGrid/CADReaders.py`
  （ANSYS 内置 Python 3.7，tasklist 里显示为普通 `python.exe`）。
- **单次干净运行，该子进程约占 0.9~1.5 GB，能跑完**（20cm 盒子 CPU 满载
  19 分钟仍在算，无死锁——20s 采样 CPU 增量 19.2s、内存 +337MB）。
- **真正的故障是泄漏累积**：连续做多个网格实验时，异常退出会留下孤儿
  CADReaders 进程（本机观测到单个涨到 **10.28 GB**），物理内存被吃光后，
  此后每次实验都报 `Out of Memory`——于是"连 16 节点盒子都崩"是假象。
- 附加原因：CADReaders 默认 `ConformalFacetingCurvatureMinSize=10mm`
  （见 options XML），对 2m 级几何做曲率细分本身就很吃内存很慢。

**对策（已落进 `meshing.kill_stale_meshing()`）**：
- 跑网格前清理 `fluent.exe / fl_mpi2220.exe / mpiexec.exe`，
  并按"**解释器名 python* + 命令行含 CADReaders.py**"双重特征精确终止孤儿
  （只匹配字符串会误伤 shell 进程——本机实测踩过这个坑）。
- 串行或低并行（每进程一份 faceting 缓存）；必要时关闭占内存的其他程序。

### 2.6 并发编辑冲突（工作区"回滚"之谜）
- 现象：本次会话写入的 `meshing.py` / `error_kb.py` 改动与新建模块多次"消失"。
- 根因：**同一仓库有另一个 agent 会话在并发编辑**（`error_kb.py` 从 13 条
  变成 15 条、新增了本会话没有的条目；`runner.py` 已被对方改动）。
- 纪律：改共享文件前先 Read 最新内容；Edit 用最小唯一锚点；改完立刻验证。

## 4. 端到端进度与剩余阻塞

```
[✓] STEP 解析 + 几何定量（单位/包围盒/实体）
[✓] 外流场域自动建模（cadquery，绕开 SCDM 门控）
[✓] 域几何导入 Fluent Meshing（705 边界节点 / 670 面 / 8-19 面区）
[✓] 几何水密性审计（UnifySameDomain+ShapeFix：is_valid=True、碎片面 0、自由边 0）
[✓] 表面网格（44.8s 完成；单位修复后从 20 分钟降到秒级）
[✗] Describe Geometry / Update Boundaries
      ← 表面网格在 2 个面上失败："Deleted 2 faces with 3 free edges"
        → "Free faces still exists" → "surface meshing was not successful"
[ ] 体网格 / 写 msh
[ ] 求解 / 受力 / 收敛（求解侧 /mesh/scale 已实现，待网格）
[ ] 云图
```

### 4.1 剩余卡点：3-free-edges 面（唯一未解阻塞）
- 现象：TGrid 读尺寸场后 `Deleted 2 faces with 3 free edges` → 表面网格失败。
- 已排除：
  - 几何复杂度 / 域大小 / 尺寸函数 / 并行度（见 §2.5 单位更正）
  - OCCT 拓扑缺陷：48 面全部 `BRepCheck_Analyzer.IsValid()=True`、
    自由边 0、非流形边 0、最小/最大面积比 3.7e-6、最小面 715mm²
  - min_size 过大也不行（0.05/0.10/0.20 均复现）
- 关键矛盾：**OCCT 认为几何完全水密，Fluent 却在其中找出 3 自由边面**
  → 高度怀疑 **OCCT 写出的 STEP 在 Fluent 的 CAD 内核里被解析出偏差**
  （旁证：P0-4 的命名导出也卡在 OCCT 的 STEP 结构上，见 §5）。
- 对照实验（进行中）：同一套网格参数下，用**原始 SolidWorks STEP**（Fluent 解析无碍）
  跑 surface mesh——若它成功，则确认是 OCCT 导出的保真度问题，
  修复路线变为「让 Fluent 自己做挖空」或「在 SpaceClaim 里做域」。

### 4.2 已落地的修复（P0-1 ~ P0-5，2026-09-24 18:00）

| 编号 | 内容 | 验收 |
|---|---|---|
| P0-1 | `render_meshing_journal(size_unit='m')`：单一 `_s()` 把 min_size/max_size/vol_max/local_sizing[].size ×1000 转 mm；`_mesh_outputs()` 兼容 `.msh.h5`；transcript/CAD 头单位断言（返回 `session_unit`/`unit_ok`） | 盒子 20min→**17.9s**，`ok=true` |
| P0-2 | `geom_cadquery.heal_and_audit()`：ShapeUpgrade_UnifySameDomain + ShapeFix_Shape，审计 is_valid / 边面数 / 碎片面清单 | 真机域 `is_valid=True`、碎片面 **0**、自由边 **0** |
| P0-3 | 硬哨兵 `_guard()`：每个 `Execute()` 后 `assert TaskObject[t].getState()['State'] != 'Out-of-date'`。**注意不能用 `.Errors`**——它返回 ModelState 对象，恒非空，assert 必挂 | 注入坏 CAD → `missing_steps` 精确定位 `import_geometry` |
| P0-3b | 软失败兜底：文本匹配 `Free faces still exists` / `surface meshing was not successful` 映射回 `surface_mesh`（此时 getState 可能不是 Out-of-date，哨兵会漏判） | 见 §4.1 |
| P0-5 | `journal_gen.build_mesh_scale_lines()`：`case.mesh_unit_mm=true` → 读网格后输出 `/mesh/scale 0.001 0.001 0.001`，随后 `/mesh/check` 打印域尺寸可作断言 | 生成 `['/mesh/scale 0.001 0.001 0.001']`，expected 含 `mesh_scale` |
| — | `kill_stale_meshing()`：按 `python*` + 命令行含 `CADReaders.py` **双特征**匹配（只按字符串会误伤自身 shell 进程） | 已清理 |

### 4.3 待办
- **P0-4 边界命名**：面分组已实现（48 面 → `aircraft_skin` 17 / `farfield` 9 / `outlet` 5 / `bottom` 5 / `top` 11 / `inlet` 1），
  但 `STEPCAFControl_Writer` 未把 `TDataStd_Name` 写进 STEP（试过 AddSubShape / AddComponent，
  需 free shape 转 XCAF assembly 结构）。**旁证：OCCT 的 STEP 写出在 Fluent 侧解析有偏差**（见 §4.1），
  命名导出与几何保真度可能是同一个 OCCT 写出问题的两面。
- **P1-7** 两套网格无关性编排、**P2-8** 云图（`/file/export/ascii` + matplotlib）。
1. 在 GUI 里手工打开一次 Fluent Meshing，导入 fluid_domain.step，
   手工跑一次 watertight workflow —— 验证是否 GUI 下 TGrid 正常（无头崩溃可能是
   无 GUI/无显示环境导致）。若 GUI 也崩，则是安装/许可问题。
2. 若 GUI 正常：从 GUI 录一段 watertight journal，即可反哺自动化（2 分钟录制法）。
3. 备选：Workbench Meshing 链接、求解器 Mosaic、或 gmsh 生成 msh。

## 5. 插件待回写清单（因 aeroharness/ 被外部进程回滚未落盘）

- `meshing.py`：`Import Geometry` 参数 `'File Name'`+`'Length Unit'` → 正确为
  `FileName` 单参；`Size Functions` 合法值注释；CD 工作目录每次新建（防残留）。
- `error_kb.py` 新增：
  - `import_geometry_argname`（FileName 参数名）
  - `cad_file_readonly_notfound`（只读属性伪装 not found）
  - `tgrid_oom_surface_mesh`（TGrid OOM 诊断与对策）
- 新模块 `aeroharness/geom_cadquery.py`（cadquery 建域，含 §3 踩坑注释）。
- `config`/pipeline：geometry 步骤支持 cadquery 后端；mesh 步骤接 run_watertight。
