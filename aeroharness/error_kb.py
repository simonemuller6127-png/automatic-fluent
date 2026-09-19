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
