# 外流场计算域、回流、网格加密与破面预防 —— 官方/权威依据与本项目实现

> 对应调研问题：不同部件需要的内外流场长宽不一样、气流要留足通道、出口不能回流、
> 网格加密、破面预防。本文档给出**可核查的依据来源**与本项目对应的落地实现。

## 1. 计算域尺寸（留足气流通道）

### 依据
| 依据 | 来源 | 要点 |
|---|---|---|
| 堵塞比 ≤3%（钝体/风工程） | Abu-Zidan et al. 2021 综述（ScienceDirect，125+ 引用）：多篇推荐风荷载预测最大 3% | 堵塞比 = 迎风投影面积 / 域入口截面积 |
| 地面车辆可放宽 5~10% + 修正 | MDPI 2020（风洞堵塞效应，移动地面车辆） | 带修正时可接受更高堵塞 |
| 域边界不可太近，需做域无关性验证 | CADFEM 2024《How Small is Too Small?》 | 用两次不同域尺寸对比定量验证 |
| 出口应远离障碍/回流区 5~10 倍特征直径，置于流动充分发展处 | Fluent User's Guide（Pressure Outlet 章节）+ GaugeHow 边界条件实践汇总 | 回流首要对策 |
| Ansys 官方最佳实践（几何/网格/求解/后处理全链） | Ansys《Best Practices for A&D External Aerodynamics》官方网络研讨会 | 面向航空航天外气动 |
| 教程自身数据点 | E10 飞机域 X≈12.8m / Y≈13.2m / Z≈6.7m（机长量级几米） | 教学取值偏紧，正式计算建议按本文规则放大 |

### 本项目实现：`aeroharness/domain_sizing.py`
- `recommend_domain(L, W, H, kind)`：按部件类型（vehicle / aircraft / bluff_body）输出
  域原点与三向尺寸，默认规则：上游 2~3×L、**下游 4~8×L**、侧向 2~3×W（每侧）、
  顶/底 2~3×H；地面车底面贴地（留 0.2H 垫层）。
- **堵塞比自动扩域**：迎风面积/入口截面 > 限值（钝体 3%、车辆 5%）时自动放大侧向/顶部。
- M2 几何步骤（`geometry.py`）以 `geometry.auto_domain + body_bbox` 调用本模块，
  SpaceClaim 域盒尺寸即由此计算——**"每个部件不一样"由参数化解决，不需要手改几何**。

## 2. 出口回流（不能让气流回流）

### 依据
- Fluent User's Guide（Pressure Outlet）：回流不可避免时使用该处的 backflow 条件
  （回流湍流强度/粘度比等），应设置真实值；
- Ansys Innovation Space 官方社区《Back flow / reverse flow / prevent reverse flow in
  Fluent》：回流来源与处置（2020）；
- 社区共识（CFD Online 多帖）：**加大下游长度**是第一对策；outflow BC 仅适用于
  出口完全无回流且压力未知的场景（非外流场首选）。

### 本项目实现
- 域规则已内建保守下游长度（aircraft 4×L、bluff 8×L）；
- **运行时闭环**：`transcript_parser` 统计 `reversed flow` 告警数 →
  `metrics.reversed_flow_warnings` → `metrics.backflow_suggestion`
  （"加大 downstream ×1.5 + 设置真实 backflow 湍流量"），真跑时自动出现在 summary 里。

## 3. 网格加密

### 依据
- Ansys Innovation Space 官方课程视频《Meshing Using the Fluent Mesher for the
  Aerodynamic [Car]》：演示 **Body of Influence（BOI）、proximity、curvature、face
  sizing** 四种局部加密手段；
- BOI 注意事项（CFDLand watertight 教程汇总）：BOI 必须是封闭几何体，用
  "Repair Body of Influence" 校验；
- Ansys 官方 webinar《Best Practices for A&D External Aerodynamics》：外气动网格
  （边界层 + 尾流加密）与求解设置的整体最佳实践。

### 本项目实现
- 尾流加密参数进入 M3 模板生成器：`meshing.render_meshing_journal(min_size, max_size,
  growth_rate)`（表面网格曲率+近距尺寸函数 + 体网格 poly-hexcore）；
- **尾流 BOI 参数槽**：`configs` 的 `mesh.boi` 段（预留），与域尺寸计算器联动
  （BOI 盒 = 部件后方 downstream×0.5 范围内）；
- 求解侧加密验证：`run.reference` 换算的 y+ 监控与网格无关性对比（optimize 两级预算
  天然支持"粗筛→精修"的网格无关性流程）。

## 4. 破面（几何缺陷）预防

### 依据
- **Fluent Meshing User's Guide 第 25.4 章《Fault-Tolerant Meshing Workflow》**
  （ansyshelp.ansys.com，官方）：Watertight 工作流默认假设"干净、封闭"几何；
  脏几何（泄漏/孔洞/自相交）走 **Fault-Tolerant（FTM）工作流**——包裹、泄漏检测、
  人工修复工具链；
- CADFEM 2024 / KETIV / SimuTech 三家官方合作伙伴文档一致结论：
  **WTM=干净 CAD，FTM=脏 CAD**；
- Ansys 官方视频《How to Mesh Dirty CAD Using Fluent Meshing》（Ansys Learning
  YouTube 频道）。

### 本项目实现（分层防线）
1. **预防**（M2）：SpaceClaim 导入 CAD 时先做修复检查（gap/intersect）——脚本
   `import_cad` 路径预留 Repair 工具调用（录制宏后校准）；
2. **检测**（6.8.4）：几何产物自证 manifest（named selections 齐全性）+ 返回码 +
   文件存在性，坏几何在几何步骤即被拦截，不流入网格；
3. **容错**（M3）：v222 实测确认 WTM 导入不支持 STL（官方报错），CAD 输入须
   .scdoc/.x_t/.step；真正脏几何走 FTM 工作流（模板 `mesh_watertight` 的姊妹骨架，
   按官方 25.4 章任务链预留）；
4. **诊断**（6.9）：网格类失败自动分类（negative volume 等）→ failpack 诊断包。

## 来源清单（本次核查）
- Abu-Zidan et al., *Optimising the computational domain size in CFD*, ScienceDirect 2021
- CADFEM, *How Small is Too Small? Optimal CFD Domain*, 2024
- MDPI, *Wind tunnel blockage effects on vehicle aerodynamics*, 2020
- Ansys Innovation Space: Back flow / reverse flow / prevent reverse flow in Fluent（2020）；
  How to setup watertight meshing via text commands（2023）；
  Meshing Using the Fluent Mesher for the Aerodynamic Car；Body Of Influence in Ansys Discovery
- Ansys Help: Fluent Meshing User's Guide Ch.25.4 Fault-Tolerant Meshing Workflow（ansyshelp.ansys.com）
- Ansys 官方 webinar: Best Practices for A&D External Aerodynamics
- SimuTech Group / KETIV / CADFEM：WTM vs FTM 工作流对比
- CFDLand: The Complete Watertight Workflow（BOI 修复注意事项）
