# automatic_fluent — Fluent Automated Tuning Harness (aeroharness)

[简体中文](README.md) | English

> Implementation of the v2 plan (Section 6) from our AI-simulation-tuning research report:
> **journal-first route + layered fallback + the 6.9 enhanced error-feedback protocol**.
> The demo case mirrors tutorial E10 *Fluent 2023 External Flow* (aircraft at 200 m/s,
> Cd≈0.0386 / Cl≈-0.0393).
> **Status: verified end-to-end on a real Fluent 2022 R2 (v222)** (read mesh → models →
> boundary conditions → initialization → iterate → force report → parsing), 43/43 offline
> self-tests passing.

---

## Install into your agent (Codex / zcode / Claude Code / Cline / DSH)

See [integrations/README.md](integrations/README.md): this repo *is* a Claude Code plugin
marketplace (one `marketplace add` command), registers as a Codex MCP server in one
command, and drops straight into the zcode/DSH skills directory.

## Quick start

```bash
git clone https://github.com/simonemuller6127-png/automatic-fluent.git
cd automatic-fluent

python run_pipeline.py doctor        # 1) self-check: discover fluent.exe / render templates / mock smoke
python tools/selftest.py             # 2) offline full-pipeline self-test (failure injection + retry + optimizer), 43 checks
python run_pipeline.py run --config configs/demo_channel.json            # 3) single mock run
python run_pipeline.py optimize --config configs/demo_channel.json --trials 16   # 4) mock tuning loop
python run_pipeline.py pipeline --config configs/demo_channel.json        # 5) M7 one-shot pipeline (geometry→mesh→solve)
python tools/baseline_check.py       # 6) M1.5 baseline on real Fluent (mass conservation + analytic pressure drop)
python tools/degradation_drill.py    # 7) M7 degradation-ladder drill (L3→L2→L1→L0), 5 checks
```

Zero hard dependencies (pure standard library runs everything). Optional extras:
`pip install -r requirements.txt` (optuna TPE engine / yaml / mcp).

## Real Fluent run (verified)

```bash
# 2D channel on real Fluent (verified on this machine, ~1 min; use ^ for line continuation on Windows)
python run_pipeline.py run --config configs/demo_channel.json --real ^
  --set case.mesh_file=meshes/channel2d.msh --set case.dim=2d ^
  --set fluent.parallel=1 --set run.n_iter=100 ^
  --set bc.inlet.set_type=true --set bc.outlet.set_type=true
```

Outputs `fx/fy (forces), cd/cl (coefficients), residuals, converged flag` into
`runs/demo_channel/<timestamp>_single-a1/` (summary.json / results.csv / transcript.log /
journal.jou).

### Aircraft case (case_airplane.json) first-run checklist

1. Point `case.mesh_file` at your aircraft mesh from E10 (.msh/.cas.h5 both work) and
   confirm zone names `inlet / outlet / wall.feiiji` match;
2. `run.n_iter=500` and `fluent.parallel=10` (half of CPU threads, per E10) are preset;
3. Reference targets are preset from E10 page 53 (Cd=0.038623359 / Cl=-0.039298652);
   set your A1 reference area via `run.reference.area`;
4. `methods.*` (second-order schemes, relaxation) and `physics.gravity=[0,0,-9.81]` are
   preset per E10, but the **first real run is a calibration run**: if any step errors,
   follow `skills/aero-fluent/references/prompt_calibration.md` (the failpack names the
   exact line);
5. Then run `optimize --real` (two-level optuna budget: coarse screening at 25%
   iterations + top-k full-fidelity refinement).

## Architecture (three layers, research report 6.1)

```
L3 integration   tools/mcp_server.py (stdio MCP: aero_doctor/aero_run/aero_optimize/aero_pipeline/aero_results)
                 + skills/aero-fluent (process skill: fill params, never write syntax
                   + error knowledge base + decision tables + human gates)
                    ↑ natural language from any agent (VSCode/Codex/zcode/Claude Code/Cline/DSH)
L2 automation    run_pipeline.py CLI (doctor/run/optimize/pipeline/journal/inspect)
                 + aeroharness/{runner, optimize, post, journal_gen, transcript_parser,
                   error_rules, error_kb, feedback, domain_sizing, geometry, meshing,
                   fluent_slot, adapters}
                    ↓
L0 foundation    journals/templates/*.jou.tmpl (templates + {{placeholders}} + sentinels)
                 + configs/*.json (parameter tables) + tools/mock_fluent.py (offline simulator)
                 + tools/make_demo_msh.py (2D verification mesh generator)
```

Degradation ladder (6.0): L3 MCP down → run the L2 CLI directly → `journal` subcommand
emits the script for manual `fluent.exe -i journal.jou` (L1) → Fluent GUI by hand
(L0, TUI recordings feed back into the template library).

## 6.9 enhanced error-feedback protocol (fully implemented)

| Layer | Implementation |
|---|---|
| ① Sentinels | `(display "; STEP-OK x")` markers in the journal; `@EXPECTED-STEPS` declares expectations; error lines auto-attribute to the "first unfinished step" |
| ② Handshake | journal writes `result.ok` at the end; timeout/crash = missing handshake = explicit failure (decoupled from exit codes) |
| ③ Classifier + knowledge base | transcript tail → `{step, category, evidence, auto_retryable, suggestion}`; rules in `error_rules.py`; **`error_kb.py` holds 13 field-debugged entries** (root cause + concrete fix + verification) |
| ④ Failure pack | `runs/<case>/<run>/failpack/diagnosis.md`: failed step + sentinel table + KB hits + last 200 transcript lines + decision table |
| ⑤ Tiered retry | divergence (relaxation ×0.85, ≤2 tries) / license (wait + retry) / mesh & crash_timeout (plain retry); config errors are never auto-retried, they come back with a diagnosis |

## Tuning loop and post-processing feedback (6.6 + Q4)

`optimize.py`: optuna TPE two-level budget (coarse screening at 25% iterations → top-k
full-fidelity refinement, duplicate params deduplicated, never re-run) + a built-in
zero-dependency pattern-search fallback engine; execution goes through the runner (with
6.9 retries); outputs `trials.csv / best.json / report.md`. Objective `coefficient_match`
(weighted relative error; the demo aligns with E10's Cd/Cl).

**Feedback loop** (verified on real runs): drag decomposition (pressure/viscous split →
wake refinement vs y+ tuning direction), residual history CSV, reversed-flow detection →
`tuning_hints` in `summary.json` automatically propose the next round of parameter moves.

### Joint mesh-count × solve-time optimization (demo_meshtime)

Mesh density is itself an optimization dimension: `optimize.mesh_params` samples mesh
parameters (e.g. NX) and **regenerates the mesh per trial** before solving; the objective
adds a mesh cost term `λ·max(0, ln(cells/ref_cells))` (cell count ∝ solve time). The
accuracy term pushes the mesh toward "accurate", the cost term toward "cheap" — the
optimum is their marginal balance: the classic mesh-convergence/cost tradeoff, automated.

```bash
python run_pipeline.py optimize --config configs/demo_meshtime.json --trials 16
```

Measured (mock, seed=7): theoretical balance NX≈27 (λ=0.03, discretization error ~0.5/NX);
the optimizer converged to **NX=25 (100 cells)** instead of the 240-cell search maximum;
`trials.csv` carries `cells / mesh_cost / accuracy` audit columns.

## Field-calibration findings (2026-09-20, Fluent 2022 R2 / v222)

Full log in `skills/aero-fluent/references/prompt_calibration.md` (Section 5). Highlights:

- Journal sentinels need `display` and `newline` on **two separate lines**; solver meshes
  are read with `read-case` (read-mesh belongs to Meshing mode);
- `set velocity-inlet` answer sequences are **asymmetric** (vmag has a "Use Profile?"
  pre-prompt, turbulence fields do not); **laminar selection also needs `yes`**;
- `report forces` has a new prompt order and vector-triple output table (parser format C);
- `surface-integrals` (mass-flow-rate / area-weighted-avg pressure) sequences calibrated
  (used by the M1.5 baseline);
- **All integer fields in .msh are hexadecimal**; face data means c0 = cell on the LEFT
  of (n0→n1) (verified statistically against 1,300 faces of a real mesh); zone name
  `wall` is reserved and gets renamed `wall-3`; answer `y` to the discard prompt at exit;
- **Meshing mode** workflows go through the datamodel (`workflow.InitializeWorkflow` /
  `TaskObject[...]`); v222 WTM import does **not support STL** (official error) — CAD
  input must be .scdoc/.x_t/.step;
- The actual install on this machine is **v222 (2022 R2)**; the research report's "v232"
  directory label was a typo (v232 = 2023 R2). The version conclusion (2022 R2) stands;
- **mcp 2.x compatibility**: FastMCP was renamed MCPServer; the bridge adapts to both.

## Repository layout

```
run_pipeline.py            # L2 CLI entry
aeroharness/               # core package (config/journal_gen/transcript_parser/error_rules/
                           #   error_kb/feedback/domain_sizing/geometry/meshing/fluent_slot/
                           #   post/runner/optimize/adapters)
docs/                      # external_flow_domain_and_mesh.md (domain/backflow/refinement/
                           #   broken-geometry guidance with official citations)
                           # official_examples_translation.md (translation mapping tables)
journals/translations/     # external_compressible_flow / ahmed_body_watertight translated journals
journals/templates/        # solve_channel (verified=live) / solve_airplane (E10 mapping,
                           #   first-run calibration pending) / mesh_watertight (M3 skeleton)
configs/                   # demo_channel.json (verified) / case_airplane.json (E10)
                           #   / demo_baseline.json (M1.5 baseline)
meshes/                    # channel2d.msh / channel2d_lam.msh (generated), channel_domain.stl
                           #   (three named patches, for watertight probes), channel_box.stl
integrations/              # install guides for Codex/zcode/Claude Code/Cline/DSH
tools/                     # mock_fluent.py / selftest.py / baseline_check.py /
                           #   degradation_drill.py / make_demo_msh.py / make_demo_stl.py / mcp_server.py
scripts/                   # spaceclaim_box_domain.py (M2, IronPython inner layer)
skills/aero-fluent/        # SKILL.md + references/prompt_calibration.md
```

## Milestones (research report 6.3)

| Milestone | Status | Notes |
|---|---|---|
| M0 environment & self-check | ✅ | doctor: fluent.exe discovery (v222) / template rendering / mock smoke |
| M1 minimal journal loop | ✅ | one command, no human touch; sentinels/handshake/classifier verified on real runs; failure-injection tested |
| M1.5 baseline | ✅ | real-run pass: mass imbalance **0.002%** (≤0.5% official criterion), Δp within **0.6%** of the 2D Poiseuille analytic solution (<5% gate); `tools/baseline_check.py` |
| M2 SpaceClaim automation | ◐ | code complete (CPython parameter pipeline + domain_sizing auto-domain + IronPython inner script + manifest validation); **environment-gated**: local SCDM ignores /RunScript (suspected script security/license dialog) — one manual GUI confirmation then it's unattended |
| M3 mesh automation | ◐ | datamodel skeleton **verified on machine** (InitializeWorkflow/TaskObject work); **v222 boundary proven**: WTM import rejects STL (official error), needs .scdoc/.x_t/.step CAD (chains with M2); demo pipeline uses the parametric mesh generator; unlocks with STL support |
| M4 solve + post | ✅ | solve → CSV/JSON; three force-report formats; residual/convergence/quality/mass-balance/reversed-flow parsing |
| M5 optimization loop | ✅ | two-level optuna + dedup + built-in fallback engine; convergence proven on a synthetic response surface |
| M6 integration layer | ✅ | in-house fluent-mcp with 5 tools (mcp 1.x/2.x compatible) + aero-fluent skill + calibration records |
| Official example translation | ✅ | external_compressible_flow (transonic wing) and ahmed_body_watertight (official mesh workflow) translated journals + mapping tables; far-field BC/BOI/boundary-layer parameters wired into the generator; **official task-chain syntax matches our probed skeleton exactly** |
| M7 end-to-end / degradation drill | ✅ | `run_pipeline.py pipeline` one-shot (geometry→mesh→solve→summary); drill 5/5 (L3 MCP→L2 CLI→L1 manual journal→L0 guide) |

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=simonemuller6127-png/automatic-fluent&type=Date)](https://star-history.com/#simonemuller6127-png/automatic-fluent&Date)

## Known limitations

- `case_airplane` template settings map E10 and are marked `verified=false`: the first
  real aircraft run is a calibration run (gravity/discretization/relaxation prompt
  sequences not yet machine-verified; everything verified on the channel is baked in);
- the demo mock's response surface is **synthetic** (optimum at turb_intensity=5,
  turb_viscosity_ratio=10, relax=0.9) — it proves the optimizer loop, not real physics;
  change `objective.targets` for real runs;
- Chinese comments appear garbled in transcripts (Fluent reads journals as ANSI) —
  cosmetic only, parsing is unaffected;
- compressible materials (ideal-gas + Sutherland) and the coupling-scheme prompt chains
  are translated from the official example and marked "probe pending" — calibrate on
  first use per the guide.
