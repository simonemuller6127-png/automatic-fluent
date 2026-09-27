#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Build a standalone offline HTML wiki for the Ansys force-analysis guides.

The Markdown files intentionally keep formulas in portable ``text`` blocks.
For the HTML build, known formula blocks are converted back to LaTeX and
rendered by the KaTeX bundled with Markdown Preview Enhanced. Images and
KaTeX assets are embedded, so the resulting HTML does not need a server or CDN.
"""
from __future__ import annotations

import re
import shutil
from html.parser import HTMLParser
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
OUTPUT = DOCS / "ansys_force_analysis_guide.html"
SOURCES = [
    DOCS / "ansys_fluent_force_analysis_tutorial_zh.md",
    DOCS / "ansys_mechanical_static_tower_analysis_tutorial_zh.md",
]

FORMULAS: dict[str, str] = {
    "F_total = F_pressure + F_viscous": r"\mathbf F_{\mathrm{total}}=\mathbf F_{\mathrm{pressure}}+\mathbf F_{\mathrm{viscous}}",
    "e_D = (cos α, sin α, 0)": r"\hat{\mathbf e}_D=(\cos\alpha,\sin\alpha,0)",
    "e_L = (-sin α, cos α, 0)": r"\hat{\mathbf e}_L=(-\sin\alpha,\cos\alpha,0)",
    "q∞ = (1/2) · ρ∞ · U∞²": r"q_\infty=\frac{1}{2}\rho_\infty U_\infty^2",
    "C_D = F_D / (q∞ · A_ref)": r"C_D=\frac{F_D}{q_\infty A_{\mathrm{ref}}}",
    "C_L = F_L / (q∞ · A_ref)": r"C_L=\frac{F_L}{q_\infty A_{\mathrm{ref}}}",
    "C_M = M / (q∞ · A_ref · L_ref)": r"C_M=\frac{M}{q_\infty A_{\mathrm{ref}}L_{\mathrm{ref}}}",
    "A_ref = D × Depth": r"A_{\mathrm{ref}}=D\times\mathrm{Depth}",
    "M_z = ∫_wall [(x - x_c)·dF_y - (y - y_c)·dF_x] dA": r"M_z=\int_{\mathrm{wall}}\left[(x-x_c)dF_y-(y-y_c)dF_x\right]dA",
    "Re_D = (1 × 1 × 1) / 0.01 = 100": r"\mathrm{Re}_D=\frac{1\times1\times1}{0.01}=100",
    "F_x,pressure + F_x,viscous = F_x,total": r"F_{x,p}+F_{x,v}=F_{x,t}",
    "F_y,pressure + F_y,viscous = F_y,total": r"F_{y,p}+F_{y,v}=F_{y,t}",
    "mass_imbalance = abs(m_dot_in - m_dot_out)\n                / max(abs(m_dot_in), abs(m_dot_out))": r"\epsilon_m=\frac{|\dot m_{\mathrm{in}}-\dot m_{\mathrm{out}}|}{\max(|\dot m_{\mathrm{in}}|,|\dot m_{\mathrm{out}}|)}",
    "K(u) · u = f": r"\mathbf K(\mathbf u)\mathbf u=\mathbf f",
    "σ = C : ε": r"\boldsymbol{\sigma}=\mathbf C:\boldsymbol{\varepsilon}",
    "∇ · σ + b = 0": r"\nabla\cdot\boldsymbol{\sigma}+\mathbf b=\mathbf 0",
    "p_i = q(z_i) · Cp_i": r"p_i=q(z_i)\,C_{p,i}",
    "F_i = ∫_Ai [(-p_i) · n_i] dA": r"\mathbf F_i=\int_{A_i}-p_i\,\mathbf n_i\,dA",
    "ΣF_x = 0,   ΣF_z = 0,   ΣM = 0": r"\sum F_x=0,\qquad \sum F_z=0,\qquad \sum M=0",
    "(r_i - r_B) × F_i": r"(\mathbf r_i-\mathbf r_B)\times\mathbf F_i",
    "H_B = P": r"H_B=P",
    "V_B = W + qH": r"V_B=W+qH",
    "M_B = P·H + (q·H²)/2 + M_j": r"M_B=PH+\frac{qH^2}{2}+M_j",
    "e = M_B / V_B": r"e=\frac{M_B}{V_B}",
    "V_B = 40 + 2×30 = 100 kN": r"V_B=40+2\times30=100\ \mathrm{kN}",
    "H_B = 10 kN": r"H_B=10\ \mathrm{kN}",
    "M_B = 10×30 + (2×30²)/2 + 20\n    = 1220 kN·m": r"M_B=10\times30+\frac{2\times30^2}{2}+20=1220\ \mathrm{kN\cdot m}",
    "e = 1220 / 100 = 12.2 m": r"e=1220/100=12.2\ \mathrm{m}",
    "σ_max ≈ N/A ± M/W": r"\sigma_{\max}\approx\frac{N}{A}\pm\frac{M}{W}",
    "A = πD²/4\nI = πD⁴/64\nW = I/(D/2)": r"A=\frac{\pi D^2}{4},\qquad I=\frac{\pi D^4}{64},\qquad W=\frac{I}{D/2}",
    "N_cr = π²·E·I / (K·L)²": r"N_{cr}=\frac{\pi^2EI}{(KL)^2}",
    "10×30 + 60×15 + 20 = 1220 kN·m": r"10\times30+60\times15+20=1220\ \mathrm{kN\cdot m}",
}

TEXT_BLOCK = re.compile(r"```text\n(.*?)\n```", re.DOTALL)


def find_crossnote() -> tuple[Path, Path]:
    extension_root = Path.home() / ".vscode" / "extensions"
    candidates = sorted(
        extension_root.glob("shd101wyy.markdown-preview-enhanced-*/out/native/crossnote-serve.js"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    if not candidates:
        raise FileNotFoundError(
            "未找到 Markdown Preview Enhanced。请安装 shd101wyy.markdown-preview-enhanced。"
        )
    cli = candidates[0]
    extension_dir = cli.parents[2]
    build_dir = extension_dir / "crossnote"
    if not (build_dir / "server-app" / "server-app.js").exists():
        raise FileNotFoundError(f"Crossnote 构建目录不完整：{build_dir}")
    return cli, build_dir


def restore_math(markdown: str) -> tuple[str, int]:
    count = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal count
        plain = match.group(1)
        latex = FORMULAS.get(plain)
        if latex is None:
            return match.group(0)
        count += 1
        return f"$$\n{latex}\n$$"

    return TEXT_BLOCK.sub(replace, markdown), count


class _BodyHtmlParser(HTMLParser):
    """Read the pre-rendered Markdown body from a Crossnote note document."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.body_html: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "body":
            values = dict(attrs)
            self.body_html = values.get("data-html")


def _load_wiki(path: Path) -> dict:
    source = path.read_text(encoding="utf-8", errors="ignore")
    marker = "window.__CROSSNOTE_WIKI__ = "
    start = source.index(marker) + len(marker)
    end = source.index(";</script>", start)
    import json

    return json.loads(source[start:end])


def _rendered_body(note_html: str) -> str:
    parser = _BodyHtmlParser()
    parser.feed(note_html)
    if parser.body_html is None:
        raise ValueError("Crossnote note does not contain body[data-html]")
    return (
        parser.body_html.replace(
            'href="ansys_fluent_force_analysis_tutorial_zh.md"', 'href="#fluent-guide"'
        ).replace(
            'href="ansys_mechanical_static_tower_analysis_tutorial_zh.md"',
            'href="#mechanical-guide"',
        )
    )


def write_combined_html(wiki_path: Path, output_path: Path) -> None:
    wiki = _load_wiki(wiki_path)
    files = {item["path"]: item for item in wiki["files"]}
    fluent = _rendered_body(files["ansys_fluent_force_analysis_tutorial_zh.md"]["html"])
    mechanical = _rendered_body(files["ansys_mechanical_static_tower_analysis_tutorial_zh.md"]["html"])

    katex_candidates = [
        value for value in wiki["assets"].values()
        if isinstance(value, str) and ".katex-display" in value
    ]
    if not katex_candidates:
        raise ValueError("No embedded KaTeX stylesheet found in Crossnote output")
    katex_css = min(katex_candidates, key=len)

    custom_css = r"""
:root {
  color-scheme: light;
  --ink: #172b3a;
  --muted: #5f7280;
  --line: #d9e3ea;
  --panel: #f4f8fb;
  --accent: #0b67a3;
  --accent-dark: #06466f;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  color: var(--ink);
  background: #eef3f7;
  font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  line-height: 1.72;
}
.topbar {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 10px max(18px, calc((100vw - 1180px) / 2));
  background: rgba(255,255,255,.96);
  border-bottom: 1px solid var(--line);
  box-shadow: 0 2px 12px rgba(16,42,67,.08);
  backdrop-filter: blur(8px);
}
.topbar strong { margin-right: auto; color: var(--accent-dark); }
.topbar a { color: var(--accent); text-decoration: none; font-weight: 600; }
.topbar a:hover { text-decoration: underline; }
.page { max-width: 1180px; margin: 24px auto 70px; padding: 0 24px; }
.guide {
  margin-bottom: 36px;
  padding: 42px 52px;
  background: white;
  border: 1px solid var(--line);
  border-radius: 18px;
  box-shadow: 0 8px 30px rgba(16,42,67,.08);
  overflow-wrap: anywhere;
}
.guide > h1:first-child { margin-top: 0; font-size: 2rem; line-height: 1.25; }
h1, h2, h3, h4 { color: #123852; line-height: 1.32; }
h1 { border-bottom: 3px solid #64a6d2; padding-bottom: 14px; }
h2 { margin-top: 2.4em; border-left: 5px solid #2b83ba; padding-left: 12px; }
h3 { margin-top: 1.8em; }
a { color: #086fa8; }
blockquote {
  margin: 18px 0;
  padding: 14px 18px;
  background: var(--panel);
  border-left: 4px solid #3c8dc4;
  color: #334e60;
}
table {
  display: block;
  width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
  margin: 18px 0;
  font-size: .94rem;
}
th, td { border: 1px solid var(--line); padding: 9px 12px; vertical-align: top; }
th { background: #e8f2f8; color: #173f58; }
tr:nth-child(even) td { background: #f8fbfd; }
img {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 18px auto;
  border: 1px solid #d8e0e6;
  border-radius: 8px;
  background: white;
}
code {
  padding: .12em .35em;
  border-radius: 4px;
  background: #edf2f5;
  color: #9b2c2c;
  font-family: Consolas, "Cascadia Mono", monospace;
}
pre {
  overflow-x: auto;
  padding: 15px 18px;
  border-radius: 8px;
  background: #17232d;
  color: #e7edf2;
  line-height: 1.5;
}
pre code { padding: 0; background: transparent; color: inherit; }
.katex-display { overflow-x: auto; overflow-y: hidden; padding: 5px 0; }
.checklist { list-style: none; padding-left: 0; }
.checklist li { margin: 6px 0; }
.footer { text-align: center; color: var(--muted); font-size: .9rem; }
@media (max-width: 760px) {
  .topbar { flex-wrap: wrap; gap: 8px 14px; }
  .topbar strong { width: 100%; }
  .page { padding: 0 10px; }
  .guide { padding: 26px 18px; border-radius: 10px; }
  th, td { padding: 7px 8px; }
}
@media print {
  body { background: white; }
  .topbar { display: none; }
  .page { max-width: none; margin: 0; padding: 0; }
  .guide { border: 0; box-shadow: none; padding: 0; break-before: page; }
}
"""
    document = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ansys Fluent 与 Mechanical 受力分析学习手册</title>
<style>{katex_css}</style>
<style>{custom_css}</style>
</head>
<body>
<nav class="topbar">
  <strong>Ansys 受力分析离线手册</strong>
  <a href="#fluent-guide">Fluent 教程</a>
  <a href="#mechanical-guide">Mechanical / 吊塔教程</a>
  <a href="ansys_fluent_force_analysis_tutorial_zh.md">Markdown 源文件</a>
</nav>
<main class="page">
  <section class="guide" id="fluent-guide">{fluent}</section>
  <section class="guide" id="mechanical-guide">{mechanical}</section>
  <p class="footer">图片与 KaTeX 公式均由本地工具预渲染并嵌入，本文件可离线打开。</p>
</main>
</body>
</html>
"""
    output_path.write_text(document, encoding="utf-8", newline="\n")


def main() -> None:
    node = shutil.which("node")
    if not node:
        raise FileNotFoundError("未找到 Node.js。")
    cli, build_dir = find_crossnote()
    total_formulas = 0

    with tempfile.TemporaryDirectory(prefix="ansys-force-html-") as tmp_name:
        tmp = Path(tmp_name)
        for source in SOURCES:
            if not source.exists():
                raise FileNotFoundError(source)
            markdown, count = restore_math(source.read_text(encoding="utf-8"))
            (tmp / source.name).write_text(markdown, encoding="utf-8", newline="\n")
            total_formulas += count

        shutil.copytree(
            DOCS / "figures",
            tmp / "figures",
            ignore=shutil.ignore_patterns("*.md"),
        )
        index = """# Ansys Fluent 与 Mechanical 受力分析学习手册

本离线 HTML 由本地 Markdown Preview Enhanced / KaTeX 构建，图片和公式均已嵌入。

- [Fluent 流体受力分析](ansys_fluent_force_analysis_tutorial_zh.md)
- [Mechanical 静力与吊塔分析](ansys_mechanical_static_tower_analysis_tutorial_zh.md)

> HTML 可直接双击打开，不依赖 VS Code Markdown 插件、CDN 或本地服务器。
"""
        (tmp / "index.md").write_text(index, encoding="utf-8", newline="\n")

        wiki_output = tmp / "crossnote-wiki.html"
        command = [
            node,
            str(cli),
            "build-wiki",
            str(tmp),
            "--vscode",
            "--build-dir",
            str(build_dir),
            "-o",
            str(wiki_output),
        ]
        subprocess.run(command, check=True)
        write_combined_html(wiki_output, OUTPUT)

    size_mb = OUTPUT.stat().st_size / 1024 / 1024
    print(f"HTML: {OUTPUT}")
    print(f"KaTeX formulas: {total_formulas}")
    print(f"Size: {size_mb:.2f} MiB")


if __name__ == "__main__":
    main()
