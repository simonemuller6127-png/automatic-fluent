# -*- coding: utf-8 -*-
"""error_kb —— 报错知识库（Q3）：错误模式 → 根因解释 → 具体修复指令 → 验证方法。

条目全部来自本机真机调试史（2026-09-20，Fluent 2022R2/v222），每条都经过实证。
failpack/diagnosis.md 会把命中条目的"修复指令"（含 config 键名）直接写给 LLM/人工。

新增知识：随排错往 KB 里追加条目即可（项目记忆，调研报告 6.9 第 3 层配套）。
"""
from __future__ import annotations

import re

KB: list[dict] = [
    {
        "id": "prompt_yn_mismatch",
        "pattern": r"Please answer y\[es\] or n\[o\]",
        "category": "config",
        "cause": "TUI prompt 应答序列与版本不符：一个 y/n 提示没有拿到可接受的应答，"
                 "把后续所有 journal 行都当应答吃掉（级联错位）。",
        "fix": "用逐行探针定位该命令的真实提示序（skills/aero-fluent/references/"
               "prompt_calibration.md 第 4 节），然后修改 config.tui.* 对应应答表"
               "（如 inlet_field_answers / ke_production_limiter）。不要改模板语法。",
        "verify": "重跑后该步骤 STEP-OK 出现且 transcript 无该报错。",
    },
    {
        "id": "read_mesh_in_solver",
        "pattern": r"invalid command \[read-mesh\]",
        "category": "config",
        "cause": "求解器模式的读网格命令是 /file/read-case；read-mesh 只存在于 "
                 "Meshing 模式（-meshing）。",
        "fix": "模板使用 /file/read-case（本项目 solve 模板已内置，出现此错说明用了旧模板或手写 journal）。",
        "verify": "transcript 出现节点/单元统计行。",
    },
    {
        "id": "faceted_not_supported",
        "pattern": r"Faceted formats, like '\.stl'.{0,40}not yet supported",
        "category": "version_limit",
        "cause": "v222 的 Watertight 工作流导入任务不支持 STL 面片格式（官方限制，"
                 "更新版本已支持）。",
        "fix": "改用 CAD 格式输入：.scdoc（M2 SpaceClaim 产物）/ .x_t / .step / .pmdb；"
               "或升级 Fluent ≥2023R1 后再走 STL。",
        "verify": "Import Geometry 任务 Execute 后 transcript 列出体区域。",
    },
    {
        "id": "msh_node_coords",
        "pattern": r"Unable to read coordinates of node (\d+)",
        "category": "mesh_file",
        "cause": ".msh 整数字段（zone-id/索引/数量/类型码）必须是十六进制；"
                 "出现十进制会被读成大得多的数（如 55 → 0x55=85）。",
        "fix": "检查网格导出器：tools/make_demo_msh.py 已按 hex 输出；外部网格用 "
               "Fluent/GAMBIT 导出而非手写。",
        "verify": "read-case 打印 nodes/cells/faces 统计且数量与预期一致。",
    },
    {
        "id": "no_face_with_given_nodes",
        "pattern": r"no face with given nodes",
        "category": "mesh_file",
        "cause": "面数据的 c0/c1 语义错误。权威约定（elbow.msh 1300 面统计实证）："
                 "c0 是 (n0→n1) 行进方向【左】侧单元，c1 是右侧；边界面 c0=内部单元在左，c1=0。",
        "fix": "修正面节点顺序/归属后重生成网格（参考 tools/make_demo_msh.py）。",
        "verify": "Building... 后无该警告且无 non-positive volume。",
    },
    {
        "id": "non_positive_volume",
        "pattern": r"cells with non-positive volume",
        "category": "mesh",
        "cause": "单元绕向反了（面方向约定错误）或几何自相交。",
        "fix": "先按 no_face_with_given_nodes 条目修面语义；若仍出现，几何破面走 "
               "SpaceClaim Repair 或 Fluent Meshing Fault-Tolerant 工作流（官方 25.4 章）。",
        "verify": "/mesh/check 无负体积；/mesh/quality 最低正交质量 >0.1。",
    },
    {
        "id": "negvol_count_warning",
        "pattern": r"(\d+)\s+cells?\s+with\s+non[- ]positive\s+volume",
        "category": "mesh",
        "cause": "网格含倒置/零体积单元。关键在于 Fluent **不会硬失败**：它对这些单元改用"
                 "另一套离散格式继续算（真实输出原话 'A different numerical scheme will be "
                 "applied to these elements'），所以残差可能照常收敛，但受力积分 Cd/Cl 已不可信。"
                 "注意这行以 WARNING: 开头而非 Error:，此前永远进不了分类器，"
                 "连带把它诱发的 divergence 也误判成纯数值问题。",
        "fix": "别降松弛因子重试（治不了倒置单元）。先跑 "
               "/mesh/repair-improve/report-poor-elements 定位坏单元；"
               "再看 failpack/diagnosis.md「网格诊断」小节里最差单元的 cell/zone/location："
               "① location 贴在壁面 → 尺寸/边界层问题，降 MaxSize 或加边界层；"
               "② 成片落在流体区 → CAD 问题（缝隙/自交），回 SpaceClaim Repair 或走 FTM。",
        "verify": "/mesh/check 不再出现 non-positive volume 警告；"
                  "并且三档网格 GCI₁₂ < 1% 才算网格够（阈值不是网格够的唯一判据）。",
    },
    {
        "id": "read_grid_section_abort",
        "pattern": r"read_grid_section\s*:\s*aborted|unable to read coordinates of node",
        "category": "mesh",
        "cause": "网格文件本身有问题：字段约定不符（.msh 整数字段须十六进制、面 c0/c1 的"
                 "左右单元语义搞反）或文件损坏/被占用。不是求解设置问题。",
        "fix": "用 Fluent/GAMBIT 重新导出网格；若为自研网格生成器，"
               "核对 tools/make_demo_msh.py 的十六进制输出与面方向约定"
               "（c0 = (n0→n1) 行进方向左侧单元，见 no_face_with_given_nodes 条目）。",
        "verify": "read-case 打印的 nodes/cells/faces 数量与预期一致，且无本条报错。",
    },
    {
        "id": "divergence_amg",
        "pattern": r"Divergence detected in AMG solver",
        "category": "divergence",
        "cause": "数值发散：常见于初始化与边界不匹配、松弛过大、网格质量差。",
        "fix": "runner 已自动降松弛重试（retry.divergence.relax_scale，≤2 次）；"
               "仍失败则检查初始化方法（标准/混合）与网格质量（metrics.quality_*）。",
        "verify": "重试后残差单调下降并收敛。",
    },
    {
        "id": "floating_point_exception",
        "pattern": r"floating point exception",
        "category": "divergence",
        "cause": "发散的伴生报错（解算出现非有限值），与 divergence 同源。",
        "fix": "同 divergence_amg。",
        "verify": "同上。",
    },
    {
        "id": "license_busy",
        "pattern": r"(Unable|unable) to (acquire|obtain) license|all licenses are in use",
        "category": "license",
        "cause": "许可证被占满或服务器不可达。",
        "fix": "runner 自动等待重试（retry.license.wait_s，≤2 次）；仍失败检查 "
               "许可证服务器/排队（本机 license=1055@localhost）。",
        "verify": "重试成功或人工释放许可证后重跑。",
    },
    {
        "id": "eof_mid_prompt",
        "pattern": r"Halting due to end of file on input",
        "category": "config",
        "cause": "journal 应答耗尽后有未关闭的 prompt（stdin=DEVNULL 下立即 EOF）。"
                 "本机已配置为快速失败设计，用于暴露应答缺口。",
        "fix": "看 transcript 中最后一个未应答的提示行，按 prompt_yn_mismatch 条目补应答；"
               "若发生在结尾：模板已内置 exit 后补 y（放弃未保存确认），检查是否被前序错误跳过。",
        "verify": "result.ok 握手文件生成 + ; DONE 标记。",
    },
    {
        "id": "reserved_zone_name",
        "pattern": r"Invalid wall zone|zone.*renamed",
        "category": "mesh_file",
        "cause": "区域名撞了 Fluent 保留字（如 wall/inlet/outlet 的类型词）会被自动改名"
                 "（wall → wall-3），TUI 引用旧名报 Invalid zone。",
        "fix": "配置里的区域名改成 meshing 实际注册名（read-case 后 transcript 的 zone 列表为准）。",
        "verify": "BC 命令行不再报 Invalid zone。",
    },
    {
        "id": "error_object_hash_f",
        "pattern": r"Error Object: #f",
        "category": "context",
        "cause": "通用 Scheme 错误对象，本身不含原因；真实原因在其上方几行。",
        "fix": "看 failpack transcript_tail 中该行之前的最后一个 Error/提示行，"
               "按对应条目处置；哨兵归属（step 字段）已定位到失败步骤。",
        "verify": "对应步骤 STEP-OK 恢复。",
    },
    {
        "id": "reversed_flow",
        "pattern": r"reversed flow|reverse flow at",
        "category": "physics",
        "cause": "出口出现回流：下游域太短或出口离回流区太近（外流场常见）。",
        "fix": "加大下游长度（domain_sizing downstream ×1.5）并在出口设置真实 "
               "backflow 湍流强度/粘度比。runner 已在 metrics.backflow_suggestion 提示。",
        "verify": "transcript 无 reversed flow 告警。",
    },
    {
        "id": "import_geometry_argname",
        "pattern": r"Failed to update task .Import Geometry.*(not provided|File Name)",
        "category": "config",
        "cause": "v222 的 Import Geometry 任务参数名是 'FileName'（无空格），且不接独立的 "
                 "'Length Unit' 参数。传成 'File Name'/'Length Unit' 报参数未提供。",
        "fix": "模板用 Arguments=dict(**{'FileName': r'<cad路径>'})（本仓库 meshing.py 已修）；"
               "单位由 CAD 自身声明决定（v222 能识别 STEP 的 MILLI+METRE）。",
        "verify": "Import Geometry Execute 后 transcript 出现 faces/nodes 统计。",
    },
    {
        "id": "cad_file_readonly_notfound",
        "pattern": r"File \".+\.(?:step|stp|scdoc|x_t|pmdb)\" not found",
        "category": "config",
        "cause": "CAD 文件带只读属性（微信/邮件下载常见）时，Fluent 的 CAD 内核无法以"
                 "读写方式打开，报错伪装成'文件不存在'，极具误导性。",
        "fix": "导入前去掉只读：chmod u+w <文件>（Windows: attrib -R <文件>）。"
               "meshing.run_watertight 已自动 chmod；直接手写 journal 时需自行处理。",
        "verify": "重跑后 STEP-OK import_geometry 出现且 transcript 有 faces 统计。",
    },
    {
        "id": "size_functions_illegal_value",
        "pattern": r"Argument Name:\s*Size Functions",
        "category": "config",
        "cause": "v222 的 Size Functions 合法值只有 Curvature / Proximity / "
                 "Curvature & Proximity——**没有 Basic**。传 Basic 会被参数校验拒绝。",
        "fix": "改用合法值；性能靠调 MinSize/MaxSize/GrowthRate，不是换尺寸函数。",
        "verify": "Generate the Surface Mesh 步骤出现 STEP-OK。",
    },
    {
        "id": "tgrid_oom_stale_process",
        "pattern": r"Out of Memory|CADToTGridConverter FAILED",
        "category": "resource",
        "cause": "【2026-09-24 根因更正】**主因是单位错配，不是内存不足**。v222 watertight "
                 "的会话长度单位跟随导入 CAD 的声明单位（我们的域由 OCCT 导出=MM），"
                 "若把 config 里的米（0.02）原样写进 journal，会被当成 0.02mm，曲率细分"
                 "小 1000 倍，尺寸场构建要 150s+.sf 涨到 1.43GB，表现为 Out of Memory / "
                 "8GB 常驻 / 20 分钟不完成——同一 bug 的三种表现。"
                 "次因：异常退出留孤儿 CADReaders.py 进程（单次干净运行仅占 0.9~1.5GB，"
                 "但多次实验叠加可达 10GB）。",
        "fix": "① config 保持米（size_unit='m'），由 meshing.render_meshing_journal 的 _s() "
               "统一 ×1000 转 mm（已修）；OCCT 不支持导出米制 STEP，write.step.unit='M' "
               "会静默回落 MM。② 跑网格前 kill_stale_meshing()（已修，按 python*+CADReaders.py "
               "双特征匹配，勿只按字符串）。",
        "verify": "run_watertight 返回 unit_ok=True 且 session_unit='mm'；"
                  "实测同几何 20 分钟 -> 17.9 秒。",
    },
    {
        "id": "meshing_unit_mismatch",
        "pattern": r"length unit = \[|Size field|faceting|\.sf\b",
        "category": "config",
        "cause": "journal 里的尺寸与 CAD 声明单位不一致（本项目最易踩：config 用米，"
                 "v222 会话按 CAD 单位的毫米解释）。差 1000 倍 = 曲率细分爆炸。",
        "fix": "统一走 render_meshing_journal(size_unit='m') 的换算；run_watertight 会"
               "核对 CAD 头 SI_UNIT 并返回 unit_ok/session_unit，不符立即失败。",
        "verify": "transcript 出现 Global Min size 被调整为预期毫米值；网格分钟级完成。",
    },
    {
        "id": "surface_mesh_free_faces",
        "pattern": r"Free faces still exists|surface meshing was not successful",
        "category": "mesh",
        "cause": "表面网格在某面上失败。两种根因：① min_size 相对最小面过小（真机："
                 "飞机最小面 span 80mm，min=50mm 触发，relax 到 100mm 即消失）；"
                 "② 几何确有共面重叠（随后会报 Found overlapping faces sharing edge）。"
                 "注意：此时任务 getState() 可能不是 Out-of-date，assert 硬哨兵拦不住、"
                 "STEP-OK 照打 → 必须靠本条的模式匹配兜底判失败。",
        "fix": "阶梯处置：先放宽 min_size（几何审计已证无碎片面时首选）；仍不行则"
               "geom_cadquery.heal_and_audit 的 UnifySameDomain/ShapeFix；再不行按官方"
               "提示『Import the CAD outside the workflow and use Diagnostics』定位具体面。",
        "verify": "missing_steps 含 surface_mesh 且 transcript 无该模式串。",
    },
    {
        "id": "msh_h5_output",
        "pattern": r"write-mesh|\.msh\.h5",
        "category": "config",
        "cause": "v222 的 /file/write-mesh x.msh 实际写出 **x.msh.h5**（HDF5 格式），"
                 "按 x.msh 判存在会误报失败。",
        "fix": "用 meshing._mesh_outputs() 同时匹配 x.msh / x.msh.h5（已修）。",
        "verify": "run_watertight 返回 out_mesh 指向实际存在的路径。",
    },
]


def lookup(lines: list[str]) -> list[dict]:
    """对候选行做知识库匹配，返回全部命中条目（含证据行）。"""
    hits = []
    for entry in KB:
        for line in lines:
            if re.search(entry["pattern"], line, re.IGNORECASE):
                hit = dict(entry)
                hit["evidence_line"] = line.strip()[:300]
                hits.append(hit)
                break
    return hits
