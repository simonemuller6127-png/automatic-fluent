# TUI 应答序列校准指南（prompt_calibration）

> 目的：journal 主路线唯一需要"版本实机核对"的地方，就是 **TUI 命令的 prompt 应答序列**。
> 语法（菜单路径）十年稳定，但每个命令**问几个问题、默认值是什么**随版本会变。
> 本指南给出三件套：① 2 分钟录制校准法（权威）；② 逐命令候选序列表；
> ③ 无 GUI 的 stdin 探测法。校准完成后把结果写进 `config.tui.*`，
> 并把 `template.verified` 置为 `live`——这就是模板库的反哺机制（6.8.1）。

## 1. 权威校准法：GUI TUI 录制（2 分钟）

1. 打开本机 Fluent（v222/2022R2），进入 Solution 模式；
2. `File → Write → Start Journal...` 存为 `record.jou`（或 File → Write → Start Transcript 看即时命令）；
3. 手工做一遍目标操作（例如：设入口速度 200、Report Forces 打印受力）；
4. `File → Write → Stop Journal`，打开 `record.jou`——里面就是**本机版本逐字节的正确序列**；
5. 把序列里每个应答值对应到 `config.tui.*` 校准项（见下表），重跑即可。

Meshing 模式同理：Fluent Launcher 选 Meshing 后再 Start Journal，
录制 watertight 工作流每个任务的参数（M3 模板校准）。

## 2. 逐命令候选序列表（config.tui.* 对应关系）

| 模板行（生成后） | 可疑应答 | 校准项 | 说明 |
|---|---|---|---|
| `/define/models/viscous/ke-standard yes` | 尾部 `yes` = Production Limiter | `tui.ke_production_limiter` | 老版本可能无此问，多余应答会污染下一问 → 录制确认 |
| `/define/boundary-conditions/set/velocity-inlet <zone> () vmag yes 200 turb-intensity 5 turb-viscosity-ratio 10 ()` | `yes` = 常数/剖面应答；字段名 `turb-intensity`/`turb-viscosity-ratio` | `tui.vmag_constant_answer` | 官方 pyfluent 0.12 exhaust 示例在 2022R2 上用 `yes`；laminar 时无湍流字段自动省略 |
| `/define/boundary-conditions/set/pressure-outlet <zone> () gauge-pressure 0 ()` | 字段名可能是 `supersonic-or-gauge-pressure` | `tui.outlet_pressure_field` | 录制确认字段名 |
| `/solve/set/discretization-scheme/pressure 2`（mom/tk/te 同） | 数字代码：压力 2=Second Order、动量 2=Second Order Upwind | `methods.*` | 老版本代码可能不同（压力 1=Linear）；录制确认 |
| `/solve/set/under-relaxation/momentum 0.7` | 子命令名（momentum/k/epsilon） | `tui.relax_var_names` | 有的版本叫 `mom`；录制确认 |
| `/define/operating-conditions/gravity yes 0 0 -9.81` | `yes`=启用重力，随后三轴分量 | — | 提示序为 X/Y/Z；录制确认 |
| `/report/forces/wall-forces <answers>` | **最大不确定项**：是否写文件/文件名/区域列表/力分量的提问顺序 | `run.force_report_style` C1/C2/C3 | 三种候选见第 3 节；解析器对 transcript 与 .lis 双通道兜底 |
| `/mesh/check`、`/mesh/quality` | 一般无应答 | `run.mesh_check` | 若某版本无 quality 子命令 → 关掉该项 |

## 3. force_report_style 三个候选

```
C1: /report/forces/wall-forces yes forces.lis wall () 1 0 0   # 先答写文件+文件名
C2: /report/forces/wall-forces wall () 1 0 0 yes forces.lis   # 先答区域+分量，最后写文件
C3: /report/forces/wall-forces no wall () 1 0 0               # 不写文件，列表进 transcript
```

判定方法：跑一次后看 transcript——若 C3 在 report 位置出现 `Error:`，
把错误行贴给 harness（它会建议换 style）；或直接按第 1 节录制一次定案。

## 4. 无 GUI 的 stdin 探测法（脚本化校准）

批处理下 journal 应答耗尽后 Fluent 会从 stdin 继续读。利用这一点可以**问出 prompt 序列**：

```bash
cd <某空目录>
python -c "print('\n'*20)" | "D:/Ansys-2023R1/ANSYS Inc/v222/fluent/ntbin/win64/fluent.exe" 3d -t1 -g -i probe.jou > probe_out.txt 2>&1
```

`probe.jou` 只写：

```scheme
/report/forces/wall-forces
; PROBE-END
exit
```

`probe_out.txt` 里会依次回显每个 prompt 及其默认值（换行喂默认值），
按顺序把显式应答填进候选序列即可。此法同样适用于 velocity-inlet set 等任何多 prompt 命令。

## 5. 校准记录（随使用追加）

| 日期 | 版本 | 命令 | 定案 | 备注 |
|---|---|---|---|---|
| 2026-09-20 | v222(2022R2) | laminar | `/define/models/viscous/laminar yes`（也有 Enable? 提示，必须答 yes） | 真跑实证 |
| 2026-09-20 | v222(2022R2) | surface-integrals | `/report/surface-integrals/mass-flow-rate <zone> () no`；`/report/surface-integrals/area-weighted-avg <zone> () pressure no`（尾答 no=不写文件） | M1.5 基线真跑实证 |
| 2026-09-20 | v222(2022R2) | 图像导出 | `/display/save-picture` 可用；但 v222 TUI 无云图创建命令（graphics objects 属 GUI/datamodel 层）→ 走翻译件 ahmed/官方 datamodel 路线 | 探针实证 |
| 2026-09-20 | v222(2022R2) | 默认模型 | 读网格后默认湍流模型为 k-omega（残差表列 k/omega）——模板必须显式设定模型 | 真跑实证 |
| 2026-09-20 | v222(2022R2) | journal 哨兵 | `(display "; STEP-OK x")` 与 `(newline)` 必须分两行；同行第二表达式被当字面文本回显 | 已固化进模板与生成器；解析器正则同时兼容两种行为 |
| 2026-09-20 | v222(2022R2) | 读网格 | 求解器用 `/file/read-case`（`read-mesh` 是 Meshing 模式命令） | 已固化进模板 |
| 2026-09-20 | v222(2022R2) | ke-standard | `/define/models/viscous/ke-standard yes` 有效（无多余 prompt 困扰） | 保留 Production Limiter 应答项 |
| 2026-09-20 | v222(2022R2) | set velocity-inlet | `vmag no <值>`（先答 "Use Profile for Velocity Magnitude? [no]"）；**turb-intensity / turb-viscosity-ratio 无前置问句直接给数值** | 字段间不对称，已参数化到 tui.inlet_field_answers |
| 2026-09-20 | v222(2022R2) | set pressure-outlet | `gauge-pressure no <值>` | tui.outlet_pressure_field / outlet_field_answers |
| 2026-09-20 | v222(2022R2) | report forces | `report/forces/wall-forces no <zone> () 1 0 0 no`：提示序 = all-wall-zones(y/n)→Zone 列表→x/y 分量→Write to File?(y/n→文件名) | 输出为矢量三元组新表，解析器新增格式 C；区域名不得用保留字 `wall`（被自动改名 wall-3） |
| 2026-09-20 | v222(2022R2) | exit | 有未保存改动时 exit 询问 "OK to discard?" → 模板末尾补一行 `y` | 已固化进模板 |
| 2026-09-20 | v222(2022R2) | .msh 格式 | 整数字段全十六进制；面数据语义 (n0,n1,c0,c1)=c0 在 (n0→n1) 左侧（elbow.msh 1300 面统计实证）；(45) 段为 3 字段字符串形式 (id 类型串 名字)；四边形 (12) 段必须带 element-type=3 | 见 tools/make_demo_msh.py 注释 |
| 2026-09-20 | v222(2022R2) | channel 全链路 | ✅ 真跑通过：read→ke→BC→init→iterate→forces→解析→CSV，30 步收敛自动判定 | demo_channel verified=live |
