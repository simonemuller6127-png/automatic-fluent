# 官方示例 → journal 翻译（Q2 交付）

> 调研报告 6.2 的既定动作："官方示例抄物理内容、不抄 API，翻译成 journal 借用"。
> 本文件是**翻译对照表 + 落地状态**。翻译件在 `journals/translations/`。
> 翻译原则：物理设置 1:1 保留；API 调用翻成我们已校准的 journal 语法；
> 未校准的 prompt 链明确标注（首次使用先过探针，见 prompt_calibration.md）。

## 1. external_compressible_flow（pyfluent 官方，跨音速机翼）

来源：`refs/official_examples/external_compressible_flow.py`（ansys/pyfluent main）
翻译件：`journals/translations/external_compressible_flow.jou.templ`
状态：**已翻译**；其中 BC/材料 prompt 链标注"待探针"，其余（网格检查/初始化/迭代）语法与
已验证的 channel 模板同源。

| 官方代码（settings API） | 翻译后 journal / config | 落地状态 |
|---|---|---|
| `viscous.model="k-omega"; k_omega_model="sst"` | `/define/models/viscous/kw-sst yes`（config physics.model="kw-sst"） | ✅ 同族语法已验证（ke-standard 真跑通过） |
| `air.density.option="ideal-gas"` + Sutherland 三系数 | 翻译件内 `/define/materials/change-create ...`（prompt 链长） | ⏳ 翻译完成，待探针定案 |
| `pressure_farfield.gauge_pressure=0; mach_number=0.8395; temperature=255.56; flow_direction=(0.998574,0,0.053382); turbulence 5%/10` | `journal_gen` 新增 **pressure-far-field** BC 类型：`set pressure-far-field <zone> () gauge-pressure/mach/temperature/flow-direction/turb-* ...`（config bc.inlet.type="pressure-far-field"） | ✅ 生成器已落地；prompt 应答序列待探针 |
| `operating_pressure=80600` | `/define/operating-conditions/operating-pressure 80600`（翻译件内） | ⏳ 待探针 |
| `hybrid_initialize()` | 翻译件用 `/solve/initialize/hyb-initialization`（或保持标准初始化） | ⏳ 待探针（标准初始化已验证可用） |
| `iterate(iter_count=25)`（注释：推荐 100） | `/solve/iterate {{n_iter}}`（config） | ✅ 已验证 |
| 官方 docstring：pressure-based coupled + pseudo time stepping；y+ 检查 | methods 段（离散/耦合）+ quality 解析已有 | ✅ 机制在位 |

## 2. ahmed_body_workflow（pyfluent 官方，Watertight 网格工作流）

来源：`refs/official_examples/ahmed_body_workflow.py`
翻译件：`journals/translations/ahmed_body_watertight.jou.templ`
状态：**已翻译**；任务链骨架（InitializeWorkflow/TaskObject/Execute）与本机 8 次探针
验证的 datamodel 语法完全一致——官方示例反向印证了 M3 骨架的正确性。

| 官方代码 | 翻译后 journal | 落地状态 |
|---|---|---|
| `InitializeWorkflow(WorkflowType="Watertight Geometry")` | 同（py-exec） | ✅ 真机验证 |
| `Import Geometry: Arguments=dict(FileName=...)` + Execute | 同（v222 需 CAD 格式，STL 不支持——官方报错实证） | ✅ 骨架验证 / STL 受版本限制 |
| Add Local Sizing：`AddChild="yes", BOIFaceLabelList, BOIGrowthRate=1.15, BOISize` + `InsertCompoundChildTask()` | 翻译件按逐面尺寸控制转写 | ✅ 翻译完成（真跑待 CAD 输入） |
| **BOI 身体**（`boi_1`，BOISize=20） | 翻译件保留；对应本项目 domain_sizing 的尾流加密建议 | ✅ 翻译完成 |
| `CFDSurfaceMeshControls={CurvatureNormalAngle:12, GrowthRate:1.15, MaxSize:50, MinSize:1, SizeFunctions:Curvature}` | 翻译件 + `meshing.render_meshing_journal(min,max,growth)` 参数化 | ✅ |
| `ImproveSurfaceMesh`（FaceQualityLimit=0.4） | 翻译件新增（表面网格质量改进任务） | ✅ 翻译完成 |
| Describe Geometry：`CappingRequired="Yes"`, `SetupType="The geometry consists of only fluid regions with no voids"` | 翻译件按官方字符串转写 | ✅ 翻译完成 |
| Boundary Layers：`smooth-transition_1`，NumberOfLayers=14, Rate=1.15, TransitionRatio=0.5 | 翻译件保留（Q4 粘性主导时的调参对象） | ✅ 翻译完成 |
| `VolumeFill="poly-hexcore"` | 翻译件 + meshing.py | ✅ |
| `session.switch_to_solver()` | `/switch-to-solution-mode`（TUI 已在根菜单实证存在） | ✅ |

## 3. E10 图文教程（项目原生参考）

`configs/case_airplane.json` + `journals/templates/solve_airplane.jou.tmpl` 即 E10 的
翻译件（200 m/s 入口、k-ε+SWF、重力 -9.81z、二阶离散、wall.feiiji 受力、Cd/Cl 参考值），
状态 ✅（结构已验证，飞机网格首跑为校准性质）。

## 4. 翻译方法论（可复用）

1. 官方示例先读"物理内容"（模型/材料/BC/方法/监控），不看 API；
2. API 调用逐条映射到已校准 journal 语法（语法表见 prompt_calibration.md）；
3. 没有校准记录的命令 → 生成带 `@EXPECTED-STEPS` 哨兵的翻译件 + 标注"待探针"；
4. 真机探针定案 → 回填本表 verified 状态（与模板反哺机制同一条流水线）。
