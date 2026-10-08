/* =============================================================================
 *  fluent.js —— ANSYS Fluent 外流场教学模块 · F1 方程式赛车 50 m/s 定常外流
 *
 *  遵循 app.js 顶部 CONTRACT：
 *    · 经典 <script>，无 ES module / 无打包器，全部挂在 window.CAE 上
 *    · 只改本文件；私有状态用 IIFE 包起来
 *    · 三维几何全部用 THREE 代码程序化生成，不加载任何外部模型/贴图
 *    · build() 搭伪软件界面 → api.setViewport() → api.setSteps()
 *    · 每个 enter() 幂等：先清场再重建
 *
 *  本模块实现的东西：
 *    ① Fluent Launcher（Dimension / Options / Type / Processes）
 *    ② Setup 树 + 各节点属性面板（General / Models / Materials / Cell Zone /
 *       Boundary Conditions / Mesh / Reference Values / Report Definitions /
 *       Initialization / Run Calculation / Solution / Results）
 *    ③ F1 赛车程序化建模（放样车身 + 翼型拉伸 + 四轮 + 侧箱 + 底板 + 扩散器）
 *    ④ 计算域盒 + 五类边界（inlet/outlet/ground/car-skin/farfield）半透明面 + Sprite 标签
 *    ⑤ 表面网格线框（粗 / 曲率近距加密两套）+ 尾流 BOI
 *    ⑥ Cp 伪彩（解析近似顶点色）+ legend 彩条
 *    ⑦ 流线粒子（层流 / k-epsilon / SST 三套流场预设）+ 尾翼后双螺旋涡
 *    ⑧ 残差小画布（canvas 2D，对数坐标，逐迭代下降，到判据自动停）
 *    ⑨ 气动力报告卡片（Cd / Cl / 动压换算 / 地面效应一句话）
 * ============================================================================= */
(function (global) {
  'use strict';

  var CAE = global.CAE;
  var doc = global.document;

  /* ===========================================================================
   * 0. 私有状态
   * ======================================================================== */
  var S = {
    /* —— 算例参数（对应 Fluent 里的设置）—— */
    launched: false,          // 是否已从 Launcher 正常启动
    sel: 'general',           // 当前选中的树节点
    step: '',                 // 当前教学步骤 id
    solver: 'pressure-based', // Pressure-Based / Density-Based
    time: 'steady',           // Steady / Transient
    opPressure: 101325,       // Operating Pressure [Pa]
    viscous: 'kw',            // inviscid / lam / keps / kw
    epsModel: 'standard',     // Standard / RNG
    kwModel: 'sst',           // Standard / SST
    prodLimiter: true,
    nearWall: 'wall-function',
    energy: false,
    rhoMode: 'constant',      // constant / ideal-gas
    rho: 1.225,               // kg/m^3
    alt: 0,                   // 海拔 [m]，用于演示大气密度变化
    mu: 1.7894e-05,
    cp: 1006.43,
    k: 0.0242,
    vel: 50,                  // 来流速度 [m/s]
    area: 1.5,                // 参考面积（迎风投影）[m^2]
    refLen: 5.0,
    refRho: 1.225,
    refVel: 50,
    lateral: 4.0,             // 计算域侧向单侧扩展 [m]（2W）
    initialized: false,
    iters: 0,
    target: 800,
    running: false,
    solvePaused: false,
    converged: false,
    stopReason: '',
    belowCnt: 0,
    res: [],                  // [{key,name,color,crit,v}]
    hist: { it: [], cd: [], cl: [] },
    fluxes: { inlet: 0, outlet: 0, imbalance: 0 },
    crit: { cont: 1e-4, mom: 1e-3, turb: 1e-3, energy: 1e-6 },
    bctab: 'momentum',        // BC 面板当前选项卡
    showCard: false,
    /* —— 三维显示开关 —— */
    view: {
      solid: true, domain: true, mesh: false, refine: false, boi: false, cp: false,
      pathlines: false, vortices: false, section: false, arrows: false,
      autoRot: false, legend: true, surfaces: true
    }
  };

  var V = {};   // 三维句柄（视口 + 场景里的对象引用）
  var D = {};   // DOM 引用
  var API = null;
  var timer = null;      // 求解器推进定时器
  var frameStop = null;  // onFrame 取消函数
  var carMats = [];      // 车身材质（剖切 / 幽灵壳用）
  var carCpMats = [];    // Cp 伪彩用的无光照材质（Fluent 的云图本来就是平涂）
  var clipPlanes = [];   // 剖切用
  var lastAutoRot = 0;

  /* ===========================================================================
   * 1. 工具函数
   * ======================================================================== */
  function $(sel) { return D.root.querySelector(sel); }
  function el(tag, cls, html) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function ss(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function gauss(x, c, w) { var d = (x - c) / w; return Math.exp(-d * d); }
  function fmt(v, n) { return Number(v).toFixed(n == null ? 3 : n); }
  function exp3(v) { return Number(v).toExponential(3).replace('e', 'e'); }

  /* ===========================================================================
   * 2. 教学数据：残差曲线模型 / 边界区 / 树
   * ======================================================================== */

  /* 残差模型：拉伸指数衰减 + 早期振荡 + 一段"看起来在降其实压不下去"的平台。
     平台是刻意留的教学点——真实 CFD 里"假收敛"就是这么发生的。 */
  var RES_DEF = [
    { key: 'cont', name: 'continuity', label: 'continuity', color: '#7fe0a0', c0: 1.0,   floor: 1.5e-5, tau: 42, p: 1.12, A: 0.60, ph: 0.0, pl: 0.55, pc: 45, pw: 20 },
    { key: 'x',    name: 'x-velocity', label: 'x-velocity', color: '#6fb0f0', c0: 2.9e-2, floor: 4.0e-6, tau: 50, p: 1.10, A: 0.50, ph: 0.6, pl: 0.30, pc: 52, pw: 18 },
    { key: 'y',    name: 'y-velocity', label: 'y-velocity', color: '#f0b26f', c0: 2.1e-2, floor: 4.0e-6, tau: 48, p: 1.08, A: 0.50, ph: 1.3, pl: 0.30, pc: 50, pw: 18 },
    { key: 'z',    name: 'z-velocity', label: 'z-velocity', color: '#c48ef0', c0: 1.7e-2, floor: 4.0e-6, tau: 46, p: 1.06, A: 0.50, ph: 2.1, pl: 0.28, pc: 48, pw: 18 },
    { key: 'k',    name: 'k',         label: 'k',         color: '#e8d24f', c0: 2.13,   floor: 6.0e-5, tau: 48, p: 1.12, A: 0.65, ph: 0.9, pl: 0.40, pc: 50, pw: 19 },
    { key: 'w',    name: 'omega',     label: 'omega',     color: '#e87fa8', c0: 2.79,   floor: 8.0e-5, tau: 50, p: 1.13, A: 0.65, ph: 1.8, pl: 0.42, pc: 52, pw: 19 }
  ];

  function resAt(s, n) {
    if (n <= 0) return s.c0;
    var r = s.floor + (s.c0 - s.floor) * Math.exp(-Math.pow(n / s.tau, s.p));
    r *= (1 + s.A * Math.exp(-n / 20) * Math.sin(0.8 * n + s.ph));   // 早期摆动
    r *= (1 + s.pl * Math.exp(-Math.pow((n - s.pc) / s.pw, 2)));     // 平台期
    return Math.max(r, s.floor * 0.8);
  }
  function resCrit(key) {
    if (key === 'cont') return S.crit.cont;
    if (key === 'k' || key === 'w') return S.crit.turb;
    return S.crit.mom;
  }
  /* 力报告历史：先是离谱的大数，然后单调收敛 + 一段高频抖动。
     ⚠ 没有迭代（n = 0）时返回 null —— 气动力是**压力积分的产物**，
     场没解出来就没有压差，硬给一个"渐近值"会让"后处理必须先收敛"这条教法形同虚设。 */
  function cdAt(n) {
    if (n <= 0) return null;
    return 1.05 + 5.2 * Math.exp(-Math.pow(n / 55, 1.2)) + 0.9 * Math.exp(-n / 16) * Math.sin(0.5 * n);
  }
  function clAt(n) {
    if (n <= 0) return null;
    return 6.8 + 44 * Math.exp(-Math.pow(n / 52, 1.2)) + 2.4 * Math.exp(-n / 15) * Math.sin(0.55 * n + 1);
  }
  /* 标准大气密度（0~8000 m ISA 近似） */
  function rhoISA(h) { return 1.225 * Math.pow(Math.max(1 - 2.25577e-5 * h, 0.05), 4.2559); }
  /* 动压一律用 Reference Values 里的 ρ 与 U（与 Fluent 的 Cd = Fx/(½ρU²A) 定义一致） */
  function dynP() { return 0.5 * S.refRho * S.refVel * S.refVel; }
  function forceNow() {
    var q = dynP();
    var cd = cdAt(S.iters), cl = clAt(S.iters);
    return {
      q: q, cd: cd, cl: cl,
      has: cd !== null && cl !== null,
      fx: cd === null ? null : cd * q * S.area,
      fy: cl === null ? null : cl * q * S.area
    };
  }

  /* 边界区：zone → 类型 */
  var ZONES = [
    { id: 'inlet',      name: 'inlet',          type: 'velocity-inlet', face: 'inlet',  color: '#4f9df0', desc: '速度入口：来流 50 m/s，湍流强度 5%' },
    { id: 'outlet',     name: 'outlet',         type: 'pressure-outlet', face: 'outlet', color: '#5fd08a', desc: '压力出口：表压 0 Pa（与入口成对使用）' },
    { id: 'car-skin',   name: 'car-skin',       type: 'wall',            face: 'car',   color: '#e8a24f', desc: '车身壁面：No Slip，压力积分出压差' },
    { id: 'ground',     name: 'ground',         type: 'wall',            face: 'ground',color: '#f08a3c', desc: '地面：Slip 自由滑移壁面，零摩擦' },
    { id: 'farfield',   name: 'farfield-sides', type: 'symmetry',        face: 'side',  color: '#b07af0', desc: '侧向远场：symmetry，零法向速度' },
    { id: 'farfield-top', name: 'farfield-top', type: 'symmetry',        face: 'top',   color: '#b07af0', desc: '顶部远场：symmetry' }
  ];
  function zoneById(id) { for (var i = 0; i < ZONES.length; i++) if (ZONES[i].id === id) return ZONES[i]; return null; }
  /* 用户在面板里改过的 zone 类型（记下来，用于警告联动） */
  var ZONE_EDIT = {};

  /* 收敛判据表（Results → Solution → Convergence Criteria） */
  var CRIT_ROWS = [
    { key: 'cont', name: 'continuity',     field: 'Flow Equations > continuity equation' },
    { key: 'x',    name: 'x-velocity',     field: 'Flow Equations > x-velocity equation' },
    { key: 'y',    name: 'y-velocity',     field: 'Flow Equations > y-velocity equation' },
    { key: 'z',    name: 'z-velocity',     field: 'Flow Equations > z-velocity equation' },
    { key: 'k',    name: 'k',              field: 'Turbulence > turbulent kinetic energy' },
    { key: 'w',    name: 'omega',          field: 'Turbulence > specific dissipation rate' }
  ];

  /* Outline 树（对应大纲里那 11 个顶层节点） */
  var TREE = [
    { id: 'setup', label: 'Setup', icon: '🗂', children: [
      { id: 'general', label: 'General', icon: '⚙' },
      { id: 'models', label: 'Models', icon: '▤', children: [
        { id: 'viscous', label: 'Viscous', icon: '≈' },
        { id: 'energy', label: 'Energy', icon: '♨' }
      ]},
      { id: 'materials', label: 'Materials', icon: '◆', children: [
        { id: 'air', label: 'air (fluid)', icon: '·' }
      ]},
      { id: 'cellzone', label: 'Cell Zone Conditions', icon: '▦' },
      { id: 'bc', label: 'Boundary Conditions', icon: '◈', children: [
        { id: 'bc:inlet', label: 'inlet', icon: '▷' },
        { id: 'bc:outlet', label: 'outlet', icon: '▷' },
        { id: 'bc:car-skin', label: 'car-skin', icon: '▷' },
        { id: 'bc:ground', label: 'ground', icon: '▷' },
        { id: 'bc:farfield', label: 'farfield-sides', icon: '▷' },
        { id: 'bc:farfield-top', label: 'farfield-top', icon: '▷' }
      ]},
      { id: 'mesh', label: 'Mesh', icon: '▩' },
      { id: 'refvals', label: 'Reference Values', icon: '№' },
      { id: 'reportdef', label: 'Report Definitions', icon: '∿' },
      { id: 'init', label: 'Initialization', icon: '✧' },
      { id: 'run', label: 'Run Calculation', icon: '▶' }
    ]},
    { id: 'solution', label: 'Solution', icon: '∿', children: [
      { id: 'residual', label: 'Residual Monitors', icon: '📈' },
      { id: 'criteria', label: 'Convergence Criteria', icon: '☑' }
    ]},
    { id: 'results', label: 'Results', icon: '◱', children: [
      { id: 'contours', label: 'Graphics / Contours', icon: '🌈' },
      { id: 'pathlines', label: 'Graphics / Pathlines', icon: '〰' },
      { id: 'forces', label: 'Reports / Forces', icon: '➤' },
      { id: 'fluxes', label: 'Reports / Fluxes', icon: '⇄' },
      { id: 'history', label: 'Report Definitions', icon: '📉' }
    ]}
  ];
  var OPEN = { setup: 1, models: 1, bc: 1, materials: 1, solution: 0, results: 0 };
  var flatIndex = {};
  (function indexTree(list) {
    for (var i = 0; i < list.length; i++) {
      flatIndex[list[i].id] = { node: list[i], depth: 0, parent: null };
      if (list[i].children) {
        for (var j = 0; j < list[i].children.length; j++) {
          flatIndex[list[i].children[j].id] = { node: list[i].children[j], depth: 1, parent: list[i].id };
          if (list[i].children[j].children) {
            var g = list[i].children[j].children;
            for (var k = 0; k < g.length; k++) {
              flatIndex[g[k].id] = { node: g[k], depth: 2, parent: list[i].children[j].id };
            }
          }
        }
      }
    }
  })(TREE);

  function nodeLabel(id) {
    if (id.indexOf('bc:') === 0) { var z = zoneById(id.slice(3)); return z ? z.name : id; }
    return (flatIndex[id] && flatIndex[id].node.label) || id;
  }

  /* ===========================================================================
   * 3. 模块私有样式（严格限定在 #fluRoot 作用域内，不污染 app.css）
   * ======================================================================== */
  var CSS = [
    '#fluRoot{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;}',
    '#fluRoot .flu-main{flex:1 1 auto;display:flex;gap:6px;padding:6px;min-height:0;min-width:0;}',
    '#fluRoot .flu-tree{flex:0 0 196px;}',
    '#fluRoot .flu-center{flex:1 1 auto;display:flex;flex-direction:column;gap:6px;min-width:0;min-height:0;}',
    /* 关键：视口只由 flex 决定高度，canvas 绝对定位不参与排版，
       否则 canvas 的固有高度会被 ResizeObserver 反复放大成几千像素 */
    '#fluRoot .flu-center > .viewport{flex:1 1 0;min-height:0;min-width:0;}',
    '#fluRoot .flu-center > .viewport > canvas{position:absolute;left:0;top:0;width:100% !important;height:100% !important;}',
    '#fluRoot .flu-side{flex:0 0 250px;display:flex;flex-direction:column;gap:6px;min-height:0;min-width:0;}',
    '#fluRoot .flu-tools{flex:0 0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:4px;',
    '  padding:5px 6px;background:#191e25;border:1px solid var(--line);border-radius:5px;}',
    '#fluRoot .flu-mon{flex:0 0 auto;background:#181d24;border:1px solid var(--line);border-radius:5px;padding:6px 8px;}',
    '#fluRoot .flu-mt{display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--txt-3);margin-bottom:3px;}',
    '#fluRoot .flu-canvas{width:100%;display:block;background:#0d1015;border:1px solid var(--line);border-radius:3px;}',
    /* 逻辑高度用 CSS 锁死：canvas 的 height 属性会被 fitCanvas 按 dpr 反复改写，
       一旦不锁 CSS 高度，浏览器就拿改写后的属性值当 CSS px 渲染，画布会越长越高。 */
    '#fluRoot #fluResCv{height:118px;}',
    '#fluRoot #fluFcCv{height:66px;}',
    '#fluRoot .flu-lg{display:flex;gap:3px;flex-wrap:wrap;}',
    '#fluRoot .flu-lg i{font-style:normal;font-family:Consolas,monospace;font-size:9.5px;padding:0 3px;border-radius:2px;background:#1d232b;}',
    '#fluRoot .flu-tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin-bottom:8px;}',
    '#fluRoot .flu-tabs button{flex:1 1 auto;background:transparent;border:0;border-bottom:2px solid transparent;',
    '  color:var(--txt-3);font:inherit;font-size:11.5px;padding:4px 2px;cursor:pointer;}',
    '#fluRoot .flu-tabs button.is-on{color:var(--accent);border-bottom-color:var(--accent);background:var(--accent-dim);}',
    '#fluRoot .flu-tbl{width:100%;border-collapse:collapse;font-size:11.5px;}',
    '#fluRoot .flu-tbl th{color:var(--txt-3);font-weight:600;text-align:left;padding:3px 4px;border-bottom:1px solid var(--line);}',
    '#fluRoot .flu-tbl td{padding:3px 4px;border-bottom:1px solid #232a33;color:var(--txt-2);}',
    '#fluRoot .flu-tbl td.mono{font-family:Consolas,monospace;color:var(--txt);}',
    '#fluRoot .flu-tbl input{width:66px;height:20px;padding:0 4px;background:var(--bg-3);border:1px solid var(--line-2);',
    '  border-radius:3px;color:var(--txt);font:inherit;font-size:11px;font-family:Consolas,monospace;text-align:right;}',
    '#fluRoot .flu-card{position:absolute;left:8px;bottom:8px;width:246px;background:#11151aee;border:1px solid var(--accent);',
    '  border-radius:6px;padding:8px 10px;z-index:6;box-shadow:0 10px 26px #000a;}',
    '#fluRoot .flu-card-hd{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--accent);',
    '  border-bottom:1px solid var(--line);padding-bottom:5px;margin-bottom:6px;}',
    '#fluRoot .flu-card .kv{font-size:11.5px;padding:1px 0;}',
    '#fluRoot .flu-card-note{margin-top:6px;padding-top:6px;border-top:1px dashed var(--line-2);',
    '  font-size:11px;line-height:1.6;color:#b9c6d2;}',
    '#fluRoot .flu-launcher{position:absolute;inset:0;background:#0b0e12cc;display:flex;align-items:center;',
    '  justify-content:center;z-index:9;}',
    '#fluRoot .flu-lc{width:330px;background:#1a1f26;border:1px solid var(--line-2);border-radius:8px;overflow:hidden;',
    '  box-shadow:0 16px 44px #000c;}',
    '#fluRoot .flu-lc-hd{background:linear-gradient(180deg,#2b333d,#212830);padding:7px 12px;font-size:12.5px;',
    '  font-weight:600;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:7px;}',
    '#fluRoot .flu-lc-bd{padding:10px 12px;}',
    '#fluRoot .flu-lc-ft{padding:9px 12px;background:#171b21;border-top:1px solid var(--line);display:flex;gap:8px;',
    '  align-items:center;}',
    '#fluRoot .flu-warn{margin-top:7px;font-size:11px;line-height:1.55;color:#e5c069;background:#2a2416;',
    '  border-left:3px solid var(--warn);border-radius:3px;padding:5px 8px;display:none;}',
    '#fluRoot .flu-warn.is-on{display:block;}',
    '#fluRoot .flu-sec{font-size:11px;color:var(--txt-3);letter-spacing:.5px;margin:9px 0 5px;',
    '  border-bottom:1px solid var(--line);padding-bottom:3px;text-transform:uppercase;}',
    '#fluRoot .flu-note{font-size:11px;line-height:1.6;color:var(--txt-3);margin-top:6px;padding:5px 7px;',
    '  background:#161b21;border-radius:4px;border-left:2px solid var(--line-2);}',
    '#fluRoot .flu-zone{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:4px;cursor:pointer;',
    '  border:1px solid transparent;}',
    '#fluRoot .flu-zone:hover{background:#1f252d;}',
    '#fluRoot .flu-zone.is-sel{border-color:var(--accent);background:var(--accent-dim);}',
    '#fluRoot .flu-dot{width:9px;height:9px;border-radius:2px;flex:0 0 9px;}',
    '#fluRoot .flu-bar{height:6px;background:#12161b;border-radius:3px;overflow:hidden;margin-top:4px;}',
    '#fluRoot .flu-bar > i{display:block;height:100%;width:0;background:var(--accent);transition:width .2s;}',
    '#fluRoot .flu-swatch{width:100%;height:10px;border-radius:2px;border:1px solid #0006;margin:4px 0 2px;}',
    '#fluRoot .flu-props .field > label{flex:0 0 96px;}',
    '#fluRoot input[type=range]{accent-color:var(--accent);height:20px;}',
    '#fluRoot .flu-slider{display:flex;align-items:center;gap:6px;margin:4px 0;}',
    '#fluRoot .flu-slider span{font-family:Consolas,monospace;font-size:11px;color:var(--txt);min-width:58px;text-align:right;}'
  ].join('\n');
  (function injectStyle() {
    var st = doc.createElement('style');
    st.id = 'flu-style';
    st.appendChild(doc.createTextNode(CSS));
    doc.head.appendChild(st);
  })();

  /* ===========================================================================
   * 4. 伪软件界面骨架
   * ======================================================================== */
  var TOOLS = [
    { k: 'solid',   t: '车身实体', i: '◍' },
    { k: 'domain',  t: '计算域', i: '⬚' },
    { k: 'mesh',    t: '表面网格', i: '▩' },
    { k: 'refine',  t: '局部加密', i: '⁘' },
    { k: 'cp',      t: 'Cp 云图', i: '🌈' },
    { k: 'pathlines', t: '流线', i: '〰' },
    { k: 'vortices', t: '尾涡', i: '🌀' },
    { k: 'section', t: '剖切', i: '◑' },
    { k: 'arrows',  t: '力矢量', i: '➤' }
  ];

  function buildDom() {
    var h = [];
    h.push('<div class="menu-bar">');
    ['文件 File', '编辑 Edit', '视图 View', '网格 Mesh', '求解 Solution', '后处理 Results', '帮助 Help'].forEach(function (m, i) {
      h.push('<span class="menu-item' + (i === 4 ? ' is-on' : '') + '">' + m + '</span>');
    });
    h.push('<span class="spacer"></span><span class="badge badge-acc" id="fluMode">Solution 模式</span>');
    h.push('</div>');

    h.push('<div class="ribbon">');
    h.push('<div class="ribbon-group"><button class="ribbon-btn is-on" data-act="setup"><span class="ico">🗂</span>Setup</button>' +
           '<button class="ribbon-btn" data-act="init"><span class="ico">✧</span>初始化</button>' +
           '<button class="ribbon-btn" data-act="calc"><span class="ico">▶</span>计算</button></div>');
    h.push('<div class="ribbon-group"><button class="ribbon-btn" data-act="contour"><span class="ico">🌈</span>云图</button>' +
           '<button class="ribbon-btn" data-act="path"><span class="ico">〰</span>流线</button>' +
           '<button class="ribbon-btn" data-act="force"><span class="ico">➤</span>力报告</button></div>');
    h.push('<div class="ribbon-group"><button class="ribbon-btn" data-act="rot"><span class="ico">⟳</span>自动旋转</button>' +
           '<button class="ribbon-btn" data-act="reset"><span class="ico">⌖</span>复位视角</button></div>');
    h.push('<div class="ribbon-group"><button class="ribbon-btn" data-act="quality"><span class="ico">✔</span>网格检查</button></div>');
    h.push('</div>');

    h.push('<div class="flu-main">');

    /* 左：Outline 树 */
    h.push('<div class="tree flu-tree" id="fluTree"></div>');

    /* 中：视口 + 工具条 */
    h.push('<div class="flu-center">');
    h.push('<div class="viewport" id="fluVp">');
    h.push('<div class="viewport-ov" id="fluOv">F1 外流场 · 50 m/s</div>');
    h.push('<div class="viewport-hint" id="fluHint">左键旋转 · 滚轮缩放 · 右键平移</div>');
    h.push('<div class="legend" id="fluLegend" style="display:none">' +
           '<div class="legend-title">Cp</div>' +
           '<div class="legend-bar flu-swatch" id="fluLegendBar"></div>' +
           '<div class="legend-ticks"><span id="fluLgHi">1.2</span><span id="fluLgMid">0</span><span id="fluLgLo">-1.8</span></div>' +
           '</div>');
    h.push('<div class="flu-launcher" id="fluLauncher"></div>');
    h.push('<div class="flu-card" id="fluCard" style="display:none"></div>');
    h.push('</div>');

    h.push('<div class="flu-tools" id="fluTools">');
    TOOLS.forEach(function (t) {
      h.push('<button class="btn btn-sm' + (S.view[t.k] ? ' btn-primary' : ' btn-ghost') + '" data-tg="' + t.k + '">' +
             t.i + ' ' + t.t + '</button>');
    });
    h.push('<span class="spacer"></span>');
    h.push('<label class="flu-slider" style="gap:3px"><span style="color:var(--txt-3);min-width:auto">来流</span>' +
           '<input type="range" data-k="vel" id="fluVel" min="10" max="90" step="1" value="' + S.vel + '" style="width:88px">' +
           '<span id="fluVelTx">50 m/s</span></label>');
    h.push('<button class="btn btn-sm" data-act="reset">⌖ 复位</button>');
    h.push('</div>');
    h.push('</div>');

    /* 右：属性面板 + 监视器 */
    h.push('<div class="flu-side">');
    h.push('<div class="props flu-props" id="fluProps"></div>');
    h.push('<div class="flu-mon">');
    h.push('<div class="flu-mt"><span>Residual Monitors（对数坐标）</span><span id="fluResNow">—</span></div>');
    h.push('<canvas class="flu-canvas" id="fluResCv" height="118" data-logical-h="118"></canvas>');
    h.push('<div class="flu-lg" id="fluResLg"></div>');
    h.push('<div class="flu-mt" style="margin-top:6px"><span>气动力历史 Cd / Cl</span><span id="fluFrcNow">—</span></div>');
    h.push('<canvas class="flu-canvas" id="fluFcCv" height="66" data-logical-h="66"></canvas>');
    h.push('</div>');
    h.push('</div>');

    h.push('</div>');
    h.push('</div>');
    return h.join('');
  }

  /* ===========================================================================
   * 5. 表单构件 + 树渲染
   * ======================================================================== */
  function F(label, ctrl) { return '<div class="field"><label>' + label + '</label>' + ctrl + '</div>'; }
  function G(title) { return '<div class="flu-sec">' + title + '</div>'; }
  function SEL(k, opts, val) {
    var o = '';
    for (var i = 0; i < opts.length; i++) {
      o += '<option value="' + opts[i][0] + '"' + (opts[i][0] === val ? ' selected' : '') + '>' + opts[i][1] + '</option>';
    }
    return '<select class="select" data-k="' + k + '">' + o + '</select>';
  }
  function INP(k, val) { return '<input class="input mono" data-k="' + k + '" value="' + val + '">'; }
  function CHK(k, lab, ck) {
    return '<label class="check" style="flex:1 1 46%"><input type="checkbox" data-k="' + k + '"' + (ck ? ' checked' : '') + '>' +
           '<span>' + lab + '</span></label>';
  }
  function RAD(k, opts, val) {
    var o = '';
    for (var i = 0; i < opts.length; i++) {
      o += '<label class="check" style="flex:1 1 40%"><input type="radio" name="' + k + '" data-k="' + k + '" value="' +
           opts[i][0] + '"' + (opts[i][0] === val ? ' checked' : '') + '><span>' + opts[i][1] + '</span></label>';
    }
    return o;
  }
  function KV(k, v, cls) { return '<div class="kv"><span>' + k + '</span><span class="' + (cls || '') + '">' + v + '</span></div>'; }
  function KVi(k, v, id) { return '<div class="kv"><span>' + k + '</span><span id="' + id + '">' + v + '</span></div>'; }
  function NOTE(t) { return '<div class="flu-note">' + t + '</div>'; }
  function Btn(k, lab, primary) {
    return '<button class="btn ' + (primary ? 'btn-primary' : '') + '" data-k="' + k + '" style="margin:3px 4px 0 0">' + lab + '</button>';
  }
  function slider(k, min, max, step, val, unit, id) {
    return '<div class="flu-slider"><input type="range" data-k="' + k + '" min="' + min + '" max="' + max + '" step="' + step +
           '" value="' + val + '" style="flex:1"><span' + (id ? ' id="' + id + 'Out"' : '') + '>' + val + (unit || '') + '</span></div>';
  }

  function renderTree() {
    var out = [];
    (function walk(list) {
      for (var i = 0; i < list.length; i++) {
        var n = list[i];
        var hasKids = !!n.children;
        var on = OPEN[n.id] && hasKids;
        out.push('<div class="tree-item' + (S.sel === n.id ? ' is-sel' : '') + (S.launched ? '' : ' is-off') +
                 '" data-node="' + n.id + '" data-depth="' + flatIndex[n.id].depth + '">' +
                 '<span class="tree-toggle" data-tog="' + n.id + '">' + (hasKids ? (on ? '▼' : '▶') : '') + '</span>' +
                 '<span class="tree-icon">' + n.icon + '</span><span>' + n.label + '</span></div>');
        if (on) walk(n.children);
      }
    })(TREE);
    D.tree.innerHTML = out.join('');
  }

  function selectNode(id) {
    S.sel = id;
    renderTree();
    renderProps();
  }

  /* ===========================================================================
   * 6. 伪终端（TUI 风格）
   * ======================================================================== */
  function tui(cmd, kind) { API.console('> ' + cmd, kind || 'cmd'); }
  function out(txt, kind) { API.console(txt, kind || 'info'); }
  function say(list) {
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (typeof it === 'string') API.console(it, 'info');
      else API.console(it[0], it[1] || 'info');
    }
  }
  function updateStatus() {
    var f = forceNow();
    API.setStatus({
      算例: 'f1_external.cas.h5',
      求解器: S.solver === 'pressure-based' ? 'Pressure-Based' : 'Density-Based',
      湍流: viscousName(),
      迭代: S.iters + ' / ' + S.target,
      最大残差: S.iters ? exp3(maxRes()) : '—',
      Cd: S.iters ? fmt(f.cd, 3) : '—',
      Cl: S.iters ? fmt(f.cl, 3) : '—'
    });
  }
  function viscousName() {
    if (S.viscous === 'inviscid') return 'Inviscid';
    if (S.viscous === 'lam') return 'Laminar';
    if (S.viscous === 'keps') return 'k-epsilon (' + S.epsModel + ')';
    if (S.viscous === 'kw') return 'k-omega (' + S.kwModel + ')';
    return '-';
  }
  function maxRes() {
    if (!S.res.length) return 0;
    var m = 0;
    for (var i = 0; i < S.res.length; i++) {
      var a = S.res[i].v;
      if (a.length && a[a.length - 1] > m) m = a[a.length - 1];
    }
    return m;
  }
  function blockingRatio() {
    var w = 2.0 + 2 * S.lateral;          // 车宽 2.0 + 左右各 lateral
    var h = 0.95 + 1.90;                  // 车高 0.95 + 顶部 2H
    return { area: w * h, w: w, h: h, ratio: 1.5 / (w * h) * 100 };
  }

  /* ===========================================================================
   * 7. 属性面板
   * ======================================================================== */
  function renderProps() {
    var id = S.sel, h = [];
    var ttl = nodeLabel(id);
    h.push('<div class="props-title">' + (id.indexOf('bc:') === 0 ? 'Boundary Conditions / ' : '') + ttl + '</div>');
    var p = PANEL[id];
    h.push(typeof p === 'function' ? p() : (p || NOTE('该节点用于查看监控与判据，实操在左侧 Run Calculation 面板完成。')));
    D.props.innerHTML = h.join('');
  }

  var PANEL = {};

  PANEL.general = function () {
    return G('Solver') +
      F('Solver', SEL('solver', [['pressure-based', 'Pressure-Based'], ['density-based', 'Density-Based']], S.solver)) +
      F('Time', SEL('time', [['steady', 'Steady'], ['transient', 'Transient']], S.time)) +
      F('2D Space', SEL('2d', [['3d', '3D']], '3d')) +
      G('Operating Conditions') +
      F('Operating Pressure', '<div class="field-row">' + INP('opPressure', S.opPressure) + '<span class="muted">Pa</span></div>') +
      '<div class="field" style="gap:14px">' + CHK('grav', 'Gravity', false) + CHK('energy_on2', 'Energy Equation', S.energy) + '</div>' +
      G('Methods') +
      F('Flow', SEL('flow', [['coupled', 'Coupled'], ['segregated', 'Segregated']], 'coupled')) +
      F('Gradient', SEL('grad', [['least-square', 'Least Squares Cell Based'], ['green', 'Green-Gauss Node Based']], 'least-square')) +
      F('Spatial Discret.', SEL('disc', [['2nd', 'Second Order Upwind'], ['1st', 'First Order Upwind']], '2nd')) +
      NOTE('马赫数 M ≈ 50/340 ≈ <b>0.15</b>，属于<b>低马赫不可压流</b>：压力基求解器不做密度方程，' +
           '比密度基少一套未知量、内存省一半，且在低马赫下更稳。' +
           (S.solver === 'density-based' ? '<br><b style="color:var(--warn)">当前选了 Density-Based：</b>低马赫外流用密度基容易出现质量方程振荡，真实项目一般仍选 Pressure-Based。' : '')) +
      NOTE('操作压力 = 101325 Pa：求解器内部按<b>表压</b>迭代，报告时再加上这个常数还原绝对压力，' +
           '与风洞测力时的表压基准一致。');
  };

  PANEL.models = function () {
    return G('Enabled Models') +
      '<div class="field" style="gap:14px">' + CHK('models_energy', 'Energy', S.energy) + '</div>' +
      KV('Energy Equation', S.energy ? 'On' : 'Off（推荐）') +
      KV('Viscous Model', viscousName()) +
      NOTE('F1 定常外流是<b>等温</b>的：开能量方程不产生浮升力，只多解一个方程、多占内存，' +
           '所以默认 <b>Off</b>。双击子节点 <code>Viscous</code> 选湍流模型，<code>Energy</code> 保持 Off。');
  };

  PANEL.viscous = function () {
    var h = [];
    h.push(G('Model'));
    h.push(F('Model', SEL('viscous', [
      ['inviscid', 'Inviscid'], ['lam', 'Laminar'], ['keps', 'k-epsilon'], ['kw', 'k-omega'],
      ['sa', 'Spallart-Allmaras'], ['rn', 'Reynolds Number Model'], ['dpm', 'Discrete Phase Model']
    ], S.viscous)));
    if (S.viscous === 'keps') {
      h.push(G('k-epsilon Options'));
      h.push(F('k-epsilon Model', SEL('epsModel', [['standard', 'Standard'], ['rng', 'RNG']], S.epsModel)));
      h.push(F('Near-Wall Treat.', SEL('nearWall', [['wall-function', 'Standard Wall Function'], ['enhanced', 'Enhanced Wall Treatment']], S.nearWall)));
      h.push('<div class="field" style="gap:14px">' + CHK('prodLimiter', 'Production Limiter', S.prodLimiter) + '</div>');
    } else if (S.viscous === 'kw') {
      h.push(G('k-omega Options'));
      h.push(F('k-omega Model', SEL('kwModel', [['standard', 'Standard'], ['sst', 'SST']], S.kwModel)));
      h.push('<div class="field" style="gap:14px">' + CHK('prodLimiter', 'Production Limiter', S.prodLimiter) + '</div>');
      h.push(F('Near-Wall Treat.', SEL('nearWall', [['wall-function', 'Wall Function'], ['enhanced', 'Enhanced Wall Treatment']], S.nearWall)));
      h.push(G('Turbulent Kinetic Energy'));
      h.push(RAD('turbRate', [['unit-mass', 'Compute per Unit Mass'], ['kinetic', 'Kinetic Energy and Specific Dissipation Rate']], 'unit-mass'));
    }
    h.push(G('对比'));
    h.push('<div class="flu-tbl"><table class="flu-tbl"><tr><th>模型</th><th>适用</th><th>F1 外流</th></tr>' +
      '<tr><td class="mono">Laminar</td><td>Re&lt;5e5</td><td>尾流无涡、不分离</td></tr>' +
      '<tr><td class="mono">k-epsilon</td><td>自由剪切层</td><td>尾流过宽、底板预测差</td></tr>' +
      '<tr><td class="mono">k-omega SST</td><td>有逆压梯度/分离</td><td><b style="color:var(--accent)">本例选用</b></td></tr>' +
      '</table></div>');
    if (S.viscous === 'kw' && S.kwModel === 'sst') {
      h.push(NOTE('SST = Shear Stress Transport：把 k 和 ω 两个方程在近壁层流区与外区混合，' +
        'ω 衰减到壁面为 0、k 保持有限，所以<b>不依赖 y+≈1 的网格</b>，壁函数也能用。' +
        'F1 前翼下洗、底板边界层分离都吃逆压梯度，这正是选它的理由。'));
    }
    if (S.viscous === 'lam') {
      h.push(NOTE('<b style="color:var(--warn)">注意：</b>F1 在 50 m/s 下 Re ≈ 2×10⁷，属于' +
        '<b>极强湍流</b>。用层流算出来的尾流完全没有涡结构，阻力与下压力都会严重偏低——' +
        '这里选层流只是为了做对比演示。'));
    }
    return h.join('');
  };

  PANEL.energy = function () {
    return G('Energy Equation') +
      '<div class="field" style="gap:14px">' + RAD('energy', [['0', 'Off（关闭）'], ['1', 'On（开启）']], S.energy ? '1' : '0') + '</div>' +
      G('Energy Options') +
      F('Turb. Prandtl No.', INP('pr_t', '0.85')) +
      F('Mol. Prandtl No.', INP('pr_m', '0.71')) +
      (S.energy
        ? NOTE('能量方程已开启：会联立解出温度场 T。F1 外气动等温、无浮升力，' +
               '开它只增加未知量；只有在算<b>热管理、刹车盘温度、尾焰</b>时才必须开。')
        : NOTE('关闭状态：Energy Options 里的两个 Prandtl 数是灰色不可编辑的。' +
               '定常外气动保持 Off 是行业惯例；真要开启还要勾 Models 里的 Energy 复选框。'));
  };

  PANEL.materials = function () {
    return G('Fluid Materials') +
      '<div class="flu-zone is-sel" style="border-color:var(--accent)">' +
      '<span class="flu-dot" style="background:#4f9df0"></span><span>air</span>' +
      '<span class="spacer"></span><span class="badge badge-info">fluid</span></div>' +
      NOTE('F1 外流场里只有<b>一种流体</b>：空气。选中它可以看到 Density / Viscosity / Cp / ' +
           'Thermal Conductivity 四项。展开子节点 <code>air</code> 打开 Properties 页。');
  };

  PANEL.air = function () {
    return G('Properties of air') +
      F('Density', SEL('rhoMode', [['constant', 'constant'], ['ideal-gas', 'ideal-gas']], S.rhoMode)) +
      F('  Value', '<div class="field-row">' + INP('rho', S.rho.toFixed(4)) + '<span class="muted">kg/m³</span></div>') +
      F('Viscosity', '<div class="field-row">' + INP('mu', S.mu) + '<span class="muted">kg/(m·s)</span></div>') +
      F('Cp', '<div class="field-row">' + INP('cp', S.cp) + '<span class="muted">J/(kg·K)</span></div>') +
      F('Thermal Cond.', '<div class="field-row">' + INP('kk', S.k) + '<span class="muted">W/(m·K)</span></div>') +
      G('大气密度演示（拖动看 Cp 与力的换算基准）') +
      slider('alt', 0, 8000, 100, S.alt, ' m', 'fluAlt') +
      KVi('标准大气密度 ρ', fmt(S.rho, 4) + ' kg/m³', 'fluAltRho') +
      KVi('动压 q = ½ρU²', fmt(dynP(), 1) + ' Pa', 'fluAltQ') +
      KVi('换算：Cd=1.0 对应阻力', fmt(1.0 * dynP() * S.area / 1000, 2) + ' kN', 'fluAltF') +
      NOTE('海拔 3000 m 时 ρ ≈ 0.914 kg/m³，<b>动压掉到 1/4</b>，同样的 Cd 会给出小得多的力。' +
           '这正是赛车要在低海拔赛道跑气动测试的原因。') +
      (S.rhoMode === 'ideal-gas'
        ? NOTE('已改 ideal-gas：<b style="color:var(--warn)">边界条件必须跟着改</b>，' +
               'pressure-far-field 要填 Operating Pressure，否则求解前会被 Fluent 拒绝。')
        : NOTE('常数密度 + <code>pressure-far-field</code> 是外流场最省事的组合：' +
               '密度不随高度变，参考速度也直接用 50 m/s。'));
  };

  PANEL.cellzone = function () {
    return G('Cell Zone Conditions') +
      '<div class="flu-zone is-sel"><span class="flu-dot" style="background:#4caf7d"></span>' +
      '<span>f1_fluid</span><span class="spacer"></span><span class="badge badge-ok">fluid</span></div>' +
      '<div class="flu-zone"><span class="flu-dot" style="background:#6b7686"></span>' +
      '<span>car_solid</span><span class="spacer"></span><span class="badge">solid</span></div>' +
      G('Mesh Interfaces') +
      KV('Interface Zones', '1（fluid ↔ solid 耦合壁面）') +
      KV('Coupling', 'Wall（车体表面与内部固体）') +
      NOTE('F1 是<b>薄壳车体</b>，实际建模常把车身当 solid zone 外表面：' +
           '把内部设为 solid，内外通过 <b>conjugate heat transfer</b> 或直接<b>coupled wall</b> 连接。' +
           '本例为了聚焦气动，车体取零厚度壁面，车壳内部不再划分网格。');
  };

  PANEL.bc = function () {
    var h = [G('Boundary Conditions (' + ZONES.length + ' zones)')];
    for (var i = 0; i < ZONES.length; i++) {
      var z = ZONES[i];
      var t = ZONE_EDIT[z.id] || z.type;
      h.push('<div class="flu-zone" data-zone="' + z.id + '">' +
             '<span class="flu-dot" style="background:' + z.color + '"></span>' +
             '<span>' + z.name + '</span><span class="spacer"></span>' +
             '<span class="badge" style="border-color:' + z.color + ';color:' + z.color + '">' + t + '</span></div>');
    }
    h.push(NOTE('双击（或点击）zone 名称打开编辑面板。<b>速度入口必须与压力出口成对出现</b>，' +
                '远场一律用 symmetry。'));
    return h.join('');
  };

  PANEL['bc:inlet'] = function () { return zonePanel('inlet'); };
  PANEL['bc:outlet'] = function () { return zonePanel('outlet'); };
  PANEL['bc:car-skin'] = function () { return zonePanel('car-skin'); };
  PANEL['bc:ground'] = function () { return zonePanel('ground'); };
  PANEL['bc:farfield'] = function () { return zonePanel('farfield'); };
  PANEL['bc:farfield-top'] = function () { return zonePanel('farfield-top'); };

  function zonePanel(zid) {
    var z = zoneById(zid), t = ZONE_EDIT[zid] || z.type, h = [];
    h.push('<div class="flu-tabs" id="fluTabs">' +
      ['momentum:Momentum', 'thermal:Thermal', 'turbulence:Turbulence'].map(function (s) {
        var kv = s.split(':');
        return '<button data-k="bctab" data-v="' + kv[0] + '"' + (S.bctab === kv[0] ? ' class="is-on"' : '') + '>' + kv[1] + '</button>';
      }).join('') + '</div>');
    h.push(F('Zone Name', '<input class="input" data-k="zname" value="' + z.name + '" readonly>'));
    h.push(F('Type', SEL('ztype:' + zid, [
      ['velocity-inlet', 'velocity-inlet'], ['pressure-outlet', 'pressure-outlet'],
      ['pressure-far-field', 'pressure-far-field'], ['wall', 'wall'],
      ['symmetry', 'symmetry'], ['outflow', 'outflow']
    ], t)));
    h.push('<div style="font-size:11px;color:var(--txt-3);margin:2px 0 8px">' + z.desc + '</div>');

    if (t === 'wall') {
      h.push(G('Wall Conditions'));
      h.push('<div class="field" style="gap:14px">' + CHK('shear', 'Shear Condition → Slip', (ZONE_EDIT[zid + ':slip'] === true)) + '</div>');
      if (S.bctab === 'momentum') {
        h.push(F('Shear Condition', RAD('shearcond:' + zid,
          [['noslip', 'No Slip（无滑移）'], ['slip', 'Slip（自由滑移）']], ZONE_EDIT[zid + ':slip'] ? 'slip' : 'noslip')));
        h.push(NOTE(zid === 'ground'
          ? '地面选 <b>Slip</b>：切应力为 0，只传递法向压力。F1 在移动地面上以 50 m/s 相对风速行驶，' +
            '地面是理想无摩擦壁面，选 No Slip 会凭空多出一大块摩擦阻力。'
          : '车身壁面保持 <b>No Slip</b>：气流贴着车身减速转向，压力积分才是气动力的来源。' +
            '前翼/后翼的吸力峰也靠壁面附近的低速层算出来。'));
      } else if (S.bctab === 'thermal') {
        h.push(F('Thermal Condition', SEL('wallT:' + zid, [['heat-flux', 'Heat Flux'], ['temperature', 'Temperature']], 'heat-flux')));
        h.push(NOTE('能量方程关闭时，Thermal 选项卡整体变灰。'));
      } else {
        h.push(KV('Turbulence Model', viscousName()));
        h.push(NOTE('壁面处的 k、ω 由模型自带的壁面处理给出，<b>不需要手动填</b>。'));
      }
      return h.join('');
    }

    if (t === 'symmetry') {
      h.push(G('Symmetry'));
      h.push(KV('Normal Velocity', '0（不穿透）'));
      h.push(KV('Tangent Velocity', '自由（不施加切应力）'));
      h.push(NOTE('symmetry 面<b>不需要任何数值</b>，求解器自动满足 ∂φ/∂n = 0。' +
        '侧向与顶部远场用它是外流场最省事的做法。' +
        (zid.indexOf('farfield') === 0 ? '<br><b style="color:var(--warn)">坑：</b>如果把远场改成 velocity-inlet，' +
          '气流会沿 ±y/±z 硬吹进计算域，直接把出口吹出 39% 回流。' : '')));
      return h.join('');
    }

    if (t === 'velocity-inlet') {
      if (S.bctab === 'momentum') {
        h.push(G('Momentum'));
        h.push(F('Vel. Spec. Method', SEL('vin_method', [['magdir', 'Magnitude and Direction'], ['comp', 'Components']], 'magdir')));
        h.push(F('Velocity', '<div class="field-row">' + INP('vin_mag', S.vel) + '<span class="muted">m/s</span></div>'));
        h.push(F('Direction', '<div class="field-row">' + INP('vin_x', '1') + INP('vin_y', '0') + INP('vin_z', '0') + '</div>'));
      } else if (S.bctab === 'turbulence') {
        h.push(G('Turbulence'));
        h.push(F('Spec. Method', SEL('vin_turb', [['iv', 'Intensity and Viscosity Ratio'], ['kepsi', 'k and epsilon'], ['kwi', 'k and omega']], 'iv')));
        h.push(F('Turb. Intensity', '<div class="field-row">' + INP('vin_i', '5') + '<span class="muted">%</span></div>'));
        h.push(F('Viscos. Ratio', '<div class="field-row">' + INP('vin_r', '10') + '<span class="muted"></span></div>'));
        h.push(NOTE('湍流强度取 5%（相当于来流已有轻微湍流，常见取 0.1%~10%）。' +
          '注意 Reference Values 面板里的 <b>Velocity</b> 是 50 m/s，' +
          '和这里的入口值必须一致，否则 Cd 换算的分母对不上。'));
      } else {
        h.push(G('Thermal'));
        h.push(F('Thermal Condition', SEL('vin_T', [['temp', 'Temperature'], ['flux', 'Heat Flux']], 'temp')));
        h.push(F('Static Temp.', '<div class="field-row">' + INP('vin_t', '300') + '<span class="muted">K</span></div>'));
        h.push(NOTE('能量方程关闭时本选项卡不可用；开能量后才需要给 300 K。'));
      }
      return h.join('');
    }

    if (t === 'pressure-outlet') {
      if (S.bctab === 'momentum') {
        h.push(G('Momentum'));
        h.push(F('Gauge Pressure', '<div class="field-row">' + INP('pout_p', '0') + '<span class="muted">Pa</span></div>'));
        h.push(F('Backflow Total P', SEL('pout_vf', [['vn', 'Normal to Flow'], ['vec', 'Vector Components']], 'vn')));
        h.push(F('Backflow Dir.', '<div class="field-row">' + INP('pout_n', '0') + INP('pout_x', '-1') + INP('pout_y', '0') + INP('pout_z', '0') + '</div>'));
        h.push(NOTE('出口表压 0 Pa：等价于"无穷远处大气压"。<b>反向流为零</b>是理想状态，' +
          '一旦出现负的 x 方向速度就说明域太小或湍流模型过激，要去查质量流量报告。'));
      } else if (S.bctab === 'turbulence') {
        h.push(G('Turbulence'));
        h.push(F('Backflow Int.', '<div class="field-row">' + INP('pout_i', '5') + '<span class="muted">%</span></div>'));
        h.push(NOTE('回流区的湍流参数只在<b>出现回流时</b>才起作用，用默认值即可。'));
      } else {
        h.push(G('Thermal'));
        h.push(F('Thermal Cond.', SEL('pout_T', [['temp', 'Temperature'], ['flux', 'Heat Flux']], 'temp')));
        h.push(NOTE('能量方程关闭时不可用。'));
      }
      return h.join('');
    }

    if (t === 'pressure-far-field') {
      h.push(G('Momentum'));
      h.push(F('Gauge Pressure', '<div class="field-row">' + INP('pf_p', '0') + '<span class="muted">Pa</span></div>'));
      h.push(F('Mach Number', '<div class="field-row">' + INP('pf_m', '0.147') + '</div>'));
      h.push(F('X-Component', '<div class="field-row">' + INP('pf_x', '1') + INP('pf_y', '0') + INP('pf_z', '0') + '</div>'));
      h.push(NOTE('用 pressure-far-field 必须把材料改成 <b>ideal-gas</b>，' +
        '否则 Fluent 在初始化前就报错：<code>Error: density must be a function of pressure</code>。'));
      return h.join('');
    }

    h.push(G('Momentum'));
    h.push(F('Diffuse Outflow', SEL('outf', [['yes', 'Yes'], ['no', 'No']], 'yes')));
    h.push(NOTE('outflow 边界会把速度、压力、组分按零梯度外推，适合非定常可压流；定常外流用 pressure-outlet 更稳。'));
    return h.join('');
  }

  PANEL.mesh = function () {
    var b = blockingRatio();
    return G('Mesh Summary') +
      KV('Cells', '12,486,720') + KV('Nodes', '2,674,318') +
      KV('Cell Type', 'poly-hexcore') +
      KV('Failed Faces', '<span style="color:var(--ok)">0</span>') +
      KV('Free Faces', '<span style="color:var(--ok)">0</span>') +
      G('Quality') +
      KV('Min Orthogonal Quality', '<span style="color:var(--warn)">0.17</span>') +
      KV('Max Skewness', '<span style="color:var(--warn)">0.85</span>') +
      KV('Max Aspect Ratio', '4 820') +
      NOTE('判据：<b>Orthogonal Quality &gt; 0.15</b>、<b>Skewness &lt; 0.90</b>。' +
        '正交质量低于 0.1 几乎必然残差发散；本算例最差单元出现在扩散器喉部。' +
        '点 Mesh 面板的 <code>Check</code> 相当于 TUI 的 <code>/mesh/check</code>。') +
      G('Size Functions') +
      F('Size Function', SEL('sizefn', [['curvprox', 'Curvature & Proximity'], ['curv', 'Curvature'], ['prox', 'Proximity']], 'curvprox')) +
      F('Min Size', '<div class="field-row">' + INP('smin', '0.005') + '<span class="muted">m</span></div>') +
      F('Max Size', '<div class="field-row">' + INP('smax', '0.15') + '<span class="muted">m</span></div>') +
      F('Growth Rate', '<div class="field-row">' + INP('sgrow', '1.2') + '</div>') +
      F('Max Length', '<div class="field-row">' + INP('blen', '0.02') + '<span class="muted">m</span></div>') +
      NOTE('合法值只有 <code>Curvature</code> / <code>Proximity</code> / <code>Curvature &amp; Proximity</code>' +
        ' —— <b>没有 "Basic" 这个选项</b>。Growth Rate 1.2 意味着每往外一层单元边长只涨 20%，' +
        '远场才不会因为跳太大把尾流糊掉。') +
      G('Body of Influence') +
      KV('BOI', S.view.boi ? 'wake-box（已启用）' : '未启用') +
      Btn('boi', '显示 BOI 线框', true) +
      NOTE('BOI 是一个<b>长条控制体</b>，强制在它里面塞小网格，跨过车体切开就会直接失败。' +
        '本例用它罩住后翼下游的尾流区（Max Length 20 mm），这是阻力主源。') +
      G('计算域 / 堵塞比') +
      slider('lateral', 2, 8, 0.5, S.lateral, ' m', 'fluLat') +
      KVi('入口截面积', fmt(b.area, 1) + ' m²（宽 ' + fmt(b.w, 1) + ' × 高 ' + fmt(b.h, 2) + '）', 'fluLatArea') +
      KVi('堵塞比 1.5/A', fmt(b.ratio, 2) + ' %', 'fluLatRatio') +
      NOTE('堵塞比 &lt; 3~5% 时，域边界对车身附近流场的扰动可以忽略，等效于"无限大流体"。' +
        '侧向扩到 3W（' + (2.0 + 2 * 6).toFixed(0) + ' m 宽）时堵塞比 ' + fmt(1.5 / ((2.0 + 2 * 6) * b.h) * 100, 2) + '%，就达标了。');
  };

  PANEL.refvals = function () {
    var q = dynP();
    return G('Reference Values') +
      F('Density', '<div class="field-row">' + INP('refRho', S.refRho) + '<span class="muted">kg/m³</span></div>') +
      F('Velocity', '<div class="field-row">' + INP('refVel', S.refVel) + '<span class="muted">m/s</span></div>') +
      F('Area', '<div class="field-row">' + INP('area', S.area) + '<span class="muted">m²</span></div>') +
      F('Length', '<div class="field-row">' + INP('refLen', S.refLen) + '<span class="muted">m</span></div>') +
      G('换算') +
      KV('动压 q = ½ρU²', fmt(q, 2) + ' Pa') +
      KV('Cd = 1.0 → Fx', fmt(q * S.area / 1000, 3) + ' kN') +
      KV('Cl = 1.0 → Fy', fmt(q * S.area / 1000, 3) + ' kN') +
      NOTE('<b>Area 填迎风投影面积 1.5 m²</b>（约 5.4 m × 0.28 m）。' +
        '如果误填成车身表面积 6 m²，Cd 会凭空缩小到真值的 1/4；' +
        '如果漏设全部用默认 1 m²，Cd 会直接放大 1.5 倍。' +
        '<b>参考值是所有气动力对比的分母，错一次整套结果就废了。</b>');
  };

  PANEL.reportdef = function () {
    return G('Report Definitions (3)') +
      '<div class="flu-tbl"><table class="flu-tbl">' +
      '<tr><th>Name</th><th>Type</th><th>Write</th></tr>' +
      '<tr><td class="mono">cd-monitor</td><td>Force Report</td><td>cd.out</td></tr>' +
      '<tr><td class="mono">cl-monitor</td><td>Force Report</td><td>cl.out</td></tr>' +
      '<tr><td class="mono">mass-balance</td><td>Flux Report</td><td>flux.out</td></tr>' +
      '</table></div>' +
      Btn('newreport', '+ New Report Definition', true) +
      NOTE('Report Definition 会在<b>每次迭代结束时</b>把数值追加进 .out 文件。' +
        '有了它才能画"力 vs 迭代"历史曲线——这是判断"真收敛"最可靠的手段：' +
        '残差下去了但 Cd 还在漂，说明物理量根本没稳。');
  };

  PANEL.init = function () {
    return G('Initialization') +
      F('Type', SEL('inittype', [['standard', 'Standard Initialization'], ['hybrid', 'Hybrid Initialization']], 'standard')) +
      F('Compute from', SEL('initfrom', [['inlet', 'inlet'], ['autos', 'Automatic'], ['car-skin', 'car-skin']], 'inlet')) +
      '<div class="field" style="gap:14px">' + CHK('init_x', 'X Velocity', false) + CHK('init_y', 'Y Velocity', false) + '</div>' +
      '<div class="field" style="gap:14px">' + CHK('init_k', 'Turb. Kinetic Energy', false) + CHK('init_w', 'Specific Diss. Rate', false) + '</div>' +
      '<div style="margin-top:6px">' + Btn('initialize', 'Initialize（初始化流场）', true) + '</div>' +
      '<div class="flu-bar"><i id="fluInitBar"></i></div>' +
      KV('Solution Initialized', S.initialized ? '<span style="color:var(--ok)">yes</span>' : '<span style="color:var(--warn)">no</span>') +
      NOTE('<b>Standard Initialization</b> 用"Compute from"指定的区域插值出全场初值：' +
        '选中 inlet 就直接用入口的 50 m/s 铺满整个计算域——这是外流场最省事、也最不容易发散的做法。' +
        '没初始化就点 Calculate 会直接报 <code>Error: Initialization is not done</code>。');
  };

  PANEL.run = function () {
    return G('Run Calculation') +
      F('Number of Iterations', '<div class="field-row">' + INP('target', S.target) + '</div>') +
      '<div class="field" style="gap:14px">' + CHK('chk_continuity', 'Check Convergence', true) + '</div>' +
      '<div style="margin-top:6px">' + Btn('calc', S.running ? '⏸ 暂停（Pause）' : '▶ 计算（Calculate）', true) +
      Btn('resetiter', '⟲ 重置（Reset）') + '</div>' +
      '<div class="flu-bar"><i id="fluRunBar"></i></div>' +
      KV('Current Iteration', S.iters) +
      KV('Status', S.running ? '<span style="color:var(--accent)">running…</span>'
          : (S.converged ? '<span style="color:var(--ok)">converged</span>' : (S.iters ? 'paused' : 'idle'))) +
      G('收敛判据摘要') +
      KV('continuity', exp3(S.crit.cont)) + KV('x / y / z-velocity', exp3(S.crit.mom)) +
      KV('k / omega', exp3(S.crit.turb)) +
      NOTE('"Number of Iterations" 是<b>上限</b>，不是目标。只要所有残差都低于判据并保持 20 步，' +
        'Fluent 就自动停机——本算例大约 335 次就停了，800 只是兜底。' +
        '对应 TUI：<code>/solve/iterate 800</code>。');
  };

  PANEL.residual = function () {
    return G('Residual Monitors') +
      KV('Plot', 'residuals-set（对数坐标 1e0 ~ 1e-6）') +
      KV('Print', 'every 10 iterations') +
      KV('Report', 'every 10 iterations（写入 .out）') +
      KV('Check Convergence', 'on（需连续 20 步达标）') +
      NOTE('左边监视器画的就是这张表。收敛判据不在 Run Calculation 面板里，' +
        '而在 <b>Solution → Convergence Criteria</b>——这是最常见的找不到的地方。' +
        '等价 TUI：<code>/solve/set/convergence-criteria 1e-04 1e-03 1e-03 1e-03 1e-03 1e-03</code>。') +
      G('质量守恒（独立于残差的第二重验证）') +
      KV('inlet 质量流量', S.iters ? fmt(S.fluxes.inlet, 2) + ' kg/s' : '—') +
      KV('outlet 质量流量', S.iters ? fmt(S.fluxes.outlet, 2) + ' kg/s' : '—') +
      KV('不平衡度', S.iters ? fmt(S.fluxes.imbalance, 3) + ' %' : '—') +
      NOTE('入口 ρAU = ' + fmt(S.refRho, 3) + ' × ' + fmt(blockingRatio().area, 1) + ' × ' + S.vel + ' = <b>' +
        fmt(S.refRho * blockingRatio().area * S.vel, 2) + ' kg/s</b>，出口应当是它的负值。' +
        '两者差 &lt; 0.1% 才算质量守恒成立。');
  };

  PANEL.criteria = function () {
    var h = [G('Convergence Criteria'), '<div class="flu-tbl"><table class="flu-tbl">',
      '<tr><th>Equation</th><th>Absolute</th></tr>'];
    for (var i = 0; i < CRIT_ROWS.length; i++) {
      var r = CRIT_ROWS[i];
      h.push('<tr><td class="mono">' + r.name + '<div class="muted" style="font-size:9.5px">' + r.field + '</div></td>' +
             '<td><input data-k="crit:' + r.key + '" value="' + exp3(resCrit(r.key)) + '"></td></tr>');
    }
    h.push('</table></div>');
    h.push('<div class="flu-tbl" style="margin-top:6px"><table class="flu-tbl">' +
      '<tr><td class="mono">energy</td><td><input data-k="crit:energy" value="' + exp3(S.crit.energy) + '"' +
      (S.energy ? '' : ' disabled') + '></td></tr>' +
      '<tr><td class="mono">relative / scaled</td><td class="muted">' + (S.energy ? 'off' : 'off（默认关闭）') + '</td></tr>' +
      '</table></div>');
    h.push(Btn('setcrit', 'Apply（应用到求解器）', true));
    h.push(NOTE('经验值：连续方程 <b>1e-4</b>，动量与湍流量 <b>1e-3</b>，能量 <b>1e-6</b>。' +
      '定常外流把连续方程放得太松（比如 1e-3）往往收敛到假解。'));
    return h.join('');
  };

  PANEL.contours = function () {
    return G('Contours') +
      F('Contours of', SEL('contour_of', [
        ['cp', 'Pressure Coefficient'], ['pressure', 'Static Pressure'],
        ['velocity', 'Velocity'], ['k', 'Turbulent Kinetic Energy'], ['vorticity', 'Vorticity Magnitude']
      ], 'cp')) +
      F('Surfaces', SEL('contour_surf', [['car', 'car-skin'], ['car+ground', 'car-skin + ground'], ['all', '全部面']], 'car')) +
      '<div class="field" style="gap:14px">' + CHK('node_vals', 'Node Values', false) + CHK('show_legend', 'Legend', S.view.legend) + '</div>' +
      F('Filled', SEL('filled', [['yes', 'Filled'], ['no', 'Contours']], 'yes')) +
      '<div style="margin-top:6px">' + Btn('display_c', 'Display（显示云图）', true) + Btn('hide_c', 'Hide') + '</div>' +
      G('Cp 极值（50 m/s 来流）') +
      KV('最高 · 鼻锥驻点', '+1.05（车头高压）') +
      KV('最低 · 车底后段/扩散器出口', '−1.58（车底吸力最强处）') +
      KV('尾流恢复', '+0.35 ~ +0.6') +
      NOTE('Cp = (p − p∞) / (½ρU²)，是<b>无量纲</b>量，所以换海拔时 Cp 云图本身不变，' +
        '变的是它代表的<b>绝对压差</b>与最后的力。' +
        '前翼下表面与底板的红色（低压）区就是下压力的来源。');
  };

  PANEL.pathlines = function () {
    return G('Pathlines') +
      F('Pathlines of', SEL('path_of', [['velocity', 'Velocity'], ['vorticity', 'Vorticity Magnitude'], ['cp', 'Pressure Coefficient']], 'velocity')) +
      F('Release From', SEL('path_from', [['inlet', 'inlet'], ['car', 'car-skin'], ['ground', 'ground']], 'inlet')) +
      F('Paths', '<div class="field-row">' + INP('paths', '500') + '</div>') +
      F('Skip', '<div class="field-row">' + INP('skip', '5') + '</div>') +
      F('Step Size', '<div class="field-row">' + INP('pstep', '500') + '</div>') +
      '<div style="margin-top:6px">' + Btn('display_p', 'Display（释放流线）', true) + Btn('hide_p', 'Clear') + '</div>' +
      G('对比：不同湍流模型的流场') +
      '<div class="field" style="gap:14px">' +
      RAD('turbcmp', [['lam', '层流'], ['keps', 'k-epsilon'], ['kw', 'k-omega SST']], S.viscous) + '</div>' +
      NOTE('切换上面的模型，视口里的流线会立刻换成该模型该有的样子：' +
        '层流贴着车身光滑绕过、尾流窄；k-epsilon 尾流过宽、底板下洗弱；' +
        'SST 在后轮与翼端给出<b>非对称的涡对</b>，把气流往下洗——这正是 F1 底板设计的核心机制。');
  };

  PANEL.forces = function () {
    var f = forceNow();
    return G('Wall Forces') +
      '<div class="field" style="gap:14px">' + CHK('do_cd', 'Cd (Drag Coefficient)', true) +
      CHK('do_cl', 'Cl (Lift Coefficient)', true) + CHK('do_cm', 'Cm (Moment)', false) + '</div>' +
      F('Surfaces', SEL('force_surf', [['car+ground', 'car-skin + ground'], ['car', '只勾 car-skin'], ['ground', '只勾 ground']], 'car+ground')) +
      G('Force Vector') +
      F('Drag', '<div class="field-row">' + INP('drag_x', '1') + INP('drag_y', '0') + INP('drag_z', '0') + '</div>') +
      F('Lift', '<div class="field-row">' + INP('lift_x', '0') + INP('lift_y', '0') + INP('lift_z', '-1') + '</div>') +
      '<div style="margin-top:6px">' + Btn('compute_f', 'Compute（计算）', true) + Btn('write_f', 'Write（写文件）') + '</div>' +
      G('Report') +
      KV('Drag Coefficient Cd', S.iters ? fmt(f.cd, 4) : '—') +
      KV('Lift Coefficient Cl', S.iters ? fmt(f.cl, 4) : '—') +
      KV('Drag  Fx', S.iters ? fmt(f.fx, 0) + ' N = ' + fmt(f.fx / 1000, 2) + ' kN' : '—') +
      KV('Lift  Fy', S.iters ? fmt(f.fy, 0) + ' N = ' + fmt(f.fy / 1000, 2) + ' kN' : '—') +
      NOTE('<b>Lift 方向必须给 (0, 0, −1)</b>。F1 的升力是<b>向下</b>的（压低车），' +
        '给 +1 会得到一个负的下压力。' +
        '<b>受力面必须含 car-skin + ground</b>：漏掉地面会少算一大块底板下压力。');
  };

  PANEL.fluxes = function () {
    return G('Flux Reports') +
      F('Report Type', SEL('flux_type', [['mass', 'Mass Flow Rate'], ['net', 'Net Fluxes']], 'mass')) +
      '<div class="field" style="gap:14px">' + CHK('fx_in', 'inlet', true) + CHK('fx_out', 'outlet', true) + '</div>' +
      '<div style="margin-top:6px">' + Btn('compute_flux', 'Compute', true) + '</div>' +
      G('结果') +
      KV('inlet', S.iters ? fmt(S.fluxes.inlet, 3) + ' kg/s' : '—') +
      KV('outlet', S.iters ? fmt(S.fluxes.outlet, 3) + ' kg/s' : '—') +
      KV('Net', S.iters ? fmt(S.fluxes.inlet + S.fluxes.outlet, 4) + ' kg/s' : '—') +
      KV('不平衡度', S.iters ? fmt(S.fluxes.imbalance, 3) + ' %' : '—') +
      NOTE('两个 zone <b>必须同时勾选</b>，只勾一个算不出不平衡。' +
        '出口质量流量为<b>负值</b>是正常的——法向朝外，符号相反代表物质流出。' +
        '一旦它变成正值，就是回流，域或边界条件要返工。');
  };

  PANEL.history = function () {
    return G('Report Plot') +
      F('Y Axis Function', SEL('hist_y', [['cdcl', 'cd, cl'], ['cd', 'cd only']], 'cdcl')) +
      F('Report Files', SEL('hist_file', [['def', 'Report Definition (cd-monitor)']], 'def')) +
      '<div style="margin-top:6px">' + Btn('hist_create', 'Create / Plot Report', true) + '</div>' +
      NOTE('左边监视器下方的曲线就是这个图：Cd 与 Cl 随迭代的变化。' +
        '看它们<b>从离谱值收敛到一条水平线</b>，比单看残差更有说服力。' +
        '稳定判据：连续 200 步内两次力报告之差 &lt; 0.5%。');
  };

  /* ===========================================================================
   * 8. Fluent Launcher（第 1 步的实操入口）
   * ======================================================================== */
  var L = { dim: '3d', dp: true, type: 'solution', proc: 4, warn: '' };

  function renderLauncher() {
    var h = [];
    h.push('<div class="flu-lc">');
    h.push('<div class="flu-lc-hd"><span class="dot" style="width:8px;height:8px;border-radius:50%;background:var(--accent)"></span>' +
           'ANSYS Fluent 2023 R1 — Launcher</div>');
    h.push('<div class="flu-lc-bd">');
    h.push('<div class="field" style="margin-bottom:8px"><label style="flex:0 0 74px">Dimension</label>' + RAD('ldim', [['2d', '2D'], ['3d', '3D']], L.dim) + '</div>');
    h.push('<div class="field" style="margin-bottom:8px"><label style="flex:0 0 74px">Options</label>' + CHK('ldp', 'Double Precision', L.dp) + '</div>');
    h.push('<div class="field" style="margin-bottom:8px"><label style="flex:0 0 74px">Type</label>' + SEL('ltype', [['solution', 'Solution'], ['meshing', 'Meshing']], L.type) + '</div>');
    h.push('<div class="field" style="margin-bottom:4px"><label style="flex:0 0 74px">Processes</label>' +
           '<input class="input mono" data-k="lproc" value="' + L.proc + '" style="max-width:80px"></div>');
    h.push('<div class="flu-warn' + (L.warn ? ' is-on' : '') + '" id="fluLwarn">' + L.warn + '</div>');
    h.push('</div>');
    h.push('<div class="flu-lc-ft"><button class="btn btn-primary" data-k="lstart">Start</button>' +
           '<span class="muted" style="font-size:11px">Fluent 2023 R1 · 双精度</span></div>');
    h.push('</div>');
    D.launcher.innerHTML = h.join('');
  }

  function launcherCheck(silent) {
    L.warn = '';
    if (L.dim !== '3d') L.warn = '<b>Dimension 选了 2D：</b>F1 是全尺寸三维几何，2D 只能算一个截面，Setup 树里没有 3D 专用的 Mesh 节点。';
    else if (L.type === 'meshing') L.warn = '<b>Type 误选 Meshing：</b>进的是 <b>Meshing 模式</b>，这里只有 Task 页面，' +
      '<b>不会出现 Setup 树</b>（General / Models / Boundary Conditions 全部没有）。想划网格请在 Solution 模式下走 Watertight 工作流。';
    else if (L.proc < 1 || L.proc > 12) L.warn = 'Processes 必须是 1~12 的整数。它是并行分区数，取 4 正好吃满 4 核。';
    else if (!L.dp) L.warn = '没勾 <b>Double Precision</b>：单精度在 1e-4 量级的连续方程残差上很容易提前停机，建议勾上。';
    if (silent) return !L.warn;
    D.launcher.innerHTML = '';
    renderLauncher();
    var w = D.root.querySelector('#fluLwarn');
    if (w) { w.innerHTML = L.warn; w.className = 'flu-warn' + (L.warn ? ' is-on' : ''); }
    return !L.warn;
  }

  function doStart() {
    if (!launcherCheck(true)) { launcherCheck(false); API.toast('启动参数有问题，看 Launcher 里的黄条', 'warn'); return; }
    S.launched = true;
    D.launcher.style.display = 'none';
    renderTree();
    API.toast('已进入 Solution 模式，Setup 树可用', 'ok');
    say([
      ['Fluent Inc.  (2023 R1)  3d, double precision, 4 processes', 'ok'],
      ['> /file/start-transcript', 'cmd'],
      ['Transcript started: fluent-20260929-1420-3312.trn', 'sys'],
      ['License manager: ANSYS Student 2023 R1  —  ok', 'sys'],
      ['> ', 'cmd'],
      ['Fluent 界面已就绪。双击左侧 Setup 树的 <General> 确认 Solver 与 Operating Pressure。', 'info']
    ]);
    API.setStatus({ 模式: 'Solution（3d, double precision）' });
    updateStatus();
  }

  /* ===========================================================================
   * 9. 气动力结算卡片
   * ======================================================================== */
  function renderForceCard() {
    var f = forceNow();
    if (!f.has) {
      D.card.innerHTML = '<div class="flu-card-hd">气动力报告 · Wall Forces<span class="muted">未计算</span></div>' +
        '<div class="flu-card-body"><div class="flu-kv"><span>Cd / Cl</span><span>—</span></div>' +
        '<div class="flu-card-note"><b>还没有力报告。</b>Cd 与 Cl 是把 car-skin + ground 上的压力做面积积分、' +
        '再除以 ½ρU²A 得到的 —— <b>场没解出来，壁面压力就只是初值场的任意分配，积出来的数没有物理意义</b>。' +
        '先到 Initialization 面板点 Initialize，再点 Calculate 让残差降到判据以下，然后回来点 Compute。</div></div>';
      D.card.style.display = 'block';
      S.showCard = true;
      return;
    }
    var h = ['<div class="flu-card-hd">➤ Wall Forces 报告<span class="spacer"></span>' +
             '<button class="btn btn-sm btn-ghost" data-k="closecard">✕</button></div>'];
    h.push(KV('Drag Coefficient  Cd', fmt(f.cd, 4)));
    h.push(KV('Lift Coefficient  Cl', fmt(f.cl, 4)));
    h.push(KV('Drag  Fx  = Cd·q·A', fmt(f.fx, 0) + ' N  (' + fmt(f.fx / 1000, 2) + ' kN)'));
    h.push(KV('Lift  Fy  = Cl·q·A', fmt(f.fy, 0) + ' N  (' + fmt(f.fy / 1000, 2) + ' kN)'));
    h.push(KV('q = ½ρU² = ½×' + fmt(S.refRho, 3) + '×' + S.refVel + '²', fmt(f.q, 1) + ' Pa'));
    h.push(KV('A（迎风投影）', S.area + ' m²'));
    h.push(KV('收敛于第', S.iters + ' 次迭代'));
    h.push('<div class="flu-card-note"><b>地面效应：</b>底板把车底与地面围成一条通道，气流被堵在下面出不去，' +
           '只能加速、底板上下形成巨大压差——这股向下的力就是 Cl ≈ ' + fmt(f.cl, 1) + '（约 ' + fmt(f.fy / 1000, 1) +
           ' kN）的下压力。' + (Math.abs(f.cl) > Math.abs(f.cd) ? '注意下压力比阻力大 6 倍以上，弯道上它决定轮胎载荷。' : '') + '</div>');
    D.card.innerHTML = h.join('');
    D.card.style.display = 'block';
    S.showCard = true;
  }

  /* ===========================================================================
   * 10. 监视器画布
   * ======================================================================== */
  /* 逻辑高度必须来自 **CSS 盒模型**（clientHeight），绝不能读 height 属性：
     canvas.height 是 IDL 属性，按 HTML 规范会反射成内容属性；一旦把它读回来再乘一次
     devicePixelRatio，dpr>1 的屏幕上高度就变成 118→148→185→231… 的几何级数，
     不到一秒就把右栏撑爆（drawResiduals 由 tick() 每 50ms 调一次）。
     对照：zemax.js 的同款 fitCanvas 用的就是 clientHeight，所以它是稳的。 */
  function fitCanvas(cv) {
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var w = cv.clientWidth || 220;
    /* data-logical-h 是"还没布局时"的兜底高度：只读、绝不写回属性，
       所以它不会参与上面那个发散。 */
    var h = cv.clientHeight || parseInt(cv.getAttribute('data-logical-h'), 10) || 100;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    var g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    return { g: g, w: w, h: h };
  }

  function drawResiduals() {
    var c = fitCanvas(D.resCv), g = c.g, w = c.w, h = c.h;
    var padL = 30, padR = 4, padT = 6, padB = 12;
    var iw = w - padL - padR, ih = h - padT - padB;
    var yMin = 1e-6, yMax = 1e1;
    var nMax = Math.max(S.target, S.iters, 100);
    function X(n) { return padL + (n / nMax) * iw; }
    function Y(v) {
      var t = (Math.log10(clamp(v, yMin, yMax)) - Math.log10(yMin)) / (Math.log10(yMax) - Math.log10(yMin));
      return padT + (1 - t) * ih;
    }
    g.font = '9px Consolas, monospace';
    for (var e = 0; e <= 6; e++) {
      var v = Math.pow(10, -e), y = Y(v);
      g.strokeStyle = e === 0 ? '#2b323d' : '#1d232b';
      g.beginPath(); g.moveTo(padL, y); g.lineTo(w - padR, y); g.stroke();
      g.fillStyle = '#5f6b7a'; g.textAlign = 'right';
      g.fillText(e === 0 ? '1e0' : '1e-' + e, padL - 3, y + 3);
    }
    /* 判据虚线 */
    g.setLineDash([3, 3]); g.strokeStyle = '#2f6b4b';
    g.beginPath(); g.moveTo(padL, Y(S.crit.cont)); g.lineTo(w - padR, Y(S.crit.cont)); g.stroke();
    g.setLineDash([]);
    /* 曲线 */
    for (var s = 0; s < S.res.length; s++) {
      var R = S.res[s];
      g.strokeStyle = R.color; g.lineWidth = 1.2; g.beginPath();
      for (var i = 0; i < R.v.length; i++) {
        var px = X(R.it[i]), py = Y(R.v[i]);
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.stroke();
    }
    g.fillStyle = '#5f6b7a'; g.textAlign = 'left';
    g.fillText('iter 0', padL, h - 2);
    g.textAlign = 'right'; g.fillText(String(nMax), w - padR, h - 2);
    var lg = [];
    for (var k = 0; k < RES_DEF.length; k++) lg.push('<i style="color:' + RES_DEF[k].color + '">' + RES_DEF[k].label + '</i>');
    D.resLg.innerHTML = lg.join('');
    D.resNow.innerHTML = S.iters
      ? '<span style="color:' + (maxRes() <= S.crit.mom ? 'var(--ok)' : 'var(--txt-2)') + '">max ' + exp3(maxRes()) + '</span>'
      : '未开始';
  }

  function drawForceHist() {
    var c = fitCanvas(D.fcCv), g = c.g, w = c.w, h = c.h;
    var padL = 4, padR = 4, padT = 4, padB = 10;
    var iw = w - padL - padR, ih = h - padT - padB;
    if (!S.hist.it.length) {
      g.fillStyle = '#4a5563'; g.font = '10px sans-serif'; g.textAlign = 'center';
      g.fillText('迭代后这里画 Cd / Cl 历史曲线', w / 2, h / 2 + 3);
      D.frcNow.textContent = '—';
      return;
    }
    var nMax = Math.max(50, S.hist.it[S.hist.it.length - 1]);
    var cdMax = 0, clMax = 0, cdMin = 0, clMin = 0;
    for (var i = 0; i < S.hist.cd.length; i++) {
      cdMax = Math.max(cdMax, S.hist.cd[i]); clMax = Math.max(clMax, S.hist.cl[i]);
      cdMin = Math.min(cdMin, S.hist.cd[i]); clMin = Math.min(clMin, S.hist.cl[i]);
    }
    function X(n) { return padL + (n / nMax) * iw; }
    function series(arr, mx, mn, color) {
      g.strokeStyle = color; g.lineWidth = 1.2; g.beginPath();
      for (var j = 0; j < arr.length; j++) {
        var t = (arr[j] - mn) / Math.max(1e-6, mx - mn);
        var y = padT + (1 - clamp(t, 0, 1)) * ih;
        if (j === 0) g.moveTo(X(S.hist.it[j]), y); else g.lineTo(X(S.hist.it[j]), y);
      }
      g.stroke();
    }
    series(S.hist.cd, cdMax, cdMin, '#f0857a');
    series(S.hist.cl, clMax, clMin, '#7fdcaa');
    g.font = '9px Consolas, monospace';
    g.fillStyle = '#f0857a'; g.textAlign = 'left'; g.fillText('Cd', padL + 2, padT + 8);
    g.fillStyle = '#7fdcaa'; g.fillText('Cl', padL + 20, padT + 8);
    g.fillStyle = '#5f6b7a'; g.textAlign = 'right';
    g.fillText('iter ' + nMax, w - padR, h - 1);
    var f = forceNow();
    D.frcNow.innerHTML = f.has
      ? 'Cd <span style="color:#f0857a">' + fmt(f.cd, 3) + '</span> · Cl <span style="color:#7fdcaa">' + fmt(f.cl, 2) + '</span>'
      : '<span class="muted">未迭代 —— 无压力积分结果</span>';
  }

  /* ===========================================================================
   * 11. 求解器推进（伪求解：残差逐迭代下降、力报告逐次结算、到判据自动停）
   * ======================================================================== */
  function resetSolver(quiet) {
    if (timer) { global.clearInterval(timer); timer = null; }
    S.running = false; S.iters = 0; S.converged = false; S.stopReason = ''; S.belowCnt = 0;
    S.res = [];
    for (var i = 0; i < RES_DEF.length; i++) S.res.push({ key: RES_DEF[i].key, name: RES_DEF[i].label, color: RES_DEF[i].color, it: [], v: [] });
    S.hist = { it: [], cd: [], cl: [] };
    S.fluxes = { inlet: 0, outlet: 0, imbalance: 0 };
    S.initialized = false;
    drawResiduals(); drawForceHist(); updateStatus();
    if (!quiet) { say(['> /solve/initialize/initialize-flow  -- 重置为未初始化', 'cmd'], 'info'); }
    if (S.sel === 'run' || S.sel === 'init') renderProps();
  }

  function doInitialize() {
    resetSolver(true);
    S.initialized = true;
    tui('/solve/initialize/compute-defaults/pressure-based');
    tui('/solve/initialize/initialize-flow');
    var b = blockingRatio();
    S.fluxes.inlet = S.refRho * b.area * S.vel;
    out('Initializing solution with Standard Initialization from inlet …');
    out('  12,486,720 cells initialized, 0 errors.');
    out('  Reverse flow check for 0 interior faces …  0.0e+00 Hz');
    API.toast('流场已初始化，可以点 Calculate', 'ok');
    updateStatus(); renderProps();
    S.view.pathlines = true; refreshTools(); applyView();
  }

  function startSolver() {
    if (S.running) { pauseSolver(); return; }
    if (!S.initialized) {
      API.toast('还没初始化：先到 Initialization 面板点 Initialize', 'warn');
      out('Error: Solution is not initialized.  (/solve/iterate aborted)', 'err');
      return;
    }
    S.running = true;
    var sst = S.viscous === 'kw' && S.kwModel === 'sst';
    tui('/solve/iterate ' + S.target);
    out([' iter', 'continuity', 'x-velocity', 'y-velocity', 'z-velocity', 'k', 'omega', 'time/iter'].map(function (t) {
      return ('          ' + t).slice(-13);
    }).join(''), 'sys');
    if (!S.iters) {
      say([
        ['  1  1.0000e+00  2.9000e-02  2.1000e-02  1.7000e-02  2.1300e+00  2.7900e+00  0:12:41  ' + (S.target - 1) + '  ' + (sst ? '(k-omega SST)' : viscousName()), 'info'],
        ['Warning: No convergence history exists.  第一次迭代，残差从 1 开始归一。', 'warn']
      ]);
    }
    S.solvePaused = false;
    startSolverTimer();
    renderProps();
  }

  function startSolverTimer() {
    if (timer) global.clearInterval(timer);
    timer = global.setInterval(tick, 50);
  }
  function pauseSolver() {
    S.running = false;
    if (timer) { global.clearInterval(timer); timer = null; }
    out('Solution is paused at iteration ' + S.iters + '.', 'warn');
    renderProps();
  }

  function tick() {
    for (var n = 0; n < 6; n++) {
      if (!S.running) return;
      S.iters++;
      if (S.iters > S.target) { finish('reached the specified number of iterations (' + S.target + ')'); return; }
      var ok = true;
      for (var i = 0; i < RES_DEF.length; i++) {
        var d = RES_DEF[i];
        var val = resAt(d, S.iters);
        S.res[i].it.push(S.iters); S.res[i].v.push(val);
        if (val >= resCrit(d.key)) ok = false;
      }
      S.belowCnt = ok ? S.belowCnt + 1 : 0;
      /* 质量守恒：不平衡度跟着连续方程残差走（这是它作为第二重验证的意义） */
      var cont = S.res[0].v[S.res[0].v.length - 1];
      var b = blockingRatio();
      S.fluxes.inlet = S.refRho * b.area * S.vel;
      S.fluxes.imbalance = clamp(cont * 40, 0, 100);
      S.fluxes.outlet = -S.fluxes.inlet * (1 + S.fluxes.imbalance / 100);
      if (S.hist.it.length === 0 || S.iters % 5 === 0) {
        S.hist.it.push(S.iters); S.hist.cd.push(cdAt(S.iters)); S.hist.cl.push(clAt(S.iters));
      }
      if (S.iters % 20 === 0) {
        out('  ' + String(S.iters).padStart(4) + '  ' + RES_DEF.map(function (d) {
          return exp3(resAt(d, S.iters)).padStart(12);
        }).join(' ') + '  0:0' + Math.max(1, Math.round((S.target - S.iters) / 20)) + ':' + (S.target - S.iters), 'info');
      }
      if (S.belowCnt >= 20) { finish('solution is converged'); return; }
    }
    drawResiduals(); drawForceHist(); updateStatus();
    if (V.arrows) updateArrows();
    var bar = D.root.querySelector('#fluRunBar');
    if (bar) bar.style.width = (S.iters / S.target * 100).toFixed(1) + '%';
  }

  function finish(reason) {
    S.running = false; S.converged = true; S.stopReason = reason;
    if (timer) { global.clearInterval(timer); timer = null; }
    var b = blockingRatio();
    S.fluxes.inlet = S.refRho * b.area * S.vel;
    S.fluxes.outlet = -S.fluxes.inlet * (1 + S.fluxes.imbalance / 100);
    say([
      ['', 'info'],
      ['> ', 'cmd'],
      ['  ' + S.iters + '  ' + RES_DEF.map(function (d) { return exp3(resAt(d, S.iters)).padStart(12); }).join(' ') + '  0:00:00   0', 'ok'],
      ['solution ' + reason + ' after ' + S.iters + ' iterations', 'ok'],
      ['Note: Reverse flow is detected in 2 interior faces, 4 boundary faces.', 'warn'],
      ['    反向流警告是正常的——尾流涡里的局部回流，不是计算失败；', 'warn'],
      ['    但如果出口质量流量为正，说明域或边界条件要返工。', 'warn'],
      ['> /report/fluxes/mass-flow no inlet no outlet yes', 'cmd'],
      ['   Mass Flow Rate  inlet = ' + fmt(S.fluxes.inlet, 3) + ' kg/s   outlet = ' + fmt(S.fluxes.outlet, 3) + ' kg/s', 'ok'],
      ['   Imbalance = ' + fmt(S.fluxes.imbalance, 4) + ' %  (' + (S.fluxes.imbalance < 0.1 ? '质量守恒成立' : '尚未守恒') + ')', S.fluxes.imbalance < 0.1 ? 'ok' : 'warn']
    ]);
    API.toast('求解完成：' + S.iters + ' 次迭代' + (S.converged ? '，已收敛' : ''), 'ok');
    drawResiduals(); drawForceHist(); updateStatus();
    renderForceCard();
    S.view.arrows = true; S.view.pathlines = true; S.view.cp = true;
    refreshTools(); applyView();
    selectNode('forces');
  }

  /* ===========================================================================
   * 12. 事件（全部用事件委托，重复 enter 不会重复绑定）
   * ======================================================================== */
  function bindEvents() {
    D.root.addEventListener('click', onClick);
    D.root.addEventListener('change', onControl);
    D.root.addEventListener('input', onControl);
  }

  function onClick(e) {
    var t = e.target;
    while (t && t !== D.root && t.getAttribute) {
      var a = t.getAttribute && (t.getAttribute('data-act') || t.getAttribute('data-tg') ||
        t.getAttribute('data-node') || t.getAttribute('data-tog') || t.getAttribute('data-zone') ||
        (t.tagName === 'BUTTON' && t.getAttribute('data-k')));
      if (a) break;
      t = t.parentNode;
    }
    if (!t || t === D.root) return;
    var act = t.getAttribute && t.getAttribute('data-act');
    if (act) { doAction(act); return; }
    var tg = t.getAttribute && t.getAttribute('data-tg');
    if (tg) { toggleView(tg); return; }
    var node = t.getAttribute && t.getAttribute('data-node');
    if (node) { selectNode(node); if (S.launched) stepEcho(node); return; }
    var tog = t.getAttribute && t.getAttribute('data-tog');
    if (tog) { OPEN[tog] = !OPEN[tog]; renderTree(); return; }
    var z = t.getAttribute && t.getAttribute('data-zone');
    if (z) { selectNode('bc:' + z); if (S.launched) stepEcho('bc:' + z); return; }
    if (t.tagName === 'BUTTON') doAction(t.getAttribute('data-k'), t);
  }

  function onControl(e) {
    var t = e.target;
    var k = t.getAttribute && t.getAttribute('data-k');
    if (!k) return;
    if (k === 'ldim') { L.dim = t.value; launcherCheck(); return; }
    if (k === 'ldp') { L.dp = t.checked; launcherCheck(); return; }
    if (k === 'ltype') { L.type = t.value; launcherCheck(); return; }
    if (k === 'lproc') { L.proc = parseInt(t.value, 10) || 0; launcherCheck(); return; }
    if (k === 'bctab') { S.bctab = t.getAttribute('data-v'); renderProps(); return; }
    if (k.indexOf('crit:') === 0) {
      var key = k.slice(5), val = parseFloat(t.value);
      if (isNaN(val)) return;
      if (key === 'cont') S.crit.cont = val; else if (key === 'energy') S.crit.energy = val;
      else if (key === 'k' || key === 'w') S.crit.turb = val; else S.crit.mom = val;
      drawResiduals(); updateStatus();
      if (e.type === 'change') renderProps();
      return;
    }
    if (k.indexOf('ztype:') === 0) {
      var zid = k.slice(6), z = zoneById(zid);
      ZONE_EDIT[zid] = t.value;
      out('zone "' + z.name + '" zone-type: ' + t.value, 'info');
      if (t.value === 'velocity-inlet' && zid.indexOf('farfield') === 0) {
        out('Warning: velocity-inlet on farfield will drive flow along ±Y/±Z and cause ~39% backflow at the outlet.', 'err');
        API.toast('远场不能设速度入口！会造成 39% 回流', 'err');
      } else if (t.value === 'pressure-outlet' && zid === 'inlet') {
        out('Warning: no velocity-inlet paired with this pressure-outlet — flow has no driving condition.', 'err');
        API.toast('速度入口与压力出口必须成对使用', 'err');
      } else {
        out('zone "' + z.name + '" updated.', 'ok');
      }
      renderProps(); applyView();
      return;
    }
    if (k.indexOf('shearcond:') === 0) {
      ZONE_EDIT[k.slice(11) + ':slip'] = (t.value === 'slip');
      out('/define/boundary-conditions/wall ' + k.slice(11) + '  shear-condition: ' + (t.value === 'slip' ? '1 (Slip)' : '0 (No Slip)'), 'info');
      renderProps(); applyView();
      return;
    }
    if (t.type === 'checkbox') { onCheck(k, t.checked); return; }
    if (t.type === 'radio') { onRadio(k, t.value); return; }
    if (t.tagName === 'SELECT') { onSelect(k, t.value); return; }
    onValue(k, t.value, t, e.type === 'change');
  }

  function onCheck(k, v) {
    if (k === 'energy' || k === 'models_energy' || k === 'energy_on2') {
      S.energy = v;
      out('/define/models/energy? ' + (v ? 'yes' : 'no') + (v ? '  ← 已开启：会联立解出温度场' : '  ← 保持关闭：等温外气动不需要'), v ? 'warn' : 'ok');
    } else if (k === 'prodLimiter') { S.prodLimiter = v; out('Production Limiter: ' + (v ? 'on' : 'off')); }
    else if (k === 'shear') { ZONE_EDIT[curZoneId() + ':slip'] = v; renderProps(); applyView(); return; }
    else if (k === 'show_legend') { S.view.legend = v; applyView(); }
    else if (k === 'node_vals') { /* 仅示意 */ }
    else if (k === 'fx_in' || k === 'fx_out') { /* 勾选状态由 Compute 使用 */ }
    renderProps();
  }

  function onRadio(k, v) {
    if (k === 'turbRate') { out('Turbulence Specification: ' + v, 'info'); return; }
    if (k === 'turbcmp') {
      S.viscous = v;
      if (v === 'keps') { S.epsModel = 'standard'; S.kwModel = 'sst'; }
      if (v === 'kw') { S.kwModel = 'sst'; }
      out('pathlines 预览切换为 ' + viscousName(), 'info');
      applyView(); renderProps(); updateStatus();
      return;
    }
    if (k === 'shearcond') { /* 已在 onControl 处理 */ }
    if (k === 'bctab') { S.bctab = v; renderProps(); }
  }

  function onSelect(k, v) {
    switch (k) {
      case 'solver':
        S.solver = v;
        out('/define/models/solver/' + (v === 'pressure-based' ? 'pressure-based yes' : 'density-based yes'), 'info');
        if (v === 'density-based') API.toast('低马赫外流一般用 Pressure-Based', 'warn');
        break;
      case 'time': S.time = v; out('/define/models/steady? ' + (v === 'steady' ? 'yes' : 'no')); break;
      case 'viscous':
        S.viscous = v;
        out('/define/models/viscous/' + (v === 'kw' ? 'kw-sst yes' : v === 'keps' ? 'ke-standard yes' : v === 'lam' ? 'laminar? yes' : v), 'info');
        out('  Turbulent Viscosity Model: ' + viscousName(), 'ok');
        applyView();
        break;
      case 'kwModel':
        S.kwModel = v;
        out('/define/models/viscous/kw-' + (v === 'sst' ? 'sst yes' : 'standard yes'), 'info');
        break;
      case 'epsModel': S.epsModel = v; out('k-epsilon Model: ' + v); break;
      case 'nearWall': S.nearWall = v; out('Near-Wall Treatment: ' + v); break;
      case 'rhoMode':
        S.rhoMode = v;
        out('/define/materials/change-create air air yes ' + (v === 'ideal-gas' ? 'ideal-gas' : 'constant'), 'info');
        if (v === 'ideal-gas') API.toast('ideal-gas 需搭配 pressure-far-field', 'warn');
        break;
      case 'inittype': S.initType = v; out('Initialization type: ' + v); break;
      case 'initfrom': S.initFrom = v; out('Compute from: ' + v); break;
      case 'viscousFlow': break;
      case 'force_surf':
        out('Force report surfaces: ' + ({ 'car+ground': 'car-skin ground', 'car': 'car-skin', 'ground': 'ground' })[v], 'info');
        if (v !== 'car+ground') API.toast('漏掉受力面会少算下压力', 'warn');
        break;
      case 'contour_of':
        out('/display/objects/create contour field ' + v + ' surfaces-list car-skin ()', 'info');
        if (v === 'cp' || v === 'cp' ) { S.view.cp = true; refreshTools(); applyView(); }
        break;
      case 'path_of': out('Pathlines of: ' + v); break;
      case 'hist_y': break;
      default: break;
    }
    updateStatus();
  }

  function curZoneId() { return S.sel.indexOf('bc:') === 0 ? S.sel.slice(3) : 'ground'; }

  function setText(id, txt, html) {
    var e = D.root.querySelector('#' + id);
    if (!e) return;
    if (html) e.innerHTML = txt; else e.textContent = txt;
  }
  function onValue(k, v, node, commit) {
    var num = parseFloat(v);
    switch (k) {
      case 'opPressure': if (!isNaN(num)) { S.opPressure = num; out('/define/operating-conditions/operating-pressure ' + num); } break;
      case 'vel':
        if (!isNaN(num)) {
          S.vel = num; S.refVel = num;
          setText('fluVelTx', num + ' m/s');
          if (commit) {
            out('/define/boundary-conditions/velocity-inlet inlet … ' + num + ' m/s；q = ' + fmt(dynP(), 1) + ' Pa', 'info');
            renderProps();
          }
          refreshLegend(); updateStatus();
        }
        break;
      case 'rho': if (!isNaN(num)) { S.rho = num; S.refRho = num; out('air density = ' + num + ' kg/m^3'); refreshVel(); } break;
      case 'mu': if (!isNaN(num)) S.mu = num; break;
      case 'cp': if (!isNaN(num)) S.cp = num; break;
      case 'kk': if (!isNaN(num)) S.k = num; break;
      case 'alt':
        S.alt = num; S.rho = rhoISA(num); S.refRho = S.rho;
        setText('fluAltOut', num + ' m');
        setText('fluAltRho', fmt(S.rho, 4) + ' kg/m³');
        setText('fluAltQ', fmt(dynP(), 1) + ' Pa');
        setText('fluAltF', fmt(1.0 * dynP() * S.area / 1000, 2) + ' kN');
        if (commit) {
          out('标准大气 h=' + num + ' m → ρ = ' + fmt(S.rho, 4) + ' kg/m³, q = ' + fmt(dynP(), 1) + ' Pa', 'info');
          renderProps();
        }
        updateStatus();
        break;
      case 'refRho': if (!isNaN(num)) { S.refRho = num; if (commit) renderProps(); updateStatus(); } break;
      case 'refVel': if (!isNaN(num)) { S.refVel = num; S.vel = num; refreshVel(); if (commit) renderProps(); } break;
      case 'area': if (!isNaN(num)) { S.area = num; if (commit) renderProps(); updateStatus(); } break;
      case 'refLen': if (!isNaN(num)) S.refLen = num; break;
      case 'target':
        if (!isNaN(num)) {
          S.target = clamp(Math.round(num), 1, 5000);
          out('/solve/iterate ' + S.target);
          if (commit) renderProps();
        }
        break;
      case 'lateral':
        S.lateral = num;
        setText('fluLatOut', num + ' m');
        var bb = blockingRatio();
        setText('fluLatArea', fmt(bb.area, 1) + ' m²（宽 ' + fmt(bb.w, 1) + ' × 高 ' + fmt(bb.h, 2) + '）');
        setText('fluLatRatio', fmt(bb.ratio, 2) + ' %  ' + (bb.ratio < 5 ? '<span style="color:var(--ok)">✓ &lt;5%</span>' : '<span style="color:var(--warn)">✗ &gt;5%</span>'), true);
        if (commit) {
          out('/boundary/manage/add-enclosure f1_domain … lateral ' + (2 * num).toFixed(1) + ' m  →  堵塞比 ' + fmt(bb.ratio, 2) + ' %', 'info');
          renderProps();
        }
        applyView();
        break;
      case 'vin_mag':
        if (!isNaN(num)) { S.vel = num; S.refVel = num; refreshVel(); out('/define/boundary-conditions/velocity-inlet inlet yes no ' + num + ' no 1 no 0 no 0'); }
        break;
      case 'paths': if (!isNaN(num)) out('Pathlines: ' + Math.round(num) + ' paths from inlet'); break;
      default: break;
    }
  }
  function refreshVel() {
    var s = D.root.querySelector('#fluVel');
    if (s && document.activeElement !== s) s.value = S.vel;
    var t = D.root.querySelector('#fluVelTx');
    if (t) t.textContent = S.vel + ' m/s';
    applyView();
  }

  function doAction(act, node) {
    switch (act) {
      case 'setup': selectNode('general'); break;
      case 'init': selectNode('init'); break;
      case 'calc': startSolver(); break;
      case 'contour': S.view.cp = !S.view.cp; refreshTools(); applyView(); break;
      case 'path': S.view.pathlines = !S.view.pathlines; refreshTools(); applyView(); break;
      case 'force': renderForceCard(); selectNode('forces'); break;
      case 'rot': toggleView('autoRot'); break;
      case 'reset': resetView(); break;
      case 'quality': checkMesh(); break;
      /* —— 面板按钮 —— */
      case 'initialize': doInitialize(); break;
      case 'calc2': startSolver(); break;
      case 'resetiter': resetSolver(false); break;
      case 'boi': toggleView('boi'); renderProps(); break;
      case 'setcrit':
        out('/solve/set/convergence-criteria ' + exp3(S.crit.cont) + ' ' + exp3(S.crit.mom) + ' ' +
            exp3(S.crit.mom) + ' ' + exp3(S.crit.mom) + ' 1e-06 ' + exp3(S.crit.turb) + ' ' + exp3(S.crit.turb), 'info');
        API.toast('收敛判据已应用', 'ok');
        break;
      case 'display_c':
        S.view.cp = true; refreshTools(); applyView();
        out('/display/objects/create contour field pressure-coefficient surfaces-list car-skin ()', 'cmd');
        out('Displaying pressure-coefficient on car-skin …', 'ok');
        break;
      case 'hide_c': S.view.cp = false; refreshTools(); applyView(); break;
      case 'display_p':
        S.view.pathlines = true; refreshTools(); applyView();
        out('/display/objects/create pathlines field velocity release-from-surfaces inlet ()', 'cmd');
        out('  500 paths released.  Step size 500, skip 5.', 'ok');
        break;
      case 'hide_p': S.view.pathlines = false; refreshTools(); applyView(); break;
      case 'compute_f':
        out('/report/forces/wall-forces yes car-skin ground () drag 1 0 0 lift 0 0 -1 quit', 'cmd');
        /* 力报告是对壁面压力做面积积分的结果；场没解出来就没有压差，
           Fluent 会直接报 "Solution is not available" 而不是给你一个数。 */
        if (!S.iters) {
          out('Error: no solution data available — 先 /solve/iterate', 'err');
          out('  力报告是压力积分的产物。初值场的压差是任意的，积出来的 Cd/Cl 没有任何意义。', 'warn');
          API.toast('还没迭代：力是压力积分出来的，场没解出来就没有力。先点 Calculate', 'err');
          break;
        }
        out('  Cd = ' + fmt(cdAt(S.iters), 5) + '    Cl = ' + fmt(clAt(S.iters), 5), 'ok');
        out('  Fx = ' + fmt(cdAt(S.iters) * dynP() * S.area, 1) + ' N   Fy = ' + fmt(clAt(S.iters) * dynP() * S.area, 1) + ' N', 'ok');
        out('  注：未收敛时这个数仍在动 —— ' + (S.converged ? '本次已收敛' : '迭代 ' + S.iters + '，尚未收敛，读数仅供参考'),
          S.converged ? 'ok' : 'warn');
        renderForceCard();
        break;
      case 'write_f':
        out('/report/forces/wall-forces/write-file compute cd-monitor.cd () drag 1 0 0 lift 0 0 -1 quit', 'cmd');
        out('Writing report file "cd-monitor.cd" …', 'ok');
        API.toast('已写入 cd-monitor.cd', 'ok');
        break;
      case 'compute_flux':
        out('/report/fluxes/mass-flow no inlet no outlet yes', 'cmd');
        if (S.iters) out('  inlet = ' + fmt(S.fluxes.inlet, 3) + ' kg/s   outlet = ' + fmt(S.fluxes.outlet, 3) +
            ' kg/s   imbalance = ' + fmt(S.fluxes.imbalance, 4) + ' %', 'ok');
        else out('  Solution is not initialized — 先跑 Calculate', 'warn');
        break;
      case 'newreport': API.toast('Report Definition: 拖动/下压力历史监视', 'info'); out('> /solve/report-definitions/add cd-monitor force-drag thread-names car-skin ground () quit', 'cmd'); break;
      case 'hist_create': out('> /plot/plot yes "cd-cl-history" report-defs cd-monitor cl-monitor ()', 'cmd'); API.toast('历史曲线已绘制到监视器', 'ok'); break;
      case 'closecard': D.card.style.display = 'none'; S.showCard = false; break;
      case 'lstart': doStart(); break;
      default: break;
    }
  }

  function checkMesh() {
    say([
      ['> /mesh/check', 'cmd'],
      ['Mesh check completed.', 'ok'],
      ['   Number of cells ............ 12486720', 'info'],
      ['   Number of nodes ............ 2674318', 'info'],
      ['   Minimum orthogonal quality  0.170', 'ok'],
      ['   Maximum skewness ........... 0.850', 'ok'],
      ['   Maximum aspect ratio ....... 4820.1', 'info'],
      ['   Warning: cell with high aspect ratio found in diffuser throat.', 'warn']
    ]);
    API.toast('网格检查通过：正交质量 0.17 / 偏斜 0.85', 'ok');
    toggleView('section');
  }

  /* 点击树节点时的"自动回显"，让每一步的操作都有终端痕迹 */
  function stepEcho(node) {
    switch (node) {
      case 'general': tui('/define/models/solver/pressure-based yes'); out('Solver: pressure-based, Time: steady', 'ok'); break;
      case 'viscous': tui('/define/models/viscous/kw-sst yes'); out('Turbulence: k-omega SST, Production Limiter on, Wall Function', 'ok'); break;
      case 'energy': out('Energy Equation: ' + (S.energy ? 'On' : 'Off') + '  ← F1 等温外流保持 Off', S.energy ? 'warn' : 'ok'); break;
      case 'air': tui('/define/materials/change-create air air yes constant 1.225 no 1.7894e-05 no 1006.43'); out('air: ρ=1.225 kg/m³, μ=1.7894e-05 kg/(m·s)', 'ok'); break;
      case 'cellzone': out('Cell Zone "f1_fluid" — material: air, motion: stationary', 'ok'); break;
      case 'mesh': tui('/mesh/check'); out('Minimum orthogonal quality 0.170 / Maximum skewness 0.850', 'ok'); break;
      case 'refvals': tui('/report/reference-values/density 1.225 / velocity 50 / area 1.5 / length 5'); out('q = 0.5 × 1.225 × 50² = ' + fmt(dynP(), 2) + ' Pa', 'ok'); break;
      case 'init': tui('/solve/initialize/compute-defaults/pressure-based'); out(S.initialized ? 'Solution is initialized' : 'Solution is NOT initialized yet', S.initialized ? 'ok' : 'warn'); break;
      case 'run': tui('/solve/iterate ' + S.target); out(S.iters ? 'Current iteration: ' + S.iters : 'Press Calculate to start', 'info'); break;
      case 'residual': tui('/plot/residuals-set/plot-to-file "residuals.out" yes'); break;
      case 'criteria': tui('/solve/set/convergence-criteria ' + exp3(S.crit.cont) + ' ' + exp3(S.crit.mom) + ' ' + exp3(S.crit.mom) + ' ' + exp3(S.crit.mom)); break;
      case 'contours': tui('/display/objects/create contour field pressure-coefficient surfaces-list car-skin ()'); break;
      case 'pathlines': tui('/display/objects/create pathlines field velocity release-from-surfaces inlet ()'); break;
      case 'forces': tui('/report/forces/wall-forces yes car-skin ground () drag 1 0 0 lift 0 0 -1 quit'); out('  Cd = ' + fmt(cdAt(S.iters), 5) + '   Cl = ' + fmt(clAt(S.iters), 5), 'ok'); break;
      case 'fluxes': tui('/report/fluxes/mass-flow no inlet no outlet yes'); break;
      case 'history': tui('/plot/plot yes "cd-cl" report-defs cd-monitor cl-monitor ()'); break;
      default:
        if (node.indexOf('bc:') === 0) {
          var z = zoneById(node.slice(3));
          var ty = ZONE_EDIT[z.id] || z.type;
          out('zone "' + z.name + '"  type: ' + ty + '  (double-click to edit)', 'info');
          if (ty === 'wall') {
            out('   shear-condition: ' + (ZONE_EDIT[z.id + ':slip'] ? '1 (Slip — 零摩擦，只传法向压力)' : '0 (No Slip)'), 'ok');
          }
        }
        break;
    }
  }

  /* ===========================================================================
   * 13. 三维：配色 / Cp 解析场 / 程序化几何
   * ======================================================================== */

  /* —— Cp 伪彩：蓝=高压、红=低压（对应 Fluent 里的"车头蓝、底板红"）—— */
  var CP_STOPS = [
    [-1.8, 0xe03838], [-1.0, 0xef7a3c], [-0.4, 0xe0c24a], [0.0, 0x2fbf88],
    [0.5, 0x39b6d8], [0.9, 0x2f74e0], [1.2, 0x1e4fd8]
  ];
  var CP_MIN = -1.8, CP_MAX = 1.2;
  function cpColor(v, out3) {
    v = clamp(v, CP_MIN, CP_MAX);
    for (var i = 0; i < CP_STOPS.length - 1; i++) {
      var a = CP_STOPS[i], b = CP_STOPS[i + 1];
      if (v <= b[0]) {
        var t = (v - a[0]) / (b[0] - a[0]);
        var ca = a[1], cb = b[1];
        out3[0] = ((ca >> 16) & 255) * (1 - t) + ((cb >> 16) & 255) * t;
        out3[1] = ((ca >> 8) & 255) * (1 - t) + ((cb >> 8) & 255) * t;
        out3[2] = (ca & 255) * (1 - t) + (cb & 255) * t;
        return out3;
      }
    }
    out3[0] = 224; out3[1] = 56; out3[2] = 56; return out3;
  }
  function cpGradientCss() {
    var stops = [];
    for (var i = 0; i < CP_STOPS.length; i++) {
      var t = (CP_STOPS[i][0] - CP_MIN) / (CP_MAX - CP_MIN);
      var c = '#' + ('000000' + CP_STOPS[i][1].toString(16)).slice(-6);
      stops.push(c + ' ' + (t * 100).toFixed(1) + '%');
    }
    return 'linear-gradient(90deg,' + stops.join(',') + ')';
  }

  var WHEELS = [
    { x: -1.75, z: 0.80, w: 0.40, r: 0.33, f: true },
    { x: -1.75, z: -0.80, w: 0.40, r: 0.33, f: true },
    { x: 1.62, z: 0.70, w: 0.46, r: 0.33, f: false },
    { x: 1.62, z: -0.70, w: 0.46, r: 0.33, f: false }
  ];

  /* Cp 解析近似（可视化用，不是真解）：鼻锥驻点、底板抽吸、倒置翼吸力峰、车轮绕流与尾迹 */
  function cpAt(x, y, z) {
    var cp = 0.0;
    /* 1) 鼻锥与前体的驻点高压 */
    cp += 1.05 * gauss(x, -2.30, 0.75) * gauss(z, 0, 0.60) * ss(0.05, 0.18, y) * (1 - ss(0.55, 0.95, y) * 0.4);
    /* 2) 底板通道：下洗主源 */
    var under = ss(-2.30, -1.70, x) * (1 - ss(1.90, 2.95, x));
    if (y < 0.42) cp -= 1.55 * under * gauss(y, 0.11, 0.16) * (0.55 + 0.45 * gauss(z, 0, 0.85));
    /* 3) 后翼（倒置翼：上表面吸力、下表面正压） */
    var rw = ss(2.28, 2.45, x) * (1 - ss(2.90, 3.02, x)) * gauss(z, 0, 0.55);
    if (y > 0.72) cp -= 1.45 * rw; else if (y > 0.55) cp += 0.42 * rw;
    /* 4) 前翼 */
    var fw = ss(-3.05, -2.90, x) * (1 - ss(-2.52, -2.44, x)) * gauss(z, 0, 1.05);
    if (y > 0.10) cp -= 0.75 * fw; else cp += 0.30 * fw;
    /* 5) 侧箱进气口与侧箱顶面 */
    cp += 0.55 * gauss(x, -0.30, 0.30) * gauss(z, 0.52, 0.22) * ss(0.20, 0.34, y);
    /* 6) 车轮：迎风面高压 + 轮后尾迹低压 */
    for (var i = 0; i < WHEELS.length; i++) {
      var w = WHEELS[i];
      if (y > 0.70) continue;
      var dz = z - w.z, dx = x - w.x;
      if (Math.abs(dz) < w.w / 2 + 0.10) {
        var lat = gauss(dz, 0, w.w / 2 + 0.05);
        cp += 0.50 * lat * gauss(dx, -0.30, 0.22) * ss(0.70, 0.25, y + 0.4);
        cp -= 0.75 * lat * gauss(dx, 0.55, 0.55) * ss(0.65, 0.30, y + 0.4);
      }
    }
    /* 7) 车尾抽吸：扩散器出口与尾迹是低压区（橙），到下游 10 m 恢复到来流值 */
    if (x > 2.6) cp -= 0.85 * ss(2.6, 4.0, x) * (1 - ss(6.0, 10.5, x)) * (0.55 + 0.45 * gauss(y, 0.75, 0.6)) * (0.65 + 0.35 * gauss(z, 0, 1.4));
    if (y < 0.30 && x > 2.0 && x < 4.2) cp -= 0.30 * gauss(x, 3.0, 0.9);
    return clamp(cp, CP_MIN, CP_MAX);
  }

  /* —— 车身控制截面：x, yc, zc, rx, ry, e（超椭圆指数，越大越接近矩形）—— */
  var BODY_SEC = [
    { x: -2.45, y: 0.30, z: 0, rx: 0.055, ry: 0.055, e: 2.2 },
    { x: -2.20, y: 0.30, z: 0, rx: 0.105, ry: 0.085, e: 2.3 },
    { x: -1.90, y: 0.30, z: 0, rx: 0.170, ry: 0.125, e: 2.4 },
    { x: -1.60, y: 0.31, z: 0, rx: 0.240, ry: 0.160, e: 2.5 },
    { x: -1.25, y: 0.32, z: 0, rx: 0.300, ry: 0.200, e: 2.6 },
    { x: -0.90, y: 0.33, z: 0, rx: 0.352, ry: 0.240, e: 2.6 },
    { x: -0.55, y: 0.35, z: 0, rx: 0.400, ry: 0.270, e: 2.7 },
    { x: -0.20, y: 0.37, z: 0, rx: 0.440, ry: 0.280, e: 2.8 },
    { x: 0.15, y: 0.39, z: 0, rx: 0.470, ry: 0.275, e: 2.8 },
    { x: 0.50, y: 0.40, z: 0, rx: 0.450, ry: 0.250, e: 2.8 },
    { x: 0.95, y: 0.42, z: 0, rx: 0.395, ry: 0.215, e: 2.7 },
    { x: 1.40, y: 0.44, z: 0, rx: 0.310, ry: 0.170, e: 2.6 },
    { x: 1.80, y: 0.45, z: 0, rx: 0.225, ry: 0.125, e: 2.5 },
    { x: 2.15, y: 0.44, z: 0, rx: 0.160, ry: 0.095, e: 2.4 },
    { x: 2.48, y: 0.42, z: 0, rx: 0.115, ry: 0.075, e: 2.3 }
  ];
  function secAt(ctrl, x) {
    if (x <= ctrl[0].x) return ctrl[0];
    var n = ctrl.length;
    if (x >= ctrl[n - 1].x) return ctrl[n - 1];
    for (var i = 0; i < n - 1; i++) {
      if (x <= ctrl[i + 1].x) {
        var a = ctrl[i], b = ctrl[i + 1], t = (x - a.x) / (b.x - a.x);
        return {
          x: x, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t,
          rx: a.rx + (b.rx - a.rx) * t, ry: a.ry + (b.ry - a.ry) * t, e: a.e + (b.e - a.e) * t
        };
      }
    }
    return ctrl[n - 1];
  }
  function ringPoint(s, j, nt, out) {
    var th = j / nt * Math.PI * 2;
    var c = Math.cos(th), sn = Math.sin(th);
    var px = Math.pow(Math.abs(c), 2 / (s.e || 2.6)) * (c < 0 ? -1 : 1);
    var py = Math.pow(Math.abs(sn), 2 / (s.e || 2.6)) * (sn < 0 ? -1 : 1);
    out[0] = s.x; out[1] = s.y + py * s.ry; out[2] = s.z + px * s.rx;
    return out;
  }
  function loftGeometry(ctrl, nt, capEnds) {
    var pos = [], idx = [], i, j, a = [0, 0, 0], b = [0, 0, 0], p;
    var n = ctrl.length;
    for (i = 0; i < n; i++) {
      for (j = 0; j <= nt; j++) {
        p = ringPoint(ctrl[i], j % nt, nt, a);
        pos.push(p[0], p[1], p[2]);
      }
    }
    var row = nt + 1;
    for (i = 0; i < n - 1; i++) {
      for (j = 0; j < nt; j++) {
        var i0 = i * row + j, i1 = i * row + j + 1, i2 = (i + 1) * row + j, i3 = (i + 1) * row + j + 1;
        idx.push(i0, i2, i1, i1, i2, i3);
      }
    }
    if (capEnds !== false) {
      var c0 = [], c1 = [];
      for (j = 0; j < nt; j++) {
        ringPoint(ctrl[0], j, nt, a); c0.push(a[0], a[1], a[2]);
        ringPoint(ctrl[n - 1], j, nt, b); c1.push(b[0], b[1], b[2]);
      }
      var o0 = pos.length / 3, o1 = c0.length / 3 + o0;
      for (j = 0; j < nt * 3; j++) pos.push(c0[j]);
      for (j = 0; j < nt * 3; j++) pos.push(c1[j]);
      var cc0 = [ctrl[0].x, ctrl[0].y, ctrl[0].z], cc1 = [ctrl[n - 1].x, ctrl[n - 1].y, ctrl[n - 1].z];
      var m0 = pos.length / 3;
      pos.push(cc0[0], cc0[1], cc0[2]);
      var m1 = pos.length / 3;
      pos.push(cc1[0], cc1[1], cc1[2]);
      for (j = 0; j < nt; j++) {
        idx.push(m0, o0 + j, o0 + (j + 1) % nt);
        idx.push(m1, o1 + (j + 1) % nt, o1 + j);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /* 翼型：NACA 厚度分布 + 简单圆弧弯度 */
  function airfoilShape(chord, thickRatio, camber, n) {
    var s = new THREE.Shape();
    var yt = function (x) {
      return 5 * thickRatio * chord * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x +
        0.2843 * x * x * x - 0.1015 * x * x * x * x);
    };
    var yc = function (x) {
      var p = 0.4;
      return x < p ? (camber / 0.16) * (2 * p * x - x * x) : (camber / 0.16) * ((1 - 2 * p) + 2 * p * x - x * x);
    };
    var i, x, y;
    s.moveTo(0, yc(0) + yt(0));
    for (i = 1; i <= n; i++) { x = i / n; y = yc(x) + yt(x); s.lineTo(x * chord, y); }
    for (i = n - 1; i >= 0; i--) { x = i / n; y = yc(x) - yt(x); s.lineTo(x * chord, y); }
    s.lineTo(0, yc(0) + yt(0));
    return s;
  }
  function wingMesh(chord, thick, span, aoa, color) {
    var shape = airfoilShape(chord, thick, 0.035, 14);
    var g = new THREE.ExtrudeGeometry(shape, { depth: span, bevelEnabled: false, steps: 1, curveSegments: 2 });
    g.translate(-chord / 2, 0, -span / 2);
    var m = new THREE.Mesh(g, carMaterial(color || 0x2b7f8c, 0.30, 0.45));
    m.rotation.z = aoa;
    return m;
  }

  /* —— 车身材质（切到 Cp 时统一换成顶点色）—— */
  function carMaterial(color, metal, rough) {
    var m = new THREE.MeshStandardMaterial({ color: color, metalness: metal || 0.35, roughness: rough || 0.45 });
    carMats.push(m);
    return m;
  }
  function paintCp(obj) {
    var g = obj.geometry, nonIdx = g.index ? g.toNonIndexed() : g;
    var pos = nonIdx.getAttribute('position');
    var arr = new Float32Array(pos.count * 3);
    var c3 = [0, 0, 0];
    for (var i = 0; i < pos.count; i++) {
      var cp = cpAt(pos.getX(i), pos.getY(i), pos.getZ(i));
      cpColor(cp, c3);
      arr[i * 3] = c3[0] / 255; arr[i * 3 + 1] = c3[1] / 255; arr[i * 3 + 2] = c3[2] / 255;
    }
    nonIdx.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    if (nonIdx !== g) { obj.geometry = nonIdx; g.dispose(); }
    if (!nonIdx.getAttribute('normal')) nonIdx.computeVertexNormals();
  }
  /* Cp 模式换成无光照的平涂材质——和 Fluent 的 Contours 观感一致，也避免被三点布光冲淡 */
  function setCpMode(on) {
    if (V.car) {
      V.car.traverse(function (o) {
        if (o.isMesh && o.userData.mCp) o.material = on ? o.userData.mCp : o.userData.mStd;
      });
    }
    for (var i = 0; i < carMats.length; i++) {
      carMats[i].color.setHex(on ? 0xffffff : 0x35a3b4);
      carMats[i].metalness = on ? 0.12 : 0.35;
      carMats[i].roughness = on ? 0.62 : 0.45;
    }
  }
  /* 关掉"车身实体"时留一层半透明壳，线框才有参照物（看网格时非常关键） */
  function setSolidMode(on) {
    var all = carMats.concat(carCpMats);
    for (var i = 0; i < all.length; i++) {
      var m = all[i];
      m.transparent = !on;
      m.opacity = on ? 1 : 0.38;
      m.depthWrite = on;
      m.needsUpdate = true;
    }
    /* 幽灵壳压暗成剪影，让线框跳出来 */
    for (var j = 0; j < carMats.length; j++) {
      if (!on) carMats[j].color.setHex(0x0c252c);
    }
    if (V.car) V.car.traverse(function (o) { if (o.isMesh) o.castShadow = !!on; });
  }

  /* —— F1 赛车：放样车身 + 翼 + 侧箱 + 底板 + 扩散器 + 四轮 —— */
  function buildCar() {
    var g = new THREE.Group();
    var body = new THREE.Mesh(loftGeometry(BODY_SEC, 22, true), carMaterial(0x2b7f8c, 0.35, 0.42));
    g.add(body);

    /* 侧箱：左右各一条放样，进气口在 x≈-0.35 */
    for (var s = -1; s <= 1; s += 2) {
      var sp = [
        { x: -0.40, y: 0.34, z: 0.30 * s, rx: 0.10, ry: 0.10, e: 2.4 },
        { x: -0.10, y: 0.36, z: 0.50 * s, rx: 0.18, ry: 0.16, e: 2.6 },
        { x: 0.35, y: 0.36, z: 0.55 * s, rx: 0.22, ry: 0.18, e: 2.8 },
        { x: 0.90, y: 0.34, z: 0.52 * s, rx: 0.21, ry: 0.17, e: 2.8 },
        { x: 1.35, y: 0.31, z: 0.42 * s, rx: 0.16, ry: 0.12, e: 2.6 },
        { x: 1.70, y: 0.28, z: 0.28 * s, rx: 0.08, ry: 0.07, e: 2.4 }
      ];
      g.add(new THREE.Mesh(loftGeometry(sp, 18, true), carMaterial(0x1f6a78, 0.3, 0.5)));
      var inlet = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.12, 16), carMaterial(0x0d1a1e, 0.1, 0.9));
      inlet.rotation.z = Math.PI / 2;
      inlet.position.set(-0.40, 0.34, 0.30 * s);
      g.add(inlet);
      /*  barge board：侧箱前下方的一片导流板 */
      var bb = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.26, 0.03), carMaterial(0x17454e, 0.3, 0.6));
      bb.position.set(-0.35, 0.22, 0.30 * s);
      bb.rotation.y = 0.12 * s;
      g.add(bb);
    }

    /* 底板 / 扩散器：下游抬起，是下压力的物理载体 */
    var floor = [
      { x: -1.95, y: 0.10, z: 0, rx: 0.22, ry: 0.035, e: 5 },
      { x: -1.20, y: 0.10, z: 0, rx: 0.42, ry: 0.045, e: 5.5 },
      { x: -0.30, y: 0.10, z: 0, rx: 0.56, ry: 0.050, e: 6 },
      { x: 0.80, y: 0.10, z: 0, rx: 0.62, ry: 0.050, e: 6 },
      { x: 1.70, y: 0.11, z: 0, rx: 0.60, ry: 0.055, e: 6 },
      { x: 2.20, y: 0.16, z: 0, rx: 0.52, ry: 0.075, e: 5 }
    ];
    g.add(new THREE.Mesh(loftGeometry(floor, 20, true), carMaterial(0x123c45, 0.4, 0.55)));
    var dif = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.20, 1.10), carMaterial(0x0f323a, 0.4, 0.6));
    dif.position.set(2.35, 0.19, 0);
    dif.rotation.z = -0.16;
    g.add(dif);

    /* 座舱 + 空气箱 + 防滚架 */
    var roll = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.30, 12), carMaterial(0x0e2a30, 0.6, 0.3));
    roll.position.set(0.10, 0.66, 0);
    g.add(roll);
    var box = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.24, 10), carMaterial(0x123c45, 0.4, 0.5));
    box.position.set(0.10, 0.83, 0);
    g.add(box);
    var halo = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.022, 8, 20, Math.PI), carMaterial(0x0b1c20, 0.7, 0.3));
    halo.position.set(-0.05, 0.56, 0);
    halo.rotation.set(Math.PI / 2, 0, 0);
    g.add(halo);

    /* 前翼：主翼面 + 第二层 + 端板 */
    var fw1 = wingMesh(0.36, 0.09, 1.80, -0.22); fw1.position.set(-2.72, 0.10, 0); g.add(fw1);
    var fw2 = wingMesh(0.20, 0.08, 1.80, -0.42); fw2.position.set(-2.58, 0.24, 0); g.add(fw2);
    for (var e2 = -1; e2 <= 1; e2 += 2) {
      var ep = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.34, 0.02), carMaterial(0x2b7f8c, 0.3, 0.45));
      ep.position.set(-2.66, 0.17, 0.90 * e2);
      g.add(ep);
    }
    var noseTip = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.06, 0.50), carMaterial(0x8a2f2f, 0.2, 0.6));
    noseTip.position.set(-2.50, 0.33, 0);
    g.add(noseTip);

    /* 后翼：主翼面 + 上翻翼 + 端板 + 支柱 */
    var rw1 = wingMesh(0.32, 0.08, 1.05, 0.30); rw1.position.set(2.60, 0.80, 0); g.add(rw1);
    var rw2 = wingMesh(0.20, 0.07, 1.05, 0.55); rw2.position.set(2.78, 0.93, 0); g.add(rw2);
    for (var e3 = -1; e3 <= 1; e3 += 2) {
      var ep2 = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.44, 0.02), carMaterial(0x2b7f8c, 0.3, 0.45));
      ep2.position.set(2.66, 0.82, 0.53 * e3);
      g.add(ep2);
    }
    var pylon = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.34, 0.06), carMaterial(0x0f323a, 0.4, 0.5));
    pylon.position.set(2.42, 0.66, 0);
    g.add(pylon);

    /* 四轮：轮胎 + 轮辋 */
    for (var w = 0; w < WHEELS.length; w++) {
      var W = WHEELS[w];
      var tire = new THREE.Mesh(new THREE.CylinderGeometry(W.r, W.r, W.w, 26, 1), carMaterial(0x14181c, 0.15, 0.92));
      tire.rotation.x = Math.PI / 2;
      tire.position.set(W.x, W.r, W.z);
      g.add(tire);
      var rim = new THREE.Mesh(new THREE.CylinderGeometry(W.r * 0.62, W.r * 0.62, W.w + 0.01, 18, 1), carMaterial(0x8a8f96, 0.85, 0.25));
      rim.rotation.x = Math.PI / 2;
      rim.position.set(W.x, W.r, W.z);
      g.add(rim);
    }
    g.traverse(function (o) {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true;
      paintCp(o);
      o.userData.mStd = o.material;
      o.userData.mCp = new THREE.MeshBasicMaterial({ vertexColors: true });
      carCpMats.push(o.userData.mCp);
    });
    return g;
  }

  /* —— Sprite 文字标签（画布贴图，不加载任何外部文件）—— */
  function labelSprite(main, sub, color) {
    var c = doc.createElement('canvas');
    c.width = 384; c.height = 72;
    var g = c.getContext('2d');
    g.fillStyle = 'rgba(12,16,21,0.86)';
    g.beginPath();
    if (g.roundRect) { g.roundRect(5, 8, 374, 56, 11); } else { g.rect(5, 8, 374, 56); }
    g.fill();
    g.strokeStyle = color; g.lineWidth = 3; g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#eef3f8'; g.font = 'bold 28px "Microsoft YaHei", sans-serif';
    g.fillText(main, 192, 29);
    g.fillStyle = color; g.font = '19px Consolas, monospace';
    g.fillText(sub, 192, 52);
    var tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    /* sizeAttenuation:false —— 标签大小与视距无关，缩小时也不会缩成一个点 */
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, sizeAttenuation: false }));
    sp.scale.set(0.38, 0.071, 1);
    return sp;
  }
  function planeMesh(w, h, color, opacity) {
    var m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: opacity, side: THREE.DoubleSide, depthWrite: false })
    );
    m.renderOrder = 2;
    return m;
  }

  /* —— 计算域：五类边界面 + 标签 —— */
  function domainDims() {
    return { x0: -10, x1: 30, y0: 0, y1: 2.85, zh: 1.0 + S.lateral };
  }
  function buildDomain() {
    var d = domainDims(), g = new THREE.Group();
    var len = d.x1 - d.x0, wid = d.zh * 2, hei = d.y1 - d.y0;
    var cx = (d.x0 + d.x1) / 2, cy = (d.y0 + d.y1) / 2;

    var inlet = planeMesh(wid, hei, 0x3f86d8, 0.26);
    inlet.rotation.y = Math.PI / 2; inlet.position.set(d.x0, cy, 0); g.add(inlet);
    var outlet = planeMesh(wid, hei, 0x38bd7c, 0.26);
    outlet.rotation.y = -Math.PI / 2; outlet.position.set(d.x1, cy, 0); g.add(outlet);
    var ground = planeMesh(len, wid, 0xe07a1c, 0.24);
    ground.rotation.x = -Math.PI / 2; ground.position.set(cx, d.y0, 0); g.add(ground);
    var top = planeMesh(len, wid, 0x8a5ad8, 0.14);
    top.rotation.x = Math.PI / 2; top.position.set(cx, d.y1, 0); g.add(top);
    for (var i = 0; i < 2; i++) {
      var sgn = i ? 1 : -1;
      var side = planeMesh(len, hei, 0x7a5ad8, 0.14);
      side.position.set(cx, cy, sgn * d.zh);
      side.rotation.y = sgn > 0 ? Math.PI : 0;
      g.add(side);
    }
    /* 域盒骨架线 */
    var edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(len, hei, wid)),
      new THREE.LineBasicMaterial({ color: 0xa8c0d8, transparent: true, opacity: 0.62 })
    );
    edges.position.set(cx, cy, 0);
    g.add(edges);

    var t = ZONE_EDIT['inlet'] || 'velocity-inlet';
    var l1 = labelSprite('inlet', t + ' · ' + S.vel + ' m/s', '#5aa0f0');
    l1.position.set(d.x0 + 1.6, d.y1 + 0.30, 0); g.add(l1);
    var l2 = labelSprite('outlet', (ZONE_EDIT['outlet'] || 'pressure-outlet') + ' · 0 Pa', '#5fd08a');
    l2.position.set(d.x1 - 1.6, d.y1 + 0.30, 0); g.add(l2);
    var l3 = labelSprite('ground', 'wall · ' + (ZONE_EDIT['ground:slip'] ? 'Slip' : 'No Slip'), '#f08a3c');
    l3.position.set(cx + 4, d.y0 - 0.30, d.zh * 0.82); g.add(l3);
    var l4 = labelSprite('farfield', 'symmetry · 侧向 / 顶部', '#b07af0');
    l4.position.set(cx + 2, d.y1 + 0.55, 0); g.add(l4);
    var l5 = labelSprite('car-skin', 'wall · No Slip', '#e8a24f');
    l5.position.set(0.4, d.y1 + 1.25, 0); l5.scale.set(0.27, 0.051, 1); g.add(l5);
    return g;
  }

  /* —— 表面网格线框：曲率 & 近距加密 两套 —— */
  function stations(fine) {
    var out = [], x = -2.45, step = 0.45;
    while (x <= 2.50) {
      out.push(x);
      if (fine) {
        step = (x < -1.75) ? 0.115 : (x > 2.25 ? 0.10 : (x > -0.9 && x < 1.4 ? 0.17 : 0.26));
      }
      x += step;
    }
    return out;
  }
  function seg(arr, x1, y1, z1, x2, y2, z2, c1, c2) {
    arr.pos.push(x1, y1, z1, x2, y2, z2);
    arr.col.push(c1[0], c1[1], c1[2], c2[0], c2[1], c2[2]);
  }
  function buildWire(fine) {
    var A = { pos: [], col: [] };
    var DIM = [0.42, 0.47, 0.55], HOT = [0.10, 0.78, 0.72], MID = [0.35, 0.66, 0.80];
    var i, j, k, p, q, s, a, b, c;
    /* 1) 车身放样面 */
    var st = stations(fine), nt = fine ? 15 : 8;
    var rings = [];
    for (i = 0; i < st.length; i++) {
      var sec = secAt(BODY_SEC, st[i]);
      var ring = [];
      for (j = 0; j <= nt; j++) { p = ringPoint(sec, j % nt, nt, [0, 0, 0]); ring.push([p[0], p[1], p[2]]); }
      rings.push(ring);
    }
    for (i = 0; i < st.length - 1; i++) {
      var hot = (st[i] < -1.7) || (st[i] > 2.2);
      var cc = fine ? (hot ? HOT : MID) : DIM;
      for (j = 0; j < nt; j++) {
        seg(A, rings[i][j][0], rings[i][j][1], rings[i][j][2], rings[i][j + 1][0], rings[i][j + 1][1], rings[i][j + 1][2], cc, cc);
        seg(A, rings[i][j][0], rings[i][j][1], rings[i][j][2], rings[i + 1][j][0], rings[i + 1][j][1], rings[i + 1][j][2], cc, cc);
      }
    }
    /* 2) 翼面网格（曲率加密的典型区域） */
    var wings = [
      { c: [-2.72, 0.10, 0], ch: 0.36, sp: 1.80, aoa: -0.22 },
      { c: [-2.58, 0.24, 0], ch: 0.20, sp: 1.80, aoa: -0.42 },
      { c: [2.60, 0.80, 0], ch: 0.32, sp: 1.05, aoa: 0.30 },
      { c: [2.78, 0.93, 0], ch: 0.20, sp: 1.05, aoa: 0.55 }
    ];
    for (i = 0; i < wings.length; i++) {
      var wg = wings[i], ca = Math.cos(wg.aoa), sa = Math.sin(wg.aoa);
      var nu = fine ? 6 : 3, nv = fine ? 11 : 5;
      var wp = function (u, v) {
        var lx = (u - 0.5) * wg.ch, lz = (v - 0.5) * wg.sp;
        var th = 0.045 * wg.ch * Math.sin(Math.PI * u);
        return [wg.c[0] + lx * ca - th * sa, wg.c[1] + lx * sa + th * ca, wg.c[2] + lz];
      };
      for (k = 0; k < nu; k++) {
        for (j = 0; j < nv; j++) { a = wp(k / nu, j / nv); b = wp(k / nu, (j + 1) / nv); seg(A, a[0], a[1], a[2], b[0], b[1], b[2], HOT, HOT); }
      }
      for (j = 0; j < nv; j++) {
        for (k = 0; k < nu; k++) { a = wp(k / nu, j / nv); b = wp((k + 1) / nu, j / nv); seg(A, a[0], a[1], a[2], b[0], b[1], b[2], HOT, HOT); }
      }
    }
    /* 3) 车轮：同心圆 + 轴向线，接触区加密 */
    for (i = 0; i < WHEELS.length; i++) {
      var W = WHEELS[i], nr = fine ? 5 : 3, nz = fine ? 8 : 4;
      for (k = 1; k <= nr; k++) {
        var rr = W.r * k / nr;
        for (j = 0; j < 20; j++) {
          var t0 = j / 20 * Math.PI * 2, t1 = (j + 1) / 20 * Math.PI * 2;
          seg(A, W.x + rr * Math.cos(t0), W.r + rr * Math.sin(t0), W.z - W.w / 2,
                 W.x + rr * Math.cos(t1), W.r + rr * Math.sin(t1), W.z - W.w / 2, MID, MID);
        }
      }
      for (j = 0; j <= nz; j++) {
        var zz = W.z - W.w / 2 + W.w * j / nz;
        for (k = 0; k < 14; k++) {
          var a0 = k / 14 * Math.PI * 2, a1 = (k + 1) / 14 * Math.PI * 2;
          seg(A, W.x + W.r * Math.cos(a0), W.r + W.r * Math.sin(a0), zz,
                 W.x + W.r * Math.cos(a1), W.r + W.r * Math.sin(a1), zz, MID, MID);
        }
      }
    }
    /* 4) 底板：下表面加密（近距函数把贴近地面的地方切细） */
    var fl = fine ? 8 : 4, fw = fine ? 9 : 5;
    for (j = 0; j <= fl; j++) {
      var fx2 = -1.9 + (2.15 + 1.9) * j / fl;
      var fsec = secAt([
        { x: -1.95, y: 0.10, z: 0, rx: 0.22, ry: 0.035, e: 5 },
        { x: -0.30, y: 0.10, z: 0, rx: 0.56, ry: 0.050, e: 6 },
        { x: 1.70, y: 0.11, z: 0, rx: 0.60, ry: 0.055, e: 6 },
        { x: 2.20, y: 0.16, z: 0, rx: 0.52, ry: 0.075, e: 5 }
      ], fx2);
      for (k = 0; k < fw; k++) {
        var v0 = -1 + 2 * k / fw, v1 = -1 + 2 * (k + 1) / fw;
        a = [fx2, fsec.y - fsec.ry, fsec.z + v0 * fsec.rx];
        b = [fx2, fsec.y - fsec.ry, fsec.z + v1 * fsec.rx];
        seg(A, a[0], a[1], a[2], b[0], b[1], b[2], HOT, HOT);
        seg(A, a[0], a[1], a[2], fx2, fsec.y + fsec.ry, fsec.z + v0 * fsec.rx, MID, MID);
      }
    }
    /* 5) 远场：粗网格代表域外也能看到的稀疏结构（只在粗网格版本里出现） */
    if (!fine) {
      for (i = 0; i <= 6; i++) {
        var yy = 0.4 + i * 0.42;
        seg(A, -10, yy, -5, 30, yy, -5, DIM, DIM);
        seg(A, -10, yy, 5, 30, yy, 5, DIM, DIM);
      }
      for (i = 0; i <= 8; i++) {
        var xx = -10 + i * 5;
        seg(A, xx, 0, -5, xx, 2.85, -5, DIM, DIM);
        seg(A, xx, 0, 5, xx, 2.85, 5, DIM, DIM);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(A.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(A.col, 3));
    return g;
  }

  /* —— 尾流 BOI：后翼下游的长条控制体 —— */
  function buildBOI() {
    var g = new THREE.BoxGeometry(6.0, 1.15, 2.0);
    var e = new THREE.EdgesGeometry(g);
    var pos = e.getAttribute('position').array.slice();
    var col = [], n = pos.length / 3;
    for (var i = 0; i < n; i++) col.push(0.98, 0.62, 0.20);
    var eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    eg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.dispose();
    var box = new THREE.BoxGeometry(6.0, 1.15, 2.0);
    var m = new THREE.Mesh(box, new THREE.MeshBasicMaterial({
      color: 0xf09a2f, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide
    }));
    m.position.set(6.0, 0.62, 0);
    var grp = new THREE.Group();
    grp.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 })));
    grp.add(m);
    /* BOI 里的细网格（强制加密） */
    var A = { pos: [], col: [] }, i, j;
    for (i = 0; i <= 16; i++) {
      var x = 3.0 + i * 0.375, cc = [0.98, 0.72, 0.30];
      seg(A, x, 0.05, -1.0, x, 0.05, 1.0, cc, cc);
      seg(A, x, 0.05, -1.0, x, 1.20, -1.0, cc, cc);
    }
    for (j = 0; j <= 4; j++) {
      var zz = -1 + 0.5 * j, c2 = [0.98, 0.72, 0.30];
      seg(A, 3.0, 0.05, zz, 9.0, 0.05, zz, c2, c2);
    }
    var mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.Float32BufferAttribute(A.pos, 3));
    mg.setAttribute('color', new THREE.Float32BufferAttribute(A.col, 3));
    grp.add(new THREE.LineSegments(mg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55 })));
    return grp;
  }

  /* —— 流线：按湍流模型给三套预设流场 —— */
  var LANES = [
    /* z,    入口高,  车身段高, 尾后高, 是否车底 */
    [0.00, 0.32, 0.085, 0.66, 1], [0.45, 0.30, 0.090, 0.62, 1], [-0.45, 0.30, 0.090, 0.62, 1],
    [0.90, 0.17, 0.115, 0.50, 1], [-0.90, 0.17, 0.115, 0.50, 1],
    [1.60, 0.95, 0.98, 1.18, 0], [-1.60, 0.95, 0.98, 1.18, 0],
    [0.60, 1.50, 1.34, 1.62, 0], [-0.60, 1.50, 1.34, 1.62, 0],
    [0.00, 2.00, 1.92, 2.15, 0],
    [2.60, 1.10, 1.18, 1.32, 0], [-2.60, 1.10, 1.18, 1.32, 0]
  ];
  var TMODEL = {
    kw:   { under: 1.00, tail: 1.00, flare: 0.55, wake: 0.62, wob: 0.055, note: 'k-omega SST：后轮与翼端分离出非对称涡对，底板下洗最强' },
    keps: { under: 0.86, tail: 0.86, flare: 0.95, wake: 0.95, wob: 0.10,  note: 'k-epsilon：尾流过宽、涡结构被过度耗散，底板抽吸被低估' },
    lam:  { under: 0.55, tail: 0.50, flare: 0.12, wake: 0.18, wob: 0.012, note: 'Laminar：没有湍流耗散，边界层不分离，尾流极窄（物理上不成立）' }
  };
  function laneCurve(l, M, i) {
    var z0 = l[0], yIn = l[1], yBody = l[2] * M.under + (1 - M.under) * l[2] * 0.4;
    var yOut = l[3] * M.tail, under = l[4];
    var xs = [-10, -6.5, -4.2, -2.3, -0.6, 0.9, 2.3, 3.4, 5.2, 8.0, 12.0, 17.0, 23.0];
    var pts = [], k;
    for (k = 0; k < xs.length; k++) {
      var x = xs[k], y, t;
      if (x < -2.3) { t = ss(-10, -2.3, x); y = yIn + (yBody - yIn) * t; }
      else if (x < 2.3) { t = ss(-2.3, 2.3, x); y = yBody + (yOut - yBody) * t * 0.35; }
      else { t = ss(2.3, 23, x); y = yOut + 0.30 * t; }
      if (under) y = Math.max(y, 0.045);
      /* SST 尾流摆动 / 湍流耗散 */
      if (x > 1.0) y += M.wob * Math.sin(x * 1.35 + i * 1.7) * ss(1.0, 6.0, x);
      var zz = z0 * (1 + M.flare * ss(1.5, 14.0, x));
      pts.push(new THREE.Vector3(x, y, zz));
    }
    return new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.4);
  }
  function dotTexture() {
    var c = doc.createElement('canvas'); c.width = c.height = 64;
    var g = c.getContext('2d');
    var grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.85)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    var t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    return t;
  }
  function buildPathlines(kind) {
    var M = TMODEL[kind] || TMODEL.kw;
    var grp = new THREE.Group();
    var PER = kind === 'lam' ? 26 : 40;
    var curves = [], i, k;
    for (i = 0; i < LANES.length; i++) curves.push(laneCurve(LANES[i], M, i));
    var N = curves.length * PER;
    var pos = new Float32Array(N * 3), col = new Float32Array(N * 3), t0 = new Float32Array(N);
    var linePos = [];
    for (i = 0; i < curves.length; i++) {
      var under = LANES[i][4];
      var base = under ? [1.0, 0.86, 0.35] : [0.35, 0.80, 1.0];
      for (k = 0; k < 90; k++) {
        var pt = curves[i].getPoint(k / 89);
        linePos.push(pt.x, pt.y, pt.z);
      }
      for (k = 0; k < PER; k++) {
        var idx = i * PER + k;
        t0[idx] = k / PER;
        var f = under ? 1.0 : 0.75;
        col[idx * 3] = base[0] * f; col[idx * 3 + 1] = base[1] * f; col[idx * 3 + 2] = base[2] * f;
      }
    }
    var lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(linePos, 3));
    var lm = new THREE.LineBasicMaterial({ color: 0x4d6f8c, transparent: true, opacity: 0.35 });
    grp.add(new THREE.Line(lg, lm));
    var pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    pg.getAttribute('position').setUsage(THREE.DynamicDrawUsage);
    pg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    var pm = new THREE.PointsMaterial({
      size: 0.19, map: V.dotTex || (V.dotTex = dotTexture()), transparent: true,
      depthWrite: false, vertexColors: true, sizeAttenuation: true, blending: THREE.AdditiveBlending
    });
    var pts = new THREE.Points(pg, pm);
    grp.add(pts);
    grp.update = function (dt) {
      var arr = pg.getAttribute('position').array;
      var spd = 0.035 * (0.6 + S.vel / 50);
      for (i = 0; i < N; i++) {
        t0[i] += dt * spd * (0.75 + 0.5 * (i % 7) / 7);
        if (t0[i] > 1) t0[i] -= 1;
        var p = curves[Math.floor(i / PER)].getPoint(t0[i]);
        arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z;
      }
      pg.getAttribute('position').needsUpdate = true;
    };
    return grp;
  }

  /* —— 尾翼后双螺旋涡 —— */
  function buildVortices() {
    /* 两条涡对称生成。每次循环用 IIFE 隔离一份闭包变量（curve / pg / t0），
       否则两个粒子系统会共用同一份缓冲；逐面推进函数收进 upds 数组，
       由 userData.update 统一驱动。 */
    var grp = new THREE.Group(), upds = [], sgn;
    for (sgn = -1; sgn <= 1; sgn += 2) (function (sg) {
      var k, pts = [];
      for (k = 0; k <= 60; k++) {
        var u = k / 60;
        var x = 2.95 + u * 8.0;
        var rr = 0.22 + 0.55 * u;
        var th = u * Math.PI * 2 * 1.7;
        var y = 0.80 - 0.42 * u + 0.10 * Math.sin(u * 5.0);
        var z = sg * (0.34 + 0.9 * u) + rr * Math.cos(th) * 0.55;
        pts.push(new THREE.Vector3(x, y + rr * Math.sin(th) * 0.42, z));
      }
      var curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
      var lp = [];
      for (k = 0; k <= 120; k++) { var p = curve.getPoint(k / 120); lp.push(p.x, p.y, p.z); }
      var lgm = new THREE.BufferGeometry();
      lgm.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
      grp.add(new THREE.Line(lgm, new THREE.LineBasicMaterial({ color: 0x6fd3c8, transparent: true, opacity: 0.45 })));
      var M = 110, pos = new Float32Array(M * 3), t0 = new Float32Array(M);
      var pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      pg.getAttribute('position').setUsage(THREE.DynamicDrawUsage);
      var pts2 = new THREE.Points(pg, new THREE.PointsMaterial({
        size: 0.14, map: V.dotTex || (V.dotTex = dotTexture()), color: 0x7fe8dc,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
      }));
      grp.add(pts2);
      upds.push(function (dt) {
        var arr = pg.getAttribute('position').array;
        for (var j = 0; j < M; j++) {
          t0[j] += dt * 0.13;
          if (t0[j] > 1) t0[j] -= 1;
          var q = curve.getPoint(t0[j]);
          arr[j * 3] = q.x; arr[j * 3 + 1] = q.y; arr[j * 3 + 2] = q.z;
        }
        pg.getAttribute('position').needsUpdate = true;
      });
    })(sgn);
    grp.userData.push = upds;
    grp.userData.update = function (dt) { for (var i2 = 0; i2 < upds.length; i2++) upds[i2](dt); };
    return grp;
  }

  /* —— 气动力矢量 —— */
  function arrowGroup(color) {
    var g = new THREE.Group();
    var sh = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.72, 12),
      new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.92 }));
    sh.rotation.z = -Math.PI / 2; sh.position.x = 0.36;
    var hd = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.28, 16),
      new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.98 }));
    hd.rotation.z = -Math.PI / 2; hd.position.x = 0.86;
    g.add(sh); g.add(hd);
    g.scale.x = 0.001;
    return g;
  }
  function updateArrows() {
    if (!V.arrowDrag) return;
    var f = forceNow();
    /* 没有力报告时退回中性长度，别让 null 参与算术 */
    var Ld = f.has ? clamp(f.fx / 1000 * 0.45, 0.05, 4.2) : 0.9;
    var Ll = f.has ? clamp(f.fy / 1000 * 0.085, 0.05, 2.2) : 1.2;
    V.arrowDrag.scale.x += (Ld - V.arrowDrag.scale.x) * 0.25;
    V.arrowLift.scale.x += (Ll - V.arrowLift.scale.x) * 0.25;
    if (V.labDrag) V.labDrag.position.set(0.9 * V.arrowDrag.scale.x + 0.9, 0.62, 0);
    if (V.labLift) V.labLift.position.set(1.25, 1.45 - 0.9 * V.arrowLift.scale.x, 0);
  }

  /* ===========================================================================
   * 14. 场景装配 / 显示开关 / 帧循环
   * ======================================================================== */
  function flowKind() { return S.viscous === 'lam' ? 'lam' : (S.viscous === 'keps' ? 'keps' : 'kw'); }

  function assemble() {
    var vp = V.vp;
    if (!vp || !vp.scene) return;
    vp.clear();
    carMats = [];
    carCpMats = [];
    if (vp.renderer) vp.renderer.localClippingEnabled = true;

    V.world = new THREE.Group();
    vp.scene.add(V.world);
    V.car = buildCar();
    V.world.add(V.car);

    V.domain = buildDomain();
    V.world.add(V.domain);

    V.wireCoarse = new THREE.LineSegments(buildWire(false),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, fog: false }));
    V.wireFine = new THREE.LineSegments(buildWire(true),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.92, fog: false }));
    V.world.add(V.wireCoarse); V.world.add(V.wireFine);

    V.boi = buildBOI();
    V.world.add(V.boi);

    V.flow = buildPathlines(flowKind());
    V.world.add(V.flow);
    V.vor = buildVortices();
    V.world.add(V.vor);

    V.arrowDrag = arrowGroup(0xff6b5a);
    V.arrowDrag.position.set(0.6, 0.62, 0);
    V.arrowLift = arrowGroup(0x5fe08a);
    V.arrowLift.rotation.z = -Math.PI / 2;
    V.arrowLift.position.set(1.25, 1.35, 0);
    V.labDrag = labelSprite('Drag', 'Fx', '#ff8a7a');
    V.labDrag.position.set(1.5, 0.62, 0);
    V.labLift = labelSprite('Downforce', 'Fy', '#7fe8a8');
    V.labLift.position.set(1.25, 0.5, 0);
    V.world.add(V.arrowDrag); V.world.add(V.arrowLift);
    V.world.add(V.labDrag); V.world.add(V.labLift);

    V.cut = new THREE.Mesh(new THREE.PlaneGeometry(6.6, 2.9),
      new THREE.MeshBasicMaterial({ color: 0x19b5a5, transparent: true, opacity: 0.10, side: THREE.DoubleSide, depthWrite: false }));
    V.cut.position.set(0, 1.0, 0);
    V.world.add(V.cut);

    applyView();
    updateArrows();
  }

  function applyClip(on) {
    var i, mats = carMats.concat(carCpMats);
    if (V.wireCoarse) mats.push(V.wireCoarse.material);
    if (V.wireFine) mats.push(V.wireFine.material);
    for (i = 0; i < mats.length; i++) {
      var m = mats[i];
      var want = on ? clipPlanes : null;
      var same = (m.clippingPlanes === want) || (!m.clippingPlanes && !want);
      m.clippingPlanes = want;
      if (!same) m.needsUpdate = true;
    }
  }

  function applyView() {
    var vp = V.vp;
    if (!vp || !vp.scene) { refreshTools(); return; }
    if (V.car) V.car.visible = true;
    setCpMode(!!S.view.cp);          /* 先定材质，再定幽灵壳，顺序不能反 */
    setSolidMode(!!S.view.solid);
    if (V.wireCoarse) V.wireCoarse.visible = !!S.view.mesh && !S.view.refine;
    if (V.wireFine) V.wireFine.visible = !!S.view.mesh && S.view.refine;
    if (V.boi) V.boi.visible = !!S.view.boi;
    if (V.flow) V.flow.visible = !!S.view.pathlines;
    if (V.vor) V.vor.visible = !!S.view.vortices;
    if (V.arrowDrag) V.arrowDrag.visible = !!S.view.arrows;
    if (V.arrowLift) V.arrowLift.visible = !!S.view.arrows;
    if (V.labDrag) V.labDrag.visible = !!S.view.arrows;
    if (V.labLift) V.labLift.visible = !!S.view.arrows;
    if (V.cut) V.cut.visible = !!S.view.section;
    if (V.domain) V.domain.visible = !!S.view.domain;
    applyClip(!!S.view.section);
    refreshTools();
    refreshLegend();
  }

  function refreshTools() {
    var wrap = D.tools;
    if (!wrap) return;
    var btns = wrap.querySelectorAll('[data-tg]');
    for (var i = 0; i < btns.length; i++) {
      var k = btns[i].getAttribute('data-tg');
      btns[i].className = 'btn btn-sm ' + (S.view[k] ? 'btn-primary' : 'btn-ghost');
    }
    var rot = D.root.querySelector('[data-act="rot"]');
    if (rot) rot.className = 'ribbon-btn' + (S.view.autoRot ? ' is-on' : '');
    var cp = D.root.querySelector('[data-act="contour"]');
    if (cp) cp.className = 'ribbon-btn' + (S.view.cp ? ' is-on' : '');
    var pa = D.root.querySelector('[data-act="path"]');
    if (pa) pa.className = 'ribbon-btn' + (S.view.pathlines ? ' is-on' : '');
  }

  function toggleView(k) {
    S.view[k] = !S.view[k];
    if (k === 'refine' && S.view.refine) { S.view.mesh = true; S.view.boi = true; }
    if (k === 'boi' && S.view.boi) S.view.mesh = true;
    applyView();
    if (S.sel === 'mesh' || S.sel === 'contours' || S.sel === 'pathlines') renderProps();
  }

  function refreshLegend() {
    if (!D.legend) return;
    D.legend.style.display = (S.view.cp && S.view.legend) ? '' : 'none';
    D.legendBar.style.background = cpGradientCss();
    D.lgLo.textContent = CP_MIN.toFixed(1) + ' 低压';
    D.lgMid.textContent = '0';
    D.lgHi.textContent = CP_MAX.toFixed(1) + ' 高压';
  }

  var CAM_NEAR = 15, CAM_FAR = 46;
  /* three-setup 的轨道控制器没有暴露"设定视距"的接口，
     这里用它自己的滚轮事件入口把视距推到目标值（不绕过其阻尼逻辑） */
  function zoomTo(dist) {
    var vp = V.vp;
    if (!vp || !vp.camera || !vp.domElement || !vp.controls) return;
    var t = vp.controls.target;
    var cur = vp.camera.position.distanceTo(t);
    if (!(cur > 0.5)) return;
    for (var guard = 0; guard < 8 && Math.abs(cur - dist) > dist * 0.12; guard++) {
      var inward = dist < cur;
      vp.domElement.dispatchEvent(new WheelEvent('wheel', {
        deltaY: inward ? -100 : 100, bubbles: true, cancelable: true
      }));
      cur = cur * (inward ? 0.711 : 1.405);
    }
  }
  function resetView() {
    var vp = V.vp;
    if (!vp) return;
    if (V.world) V.world.rotation.y = 0;
    /* controls.update() 每帧会用内部值覆写 camera.position 与 controls.target，
       所以这里必须走 controls.setView()，直接改 camera / target 是无效的。
       角度取 build() 里 setViewport 的初始机位 (11.5, 4.2, 13.0)，
       视距回到各步骤的默认近景 CAM_NEAR。 */
    if (vp.controls && vp.controls.setView) {
      var t = new THREE.Vector3(11.5, 4.2 - 0.4, 13.0);
      vp.controls.setView(Math.atan2(t.x, t.z), Math.acos(t.y / t.length()),
        CAM_NEAR, [0, 0.4, 0]);
    } else if (vp.controls && vp.controls.reset) {
      vp.controls.reset();
      zoomTo(CAM_NEAR);
    }
    API.toast('视角已复位', 'info');
  }

  var ovTick = 0;
  function frame(dt) {
    if (S.view.pathlines && V.flow && V.flow.update) V.flow.update(dt);
    if (S.view.vortices && V.vor && V.vor.userData.update) V.vor.userData.update(dt);
    if (S.view.arrows) updateArrows();
    if (S.view.autoRot && V.world) V.world.rotation.y += dt * 0.22;
    ovTick += dt;
    if (ovTick > 0.4) {
      ovTick = 0;
      var f = forceNow();
      var txt = 'F1 外流场 · ' + S.vel + ' m/s · ' + viscousName() +
        (S.iters ? ' · iter ' + S.iters + ' · Cd ' + fmt(f.cd, 2) + ' / Cl ' + fmt(f.cl, 1) : ' · 未迭代');
      if (D.ov && D.ov.textContent !== txt) D.ov.textContent = txt;
    }
  }

  /* ===========================================================================
   * 15. 教学步骤
   * ======================================================================== */
  function setView(o) {
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) S.view[k] = o[k];
  }
  function viewAll(v) {
    setView({
      solid: v, domain: v, mesh: v, refine: v, boi: v, cp: v,
      pathlines: v, vortices: v, section: v, arrows: v, autoRot: false
    });
  }
  /* cam：这一步的默认视距。不传就用模块级 CAM_NEAR（近景）。
     形参原本叫 CAM_NEAR，会遮蔽同名的模块级 var，读代码时极容易看错，已改名。 */
  function stepPrepare(id, node, view, lines, cam) {
    S.step = id;
    setView(view);
    if (node) selectNode(node);
    assemble();
    applyView();
    zoomTo(cam === undefined ? CAM_NEAR : cam);
    if (lines) say(lines);
    updateStatus();
  }

  var STEPS = [
    {
      id: 'launch-case',
      title: '启动与新建算例',
      goal: '从 Launcher 用 <b>Solution 模式 + 3D + 双精度</b> 启动 Fluent，进主界面后确认求解器为 Pressure-Based、时间步为 Steady。',
      uiAction: '视口中央的 <b>Fluent Launcher</b>：Dimension 选 <b>3D</b>，Options 勾 <b>Double Precision</b>，Type 选 <b>Solution</b>，Processes 填 <b>4</b>，点 <b>Start</b>。' +
        '启动后双击左侧 Setup 树的 <b>General</b> 节点，确认 Solver=Pressure-Based、Time=Steady、Operating Pressure=101325 Pa。' +
        '（如果 Type 选了 Meshing，会出现黄条警告：Meshing 模式里根本没有 Setup 树。）',
      hints: [
        '找入口：<b>开始菜单 → ANSYS Fluent 2023 R1</b>，<b>不要开 Workbench</b>。Workbench 会先进 Project Schematic，初学者容易在那里迷路。',
        '坑：Type 误选 <b>Meshing</b> 就只会看到 Task 页面，没有 Setup 树，必须退回重开。<br>坑：没勾 Double Precision，单精度在 1e-4 量级的连续方程残差上很容易提前停机。',
        '为什么：F1 迎风面积约 1.5 m²，50 m/s 下 Ma ≈ 0.15 属于<b>低马赫不可压流</b>——压力基求解器不做密度方程，比密度基少一套未知量、内存省一半、低马赫下更稳。'
      ],
      physics: '定常外流按<b>质量守恒</b>求解：进域的空气质量 = 出域的空气质量。低马赫下压力变化很小（&lt;5%），可以当成不可压处理，' +
        '此时压力基与密度基的物理差别可以忽略，但数值稳定性差别很大。',
      threeD: '视口里是 F1 赛车的程序化几何，处在半透明"计算域"长方体内。拖动下方 <b>来流速度</b> 滑块可以看到后处理量级随速度平方变化。' +
        '三维视口：左键拖 = 旋转，滚轮 = 缩放，右键拖 = 平移。',
      expected: 'Setup 树节点可点、属性面板可编辑、伪终端里出现 <code>&gt; /file/start-transcript</code>，控制台<b>没有红字</b>。',
      notes: 'Processes 是并行分区数，4 核机器填 4 正好；单核机器填 1 也行，只是慢。' +
        'Fluent 学生版节点数有上限，本算例 1200 万网格在限制之内。',
      enter: function (c) {
        stepPrepare('launch-case', 'general',
          { solid: true, domain: false, mesh: false, cp: false, pathlines: false, vortices: false, section: false, arrows: false, boi: false, refine: false, autoRot: false },
          [
            ['ANSYS Fluent 2023 R1 Launcher', 'sys'],
            ['  Dimension : 3D        Options : Double Precision', 'sys'],
            ['  Type      : Solution   Processes : 4', 'sys'],
            ['还没点 Start。Type 选错成 Meshing 就没有 Setup 树——先按界面上的选项试一遍。', 'warn']
          ]);
        D.launcher.style.display = '';
        renderLauncher();
      }
    },
    {
      id: 'read-geometry',
      title: '读入 F1 几何',
      goal: '把 F1 车身几何读进算例，<b>核对单位是米</b>，并看清前翼、后翼、底板、扩散器这些产生大部分气动力的部件。',
      uiAction: '<b>文件 → 读入 → Case &amp; Data…</b>（对应 TUI <code>/file/read-case "F1_car_5m.cas.h5"</code>）。' +
        '在 Meshing 模式下则是 <b>File → Import → Geometry</b>，参数名写 <b>FileName</b>（不是 File Name，带空格的写法在批处理里会失败），' +
        '长度单位由 CAD 自身声明决定，读完务必在 General → Units 里确认。',
      hints: [
        '找入口：主界面左上 <b>File → Read… → Case &amp; Data…</b>；TUI 写法 <code>/file/read-case</code> 与之等价。',
        '坑：报 <b>File not found</b> 多半是文件带只读属性或路径含中文/空格。右键属性里取消只读，并把文件挪到纯英文短路径下。',
        '为什么：单位错三个量级（比如 mm 当 m 用），网格会慢一百倍，还会把车"吹"成一辆 5 公里长的怪物，' +
        '而 Fluent <b>不会报错</b>——它只会安静地算一个错误答案。'
      ],
      physics: '几何文件里<b>没有流体域</b>。F1 外流要的是"把车当障碍物、四周是空气"的那块空间，所以读完车体还要加计算域。',
      threeD: '视口切到 <b>表面网格线框</b>：前翼端板、后翼、底板、扩散器都用线框画出来，可以绕着车转着看。' +
        '按工具条的 <b>局部加密</b> 按钮，线框会在曲率大的地方（鼻锥、翼端、扩散器喉部）明显变密。',
      expected: '包围盒：<b>车长 5.4 m、车宽 2.0 m、车高 0.95 m</b>；控制台出现 cells/nodes 统计与 <code>0 failed faces</code>。',
      notes: '真实 F1 是"薄壳"车体，本例把车壳当零厚度壁面处理；要想算刹车温度或座舱散热，才需要把内部建成 solid zone。',
      enter: function (c) {
        stepPrepare('read-geometry', 'general',
          { solid: false, domain: false, mesh: true, refine: true, boi: false, cp: false, pathlines: false, vortices: false, section: false, arrows: false, autoRot: false },
          [
            ['> /file/read-case "F1_car_5m.cas.h5"', 'cmd'],
            ['Reading "F1_car_5m.cas.h5"...', 'info'],
            ['   1 842 116 faces, 983 204 surface nodes', 'info'],
            ['   0 failed faces, 0 free faces', 'ok'],
            ['   Bounding box: X 5.40 m  Y 0.95 m  Z 2.00 m   ← 单位是米，不是毫米', 'ok'],
            ['   单位核对：General → Units = m。若是 mm，车会变成 5.4 km 的怪物且不报错。', 'warn']
          ]);
        D.ov.textContent = '包围盒 5.40 × 2.00 × 0.95 m  ·  表面网格（曲率 & 近距加密）';
        D.launcher.style.display = 'none';
      }
    },
    {
      id: 'domain-sizing',
      title: '规划计算域与堵塞比',
      goal: '把计算域包住整台车：上游 2L、下游 6L、侧向每侧 2W、顶部 2H，并让<b>堵塞比低于 5%</b>。',
      uiAction: 'Watertight 流程里 <b>Import Geometry</b> 之后展开 <b>Details</b>（或 CAD 端直接建 Enclosure）填 <b>Max Length</b>；' +
        'TUI 等价写法 <code>/boundary/manage/add-enclosure f1_domain 10 30 4 4 1.9 0</code>（六面各自的扩展量，单位 m）。' +
        '本步在 <b>Mesh</b> 面板拖动"侧向扩展"滑块，实时看<b>堵塞比</b>怎么变，低于 5% 才算合格。',
      hints: [
        '找入口：<b>Details</b> 面板里的 <b>Max Length</b> 字段（或 Enclosure 的各方向填充量）。',
        '坑：下游只给 2L，尾流被域后壁挡住会反射回来，<b>必然回流</b>、阻力算高一大截。',
        '为什么：堵塞比 &lt; 3~5% 时，域边界对车身附近流场的扰动 &lt; 1%，可以当成"无限大流体"；' +
        '域太小放大阻力，域太大浪费格子（每边放大一倍，格子数 ×8）。'
      ],
      physics: '流动取决于域外的"无穷远"条件。堵塞比 A_car / A_inlet 太大时，域壁就像近地飞行，' +
        '会产生额外的地面效应与绕流偏折，直接污染 Cd 与 Cl。',
      threeD: '半透明域盒把车包住：<b>蓝色 inlet</b>（来流箭头）、<b>绿色 outlet</b>、<b>橙色 ground</b>（贴地壁面）、' +
        '<b>紫色 farfield</b>（侧向与顶部 symmetry）。每块面都有 Sprite 文字标签，标注对应的 Fluent 边界类型。' +
        '拖动 Mesh 面板里的侧向滑块，能看到域盒左右两面<b>真的在动</b>。',
      expected: '侧向 4.0 m（2W）时入口截面积 10.0 × 2.85 = 28.5 m²，堵塞比 5.26%——<b>略超 5%</b>；' +
        '把侧向拉到 6.0 m（3W）后降到 3.76%，合格。',
      notes: '本例的 F1 地面效应本身就要求"底板离地很近"，所以下游给到 6L 是为了把扩散器尾流完整包住；' +
        '常规民用汽车 3L 上游 / 8L 下游就够。',
      enter: function (c) {
        var b = blockingRatio();
        stepPrepare('domain-sizing', 'mesh',
          { solid: true, domain: true, mesh: false, boi: false, cp: false, pathlines: false, vortices: false, section: false, arrows: false, autoRot: false },
          [
            ['> /boundary/manage/add-enclosure f1_domain 10 30 4 4 1.9 0', 'cmd'],
            ['   upstream 10.0 m (2L)   downstream 30.0 m (6L)', 'info'],
            ['   lateral 4.0 m each side (2W)   top 1.9 m (2H)   bottom on ground', 'info'],
            ['   inlet cross-section = ' + fmt(b.area, 1) + ' m²   blocking ratio = ' + fmt(b.ratio, 2) + ' %', b.ratio < 5 ? 'ok' : 'warn'],
            ['   ' + (b.ratio < 5 ? '✓ 堵塞比 < 5%，域边界扰动可忽略' : '✗ 略超 5%：到 Mesh 面板把侧向拉到 6 m 再看'), b.ratio < 5 ? 'ok' : 'warn'],
            ['   底部必须<b>贴地</b>并留 0.2 m 首层网格：地面是 moving ground 里的 Slip 壁面，', 'info'],
            ['   底板与地面的夹角直接决定下压力大小。', 'info']
          ], CAM_FAR);
        D.ov.textContent = '计算域 40 × 10 × 2.85 m  ·  堵塞比 ' + fmt(b.ratio, 2) + '%';
      }
    },
    {
      id: 'surface-mesh',
      title: '表面网格与尾流 BOI',
      goal: '用 <b>Curvature &amp; Proximity</b> 划分表面网格，再用一条<b>长条 BOI</b> 把后翼下游的尾流强制加密。',
      uiAction: '点工具条 <b>表面网格</b>（默认是粗网格），再点 <b>局部加密</b> 切到加密版。' +
        '在 <b>Mesh</b> 面板核对：Size Functions = <b>Curvature &amp; Proximity</b>，Min 5 mm、Max 150 mm、Growth Rate 1.2；' +
        'BOI 长条体包住后翼下游，<b>Max Length 20 mm</b>，点"显示 BOI 线框"看它的范围。',
      hints: [
        '找入口：Watertight 任务里的 <b>Generate the Surface Mesh → Details</b>，以及 <b>Local Sizing → BOI</b> 行。',
        '坑：Size Functions 的合法值只有 <b>Curvature / Proximity / Curvature &amp; Proximity</b> 三个，' +
        '<b>没有 "Basic" 这个选项</b>，选错会直接报 invalid value。',
        '坑：BOI 必须是一个<b>封闭体</b>，跨过车体把它切开，网格会直接失败。',
        '为什么：曲率加密让小半径的地方自动细化；近距加密防止缝隙被大单元跨过；' +
        'BOI 则是"这里必须细，不管自动尺寸算出来多大"——翼端涡与扩散器尾迹是阻力主源。'
      ],
      physics: '近壁网格决定边界层的分辨率：首层高度与 y+ 共同决定壁函数是否有效。' +
        'SST 模型的 ω 衰减到壁面，所以 y+ 只要落在 30~300 的墙函数区间就行，不必追求 y+≈1。',
      threeD: '同一步里对比两套线框：<b>粗网格</b>下均匀稀疏；<b>局部加密</b>下鼻锥、翼端、底板与扩散器喉部的线明显更密，' +
        '橙色长条体就是 BOI——框内是强制细网格，框外照常。',
      expected: '粗网格 ≈ 12 站、加密网格 ≈ 55 站；无 Failed Faces、自由边 0；最大边长 150 mm、最小 5 mm、Growth 1.2。',
      notes: 'Growth Rate 1.2 表示每往外一层边长只涨 20%。取 1.05 会让网格量翻十几倍，取 1.5 尾流会糊掉。',
      enter: function (c) {
        stepPrepare('surface-mesh', 'mesh',
          { solid: false, domain: true, mesh: true, refine: true, boi: true, cp: false, pathlines: false, vortices: false, section: false, arrows: false, autoRot: false },
          [
            ['> /size-functions/curvature? yes', 'cmd'],
            ['> /size-functions/proximity? yes', 'cmd'],
            ['   Minimum Size 0.005 m   Maximum Size 0.15 m   Growth Rate 1.2', 'info'],
            ['> /boundary/manage/boi create "wake-box"', 'cmd'],
            ['   BOI: 6.0 m × 1.15 m × 2.0 m，长轴沿流向，位于后翼下游', 'ok'],
            ['   Max Length inside BOI = 0.02 m', 'info'],
            ['> /mesh/surface-mesh', 'cmd'],
            ['   Surface mesh generated.  0 failed faces, 0 free faces.', 'ok']
          ]);
        D.ov.textContent = '表面网格：曲率 & 近距加密 + 尾流 BOI';
      }
    },
    {
      id: 'describe-volume-mesh',
      title: '描述几何、体网格与质量检查',
      goal: '声明域类型（流体还是空腔）、给面组起名、生成 <b>poly-hexcore</b> 体网格，并检查质量是否达标。',
      uiAction: 'Meshing 树里双击 <b>Describe Geometry</b>，Details 里 <b>Setup Type</b> 选第 3 项 <b>both fluid and solid regions and/or voids</b>，' +
        '再点 <b>Update Boundaries</b> 把面重命名成 <b>inlet / outlet / ground / car-skin / farfield-*</b>。' +
        '回到 Solution 模式双击 Setup 树里的 <b>Mesh</b> 节点，点 <b>Check</b>（等价 <code>/mesh/check</code>）。',
      hints: [
        '找入口：Meshing 树里的 <b>Describe Geometry</b> 节点，右侧 Details 面板的 Setup Type 下拉。',
        '坑：Setup Type 选第 1 项 <code>fluid regions only</code> 会把域面直接吞成 interior，' +
        '面组全部丢失、后面配不了边界条件。',
        '坑：面组名里带 <code>fluid regions with voids</code> 这种非法串会漏出 freeparts 面。',
        '为什么：<b>正交质量 &lt; 0.1 残差必发散</b>。体网格在扩散器喉部这种几何突变处最容易出坏单元，' +
        '所以必须 Check 之后才敢点 Calculate。'
      ],
      physics: 'Setup Type 决定内腔被判成 fluid 还是 solid——判错求解器会直接拒绝边界条件。' +
        'poly-hexcore 的好处是近壁用多面体保住精度、远场用六面体省单元，比纯四面体快 2~3 倍。',
      threeD: '点工具条的 <b>剖切</b>：计算域沿 z=0 被切开，能直接看到<b>车底与地面之间只有几层网格</b>，' +
        '而底板前后（扩散器）明显更密。',
      expected: '面组 6 个齐全、泄漏面 0；<b>Orthogonal Quality &gt; 0.15</b>（实际 0.17）、<b>Skewness &lt; 0.90</b>（实际 0.85）。',
      notes: 'Quality 里的 Max Aspect Ratio 4820 属于正常——F1 底板和端板本来就是薄长条结构，' +
        '真正要盯的是正交质量与偏斜度这两个无量纲指标。',
      enter: function (c) {
        stepPrepare('describe-volume-mesh', 'mesh',
          { solid: true, domain: true, mesh: false, boi: false, cp: false, pathlines: false, vortices: false, section: true, arrows: false, autoRot: false },
          [
            ['> /file/write-case "F1_described.cas.h5"', 'cmd'],
            ['> /mesh/check', 'cmd'],
            ['   Mesh check completed.', 'ok'],
            ['   Number of cells ............ 12 486 720', 'info'],
            ['   Minimum orthogonal quality  0.170', 'ok'],
            ['   Maximum skewness ........... 0.850', 'ok'],
            ['   Zone "inlet" (velocity-inlet) / "outlet" (pressure-outlet) / "ground" (wall) / "car-skin" (wall) / "farfield-*" (symmetry)', 'info'],
            ['   剖切视图：车底与地面之间只有 3~4 层单元，扩散器喉部最密。', 'info']
          ]);
        D.ov.textContent = '体网格 poly-hexcore · 剖切视图 z=0 · 正交质量 0.17 / 偏斜 0.85';
      }
    },
    {
      id: 'general-materials',
      title: '材料与操作压力',
      goal: '设定空气物性（ρ、μ、Cp）与 <b>Operating Pressure</b>，把表压与绝对压的基准分开。',
      uiAction: '双击 <b>Materials → Fluid → air</b>：Density = <b>constant, 1.225 kg/m³</b>，' +
        'Viscosity = <b>1.7894e-05 kg/(m·s)</b>，Cp = 1006.43 J/(kg·K)。' +
        '再回 <b>General</b> 面板把 <b>Operating Pressure 填 101325 Pa</b>。' +
        '本步可以拖动 air 面板里的<b>海拔滑块</b>，看大气密度与动压 q 怎么变。',
      hints: [
        '找入口：<b>Materials</b> 节点，双击列表里的 <b>air</b>，右侧出现 Properties 页。',
        '坑：要用 <code>pressure-far-field</code> 就必须把 Density 改成 <b>ideal-gas</b>，' +
        '否则 Fluent 在初始化之前就会拒绝：<code>density must be a function of pressure</code>。',
        '为什么：操作压力把<b>表压与绝对压</b>分开。求解器内部按表压迭代（数值范围小、更稳），' +
        '报告时再补上这个常数还原绝对压，和风洞测力时的表压基准完全一致。'
      ],
      physics: '报告出来的气动力只依赖<b>压差</b>，所以理想气体与常数密度给出的力几乎一样；' +
        '但用了 ideal-gas 之后，海拔/温度变化会自然进入动压 q = ½ρU²。',
      threeD: 'Cp 云图开着（<b>轮廓显示</b> 按钮），车头是蓝色高压区、底板是红色吸力区。' +
        '拖动海拔滑块时，右栏的 q = ½ρU² 实时变化——3000 m 时 ρ≈0.914，动压掉到四分之一。',
      expected: 'ρ = 1.225 kg/m³、μ = 1.7894e-05、q = 0.5×1.225×50² = <b>1531.25 Pa</b>。',
      notes: 'Cp 是<b>无量纲</b>压力系数 Cp = (p−p∞)/(½ρU²)，换海拔时 Cp 云图本身不变，' +
        '变的是它代表的绝对压差和最终的力——别把这两件事搞混。',
      enter: function (c) {
        stepPrepare('general-materials', 'air',
          { solid: true, domain: true, mesh: false, boi: false, cp: true, pathlines: false, vortices: false, section: false, arrows: false, autoRot: false },
          [
            ['> /define/materials/change-create air air yes constant 1.225 no 1.7894e-05 no 1006.43 no 0.0242', 'cmd'],
            ['   air: ρ = 1.225 kg/m³ (constant),  μ = 1.7894e-05 kg/(m·s)', 'ok'],
            ['> /define/operating-conditions/operating-pressure 101325', 'cmd'],
            ['   Operating Pressure = 101325 Pa  ← 表压基准', 'ok'],
            ['   标准大气：h = 0 m → ρ = 1.2250 kg/m³,  q = ½ρU² = ' + fmt(dynP(), 2) + ' Pa', 'info'],
            ['   h = 3000 m → ρ = 0.9143 kg/m³,  q = ¼ × 海平面 —— 同样 Cd 只出四分之一的力', 'warn']
          ]);
        D.ov.textContent = 'Cp 伪彩：蓝=高压（鼻锥驻点）→ 红=低压（底板抽吸）';
      }
    },
    {
      id: 'turbulence-model',
      title: '选湍流模型并关掉能量方程',
      goal: '在层流 / k-epsilon / k-omega 之间做选择，并确认 <b>Energy = Off</b>。',
      uiAction: '双击 <b>Models → Viscous</b>：Model 由 Laminar 改选 <b>k-omega</b>，其下 <b>k-omega Model = SST</b>、' +
        '勾 <b>Production Limiter</b>、<b>Near-Wall Treatment = Wall Function</b>，k 与 ω 速率选 <b>Compute per Unit Mass</b>。' +
        '<b>Models → Energy 保持 Off。</b>在 <b>Pathlines</b> 面板可以一键对比三种模型的流场差别。',
      hints: [
        '找入口：<b>Models → Viscous</b>，Model 下拉；<b>选 k-omega 之后 SST 选项才会出现</b>。',
        '坑：读入带湍流数据的 case 后，Viscous 常常<b>已经被默认激活成 k-omega</b>，必须显式检查一遍再改，别以为默认就是对的。',
        '为什么：有<b>分离/逆压梯度</b>选 SST（F1 前翼下洗、底板边界层分离全靠它）；自由来流、无大分离才选 k-epsilon。'
      ],
      physics: '能量方程解温度场；F1 外气动是<b>等温</b>的，没有浮升力，' +
        '开它只会增加未知量与内存、拖慢收敛。SST 的 ω 衰减到壁面为 0，所以能预测逆压梯度下的分离。',
      threeD: '同一辆车的三套流场：<b>层流</b>尾流窄得像没扰动；<b>k-epsilon</b> 尾流一下子摊得很宽、底板下洗变弱；' +
        '<b>SST</b> 在后轮与翼端拖出<b>非对称的涡对</b>，把气流往下洗——这正是 F1 底板设计赖以工作的机制。',
      expected: 'Models 面板里 Viscous = k-omega (SST)、Energy = Off；残差监视器出六条曲线（continuity / x,y,z-velocity / k / omega）。',
      notes: 'F1 在 50 m/s 下 Re ≈ 2×10⁷，属于极强湍流。层流选项留在这里只是为了做对比演示，' +
        '真实算例选它会严重低估阻力与下压力。',
      enter: function (c) {
        stepPrepare('turbulence-model', 'viscous',
          { solid: true, domain: true, mesh: false, boi: false, cp: false, pathlines: true, vortices: true, section: false, arrows: false, autoRot: false },
          [
            ['> /define/models/viscous/kw-sst yes', 'cmd'],
            ['   Turbulent Viscosity Model: k-omega (SST)', 'ok'],
            ['   Production Limiter: on     Near-Wall Treatment: Wall Function', 'info'],
            ['   Turbulent Kinetic Energy / Specific Dissipation Rate: Compute per Unit Mass', 'info'],
            ['> /define/models/energy? no no no no yes', 'cmd'],
            ['   Energy Equation: OFF  ← 等温外气动不需要能量方程', 'ok'],
            ['   层流 vs k-epsilon vs SST：切 Pathlines 面板的对比按钮看尾流差别。', 'info']
          ]);
        D.ov.textContent = 'k-omega (SST) · Energy Off · 流线与尾涡可视化';
      }
    },
    {
      id: 'boundary-conditions',
      title: '设置五类边界条件',
      goal: '把 <b>inlet / outlet / ground / car-skin / farfield-*</b> 五类边界全部配对配齐，并确认没有 BC warning。',
      uiAction: '双击 <b>Boundary Conditions</b> 里各 zone：' +
        '<b>inlet → velocity-inlet</b>，Momentum 选项卡 Velocity Specification Method = <b>Magnitude and Direction</b>，X=50、Y=Z=0，' +
        'Turbulence 选项卡 Intensity and Viscosity Ratio <b>5% / 10</b>；' +
        '<b>outlet → pressure-outlet</b>，Gauge Pressure = <b>0</b>；' +
        '<b>car-skin 与 ground → wall</b>，Wall Conditions → Momentum → Shear Condition = <b>Slip</b>（仅地面）；' +
        '<b>farfield-* → symmetry</b>。',
      hints: [
        '找入口：<b>Boundary Conditions</b> 展开就是 zone 列表，双击 zone 名打开编辑面板；面板顶部有 Momentum / Thermal / Turbulence 三个选项卡。',
        '坑：把侧向/顶部远场设成 velocity-inlet，气流会沿 ±y/±z 硬吹进计算域，直接造成出口 <b>39% 回流</b>。' +
        '本模块里你要是真这么改，面板会立刻报红警告。',
        '坑：速度入口与压力出口必须<b>成对使用</b>，只设一个 Fluent 会报 no driving condition。',
        '为什么：移动地面坐标系下，地面是<b>自由滑移壁面</b>——Slip 壁面切应力为零，只传递法向压力，' +
        '这正是下压力的来源；车体则必须 No Slip，气流贴着它减速转向才产生压差。'
      ],
      physics: '气动力 = 壁面静压积分 + 剪切应力积分。F1 以<b>压力项绝对主导</b>（接地面积大、压差大），' +
        '地面几乎不产摩擦力，所以 Slip 壁面对阻力几乎没有影响，却对下压力至关重要。',
      threeD: '点视口里不同颜色的面，或点左侧树里的 zone 名，标签会跟着变。' +
        '蓝面是来流面（50 m/s 吹向 +X），绿面是抽离面，橙色的地面带 Slip 标签。',
      expected: '没有 BC warning；Reference Values 里的 Velocity 也是 50 m/s，与入口一致。',
      notes: '入口湍流强度取 5% 属于常见工程取值（0.1%~10% 之间）。' +
        '如果湍流强度给 0.1%，SST 起步会有较长的过渡期；给 10%，尾流会明显偏脏。',
      enter: function (c) {
        stepPrepare('boundary-conditions', 'bc:inlet',
          { solid: true, domain: true, mesh: false, boi: false, cp: false, pathlines: true, vortices: false, section: false, arrows: false, autoRot: false },
          [
            ['> /define/boundary-conditions/velocity-inlet inlet yes no 50 no 1 no 0 no 0', 'cmd'],
            ['   inlet: velocity-inlet, 50 m/s along +X', 'ok'],
            ['   Turbulent Intensity 5%   Viscosity Ratio 10', 'info'],
            ['> /define/boundary-conditions/pressure-outlet outlet yes no 0 no yes no no no', 'cmd'],
            ['   outlet: pressure-outlet, gauge pressure 0 Pa', 'ok'],
            ['> /define/boundary-conditions/wall', 'cmd'],
            ['   zone-type [wall]: ground', 'info'],
            ['   shear-condition [0=No Slip, 1=Slip]: 1   ← 地面自由滑移，只传法向压力', 'ok'],
            ['   car-skin 保持 0 (No Slip)', 'info'],
            ['> /define/boundary-conditions/symmetry farfield-sides farfield-top', 'cmd'],
            ['   farfield-*: symmetry（∂φ/∂n = 0，无需填任何数值）', 'ok'],
            ['   6 个 zone 全部就绪，无 warning。', 'ok']
          ]);
        D.ov.textContent = '五类边界：velocity-inlet / pressure-outlet / wall(Slip) / symmetry';
      }
    },
    {
      id: 'initialize-run',
      title: '初始化、参考值与迭代设置',
      goal: '填好<b>参考值四项</b>、用 Standard Initialization 生成初值、把迭代上限设成 800。',
      uiAction: '双击 <b>Reference Values</b>：Density = 1.225、Velocity = 50、<b>Area = 1.5 m²（迎风投影）</b>、Length = 5.0 m。' +
        '双击 <b>Initialization</b>：Standard Initialization、<b>Compute from = inlet</b>，点 <b>Initialize</b>。' +
        '<b>Run Calculation</b> 把 Number of Iterations 设成 <b>800</b>。' +
        '收敛判据不在这个面板，在 <b>Solution → Convergence Criteria</b>。',
      hints: [
        '找入口：判据在 <b>Solution</b> 节点，<b>不在</b> Run Calculation 面板——这是最常见的找不到的地方。',
        '坑：Area 填成侧投影面积或车身表面积，Cd 会放大或缩小好几倍；漏设参考值会沿用默认 1 m²，' +
        '所有 Cd 直接放大 1.5 倍，跨算例对比全废。',
        '为什么：Cd = Fx / (½ρU²·A)。50 m/s 的动压 q = 0.5×1.225×2500 = <b>1531 Pa</b>，这是后处理所有换算的基准。'
      ],
      physics: 'Standard Initialization 直接用入口速度铺满全场，物理上等于"一上来车已经在风里以 50 m/s 冲"，' +
        '是最不容易发散的外流场初始化方式。Compute from 也可以选 car-skin（按局部方向插值）或者 Automatic。',
      threeD: '来流滑块和右栏的 q 联动：把速度拉到 80 m/s，q 从 1531 Pa 涨到 3920 Pa，' +
        '同一组 Cd 换算出来的力也按平方律放大。',
      expected: '参考值四项已填、初始流场已生成（Solution Initialized = yes）、Run Calculation 显示 800 iterations。',
      notes: 'Reference Values 里的 Velocity 必须和 BC 里的入口速度一致，否则' +
        'q = ½ρU² 的分母对不上，Cd 与实际气动系数无关。',
      enter: function (c) {
        if (!S.initialized) doInitialize();
        stepPrepare('initialize-run', 'refvals',
          { solid: true, domain: true, mesh: false, boi: false, cp: false, pathlines: true, vortices: false, section: false, arrows: false, autoRot: false },
          [
            ['> /report/reference-values/density 1.225', 'cmd'],
            ['> /report/reference-values/velocity 50', 'cmd'],
            ['> /report/reference-values/area 1.5', 'cmd'],
            ['> /report/reference-values/length 5', 'cmd'],
            ['   q = ½ρU² = 0.5 × 1.225 × 50² = ' + fmt(dynP(), 2) + ' Pa', 'ok'],
            ['   Cd = Fx / (q·A)，A = 1.5 m²（迎风投影，不是表面积！）', 'warn'],
            ['> /solve/set/convergence-criteria 1e-04 1e-03 1e-03 1e-03 1e-03 1e-03', 'cmd'],
            ['> /solve/iterate 800', 'cmd'],
            ['   800 是上限；所有残差低于判据并保持 20 步会自动停机（本例约 335 步）。', 'info']
          ]);
        D.ov.textContent = '参考值 ρ=1.225 U=50 A=1.5 L=5.0  ·  q = ' + fmt(dynP(), 1) + ' Pa';
      }
    },
    {
      id: 'solve-converge',
      title: '迭代求解与收敛判读',
      goal: '点 Calculate 跑到收敛，并同时拿到<b>三条独立证据</b>：残差、质量守恒、气动力平稳。',
      uiAction: '到 <b>Run Calculation</b> 面板点 <b>Calculate</b>（再点一次是暂停）。' +
        '迭代过程中反复看两件事：右边的<b>残差监视器</b>与<b>气动力历史曲线</b>；' +
        '再到 <b>Reports → Fluxes</b> 同时勾选 <b>inlet 与 outlet</b>，点 Compute 比对 Mass Flow Rate。',
      hints: [
        '找入口：<b>Fluxes</b> 在 Results 树的 Reports 节点，<b>必须同时勾 inlet 和 outlet</b>，只勾一个算不出不平衡。',
        '坑：残差掉了但 Cd 还在漂，就是<b>未真收敛</b>——此时看物理量历史曲线最准。',
        '坑：出口质量流量为<b>正</b>说明回流（正常应为负值，符号相反表示流出）。',
        '为什么：残差是<b>方程不平衡量</b>，它降下去只说明离散方程解得稳；' +
        '物理量平稳才说明流场真的不再变化——两者是独立的证据，缺一不可。'
      ],
      physics: 'continuity 到 1e-4、动量与湍流量到 1e-3，说明方程已耦合到定常态；' +
        '质量守恒（进出质量流量差 &lt; 0.1%）是与残差完全独立的第二重验证。' +
        '算例在第 40~60 次迭代附近有一段"假收敛"平台——残差暂时走平又回升，这是真实 CFD 里最常见的陷阱。',
      threeD: '流线粒子随迭代推进：从"整个域都铺满 50 m/s"的初值，慢慢演化成包住车身的稳定绕流；' +
        '红色 <b>Drag</b> 与绿色 <b>Downforce</b> 箭头随着力收敛而<b>变长</b>并稳定下来。',
      expected: '残差 20 步不回升；进出质量流量差 &lt; 0.1%；两次力报告差 &lt; 0.5%。',
      notes: '如果中途想重来：Run Calculation 面板的 <b>Reset</b> 会把迭代号、残差历史与力历史一起清零，' +
        '但<b>不会</b>清除边界条件与网格——想彻底重置就重新 Initialize。',
      enter: function (c) {
        if (!S.initialized) doInitialize();
        stepPrepare('solve-converge', 'residual',
          { solid: true, domain: true, mesh: false, boi: false, cp: false, pathlines: true, vortices: false, section: false, arrows: true, autoRot: false },
          [
            ['> /solve/iterate ' + S.target, 'cmd'],
            ['   Solution is initialized — 随时点 Run Calculation → Calculate 开始迭代。', 'info'],
            ['   左边残差监视器按对数坐标画 6 条曲线，右边画 Cd / Cl 历史。', 'info'],
            ['   第 40~60 步附近有一小段平台：残差看起来走平了又回升——这就是"假收敛"。', 'warn'],
            ['   真正收敛后还会自动触发一次质量流量校验。', 'info']
          ]);
        D.ov.textContent = '迭代中：残差 / 质量流量 / Cd·Cl 三重验证';
      }
    },
    {
      id: 'post-contour-force',
      title: '后处理云图与气动力报告',
      goal: '出 Cp 云图、绕飞流线、尾涡，切力矢量与力报告，拿到<b>可信的下压力与阻力</b>。',
      uiAction: '<b>Results → Graphics → Contours</b>：Contours of = <b>Pressure Coefficient</b>，Surfaces 只勾 <b>car-skin</b>，点 <b>Display</b>。' +
        '再开 <b>Pathlines</b>：Pathlines of = <b>Velocity</b>，从 <b>inlet</b> 释放、Paths = 500。' +
        '然后 <b>Reports → Reports → Forces</b>：勾 <b>Cd / Cl</b>，Surfaces 选 <b>car-skin 与 ground</b>，' +
        'Force Vector 设 Drag = (1,0,0)、<b>Lift = (0,0,−1)</b>，点 <b>Compute</b>（或 Write 写文件）。' +
        '最后在 <b>Report Definitions</b> 里创建 cd-monitor / cl-monitor 并 Plot 画历史曲线。',
      hints: [
        '找入口：Results 树下面挂着 <b>Graphics</b> 与 <b>Reports</b> 两个子节点，前者出图、后者出数。',
        '坑：<b>Lift 必须给 (0, 0, −1)</b>。F1 的升力是向下的（压低车），给 +1 会得到一个负的下压力。',
        '坑：<b>受力面必须含 car-skin + ground</b>，漏掉地面会少算一大块底板下压力（实测差 30% 以上）。',
        '为什么：Cp 云图上<b>红=低压</b>的地方（底板、前翼下表面、后翼上表面）就是下压力的来源；' +
        '车头蓝高压与尾流橙高压贡献阻力。'
      ],
      physics: '气动力 = 壁面静压积分 + 剪切应力积分。F1 接地面积大、压差大，' +
        '所以压力项绝对主导，剪切项在千分之几量级可以忽略。',
      threeD: '车身叠加 Cp 伪彩（蓝高压→红低压）+ <b>legend 彩条</b>；流线从入口绕过车身、在尾翼后汇聚成尾迹；' +
        '橙色双螺旋涡粒子从后翼甩出，红色箭头向后、绿色箭头向下。',
      expected: 'Cd ≈ <b>0.9~1.3</b>、阻力 ≈ <b>2~2.5 kN</b>；下压力 Cl ≈ <b>5~10</b>、约 <b>10~23 kN</b>。',
      notes: '如果算出来的 Cd 特别小，先查三件事：Reference Values 的 Area 是不是 1.5 m²、' +
        '受力面是不是漏了 ground、参考 Velocity 是不是和入口一致。',
      enter: function (c) {
        stepPrepare('post-contour-force', 'contours',
          { solid: true, domain: true, mesh: false, boi: false, cp: true, pathlines: true, vortices: true, section: false, arrows: true, autoRot: false },
          [
            ['> /display/objects/create contour field pressure-coefficient surfaces-list car-skin ()', 'cmd'],
            ['   Contours of pressure-coefficient displayed on car-skin.', 'ok'],
            ['   Cp 图例量程 -1.80 ~ +1.20；本模型实际读数：最高 +1.05（鼻锥驻点，蓝）、' +
             '最低 -1.58（车底后段与扩散器出口，红）、尾流约 +0.4（橙）', 'info'],
            ['> /display/objects/create pathlines field velocity release-from-surfaces inlet ()', 'cmd'],
            ['   500 paths released from inlet.', 'ok'],
            ['> /report/forces/wall-forces yes car-skin ground () drag 1 0 0 lift 0 0 -1 quit', 'cmd'],
            S.iters
              ? ['   Cd = ' + fmt(cdAt(S.iters), 5) + '    Cl = ' + fmt(clAt(S.iters), 5), 'ok']
              : ['   还没迭代，力报告取的是初值——先去上一步跑 Calculate。', 'warn'],
            ['   Fx = ' + fmt(cdAt(S.iters) * dynP() * S.area, 0) + ' N   Fy = ' + fmt(clAt(S.iters) * dynP() * S.area, 0) + ' N', 'ok'],
            ['   下压力是阻力的 ' + fmt(Math.abs(clAt(S.iters) / Math.max(1e-6, cdAt(S.iters))), 1) + ' 倍——这就是 F1 弯道压车尾的底气。', 'info']
          ]);
        if (S.iters) renderForceCard();
        D.ov.textContent = 'Cp 伪彩 + 流线 + 尾涡 + 力矢量  ·  Cd ' + fmt(cdAt(S.iters), 2) + ' / Cl ' + fmt(clAt(S.iters), 1);
      }
    },
    {
      id: 'workflow-review',
      title: '全流程复盘与自检',
      goal: '把 12 步串成一条完整链路，并对照<b>六项自检</b>确认这个算例的结果可以直接拿去用。',
      uiAction: '按顺序点一遍左侧步骤，确认每一步的"预期结果"都达到了。任何一项没达到，回到对应步骤重做——' +
        'Fluent 里绝大多数"结果不对"的问题，都能在这条链路的某一环上找到原因。',
      hints: [
        '自检清单：① Domain 堵塞比 &lt; 5% ② 无 Failed Faces、正交质量 &gt; 0.15 ' +
        '③ 残差到判据并保持 20 步 ④ 质量流量不平衡 &lt; 0.1% ⑤ 参考值 Area = 1.5 m² ⑥ Lift 方向 = (0,0,−1)。',
        '一句话记住整条链路：<b>几何 → 计算域 → 表面网格 → 体网格 → 材料/操作压力 → 湍流模型 → ' +
        '边界条件 → 参考值 → 初始化 → 迭代收敛 → 后处理 → 气动力报告</b>。'
      ],
      physics: '外流场气动力的三个层次：<b>压力项（主导）</b>、剪切项（小）、参考量换算（最容易被搞错）。' +
        '任何一环错了，出来的数字都"看起来正常"但没有可比性——所以每一步都要有独立的验证证据。',
      threeD: '所有图层同时打开：计算域、车身 Cp 云图、表面网格、流线、尾涡、力矢量，' +
        '再点<b>自动旋转</b>绕着看一圈。',
      expected: '六项自检全部通过；残差 335 步收敛；质量不平衡 &lt; 0.1%；Cd ≈ 1.05、Cl ≈ 6.8（' +
        '阻力约 2.4 kN、下压力约 15.6 kN @ 50 m/s）。',
      notes: '下一步可以试试：把来流速度滑块拉到 30 m/s 再算一次，看 Cd 随 Re 的变化；' +
        '或者把 S.lateral 改成 6 m（3W）重算，比较堵塞比对阻力的影响。',
      enter: function (c) {
        viewAll(true);
        setView({ autoRot: true });
        stepPrepare('workflow-review', 'run',
          { solid: true, domain: true, mesh: true, refine: true, boi: true, cp: true, pathlines: true, vortices: true, section: false, arrows: true, autoRot: true },
          [
            ['=== F1 50 m/s 定常外流 · 全流程复盘 ===', 'sys'],
            [' 1 启动      : Launcher → 3D / Double Precision / Solution / 4 processes', 'ok'],
            [' 2 读几何    : File → Read → Case & Data，单位 = m，包围盒 5.40 × 2.00 × 0.95', 'ok'],
            [' 3 计算域    : 上游 2L / 下游 6L / 侧 2W / 顶 2H，堵塞比 ' + fmt(blockingRatio().ratio, 2) + ' %', 'ok'],
            [' 4 表面网格  : Curvature & Proximity + 尾流 BOI（Max Length 20 mm）', 'ok'],
            [' 5 体网格    : poly-hexcore，正交质量 0.17 / 偏斜 0.85', 'ok'],
            [' 6 材料      : ρ=1.225, μ=1.7894e-05, Operating Pressure 101325', 'ok'],
            [' 7 湍流      : k-omega (SST)，Energy Off', 'ok'],
            [' 8 边界      : inlet 50 m/s / outlet 0 Pa / ground Slip / car-skin No Slip / farfield symmetry', 'ok'],
            [' 9 初始化    : Reference ρ=1.225 U=50 A=1.5 L=5.0，Standard Init from inlet', 'ok'],
            ['10 收敛      : ' + (S.iters ? S.iters + ' 步，max residual ' + exp3(maxRes()) : '尚未迭代') + '，质量不平衡 ' + fmt(S.fluxes.imbalance, 4) + ' %', 'ok'],
            ['11 后处理    : Cp 云彩 / 流线 / 尾涡 + Forces（Cd、Cl，受力面 car-skin + ground）', 'ok'],
            ['   结果      : Cd = ' + fmt(cdAt(S.iters), 3) + '   Cl = ' + fmt(clAt(S.iters), 2) + '   q = ' + fmt(dynP(), 1) + ' Pa', 'ok']
          ]);
        if (S.iters) renderForceCard();
        D.ov.textContent = '全流程复盘 · 自动旋转中 · 可随时点「复位」停下';
      }
    }
  ];

  /* ===========================================================================
   * 16. 注册模块
   * ======================================================================== */
  CAE.registerModule({
    id: 'fluent',
    name: 'ANSYS Fluent',
    tagline: '外流场 · 流体仿真',
    accent: '#19b5a5',
    build: function (ctx) {
      API = ctx.api;
      D.root = ctx.root;
      D.root.id = 'fluRoot';           // 模块私有样式的作用域锚点（见 CSS 段）
      D.root.style.overflow = 'hidden';
      D.root.innerHTML = buildDom();

      D.tree = D.root.querySelector('#fluTree');
      D.props = D.root.querySelector('#fluProps');
      D.tools = D.root.querySelector('#fluTools');
      D.launcher = D.root.querySelector('#fluLauncher');
      D.card = D.root.querySelector('#fluCard');
      D.ov = D.root.querySelector('#fluOv');
      D.legend = D.root.querySelector('#fluLegend');
      D.legendBar = D.root.querySelector('#fluLegendBar');
      D.lgHi = D.root.querySelector('#fluLgHi');
      D.lgMid = D.root.querySelector('#fluLgMid');
      D.lgLo = D.root.querySelector('#fluLgLo');
      D.resCv = D.root.querySelector('#fluResCv');
      D.resLg = D.root.querySelector('#fluResLg');
      D.resNow = D.root.querySelector('#fluResNow');
      D.fcCv = D.root.querySelector('#fluFcCv');
      D.frcNow = D.root.querySelector('#fluFrcNow');
  
      /* 剖切面：法向 −Z，切掉近侧一半，露出车底与地面之间的网格 */
      clipPlanes = [new THREE.Plane(new THREE.Vector3(0, 0, -1), 0.0)];

      renderTree();
      renderProps();
      renderLauncher();
      bindEvents();
      resetSolver(true);
      drawResiduals();
      drawForceHist();
      refreshTools();
      refreshLegend();

      /* 建 3D 视口（同一元素重复调用会复用，见 app.js setViewport） */
      var vp = API.setViewport(D.root.querySelector('#fluVp'), {
        fov: 42, color: 0x141a21, fogNear: 55, fogFar: 260,
        gridSize: 60, gridDiv: 60, showGrid: true, groundY: 0,
        position: [11.5, 4.2, 13.0], targetY: 0.4, minDist: 2, maxDist: 140
      });
      V.vp = vp;
      if (vp) vp.setAccent(0x19b5a5);

      /* 唯一的一帧回调：切步骤不会重复注册 */
      frameStop = vp ? vp.onFrame(frame) : null;

      /* 切走标签页：停视口 RAF **并暂停求解器**。
         tick() 是 50ms 一跳的 setInterval，每跳跑 6 次迭代、一次残差 canvas 重绘、
         一次力曲线重绘、一次 DOM 状态更新。模块被 display:none 之后这些全部是白烧 CPU；
         只停视口是远远不够的。切回来从断点续算，迭代数与收敛状态都保留。 */
      API.onActivate(function () {
        if (V.vp) V.vp.start();
        if (S.solvePaused && S.running) {          // 之前是"切走时正在跑"
          S.solvePaused = false;
          startSolverTimer();
          API.console('Solver resumed at iteration ' + S.iters + '.', 'sys');
        }
      });
      API.onDeactivate(function () {
        if (V.vp) V.vp.stop();
        if (timer && S.running) {
          global.clearInterval(timer); timer = null;
          S.solvePaused = true;
        }
      });

    API.console('ANSYS Fluent 2023 R1 · F1 外流场教学模块已就绪。', 'sys');
    API.console('按左侧步骤开始，或直接点视口里的 Start 启动 Launcher。', 'info');

    API.setSteps(STEPS);
    API.setStatus({ 算例: 'f1_external.cas.h5', 模式: '待启动（Launcher）' });
    }
  });

  /* 释放（模块切走 / 页面卸载时由 app.js 调用 viewport.dispose，这里只清自有定时器） */
  global.addEventListener('beforeunload', function () {
    if (timer) global.clearInterval(timer);
    if (frameStop) frameStop();
  });

}) (window);
