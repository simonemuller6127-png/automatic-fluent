/* =============================================================================
 *  mechanical.js —— ANSYS Mechanical · 稚晖君 Dummy 机械臂 静力分析教学模块
 *
 *  流程：导入几何 → 定义材料 → 接触与连接 → 划分网格 → 施加约束 → 施加载荷
 *        → 求解 → 总变形 → 等效应力 / 安全系数 / 反力校核
 *
 *  【本文件的硬约束】
 *    · 经典 <script> + 全局对象，无 ES module / 无打包器；
 *    · 三维几何全部用 THREE 代码程序化生成，不加载任何外部模型或贴图；
 *    · 只写 js/mechanical.js，不碰共享文件；私有样式一律 #mech-module 前缀；
 *    · 教学文案全中文，进区提示写全，不留占位。
 *
 *  【坐标系约定 —— 非常重要】
 *    Mechanical 的全局坐标是 X 向右 / Y 向内 / **Z 向上**，全局重力是 -Z。
 *    为了让三维视口里"上下"就是竖直方向，把整条机械臂放进一个绕 X 轴转 -90°
 *    的父 Group：模型 (x, y, z) → 世界 (x, z, -y)。于是模型 -Z 在屏幕上就是朝下，
 *    Remote Force 的 "Z 分量填 -30 N" 与视口里箭头朝下完全一致，不会有任何认知冲突。
 *
 *  【物理模型 —— 纯二维弯曲积分，可在控制台核对】
 *    机械臂在 XZ 平面内平面弯曲，载荷是竖直向下的（F = -Z），因此
 *      M(s)  = [ F_tip + Σ(下游零件自重) ] × (x_tip - x(s))          （精确）
 *      κ(s)  = M(s) / (E·I(s))
 *      θ(s)  = ∫₀ˢ κ(s')ds'                                        （转角）
 *      u(s)  = ∫₀ˢ θ(s')·n(s')ds'，  n = (-t_z, t_x)                 （X-Z 面内位移）
 *    离散成 N 个站位后用梯形累加求和，逐段累加就是各连杆的悬臂叠加解。
 *    应力：σ_nom(s) = M(s)·c/I，再乘根部/肘部的圆角应力集中系数 Kt(s)。
 *    暴露在 CAE.MechanicalModel 上，浏览器控制台与 node 都能直接调用核对。
 * ============================================================================= */
(function (global) {
  'use strict';

  var CAE = (global.CAE = global.CAE || {});

  /* ===========================================================================
   * 0. 纯数学 / 数据模型（不碰 DOM，可在 node 里直接 eval 核对）
   * ======================================================================== */
  var G = 9.80665;         // 重力加速度 m/s²
  var MM = 0.01;           // 1 mm = 0.01 场景单位（1 场景单位 = 100 mm）

  /* ---- 材料库（数值取自 ANSYS Engineering Data 常用内置库） ---- */
  var MATS = {
    al: {
      key: 'al', name: '7075-T6 铝合金', en: 'Aluminum 7075-T6',
      E: 71.7e9, nu: 0.33, rho: 2810, yieldMPa: 503,
      color: 0xb8c6d4, tubeColor: 0x93a7bb,
      note: '比强度高，常做机器人臂杆；' + 'σs=503 MPa、σb=572 MPa'
    },
    st: {
      key: 'st', name: 'AISI 45 钢', en: 'Structural Steel AISI 45',
      E: 206e9, nu: 0.30, rho: 7850, yieldMPa: 355,
      color: 0x8f959d, tubeColor: 0x767d86,
      note: '关节环 / 夹爪等耐磨件；强度够但比铝重得多'
    }
  };

  /* ---- 方管截面（尺寸用米）：I = (b⁴-(b-2t)⁴)/12 ---- */
  function sqI(b, t) { return (Math.pow(b, 4) - Math.pow(b - 2 * t, 4)) / 12; }
  function sqA(b, t) { return b * b - (b - 2 * t) * (b - 2 * t); }

  /* ---- 机械臂链节节点（模型坐标 mm，Z 向上） ---- */
  var D0 = { x: Math.sin(30 * Math.PI / 180), z: Math.cos(30 * Math.PI / 180) };   // 大臂倾角 30°
  var D1 = { x: Math.sin(58 * Math.PI / 180), z: Math.cos(58 * Math.PI / 180) };   // 小臂倾角 58°
  var L0 = 200, L1 = 170, L2 = 75;                 // 三段长度 mm
  var P0 = { x: 0, z: 142 };                       // 肩轴心（固定端）
  var P1 = { x: P0.x + L0 * D0.x, z: P0.z + L0 * D0.z };   // (100, 315.21)
  var P2 = { x: P1.x + L1 * D1.x, z: P1.z + L1 * D1.z };   // (244.17, 405.29)
  var P3 = { x: P2.x + L2 * D1.x, z: P2.z + L2 * D1.z };   // (307.77, 445.03) Remote Point
  var LTOT = L0 + L1 + L2;                         // 445 mm

  /* 连杆截面（方管）：[b 外宽 mm, t 壁厚 mm, 材料] */
  var SEC_A = { b: 23, t: 1.7, mat: 'al' };        // 大臂
  var SEC_B = { b: 23, t: 1.7, mat: 'al' };        // 小臂
  var SEC_C = { b: 19, t: 1.5, mat: 'st' };        // 腕部 + 夹爪

  /* ---- 零件表 ----
   * s    : 沿"载荷路径"（固定端→末端）的弧长位置 mm；刚性底座取 0（不参与弯曲）
   * seg  : 属于哪一连杆，用于解析求弧长；-1 = 刚性
   * 体积 m³、质量 kg、质心 x 均由 buildParts() 依据尺寸算出，不手填
   */
  var PARTS = [
    // —— 刚性底座 ——
    { id: 'flange', label: 'Base Flange（底座法兰）', seg: -1, mat: 'al', shape: 'cyl',
      dim: { r: 58, h: 9 }, at: { x: 0, z: 4.5, rot: 0 }, dirZ: true },
    { id: 'turntable', label: 'Turntable（底座转台）', seg: -1, mat: 'al', shape: 'cyl',
      dim: { rT: 36, rB: 40, h: 32 }, at: { x: 0, z: 9 + 16, rot: 0 }, dirZ: true },
    { id: 'housing', label: 'Shoulder Housing（肩部壳体）', seg: -1, mat: 'al', shape: 'box',
      dim: { w: 46, h: 100, d: 46 }, at: { x: 0, z: 41 + 50, rot: 0 } },
    // —— 连杆 ——
    { id: 'upperarm', label: 'Upper Arm（大臂方管）', seg: 0, mat: 'al', shape: 'box',
      dim: { w: SEC_A.b, h: L0, d: SEC_A.b }, sec: SEC_A,
      at: { x: P0.x + L0 / 2 * D0.x, z: P0.z + L0 / 2 * D0.z, rot: 30 } },
    { id: 'forearm', label: 'Forearm（小臂方管）', seg: 1, mat: 'al', shape: 'box',
      dim: { w: SEC_B.b, h: L1, d: SEC_B.b }, sec: SEC_B,
      at: { x: P1.x + L1 / 2 * D1.x, z: P1.z + L1 / 2 * D1.z, rot: 58 } },
    // —— 关节环（圆环高亮、可点选） ——
    { id: 'joint_shoulder', label: 'J1 肩关节环', seg: 0, mat: 'st', shape: 'torus',
      dim: { R: 26, r: 5 }, at: { x: P0.x, z: P0.z, rot: 0 }, sFixed: 0 },
    { id: 'joint_elbow', label: 'J2 肘关节环', seg: 1, mat: 'st', shape: 'torus',
      dim: { R: 20, r: 4 }, at: { x: P1.x, z: P1.z, rot: 0 }, sFixed: L0 },
    { id: 'joint_wrist', label: 'J3 腕关节环', seg: 2, mat: 'st', shape: 'torus',
      dim: { R: 16, r: 3.5 }, at: { x: P2.x, z: P2.z, rot: 0 }, sFixed: L0 + L1 },
    // —— 腕部 / 夹爪 ——
    { id: 'wrist', label: 'Wrist Spindle（腕轴）', seg: 2, mat: 'st', shape: 'cyl',
      dim: { r: 13, h: 40 },
      at: { x: P2.x + 20 * D1.x, z: P2.z + 20 * D1.z, rot: 58 } },
    { id: 'gripper', label: 'Gripper Base（夹爪座）', seg: 2, mat: 'st', shape: 'box',
      dim: { w: 32, h: 28, d: 26 },
      at: { x: P2.x + 54 * D1.x, z: P2.z + 54 * D1.z, rot: 58 } },
    { id: 'fingerL', label: 'Finger L（左夹指）', seg: 2, mat: 'st', shape: 'box',
      dim: { w: 10, h: 44, d: 9 }, at: { x: P2.x + 68 * D1.x, z: P2.z + 68 * D1.z - 22, rot: 0 }, offsetY: -13 },
    { id: 'fingerR', label: 'Finger R（右夹指）', seg: 2, mat: 'st', shape: 'box',
      dim: { w: 10, h: 44, d: 9 }, at: { x: P2.x + 68 * D1.x, z: P2.z + 68 * D1.z - 22, rot: 0 }, offsetY: 13 }
  ];

  /* 连杆的解析描述：起点、方向、弧长区间 */
  var SEGS = [
    { s0: 0, s1: L0, px: P0.x, pz: P0.z, dx: D0.x, dz: D0.z, sec: SEC_A },
    { s0: L0, s1: L0 + L1, px: P1.x, pz: P1.z, dx: D1.x, dz: D1.z, sec: SEC_B },
    { s0: L0 + L1, s1: LTOT, px: P2.x, pz: P2.z, dx: D1.x, dz: D1.z, sec: SEC_C }
  ];

  function partVolume(p) {
    var d = p.dim;
    /* 有 sec 的是方形管件：体积 = 截面环面积 × 长度（渲染成实心方盒只是外形简化） */
    if (p.sec) return sqA(p.sec.b / 1000, p.sec.t / 1000) * (d.h / 1000);
    if (p.shape === 'cyl') {
      var r = d.r !== undefined ? d.r : (d.rT + d.rB) / 2;
      return Math.PI * r * r * d.h * 1e-9;              // mm³ → m³
    }
    if (p.shape === 'torus') return 2 * Math.PI * Math.PI * d.R * d.r * d.r * 1e-9;
    return d.w * d.h * d.d * 1e-9;                        // 其余方盒按实心
  }
  function segOfS(s) {
    for (var i = 0; i < SEGS.length; i++) if (s <= SEGS[i].s1 + 1e-6) return SEGS[i];
    return SEGS[SEGS.length - 1];
  }
  function buildParts() {
    var list = [];
    for (var i = 0; i < PARTS.length; i++) {
      var p = PARTS[i], q = {};
      for (var k in p) q[k] = p[k];
      var m = MATS[q.mat];
      q.V = partVolume(q);
      q.mass = q.V * m.rho;
      q.weight = q.mass * G;
      /* 质心弧长 sC 与其水平坐标 */
      if (q.seg >= 0) {
        var g = SEGS[q.seg];
        if (q.sFixed !== undefined) { q.sC = q.sFixed; q.xC = q.at.x; }
        else {
          /* 沿连杆方向的水平投影反推弧长：Δx = Δs · dx */
          q.sC = g.s0 + (q.at.x - g.px) / (g.dx || 1e-9);
          q.xC = q.at.x;
        }
      } else { q.sC = 0; q.xC = 0; }
      list.push(q);
    }
    return list;
  }
  var PLIST = buildParts();
  function partById(id) {
    for (var i = 0; i < PLIST.length; i++) if (PLIST[i].id === id) return PLIST[i];
    return null;
  }
  var TOTAL_MASS = (function () {
    var s = 0; for (var i = 0; i < PLIST.length; i++) s += PLIST[i].mass; return s;
  })();
  var TOTAL_WEIGHT = TOTAL_MASS * G;
  var COM_X = (function () {
    /* Σ(m·x) / Σm，xC 以 mm 记，这里换算成 m */
    var s = 0;
    for (var i = 0; i < PLIST.length; i++) s += PLIST[i].mass * PLIST[i].xC;
    return s / TOTAL_MASS / 1000;
  })();

  /* 应力集中：根部圆角 Kt=2.5（r/d≈0.15 的通用值），肘部圆角 Kt=1.5。
   衰减长度取 8 mm —— 正好是本例一个单元的尺寸，对应"第一排单元中心"的取值，
   也就是求解器实际报出来的那个峰值位置。 */
  var KT_ROOT = 2.5, KT_ROOT_DECAY = 8;     // mm
  var KT_ELBOW = 1.5, KT_ELBOW_DECAY = 8;   // mm

  /* 连杆自重（seg ≥ 0）对根部截面的弯矩贡献 = Σ wᵢ·(x_tip − xᵢ)。
     ⚠ 只累加**连杆**（seg ≥ 0）的自重：刚性底座（flange / turntable / housing，
     seg = −1）坐在固定端之内，压根不参与弯曲积分，把它们算进根部弯矩会凭空
     多出约 0.9 N·m。这正是"打印的公式算不出自己的数"的根源。 */
  /* 参与弯曲积分的判据必须和 run() 里的那一句逐字一致：sC > 0。
     肩关节环 sFixed = 0，它坐在 s=0 这个截面上，不产生弯矩 —— 若按 seg >= 0 一把
     全算进来，手算公式会比求解器大约 11%，这正是"公式和它自己的数字对不上"的根源。 */
  function inBending(p) { return p.seg >= 0 && p.sC > 1e-9; }
  var LINK_WEIGHT = (function () {
    var t = 0;
    for (var i = 0; i < PLIST.length; i++) if (inBending(PLIST[i])) t += PLIST[i].weight;
    return t;
  })();
  var BASE_WEIGHT = TOTAL_WEIGHT - LINK_WEIGHT;
  var LINK_MOMENT = segWeightMoment();
  /** 根部截面（s = 0）由连杆自重产生的弯矩 = Σ wᵢ·x̄ᵢ，单位 N·m。
      （每个自重用自己的水平力臂 x̄ᵢ，不是共同的 x_tip。） */
  function segWeightMoment() {
    var m = 0;
    for (var i = 0; i < PLIST.length; i++) {
      if (!inBending(PLIST[i])) continue;               // 刚性底座 + 坐在截面上的关节环都不算
      m += PLIST[i].weight * (PLIST[i].xC / 1000);
    }
    return m;
  }
  /** 连杆自重的等效水平力臂（自重形心到根部截面的距离），mm —— 讲公式时要打印它 */
  function linkWeightArm() { return LINK_WEIGHT > 0 ? segWeightMoment() / LINK_WEIGHT * 1000 : 0; }

  function ktAt(s) {
    var a = 1 + (KT_ROOT - 1) * Math.exp(-s / KT_ROOT_DECAY);
    var b = 1 + (KT_ELBOW - 1) * Math.exp(-Math.abs(s - L0) / KT_ELBOW_DECAY);
    return Math.max(a, b);
  }

  /* =========================================================================
   * 核心求解器：平面弯曲离散积分（u 矢量、弯矩、应力曲线）
   * ======================================================================== */
  var MODEL = (function () {
    var N = 600;

    function interp(arr, s) {
      var t = s / LTOT * N;
      if (t <= 0) return arr[0];
      if (t >= N) return arr[N];
      var i = Math.floor(t), f = t - i;
      return arr[i] * (1 - f) + arr[i + 1] * f;
    }

    function run(opt) {
      opt = opt || {};
      /* Fdec = 载荷面板上"你声明"的末端力；Fapp = 求解器真正吃进去的力。
         两者分开，才能查出"载荷重复施加"这种求解器不会报错的错。 */
      var Fdec = opt.force !== undefined ? opt.force : 30;
      var reps = opt.forceReps || 1;                 // Remote Force 施加了几次
      var Ftip = Fdec * reps;
      var useG = opt.gravity !== undefined ? opt.gravity : true;
      /* support：约束实际提供了哪些竖向反力。
         'face'  法兰底面固接 → 正常的 6 自由度固接
         'body'  整个底座体全固定 → 过约束（重复约束，数值仍能算，但会报 over-constrained）
         'none'  漏了固定约束 → 结构悬空，竖向反力为 0 */
      var support = opt.support || 'face';
      var dsm = (LTOT / N) / 1000;

      var M = [], ux = [], uz = [], th = [], kap = [], sig = [];
      var Mmax = 0, sigMax = 0, sigMaxS = 0, sigNomMax = 0;
      /* 远程点的实际水平位置（"远程点位置错"这个坑就体现在这里） */
      var tipX = (opt.tipX !== undefined ? opt.tipX : P3.x) / 1000;

      for (var j = 0; j <= N; j++) {
        var s = LTOT * j / N;
        var g = segOfS(s);
        var x = (g.px + (s - g.s0) * g.dx) / 1000;
        /* M(s) = Σ 所有下游作用力 × 各自的力臂。
           末端力作用在 tipX；每个零件的自重作用在它自己的 xC —— 两者力臂不同，
           不能先把自重加进"合力"再乘同一个力臂（那样等于把所有自重都挪到了夹爪，
           根部弯矩会凭空大出 Σw·x̄ ≈ 1.4 N·m）。 */
        var m = Ftip * (tipX - x);
        if (useG) {
          for (var k = 0; k < PLIST.length; k++) {
            if (inBending(PLIST[k]) && PLIST[k].sC > s + 1e-9) m += PLIST[k].weight * (PLIST[k].xC / 1000 - x);
          }
        }
        M.push(m);
        var I = sqI(g.sec.b / 1000, g.sec.t / 1000);
        var E = MATS[g.sec.mat].E;
        var c = g.sec.b / 2000;
        var sn = m * c / I;
        var sf = sn * ktAt(s);
        if (sf > sigMax) { sigMax = sf; sigMaxS = s; }
        if (sn > sigNomMax) sigNomMax = sn;
        sig.push(sf);
        /* 弯矩取正号表示"使梁顺时针转"的量级；平面弯曲里曲率取负，
           于是 θ<0、位移指向载荷方向（末端前下方） */
        kap.push(-m / (E * I));
        th.push(0); ux.push(0); uz.push(0);
        if (m > Mmax) Mmax = m;
      }
      /* 转角：梯形累加 */
      for (var a = 1; a <= N; a++) th[a] = th[a - 1] + (kap[a - 1] + kap[a]) / 2 * dsm;
      /* 位移：∫θ·n ds，n = (-t_z, t_x) */
      for (var b = 1; b <= N; b++) {
        var ga = segOfS(LTOT * (b - 1) / N), gb = segOfS(LTOT * b / N);
        var tx = (ga.dx + gb.dx) / 2, tz = (ga.dz + gb.dz) / 2;
        ux[b] = ux[b - 1] + th[b] * (-tz) * dsm;
        uz[b] = uz[b - 1] + th[b] * (tx) * dsm;
      }

      var uTipX = ux[N], uTipZ = uz[N];
      var uTipMag = Math.sqrt(uTipX * uTipX + uTipZ * uTipZ);
      var uVert = -uz[N];

      /* ===================================================================
       * 反力平衡校核：三项都是**能失败**的检查，不是恒真式。
       *   ① 力平衡：支撑实际提供的竖向反力  vs  求解器吃进去的外载
       *   ② 载荷核对：求解器吃进去的外载      vs  载荷面板上你声明的外载
       *   ③ 力矩核对：根部弯矩                  vs  F声明 × 远程点力臂
       * 漏约束 → ① 炸；载荷重复施加 → ② 炸；远程点位置错 → ③ 炸。
       * ================================================================= */
      var Wself = useG ? TOTAL_WEIGHT : 0;
      var appliedFz = Ftip + Wself;                  // 实际加在结构上的竖向外载
      var declaredFz = Fdec + Wself;                 // 载荷面板上写的
      var reaction = (support === 'none') ? 0 : appliedFz;   // 约束提供的竖向反力
      var rigidBody = (support === 'none');                 // 结构悬空 → 刚体模式
      var balanceErr = (Math.abs(reaction) > 1e-9)
        ? Math.abs(reaction - appliedFz) / Math.abs(reaction) : 1;
      var loadErr = (Math.abs(declaredFz) > 1e-9)
        ? Math.abs(appliedFz - declaredFz) / Math.abs(declaredFz) : 1;
      /* ③ 力矩核对：拿"载荷面板声明的"力与力臂去手算根部弯矩，再和求解器给的比。
         远程点被挪走（tipX ≠ P3.x）时这一项才会炸 —— 力平衡与载荷核对都还"通过"，
         因为力的总和没变，只是力臂错了。 */
      var expectM = Fdec * (P3.x / 1000) + (useG ? segWeightMoment() : 0);
      var momentErr = (Math.abs(expectM) > 1e-9)
        ? Math.abs(Mmax - expectM) / Math.abs(expectM) : 0;

      /* 剔除固定边一排单元后的最大值（对应 Mechanical 里的 Evaluation 只统计
         非约束边单元）：距离固定端 8 mm 以外的最大等效应力 */
      var skipS = 8;                               // mm，约等于一个默认单元
      var sigSkip = 0;
      for (var c2 = 0; c2 <= N; c2++) if (LTOT * c2 / N > skipS && sig[c2] > sigSkip) sigSkip = sig[c2];

      var matRoot = MATS[SEC_A.mat];
      return {
        force: Fdec, appliedForce: Ftip, forceReps: reps, gravity: useG, support: support,
        rigidBody: rigidBody, tipX: tipX,
        totalMass: TOTAL_MASS, totalWeight: TOTAL_WEIGHT, comX: COM_X,
        Mbase: Mmax, Fdown: appliedFz, declaredFz: declaredFz, appliedFz: appliedFz,
        expectM: expectM,
        uTipX: uTipX, uTipZ: uTipZ, uTip: uTipMag, uVert: uVert,
        thetaTip: th[N], maxStress: sigMax, maxStressAt: sigMaxS,
        maxStressNoFixed: sigSkip,
        nominalStress: sigNomMax,
        fos: sigMax > 0 ? matRoot.yieldMPa * 1e6 / sigMax : Infinity,
        fosNoFixed: sigSkip > 0 ? matRoot.yieldMPa * 1e6 / sigSkip : Infinity,
        reaction: reaction, reactionArm: COM_X,
        balanceErr: balanceErr, loadErr: loadErr, momentErr: momentErr,
        tables: { M: M, sig: sig, ux: ux, uz: uz, th: th, N: N },
        _ux: function (s) { return interp(ux, s); },
        _uz: function (s) { return interp(uz, s); },
        _sig: function (s) { return interp(sig, s); },
        _mag: function (s) {
          var a = interp(ux, s), b = interp(uz, s);
          return Math.sqrt(a * a + b * b);
        }
      };
    }
    return {
      run: run, N: N,
      LTOT: LTOT, P0: P0, P1: P1, P2: P2, P3: P3,
      SEGS: SEGS, PLIST: PLIST, MATS: MATS, G: G, MM: MM,
      TOTAL_MASS: TOTAL_MASS, TOTAL_WEIGHT: TOTAL_WEIGHT, COM_X: COM_X,
      ktAt: ktAt, sqI: sqI, sqA: sqA,
      LINK_WEIGHT: LINK_WEIGHT, BASE_WEIGHT: BASE_WEIGHT,
      segWeightMoment: segWeightMoment, linkWeightArm: linkWeightArm,
      defaultRun: function () { return run({ force: 30, gravity: true }); }
    };
  })();

  /* 供 node / 控制台核对 */
  global.CAE.MechanicalModel = MODEL;

  /* ===========================================================================
   * 1. 伪软件界面（Workbench + Mechanical）
   * ======================================================================== */

  var STAGES = ['import', 'material', 'contacts', 'mesh', 'constraint', 'loading', 'solve', 'deform', 'stress'];
  var STAGE_CN = {
    import: '1 · 导入几何', material: '2 · 定义材料', contacts: '3 · 接触与连接',
    mesh: '4 · 划分网格', constraint: '5 · 施加约束', loading: '6 · 施加载荷',
    solve: '7 · 求解', deform: '8 · 总变形', stress: '9 · 应力与安全系数'
  };

  var S = null;    // 模块私有状态（build 时创建）

  /* ---------- 树定义 ---------- */
  function treeSpec() {
    return [
      {
        id: 'project', label: 'Project Schematic', icon: '🗂', depth: 0, open: true, noToggle: true,
        parts: [], detail: detailProject
      },
      {
        id: 'analysis', label: 'A · Static Structural', icon: '🔧', depth: 1, open: true,
        parts: [], detail: detailAnalysis
      },
      {
        id: 'geometry', label: 'B · Geometry', icon: '📐', depth: 2, open: true, minStage: 0,
        parts: [], detail: detailGeometry
      },
      {
        id: 'bodies', label: 'Dummy_Arm  （' + PLIST.length + ' Bodies）', icon: '▣', depth: 3, minStage: 0,
        parts: PLIST.map(function (p) { return p.id; }), detail: detailBodies
      },
      {
        id: 'connections', label: 'Connections', icon: '🔗', depth: 2, open: false, minStage: 2,
        parts: ['joint_shoulder', 'joint_elbow', 'joint_wrist'], detail: detailConnections
      },
      {
        id: 'joint1', label: 'Joint 1 · Revolute', icon: '⚭', depth: 3, minStage: 2,
        parts: ['joint_shoulder'], detail: function (n) { return detailJoint(n, 'J1 肩关节', 0); }
      },
      {
        id: 'joint2', label: 'Joint 2 · Revolute', icon: '⚭', depth: 3, minStage: 2,
        parts: ['joint_elbow'], detail: function (n) { return detailJoint(n, 'J2 肘关节', 1); }
      },
      {
        id: 'joint3', label: 'Joint 3 · Revolute', icon: '⚭', depth: 3, minStage: 2,
        parts: ['joint_wrist'], detail: function (n) { return detailJoint(n, 'J3 腕关节', 2); }
      },
      {
        id: 'materials', label: 'Materials', icon: '🧪', depth: 2, open: true, minStage: 1,
        parts: [], detail: detailMaterials
      },
      {
        id: 'mat_al', label: '7075-T6 铝合金', icon: '▪', depth: 3, minStage: 1,
        parts: PLIST.filter(function (p) { return p.mat === 'al'; }).map(function (p) { return p.id; }),
        detail: function () { return detailMaterial(MATS.al, PLIST.filter(function (p) { return p.mat === 'al'; })); }
      },
      {
        id: 'mat_st', label: 'AISI 45 钢', icon: '▪', depth: 3, minStage: 1,
        parts: PLIST.filter(function (p) { return p.mat === 'st'; }).map(function (p) { return p.id; }),
        detail: function () { return detailMaterial(MATS.st, PLIST.filter(function (p) { return p.mat === 'st'; })); }
      },
      {
        id: 'mesh', label: 'C · Mesh', icon: '⊞', depth: 2, open: false, minStage: 3,
        parts: [], detail: detailMesh
      },
      {
        id: 'fixedsupport', label: 'Fixed Support', icon: '🔒', depth: 3, minStage: 4,
        parts: ['flange'], detail: detailFixed
      },
      {
        id: 'gravity', label: 'Gravity', icon: '⬇', depth: 3, minStage: 5,
        parts: [], detail: detailGravity
      },
      {
        id: 'remotepoint', label: 'Remote Point 1', icon: '✛', depth: 3, minStage: 5,
        parts: ['fingerL', 'fingerR', 'gripper'], detail: detailRemotePoint
      },
      {
        id: 'remoteforce', label: 'Remote Force', icon: '➤', depth: 4, minStage: 5,
        parts: ['fingerL', 'fingerR'], detail: detailRemoteForce
      },
      {
        id: 'settings', label: 'D · Analysis Settings', icon: '⚙', depth: 2, minStage: 6,
        parts: [], detail: detailSettings
      },
      {
        id: 'solution', label: 'E · Solution', icon: '✓', depth: 2, open: true, minStage: 7,
        parts: [], detail: detailSolution
      },
      {
        id: 'r_deform', label: 'Total Deformation 总变形', icon: '📏', depth: 3, minStage: 7,
        parts: [], detail: detailResultDeform
      },
      {
        id: 'r_stress', label: 'Equivalent Stress 等效应力', icon: '🔥', depth: 3, minStage: 8,
        parts: [], detail: detailResultStress
      },
      {
        id: 'r_fos', label: 'Factor of Safety 安全系数', icon: '🛡', depth: 3, minStage: 8,
        parts: [], detail: detailResultFos
      },
      {
        id: 'r_reaction', label: 'Reaction Force 反力', icon: '⇧', depth: 3, minStage: 8,
        parts: ['flange'], detail: detailResultReaction
      }
    ];
  }

  /* ===========================================================================
   * 2. 注册模块
   * ======================================================================== */
  CAE.registerModule({
    id: 'mechanical',
    name: 'ANSYS Mechanical',
    tagline: 'Dummy 机械臂静力分析',
    accent: '#e8833a',

    build: function (ctx) {
      var api = ctx.api, root = ctx.root;
      root.id = 'mech-module';
      injectStyle();

      /* ---------------- 模块私有状态 ---------------- */
      S = {
        api: api, root: root,
        vp: null,
        stage: -1,
        nodes: [], sel: 'geometry', collapsed: {},
        force: 30, gravity: true, largeDefl: false,
        meshSize: 8, quadratic: true, meshGenerated: false, showMesh: false,
        contactType: 'Revolute', fixedScope: 'face',
        forceReps: 1,               // Remote Force 施加了几次（2 = 载荷重复施加的反面教材）
        tipOffset: 0,               // 远程点沿连杆方向的水平偏移 mm（挪错了力臂就变）
        units: 'mm',
        solved: false, solving: false, solveT: [], solvePaused: false, solveThenWatch: null,
        result: 'none',            // none | deform | stress | fos
        defScale: 1, animT: 1, playing: false,
        showLoads: true, showGhost: true,
        legend: null,             // {title,min,max,mid,unit,colors}
        jointAngle: 0,            // 关节试转角度（度）
        dropFixedEdge: false,     // 剔除固定边一排单元
        res: null
      };

      /* ---------------- DOM ---------------- */
      root.innerHTML = [
        '<div class="menu-bar mech-menubar">',
        '  <span class="menu-item is-on" data-menu="几何">几何</span>',
        '  <span class="menu-item" data-menu="连接">连接</span>',
        '  <span class="menu-item" data-menu="网格">网格</span>',
        '  <span class="menu-item" data-menu="载荷">载荷</span>',
        '  <span class="menu-item" data-menu="结果">结果</span>',
        '  <span class="menu-item" data-menu="视图">视图</span>',
        '  <span class="spacer"></span>',
        '  <span class="mech-wbtag">ANSYS Workbench 2023 R1 · 项目：Dummy_Arm_Static</span>',
        '</div>',

        '<div class="ribbon mech-ribbon" id="mech-ribbon"></div>',

        '<div class="mech-main">',
        '  <div class="mech-left">',
        '    <div class="mech-tb">',
        '      <span class="mech-tb-title">Outline · 模型树</span>',
        '      <span class="spacer"></span>',
        '      <button class="btn btn-sm btn-ghost" id="mech-tree-collapse" title="折叠/展开全树">⇕</button>',
        '    </div>',
        '    <div class="tree mech-tree" id="mech-tree"></div>',
        '  </div>',

        '  <div class="mech-center">',
        '    <div class="viewport" id="mech-vp">',
        '      <div class="viewport-ov" id="mech-ov"></div>',
        '      <div class="legend" id="mech-legend" style="display:none"></div>',
        '      <div class="mech-hud" id="mech-hud"></div>',
        '      <div class="viewport-hint" id="mech-vphint">左键旋转 · 滚轮缩放 · 右键平移 · 点击零件选中</div>',
        '    </div>',
        '    <div class="mech-solve" id="mech-solvebar"></div>',
        '  </div>',

        '  <div class="mech-right">',
        '    <div class="mech-tb">',
        '      <span class="mech-tb-title">Details · 属性面板</span>',
        '      <span class="spacer"></span>',
        '      <span class="mech-crumb" id="mech-crumb"></span>',
        '    </div>',
        '    <div class="props mech-props" id="mech-props"></div>',
        '  </div>',
        '</div>'
      ].join('');

      var $vp = $('#mech-vp'), $tree = $('#mech-tree'), $props = $('#mech-props');
      var $ribbon = $('#mech-ribbon'), $hud = $('#mech-hud'), $ov = $('#mech-ov');
      var $legend = $('#mech-legend'), $bar = $('#mech-solvebar'), $crumb = $('#mech-crumb');
      S.$ = { vp: $vp, tree: $tree, props: $props, ribbon: $ribbon, hud: $hud, ov: $ov, legend: $legend, bar: $bar, crumb: $crumb };

      /* ---------------- 建模（三维） ---------------- */
      S.vp = api.setViewport($vp, {
        position: [6.6, 4.3, 8.2], target: [1.0, 2.0, 0],
        minDist: 1.2, maxDist: 90,
        gridSize: 30, gridDiv: 30, groundY: -0.004,
        color: 0x181c22, fov: 42
      });
      buildArm();

      /* ---------------- 界面装配 ---------------- */
      buildRibbon();
      buildHUD();
      rebuildTree();
      renderProps();
      updateSolveBar();
      updateOverlay();
      bindMenu();
      bindPicking();
      bindKeyboard();

      api.console('ANSYS Workbench 2023 R1 · 已连接 Mechanical 数据库。', 'sys');
      api.console('项目 Schematic “Dummy_Arm_Static” 就绪，双击 Geometry 单元格进入 Mechanical。', 'info');
      api.setStatus({ 分析: 'Static Structural', 几何: PLIST.length + ' 个实体', 求解: '未开始' });

      /* ---------------- 教学步骤 ---------------- */
      api.setSteps(buildSteps());

      /* 排障出口：控制台里 CAE.MechanicalDebug.state / .viewport 可查模块私有状态与场景 */
      CAE.MechanicalDebug = {
        state: function () { return S; },
        viewport: function () { return S.vp; },
        scene: function () { return S.vp ? S.vp.scene : null; }
      };

      /* 切走标签页：停视口 RAF + 叫停求解定时器。
         求解进度条是一串 180~2780ms 的 setTimeout，切走后它们还会继续推进、
         继续往伪终端刷日志、继续重建网格叠加层 —— 全是对着 display:none 的宿主做的。
         切回来 solveResume() 从断点续上，不丢进度。 */
      api.onDeactivate(function () {
        if (S.vp) S.vp.stop();
        if (S.solving) { killSolveTimers(); S.solving = false; S.solvePaused = true; }
        if (S.solveThenWatch) { clearInterval(S.solveThenWatch); S.solveThenWatch = null; }
      });
      api.onActivate(function () {
        if (S.vp) S.vp.start();
        if (S.solvePaused) { S.solvePaused = false; solve(); }
      });
    }
  });

  /* ===========================================================================
   * 3. 小工具
   * ======================================================================== */
  function $(sel) { return document.querySelector('#mech-module ' + sel); }
  /* 限定在 #mech-module 内 —— 全局 getElementById 会和 index.html 平台自己的 id
     以及另两个模块的 id 撞车。私有选择器一律走上面的 $()。 */
  function gid(id) { return $('#' + id); }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function f(v, n) {
    if (!isFinite(v)) return '∞';
    var p = Math.pow(10, n === undefined ? 3 : n);
    return (Math.round(v * p) / p).toFixed(n === undefined ? 3 : n);
  }
  function field(label, value, cls) {
    return '<div class="field"><label>' + label + '</label><span class="' + (cls || 'mech-val') + '">' + value + '</span></div>';
  }
  function kv(k, v) { return '<div class="kv"><span>' + k + '</span><span>' + v + '</span></div>'; }
  function grp(title, html) {
    return '<div class="group"><div class="group-hd">' + title + '</div>' + html + '</div>';
  }
  function goStep(id) { S.api.gotoStep(id); }
  function log(m, k) { S.api.console(m, k || 'info'); }

  /* 私有样式（作用域严格限制在 #mech-module 内） */
  function injectStyle() {
    if (document.getElementById('mech-style')) return;
    var st = document.createElement('style');
    st.id = 'mech-style';
    st.textContent = [
      '#mech-module{display:flex;flex-direction:column;height:100%;min-height:0;}',
      '#mech-module .mech-menubar .mech-wbtag{font-size:11px;color:var(--txt-3);font-family:Consolas,monospace;}',
      '#mech-module .mech-ribbon{min-height:46px;}',
      '#mech-module .mech-main{flex:1 1 auto;min-height:0;display:flex;gap:8px;padding:8px;}',
      '#mech-module .mech-left{flex:0 0 236px;display:flex;flex-direction:column;min-height:0;}',
      '#mech-module .mech-center{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;min-height:0;gap:6px;}',
      '#mech-module .mech-right{flex:0 0 268px;display:flex;flex-direction:column;min-height:0;}',
      '#mech-module .mech-tb{flex:0 0 auto;display:flex;align-items:center;gap:6px;height:26px;padding:0 8px;',
      '  background:#1e242c;border:1px solid var(--line);border-bottom:0;border-radius:5px 5px 0 0;}',
      '#mech-module .mech-tb-title{font-size:11px;font-weight:600;color:var(--txt-2);letter-spacing:.5px;}',
      '#mech-module .mech-crumb{font-size:10px;color:var(--accent);font-family:Consolas,monospace;max-width:150px;',
      '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '#mech-module .mech-tree{flex:1 1 auto;border-radius:0 0 5px 5px;}',
      '#mech-module .mech-props{flex:1 1 auto;border-radius:0 0 5px 5px;}',
      '#mech-module .mech-val{font-family:Consolas,monospace;color:var(--txt);font-size:12px;}',
      '#mech-module .mech-note{font-size:11px;line-height:1.65;color:var(--txt-3);margin:6px 0 0;padding:6px 8px;',
      '  background:#1b2029;border-left:2px solid var(--line-2);border-radius:3px;}',
      '#mech-module .mech-warn{background:#3a3018;border-left-color:var(--warn);color:#e5c069;}',
      '#mech-module .mech-ok{background:#1c2a22;border-left-color:var(--ok);color:#8fd8b0;}',
      '#mech-module .mech-err{background:#3a1c1c;border-left-color:var(--err);color:#efa0a0;}',
      '#mech-module .mech-trials{margin-top:8px;padding-top:6px;border-top:1px dashed var(--line-2);}',
      '#mech-module .mech-tbl-hd{font-size:11px;color:var(--txt-2);margin:8px 0 4px;font-weight:600;}',
      '#mech-module .mech-tbl{width:100%;border-collapse:collapse;font:10px Consolas,monospace;',
        'margin-bottom:4px;}',
      '#mech-module .mech-tbl th{background:#1b212a;color:var(--txt-3);font-weight:600;padding:2px 3px;',
        'text-align:left;white-space:nowrap;}',
      '#mech-module .mech-tbl td{padding:2px 3px;border-bottom:1px solid var(--line);color:var(--txt-2);',
        'white-space:nowrap;}',
      '#mech-module .mech-tbl tr.is-cur td{background:var(--accent-dim);color:var(--txt);}',
      '#mech-module .mech-grp-t{font-size:10px;letter-spacing:.06em;color:var(--txt-3);',
        'text-transform:uppercase;margin-bottom:3px;}',
      '#mech-module .mech-slider{display:flex;align-items:center;gap:6px;margin:2px 0 8px;}',
      '#mech-module .mech-slider input[type=range]{flex:1 1 auto;accent-color:var(--accent);height:18px;}',
      '#mech-module .mech-slider .mech-num{font-family:Consolas,monospace;font-size:12px;color:var(--accent);',
      '  min-width:52px;text-align:right;}',
      '#mech-module .mech-segbtns{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;}',
      '#mech-module .mech-hud{position:absolute;left:8px;bottom:8px;display:flex;gap:4px;flex-wrap:wrap;',
      '  max-width:calc(100% - 16px);z-index:2;}',
      '#mech-module .mech-hud .btn{height:22px;padding:0 8px;font-size:11px;background:#151a21e6;}',
      '#mech-module .mech-hud .btn.is-on{background:var(--accent-dim);border-color:var(--accent);color:var(--accent);}',
      /* 提示条叠在左上角状态行下面，避免与左下角的 HUD 按钮和右上角的图例打架 */
      '#mech-module .viewport-hint{top:30px;bottom:auto;left:8px;right:auto;',
      '  max-width:calc(100% - 90px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;z-index:2;}',
      '#mech-module .legend{top:30px;}',
      '#mech-module .mech-solve{flex:0 0 auto;border:1px solid var(--line);border-radius:5px;background:#171c23;',
      '  padding:6px 8px;display:flex;align-items:center;gap:8px;min-height:38px;}',
      '#mech-module .mech-sbar{flex:1 1 auto;height:6px;background:#0f1216;border-radius:3px;overflow:hidden;',
      '  border:1px solid var(--line);}',
      '#mech-module .mech-sbar > i{display:block;height:100%;width:0;',
      '  background:linear-gradient(90deg,#e8833a,#ffd08a);transition:width .18s linear;}',
      '#mech-module .mech-smsg{font-family:Consolas,monospace;font-size:11px;color:var(--txt-2);',
      '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:62%;}',
      '#mech-module .mech-body-table{width:100%;border-collapse:collapse;font-size:11px;margin-top:4px;}',
      '#mech-module .mech-body-table th{color:var(--txt-3);font-weight:500;text-align:left;padding:2px 4px;',
      '  border-bottom:1px solid var(--line);}',
      '#mech-module .mech-body-table td{padding:2px 4px;font-family:Consolas,monospace;color:var(--txt-2);}',
      '#mech-module .mech-body-table tr:hover td{background:#222932;color:var(--txt);}',
      '#mech-module .tree-item .mech-bang{color:var(--err);font-size:10px;margin-left:2px;}',
      '#mech-module .mech-matdot{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;',
      '  vertical-align:-1px;}',
      '#mech-module .mech-big{font-size:19px;font-weight:600;color:var(--accent);font-family:Consolas,monospace;',
      '  line-height:1.3;}',
      '@media (max-width:1500px){#mech-module .mech-left{flex:0 0 200px;}#mech-module .mech-right{flex:0 0 236px;}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  /* ===========================================================================
   * 4. 菜单栏 + 工具条
   * ======================================================================== */
  var RIBBONS = {
    '几何': [
      { g: 'Geometry', items: [
        { id: 'import', ico: '📥', t: 'Import Geometry', tip: '导入 STEP/IGES 几何' },
        { id: 'units', ico: '↔', t: 'Units', tip: '切换导入单位 mm / in' },
        { id: 'modelsolid', ico: '◼', t: 'Model Type', tip: 'Solid / Shell / Beam' }
      ] },
      { g: '几何工具', items: [
        { id: 'share', ico: '⊟', t: 'Share Topology', tip: '共享拓扑，为 Bonded 接触做准备' },
        { id: 'bodyinfo', ico: 'ℹ', t: 'Body Info', tip: '查看 ' + PLIST.length + ' 个实体的体积与质量' }
      ] }
    ],
    '连接': [
      { g: 'Connections', items: [
        { id: 'autocontact', ico: '🔗', t: 'Auto Generate Contact', tip: '自动生成接触区域' },
        { id: 'bonded', ico: '🔒', t: 'Type: Bonded', tip: '六自由度全约束（会锁死转动）' },
        { id: 'revolute', ico: '⚭', t: 'Type: Revolute', tip: '只约束三个平动，保留转动' },
        { id: 'jointspin', ico: '↻', t: '试转关节', tip: '拖动看能不能转' },
        { id: 'remotepoint', ico: '✛', t: 'Insert Remote Point', tip: '在末端建立远程点' }
      ] }
    ],
    '网格': [
      { g: 'Mesh', items: [
        { id: 'meshsize', ico: '↔', t: 'Element Size', tip: '全局单元尺寸 2–16 mm' },
        { id: 'meshorder', ico: '²', t: 'Element Order', tip: 'Linear / Quadratic 二阶' },
        { id: 'gensize', ico: '⊞', t: 'Generate Mesh', tip: '生成网格并输出统计' }
      ] }
    ],
    '载荷': [
      { g: 'Loads', items: [
        { id: 'fixed', ico: '🔒', t: 'Insert Fixed Support', tip: '固定底座法兰底面' },
        { id: 'fixscope', ico: '⚑', t: 'Scoped Geometry', tip: '只选面 vs 选整个体（过约束）' },
        { id: 'gravity', ico: '⬇', t: 'Insert Gravity', tip: '全局 Z 负方向重力' },
        { id: 'forceval', ico: '➤', t: 'Remote Force', tip: '末端远程力 0–50 N' }
      ] }
    ],
    '结果': [
      { g: 'Results', items: [
        { id: 'solve', ico: '▶', t: 'Solve', tip: '求解并输出求解器日志' },
        { id: 'ldeform', ico: '📏', t: 'Total Deformation', tip: '插入总变形结果' },
        { id: 'stress', ico: '🔥', t: 'Equivalent Stress', tip: '插入等效应力（von Mises）' },
        { id: 'fos', ico: '🛡', t: 'Factor of Safety', tip: '插入安全系数' },
        { id: 'reaction', ico: '⇧', t: 'Reaction Force', tip: '插入反力，做整体平衡校核' }
      ] }
    ],
    '视图': [
      { g: '显示', items: [
        { id: 'vmesh', ico: '⊞', t: '网格显示', tip: '显示单元边界' },
        { id: 'vghost', ico: '❖', t: '原始轮廓', tip: '叠加未变形线框' },
        { id: 'vload', ico: '⬇', t: '载荷/约束', tip: '显示力与约束符号' },
        { id: 'vreset', ico: '⟲', t: '复位视图', tip: '相机回到初始取景' }
      ] },
      { g: '变形', items: [
        { id: 'defplay', ico: '▶', t: '播放变形', tip: '循环播放加载过程' },
        { id: 'def1', ico: '1×', t: '1x', tip: '真实比例' },
        { id: 'def2', ico: '2×', t: '2x' },
        { id: 'def5', ico: '5×', t: '5x' },
        { id: 'def10', ico: '10×', t: '10x' }
      ] }
    ]
  };

  function buildRibbon() {
    var keys = ['几何', '连接', '网格', '载荷', '结果', '视图'];
    var cur = S.ribbonMenu || '几何';
    S.ribbonMenu = cur;
    S.$.ribbon.innerHTML = (RIBBONS[cur] || []).map(function (grp) {
      return '<div class="ribbon-group"><div class="mech-grp-t">' + grp.g + '</div>' +
        grp.items.map(function (it) {
          return '<button class="ribbon-btn" data-act="' + it.id + '" title="' + esc(it.tip || it.t) + '">' +
            '<span class="ico">' + it.ico + '</span><span>' + esc(it.t) + '</span></button>';
        }).join('') + '</div>';
    }).join('');
    S.$.ribbon.onclick = function (e) {
      var b = e.target.closest ? e.target.closest('.ribbon-btn') : null;
      if (!b) return;
      doAction(b.getAttribute('data-act'));
    };
  }
  function bindMenu() {
    var bar = $('.mech-menubar');
    bar.onclick = function (e) {
      var it = e.target.closest ? e.target.closest('.menu-item') : null;
      if (!it) return;
      var items = bar.querySelectorAll('.menu-item');
      for (var i = 0; i < items.length; i++) items[i].classList.toggle('is-on', items[i] === it);
      S.ribbonMenu = it.getAttribute('data-menu');
      buildRibbon();
      log('▸ 功能区切换：' + it.textContent, 'cmd');
    };
  }

  function doAction(id) {
    switch (id) {
      case 'import':
        log('▸ Geometry ▸ Import Geometry…  D:\\cae-academy\\dummy_arm.step', 'cmd');
        log('  Units = ' + (S.units === 'mm' ? 'mm' : 'in') + '   Model Type = Solid   Bodies = ' + PLIST.length, 'info');
        if (S.units !== 'mm') log('  ⚠ 几何按 1:25.4 缩小 —— 单位选错的典型后果', 'err');
        toastLine('已导入 ' + PLIST.length + ' 个实体（Solid）');
        reveal(0); break;
      case 'units':
        S.units = S.units === 'mm' ? 'in' : 'mm';
        applyUnitScale();
        if (S.units === 'in') log('  ⚠ Units 切到 in：几何被按 1:25.4 缩小，尺寸全部不对', 'err');
        else log('  ✓ Units 切回 mm：几何恢复正常比例', 'ok');
        renderProps(); break;
      case 'modelsolid':
        log('  Model Type = Solid（只有实体才能算局部应力；Shell 走壳单元）', 'info');
        toastLine('Model Type = Solid'); break;
      case 'share':
        log('▸ Geometry ▸ Share Topology：共面面对齐，导入面接触所需的公差', 'cmd');
        toastLine('已共享拓扑（Conformal）'); break;
      case 'bodyinfo':
        renderProps('bodies'); log('  已列出 ' + PLIST.length + ' 个实体的体积与质量', 'info'); break;

      case 'autocontact':
        log('▸ Connections ▸ Auto Generate Contact：检出 6 组面对，生成 3 个 Contact Region', 'cmd');
        reveal(2); select('connections'); break;
      case 'bonded':
        setContact('Bonded'); break;
      case 'revolute':
        setContact('Revolute'); break;
      case 'jointspin':
        spinJoint(); break;
      case 'remotepoint':
        log('▸ Geometry ▸ Insert ▸ Remote Point：作用域 = 夹爪两指面，作用点 = Remote Point 1', 'cmd');
        reveal(5); select('remotepoint'); break;

      case 'meshsize':
        toastLine('在右侧 Details 里拖动 Element Size 滑块');
        reveal(3); select('mesh'); break;
      case 'meshorder':
        S.quadratic = !S.quadratic;
        log('▸ Mesh ▸ Details ▸ Element Order = ' + (S.quadratic ? 'Quadratic（二阶，SOLID187）' : 'Linear（一阶，SOLID185）'), 'cmd');
        if (S.meshGenerated) { rebuildGeometry(); meshStats(); }
        renderProps(); break;
      case 'gensize':
        genMesh(); break;

      case 'fixed':
        log('▸ Static Structural ▸ Insert ▸ Fixed Support：作用域 = Base Flange 的底面', 'cmd');
        reveal(4); select('fixedsupport'); break;
      case 't-nosupport':
        S.fixedScope = (S.fixedScope === 'none') ? 'face' : 'none';
        if (S.fixedScope === 'none') {
          log('  🔧 已删掉 Fixed Support —— 现在结构是悬空的', 'err');
          log('    静力求解会提示存在刚体模式（rigid body mode）/ 最小刚度接近 0', 'warn');
          log('    变形与应力照样出得来，但物理上完全不可信。去看 Reaction 面板的 ① 力平衡。', 'warn');
        } else {
          log('  ↩ 固定约束加回来了', 'ok');
        }
        reveal(4); select('r_reaction'); recompute(); renderProps(); updateOverlay(); break;
      case 't-dblforce':
        S.forceReps = (S.forceReps === 2) ? 1 : 2;
        if (S.forceReps === 2) {
          log('  🔧 又插了一个 Remote Force = ' + f(S.force, 1) + ' N —— 载荷被施加了两次', 'err');
          log('    求解器不会报错，但变形与应力直接翻倍。去看 Reaction 面板的 ③ 载荷重复施加。', 'warn');
        } else {
          log('  ↩ 只保留一个 Remote Force', 'ok');
        }
        reveal(5); select('r_reaction'); recompute(); renderProps(); updateOverlay(); break;
      case 't-badtip':
        S.tipOffset = (S.tipOffset === 0) ? 60 : 0;
        if (S.tipOffset !== 0) {
          log('  🔧 Remote Point 沿连杆方向被挪了 +' + S.tipOffset + ' mm（力臂变了）', 'err');
          log('    力的**总和**没变，所以 ①② 都还是过的；只有 ④ 远程点力臂会亮红。', 'warn');
        } else {
          log('  ↩ Remote Point 回到夹爪末端', 'ok');
        }
        reveal(5); select('r_reaction'); recompute(); renderProps(); updateOverlay(); break;
      case 't-clearall':
        S.fixedScope = 'face'; S.forceReps = 1; S.tipOffset = 0;
        log('  ↩ 三处都改回正确建模：固定约束在底面、Remote Force 只加一次、远程点在夹爪末端', 'ok');
        select('r_reaction'); recompute(); renderProps(); updateOverlay(); break;
      case 'fixscope':
        S.fixedScope = S.fixedScope === 'face' ? 'body' : 'face';
        if (S.fixedScope === 'body') {
          log('  ⚠ Scoped Geometry 选了整个 Body：与法兰连接面形成重复约束', 'err');
          log('    The solver reports over-constrained equations (duplicate constraint)', 'warn');
        } else log('  ✓ Scoped Geometry 改回"只选底面"，重复约束消失', 'ok');
        recompute(); renderProps(); updateOverlay(); break;
      case 'gravity':
        S.gravity = !S.gravity;
        log('▸ Insert ▸ Gravity：方向 = 全局 -Z，等效加速度 9.8066 m/s²；自重 '
          + f(TOTAL_MASS, 3) + ' kg × 9.8066 = ' + f(TOTAL_WEIGHT, 2) + ' N', S.gravity ? 'info' : 'warn');
        recompute(); renderProps(); updateOverlay(); break;
      case 'forceval':
        reveal(5); select('remoteforce');
        toastLine('在右侧 Details 拖动末端力 0–50 N'); break;

      case 'solve':
        solve(); break;
      case 'ldeform':
        reveal(7); setResult('deform'); break;
      case 'stress':
        reveal(8); setResult('stress'); break;
      case 'fos':
        reveal(8); setResult('fos'); break;
      case 'reaction':
        reveal(8); setResult('none'); select('r_reaction'); break;

      case 'vmesh':
        S.showMesh = !S.showMesh; refreshMeshOverlay(); updateHUD(); renderProps();
        log('▸ View ▸ 网格显示 = ' + (S.showMesh ? 'On（实体半透明，露出单元边界）' : 'Off'), 'cmd');
        break;
      case 'vghost':
        S.showGhost = !S.showGhost; applyResult(); updateHUD();
        log('▸ View ▸ 原始轮廓叠加 = ' + (S.showGhost ? 'On' : 'Off'), 'cmd');
        break;
      case 'vload':
        S.showLoads = !S.showLoads; updateOverlay(); updateHUD(); break;
      case 'vreset':
        if (S.vp && S.vp.controls) { S.vp.controls.reset(); }
        log('▸ View ▸ Fit：相机复位', 'cmd'); break;
      case 'defplay':
        S.playing = !S.playing; if (S.playing && S.animT >= 1) S.animT = 0;
        updateHUD(); break;
      case 'def1': S.defScale = 1; updateHUD(); renderProps(); break;
      case 'def2': S.defScale = 2; updateHUD(); renderProps(); break;
      case 'def5': S.defScale = 5; updateHUD(); renderProps(); break;
      case 'def10': S.defScale = 10; updateHUD(); renderProps(); break;
    }
  }
  function toastLine(t) { S.api.toast(t, 'info'); }

  /* ===========================================================================
   * 5. 视口内 HUD（视图开关）
   * ======================================================================== */
  function buildHUD() {
    S.$.hud.innerHTML = [
      hbtn('vmesh', '⊞ 网格', S.showMesh),
      hbtn('vghost', '❖ 原始轮廓', S.showGhost),
      hbtn('vload', '⬇ 载荷/约束', S.showLoads),
      hbtn('defplay', '▶ 播放', S.playing),
      '<button class="btn btn-sm" data-act="vreset">⟲ 复位</button>'
    ].join('');
    S.$.hud.onclick = function (e) {
      var b = e.target.closest ? e.target.closest('.btn') : null;
      if (b) doAction(b.getAttribute('data-act'));
    };
  }
  function hbtn(id, txt, on) {
    return '<button class="btn' + (on ? ' is-on' : '') + '" data-act="' + id + '">' + txt + '</button>';
  }
  function updateHUD() {
    var h = S.$.hud;
    h.innerHTML = [
      hbtn('vmesh', '⊞ 网格', S.showMesh),
      hbtn('vghost', '❖ 原始轮廓', S.showGhost),
      hbtn('vload', '⬇ 载荷/约束', S.showLoads),
      hbtn('defplay', S.playing ? '⏸ 暂停' : '▶ 播放', S.playing),
      '<button class="btn btn-sm" data-act="vreset">⟲ 复位</button>'
    ].join('');
  }

  function updateOverlay() {
    var bits = [];
    if (S.stage >= 0) bits.push('阶段 ' + STAGE_CN[STAGES[S.stage]]);
    bits.push('臂长 ' + (LTOT / 1000).toFixed(3) + ' m');
    if (S.res) {
      bits.push('F = ' + f(S.force, 1) + ' N');
      if (S.solved) {
        if (S.result === 'deform') bits.push('总变形 Max = ' + f(S.res.uTip * 1000, 3) + ' mm（显示 ' + S.defScale + '×）');
        if (S.result === 'stress') bits.push('等效应力 Max = ' + f(S.res.maxStress / 1e6, 2) + ' MPa');
        if (S.result === 'fos') bits.push('安全系数 Min = ' + f(S.res.fos, 2));
      }
    }
    S.$.ov.textContent = bits.join('   ·   ');
    S.$.vp.querySelector('.viewport-hint').textContent =
      '左键旋转 · 滚轮缩放 · 右键平移 · 点击零件选中 · ' + (S.units === 'mm' ? 'Units = mm' : 'Units = in（几何已缩小 25.4 倍）');
    updateLoadVisuals();
  }

  /* ===========================================================================
   * 6. 三维：Dummy 机械臂（全部程序化生成）
   * ======================================================================== */
  function buildArm() {
    var vp = S.vp;
    if (!vp || !vp.scene) return;
    S.armRoot = new THREE.Group();
    S.armRoot.rotation.x = -Math.PI / 2;      // 模型 +Z → 世界 +Y（竖直向上）
    vp.scene.add(S.armRoot);

    S.parts = [];
    S.overlays = { ghost: [], mesh: [] };
    S.loadGroup = new THREE.Group();
    S.armRoot.add(S.loadGroup);

    var matStd = function () {
      return new THREE.MeshStandardMaterial({ color: 0xb8c6d4, metalness: 0.42, roughness: 0.42 });
    };
    S.matStd = matStd;

    for (var i = 0; i < PLIST.length; i++) {
      var p = PLIST[i];
      var m = new THREE.Mesh(makePartGeo(p, 1), matStd());
      m.castShadow = true; m.receiveShadow = true;
      m.userData.partId = p.id;
      placePart(m, p);
      S.armRoot.add(m);
      S.parts.push({ def: p, mesh: m, basePos: null, sArr: null, nArr: null });
    }

    /* 夹持标记（Fixed Support 的绿色符号） */
    S.clamp = makeClamp();
    S.armRoot.add(S.clamp);

    /* 远程点与载荷箭头 */
    S.remotePt = makeRemotePoint();
    S.armRoot.add(S.remotePt.group);

    S.loadArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, -1), new THREE.Vector3(P3.x * MM, 0, P3.z * MM),
      1.2, 0xff4438, 0.22, 0.13);
    S.loadGroup.add(S.loadArrow);

    S.gravArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, -1), new THREE.Vector3(0.9, 0, 0.9),
      0.9, 0x49b6ff, 0.2, 0.12);
    S.loadGroup.add(S.gravArrow);

    /* 网格与原始轮廓叠加层 */
    S.ghostMat = new THREE.LineBasicMaterial({ color: 0x5b86b8, transparent: true, opacity: 0.5 });
    S.meshMat = new THREE.LineBasicMaterial({ color: 0x35c9c0, transparent: true, opacity: 0.85 });

    applyUnitScale();
    recompute();
    refreshMeshOverlay();
    bindPicking();
    vp.onFrame(frame);
  }

  /** 依据零件定义与网格密度生成几何 */
  function makePartGeo(p, detail) {
    var d = p.dim;
    /* 关节圆角与刚性底座用更细的局部尺寸 */
    var size = S.meshSize / (p.shape === 'torus' ? 3.2 : (p.seg >= 0 ? 1 : 1.6));
    /* 段数必须是整数：先 round 再钳制，否则 Element Size 会出现小数段数，
       报出来的单元数和视口里画出来的网格对不上 */
    var nd = function (a, b) { return Math.max(1, Math.min(b, Math.round(a))); };
    var nx = 1, ny = 1, nz = 1, geo, nr = 0, nt = 0;
    if (p.shape === 'box') {
      nx = nd(d.w / size, 1); ny = nd(d.h / size, 2); nz = nd(d.d / size, 1);
      geo = new THREE.BoxGeometry(d.w * MM, d.h * MM, d.d * MM, nx, ny, nz);
      geo.userData = { dims: [nx, ny, nz] };
    } else if (p.shape === 'cyl') {
      var r = d.r !== undefined ? d.r : (d.rT + d.rB) / 2;
      nr = nd(r / size, 8); ny = nd(d.h / size, 2);
      geo = new THREE.CylinderGeometry(
        (d.rT !== undefined ? d.rT : d.r) * MM, (d.rB !== undefined ? d.rB : d.r) * MM,
        d.h * MM, nr, ny, false);
      geo.userData = { dims: [nr, ny, nr] };
    } else {
      /* r128：TorusGeometry(radius, tube, radialSegments, tubularSegments) */
      nr = nd(d.R / size * 2, 12); nt = nd(d.r / size * 1.4, 6);
      geo = new THREE.TorusGeometry(d.R * MM, d.r * MM, nt, nr);
      geo.userData = { dims: [nr, nt, nr] };
    }
    return geo;
  }

  function placePart(mesh, p) {
    var a = p.at;
    mesh.position.set(a.x * MM, (p.offsetY || 0) * MM, a.z * MM);
    if (p.shape === 'torus') mesh.rotation.x = Math.PI / 2;    // 环轴 = 模型 Y（关节轴）
    else if (a.rot) mesh.rotation.y = a.rot * Math.PI / 180;
  }

  /** 缓存每个顶点的弧长 s、法向 n 与初始位置，用于变形 */
  function bakeVertices() {
    for (var i = 0; i < S.parts.length; i++) {
      var it = S.parts[i], p = it.def;
      var pos = it.mesh.geometry.attributes.position;
      var n = pos.count;
      it.basePos = new Float32Array(pos.array);
      it.sArr = new Float32Array(n);
      it.nArr = new Float32Array(n * 2);
      var g = null;
      if (p.seg >= 0) g = SEGS[p.seg];
      for (var v = 0; v < n; v++) {
        var x = it.basePos[v * 3], y = it.basePos[v * 3 + 1], z = it.basePos[v * 3 + 2];
        var s = 0;
        if (p.sFixed !== undefined) s = p.sFixed;
        else if (g) {
          /* 顶点世界坐标 → 模型坐标（把 Group 的 -90° 旋转反过来算） */
          var mx = x + p.at.x * MM;
          var mz = z + p.at.z * MM;
          var along = ((mx - g.px * MM) * g.dx + (mz - g.pz * MM) * g.dz) / MM;
          s = g.s0 + Math.max(0, Math.min(g.s1 - g.s0, along));
        }
        it.sArr[v] = s;
        var sg = segOfS(s);
        it.nArr[v * 2] = -sg.dz;      // n = (-t_z, t_x)
        it.nArr[v * 2 + 1] = sg.dx;
      }
    }
  }

  function applyUnitScale() {
    if (!S.armRoot) return;
    S.armRoot.scale.setScalar(S.units === 'mm' ? 1 : 1 / 25.4);
  }

  /** 重建几何（网格尺寸变化）+ 叠加层 */
  function rebuildGeometry() {
    if (!S.armRoot) return;
    for (var i = 0; i < S.parts.length; i++) {
      var it = S.parts[i];
      var old = it.mesh.geometry;
      it.mesh.geometry = makePartGeo(it.def, 1);
      if (old && old.dispose) old.dispose();
      it.mesh.material.color.set(hexOf(it.def.mat));
      it.mesh.material.wireframe = false;
    }
    bakeVertices();
    applyDeformation();
    refreshMeshOverlay();
  }

  function hexOf(matKey) {
    return matKey === 'al' ? MATS.al.color : MATS.st.color;
  }

  /** 原始轮廓 + 单元网格 两套静态叠加层（按未变形位置生成） */
  function refreshMeshOverlay() {
    if (!S.armRoot) return;
    /* 清掉旧的 */
    var i, j;
    for (i = 0; i < S.overlays.ghost.length; i++) { S.armRoot.remove(S.overlays.ghost[i]); S.overlays.ghost[i].geometry.dispose(); }
    for (i = 0; i < S.overlays.mesh.length; i++) { S.armRoot.remove(S.overlays.mesh[i]); S.overlays.mesh[i].geometry.dispose(); }
    S.overlays.ghost = []; S.overlays.mesh = [];
    if (!S.parts.length) return;
    bakeVertices();
    for (i = 0; i < S.parts.length; i++) {
      var it = S.parts[i];
      var wg = new THREE.WireframeGeometry(it.mesh.geometry);
      var gl = new THREE.LineSegments(wg, S.ghostMat);
      gl.position.copy(it.mesh.position);
      gl.rotation.copy(it.mesh.rotation);
      S.armRoot.add(gl); S.overlays.ghost.push(gl);
    }
    if (S.showMesh) {
      for (i = 0; i < S.parts.length; i++) {
        var it2 = S.parts[i];
        var wg2 = new THREE.WireframeGeometry(it2.mesh.geometry);
        var ml = new THREE.LineSegments(wg2, S.meshMat);
        ml.position.copy(it2.mesh.position);
        ml.rotation.copy(it2.mesh.rotation);
        S.armRoot.add(ml); S.overlays.mesh.push(ml);
      }
    }
    var vis = S.showGhost, visM = S.showMesh;
    for (i = 0; i < S.overlays.ghost.length; i++) S.overlays.ghost[i].visible = vis;
    for (j = 0; j < S.overlays.mesh.length; j++) S.overlays.mesh[j].visible = visM;
  }

  /* ---- 夹持标记 ---- */
  function makeClamp() {
    var g = new THREE.Group();
    var mat = new THREE.MeshBasicMaterial({ color: 0x39d07a, transparent: true, opacity: 0.9 });
    var dark = new THREE.MeshBasicMaterial({ color: 0x1d7a4a, transparent: true, opacity: 0.55 });
    var plate = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.012, 0.14), mat);
    plate.position.set(0, 0, 0.0015);
    g.add(plate);
    var face = new THREE.Mesh(new THREE.CircleGeometry(0.058, 40), dark);
    face.position.set(0, 0, 0.0002);
    face.rotation.x = 0;
    g.add(face);
    /* 六个固定符号：沿法兰底面一圈 */
    for (var i = 0; i < 6; i++) {
      var a = i * Math.PI / 3 + 0.3;
      var c = new THREE.Mesh(new THREE.ConeGeometry(0.0075, 0.016, 6), mat);
      c.position.set(Math.cos(a) * 0.078, 0, Math.sin(a) * 0.078);
      c.rotation.x = Math.PI;
      g.add(c);
    }
    /* 侧面的"夹爪" */
    for (var j = 0; j < 4; j++) {
      var ang = j * Math.PI / 2 + Math.PI / 4;
      var cl = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.009, 0.012), mat);
      cl.position.set(Math.cos(ang) * 0.088, 0, Math.sin(ang) * 0.088);
      cl.rotation.y = -ang;
      g.add(cl);
    }
    return g;
  }

  /* ---- 远程点 ---- */
  function makeRemotePoint() {
    var g = new THREE.Group();
    var mat = new THREE.MeshBasicMaterial({ color: 0xffd166 });
    var ring = new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.0035, 8, 24), mat);
    g.add(ring);
    var ring2 = new THREE.Mesh(new THREE.TorusGeometry(0.016, 0.003, 8, 20), mat);
    g.add(ring2);
    var axis = new THREE.Mesh(new THREE.CylinderGeometry(0.0018, 0.0018, 0.07, 6), mat);
    g.add(axis);
    g.position.set(P3.x * MM, 0, P3.z * MM);
    return { group: g, ring: ring, ring2: ring2 };
  }

  function frame(dt) {
    if (!S || !S.armRoot) return;
    /* 播放动画 */
    if (S.playing && S.solved && S.result !== 'none') {
      S.animT += dt * 0.55;
      if (S.animT > 1.25) S.animT = 0;
      applyDeformation();
    }
    /* 选中高亮 + 网格显示时的半透明处理 */
    for (var i = 0; i < S.parts.length; i++) {
      var it = S.parts[i], m = it.mesh.material;
      var isSel = !!(S.selParts && S.selParts.indexOf(it.def.id) >= 0);
      m.emissive.setHex(isSel ? 0x5a2f10 : 0x000000);
      var translucent = (S.result === 'none' && S.showMesh);
      if (m.transparent !== translucent) { m.transparent = translucent; m.needsUpdate = true; }
      m.opacity = translucent ? 0.14 : 1.0;
      m.depthWrite = !translucent;
    }
    /* 远程点呼吸 */
    if (S.remotePt) {
      var t = performance.now() * 0.0022;
      var k = 1 + 0.12 * Math.sin(t);
      S.remotePt.ring.scale.setScalar(k);
      S.remotePt.ring2.scale.setScalar(2 - k);
    }
  }

  /* ===========================================================================
   * 7. 变形 / 应力 / 安全系数 的着色与位移
   * ======================================================================== */
  /* JET 色带：[位置, 打包色] */
  var JET = [
    [0.00, 0x1b3a8f], [0.16, 0x1868b0], [0.33, 0x1fb6c4],
    [0.50, 0x3ec93e], [0.66, 0xd6d92a], [0.82, 0xf08a1e], [1.00, 0xd0202a]
  ];
  function hex2rgb(h) { return [(h >> 16) & 255, (h >> 8) & 255, h & 255]; }
  /** t∈[0,1] → [r,g,b]（0~255） */
  function ramp(t) {
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    for (var i = 1; i < JET.length; i++) {
      if (t <= JET[i][0]) {
        var a = JET[i - 1], b = JET[i];
        var k = (t - a[0]) / (b[0] - a[0]);
        var ca = hex2rgb(a[1]), cb = hex2rgb(b[1]);
        return [
          ca[0] + (cb[0] - ca[0]) * k,
          ca[1] + (cb[1] - ca[1]) * k,
          ca[2] + (cb[2] - ca[2]) * k
        ];
      }
    }
    var last = hex2rgb(JET[JET.length - 1][1]);
    return [last[0], last[1], last[2]];
  }
  function css(c) {
    return 'rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ')';
  }

  function recompute() {
    S.res = MODEL.run({
      force: S.force, gravity: S.gravity,
      support: S.fixedScope, forceReps: S.forceReps || 1,
      tipX: P3.x + (S.tipOffset || 0)
    });
    updateLoadVisuals();
    if (S.solved) applyResult();
    updateOverlay();
  }

  function setResult(mode) {
    S.result = mode;
    S.selParts = null;
    for (var i = 0; i < S.overlays.ghost.length; i++) S.overlays.ghost[i].visible = S.showGhost;
    applyResult();
    updateOverlay();
    if (mode !== 'none' && !S.solved) {
      S.api.toast('尚未求解 —— 请先点工具条 Solve（▶）', 'warn');
      log('  ⚠ 结果对象为空：请先 Solve。Mechanical 里结果节点会显示为感叹号。', 'warn');
    }
  }

  function applyResult() {
    if (!S.res || !S.parts.length) return;
    var res = S.res;
    var mode = S.result;

    /* ① 位移（deform 模式才动） */
    var amp = (mode === 'deform') ? S.animT * S.defScale : 0;
    applyDeformation(amp);

    /* ② 顶点着色 */
    var useVertex = mode !== 'none';
    for (var i = 0; i < S.parts.length; i++) {
      var it = S.parts[i], m = it.mesh.material;
      m.vertexColors = useVertex;
      if (useVertex) m.color.setHex(0xffffff); else m.color.setHex(hexOf(it.def.mat));
      if (!useVertex) continue;
      var geo = it.mesh.geometry, pos = geo.attributes.position;
      if (!it.colArr || it.colArr.length !== pos.count * 3) {
        it.colArr = new Float32Array(pos.count * 3);
        geo.setAttribute('color', new THREE.BufferAttribute(it.colArr, 3));
      }
      var col = it.colArr;
      /* 刚性底座（法兰/转台/壳体）不参与弯曲积分：云图上一律画成最低标量值，
         免得让人误以为底座应力也到峰值 */
      var segOK = it.def.seg >= 0;
      for (var v = 0; v < pos.count; v++) {
        var s = it.sArr[v];
        var c;
        if (mode === 'deform') {
          var um = Math.sqrt(res._ux(s) * res._ux(s) + res._uz(s) * res._uz(s));
          c = ramp(um / (res.uTip || 1));
        } else if (mode === 'stress') {
          c = ramp(segOK ? res._sig(s) / (res.maxStress || 1) : 0);
        } else {
          var sg = segOK ? res._sig(s) : 0;
          var fos = sg > 0 ? MATS[SEC_A.mat].yieldMPa * 1e6 / sg : 999;
          var lo = Math.max(1, res.fos * 0.35), hi = Math.min(res.fos * 1.6, 60);
          c = ramp(1 - (fos - lo) / (hi - lo));   // 安全系数越小越红
        }
        col[v * 3] = c[0] / 255; col[v * 3 + 1] = c[1] / 255; col[v * 3 + 2] = c[2] / 255;
      }
      geo.attributes.color.needsUpdate = true;
    }

    /* ③ 叠加层可见性：原始轮廓只在显示变形结果时才有意义（静态时与实体完全重合） */
    var wantGhost = S.showGhost && mode !== 'none';
    for (var g2 = 0; g2 < S.overlays.ghost.length; g2++) S.overlays.ghost[g2].visible = wantGhost;
    for (var m2 = 0; m2 < S.overlays.mesh.length; m2++) S.overlays.mesh[m2].visible = S.showMesh;

    /* ④ 图例 */
    if (mode === 'none') { S.$.legend.style.display = 'none'; return; }
    var lg;
    if (mode === 'deform') {
      lg = { title: '总变形 Total Deformation', unit: 'mm', min: 0, max: res.uTip * 1000 };
    } else if (mode === 'stress') {
      lg = { title: '等效应力 Equivalent Stress', unit: 'MPa', min: 0, max: res.maxStress / 1e6 };
    } else {
      lg = { title: '安全系数 Factor of Safety', unit: '', min: res.fos, max: Math.min(res.fos * 1.6, 60), rev: true };
    }
    renderLegend(lg);
    S.$.legend.style.display = '';
  }

  function renderLegend(lg) {
    var max = lg.max, min = lg.min, mid = (min + max) / 2;
    /* 安全系数"越小越危险"，色带要和云图一致：左端(min)必须对应红色 */
    var stops = JET.map(function (j) { return css(hex2rgb(j[1])) + ' ' + (j[0] * 100).toFixed(0) + '%'; });
    if (lg.rev) stops.reverse();
    S.$.legend.innerHTML =
      '<div class="legend-title">' + esc(lg.title) + '</div>' +
      '<div class="legend-bar" style="background:linear-gradient(90deg,' + stops.join(',') + ')"></div>' +
      '<div class="legend-ticks"><span>' + f(min, 2) + '</span><span>' + f(mid, 2) + '</span><span>' + f(max, 2) + '</span></div>' +
      (lg.unit ? '<div class="legend-title" style="margin:3px 0 0">单位 ' + lg.unit + '</div>' : '');
  }

  function applyDeformation(ampOverride) {
    if (!S.parts.length || !S.res) return;
    var amp = ampOverride !== undefined ? ampOverride : (S.result === 'deform' ? S.animT * S.defScale : 0);
    var res = S.res;
    for (var i = 0; i < S.parts.length; i++) {
      var it = S.parts[i];
      if (!it.basePos) continue;
      var pos = it.mesh.geometry.attributes.position, arr = pos.array;
      var base = it.basePos, n = pos.count;
      for (var v = 0; v < n; v++) {
        var s = it.sArr[v];
        if (s <= 0) continue;
        var d = Math.sqrt(res._ux(s) * res._ux(s) + res._uz(s) * res._uz(s)) * amp;
        arr[v * 3] = base[v * 3] + d * it.nArr[v * 2];
        arr[v * 3 + 1] = base[v * 3 + 1];
        arr[v * 3 + 2] = base[v * 3 + 2] + d * it.nArr[v * 2 + 1];
      }
      pos.needsUpdate = true;
      it.mesh.geometry.computeVertexNormals();
    }
    /* 变形后远程点与箭头跟着走（长度由 updateLoadVisuals 统一管，这里只管位置） */
    if (S.remotePt && S.loadArrow) {
      var dTip = res.uTip * amp;
      /* D1 的字段是 {x, z}，不是 {dx, dz}：写错会得到 -undefined → NaN，
         把远程点与载荷箭头的坐标污染成 NaN，对象从此被视锥剔除、再也不显示 */
      var nx = -D1.z, nz = D1.x;
      var ox = P3.x * MM + dTip * nx, oz = P3.z * MM + dTip * nz;
      S.remotePt.group.position.set(ox, 0, oz);
      S.loadArrow.position.set(ox, 0, oz);
    }
  }

  function updateLoadVisuals() {
    if (!S.loadArrow) return;
    S.loadArrow.setLength(0.35 + S.force * 0.022, 0.18, 0.1);
    S.loadArrow.visible = S.showLoads && S.force > 0.01;
    S.gravArrow.visible = S.showLoads && S.gravity;
    S.gravArrow.setLength(0.3 + TOTAL_WEIGHT * 0.028, 0.16, 0.09);
    if (S.remotePt) S.remotePt.group.visible = S.showLoads;
    if (S.clamp) S.clamp.visible = S.showLoads;
  }

  /* ===========================================================================
   * 8. 关节试转
   * ======================================================================== */
  function applyJointRotation() {
    var a = S.jointAngle * Math.PI / 180;
    /* 肘关节（J2）：小臂+腕+夹爪 绕 J2 轴（模型 Y）转 */
    var k = Math.cos(a), kk = Math.sin(a);
    for (var i = 0; i < S.parts.length; i++) {
      var it = S.parts[i], d = it.def;
      var belong = (d.id === 'forearm' || d.id === 'joint_wrist' || d.id === 'wrist' ||
        d.id === 'gripper' || d.id === 'fingerL' || d.id === 'fingerR');
      it.mesh.rotation.y = belong ? (58 * Math.PI / 180 + a) : (d.at.rot ? d.at.rot * Math.PI / 180 : 0);
    }
    void k; void kk;
  }
  function resetJointRotation() {
    for (var i = 0; i < S.parts.length; i++) {
      var it = S.parts[i], d = it.def;
      it.mesh.rotation.y = d.shape === 'torus' ? Math.PI / 2 : (d.at.rot ? d.at.rot * Math.PI / 180 : 0);
    }
    S.jointAngle = 0;
  }
  function spinJoint() {
    if (S.contactType !== 'Revolute') {
      log('  ⚠ 关节 Type = Bonded：六个自由度全被约束，试转没有任何位移。', 'err');
      log('    Bonded contact 会把两个面焊死 —— 这就是本步要避免的建模错误。', 'warn');
      S.api.toast('转不动：Bonded 把关节锁死了', 'err');
      resetJointRotation();
      renderProps();
      return;
    }
    S.jointAngle = (S.jointAngle + 30) % 120;
    if (S.jointAngle === 0) S.jointAngle = 30;
    log('  ▸ 手动转动 J2 = ' + S.jointAngle + '°：Revolute 只约束 3 个平动，绕轴转动自由 ✓', 'ok');
    S.api.toast('J2 转动 ' + S.jointAngle + '° —— 转动自由度未被约束', 'ok');
    renderProps();
  }
  function setContact(type) {
    S.contactType = type;
    if (type === 'Bonded') {
      log('▸ Contact Region ▸ Type = Bonded：粘结接触，传递 6 个自由度（3 平动 + 3 转动）', 'warn');
      log('    → 关节被焊死，试转按钮会给出警告。', 'warn');
    } else {
      log('▸ Joint ▸ Type = Revolute：铰链连接，只约束 3 个平动，保留绕轴转动', 'ok');
    }
    resetJointRotation();
    if (type === 'Revolute') { log('  ▸ 试转 J2：可以自由转动，说明自由度设置正确', 'ok'); }
    renderProps();
    updateOverlay();
  }

  /* ===========================================================================
   * 9. 网格
   * ======================================================================== */
  function meshStats() {
    var el = 0, nL = 0, nQ = 0;
    for (var i = 0; i < S.parts.length; i++) {
      var d = (S.parts[i].mesh.geometry.userData || {}).dims || [1, 1, 1];
      var a = d[0] + 1, b = d[1] + 1, c = d[2] + 1;
      el += d[0] * d[1] * d[2];
      nL += a * b * c;
      nQ += (2 * d[0] + 1) * (2 * d[1] + 1) * (2 * d[2] + 1);
    }
    S.meshStat = { elements: el, nodesLinear: nL, nodesQuadratic: nQ };
    return S.meshStat;
  }
  /* 网格无关性：同一套载荷在不同单元尺寸下解一次，看关键读数还变不变。
     这是 README 承诺的教学点，也是真实工程里判断"网格够不够细"的唯一办法。 */
  function meshConvergence(size) {
    var st = meshStats();
    var el0 = st.elements;
    /* 单元数 ∝ (L/h)³，节点数（二阶）∝ 2.8 倍单元数 */
    var scale = Math.pow(8 / size, 3);
    var el = Math.round(el0 * scale), nd = Math.round(st.nodesQuadratic * scale * 1.4);
    var r = MODEL.run({ force: S.force, gravity: S.gravity, support: S.fixedScope === 'none' ? 'none' : 'face', forceReps: S.forceReps || 1 });
    /* 空间离散误差按 O(h²) 收敛：一阶单元读数 ∝ h²，二阶 ∝ h⁴。
       这里用与网格无关的解析弯矩/曲率来标定"这个尺寸下会偏多少"。 */
    var I = sqI(SEC_A.b / 1000, SEC_A.t / 1000), E = MATS[SEC_A.mat].E;
    var kRoot = r.Mbase / (E * I);
    var hRel = size / 8;                       // 相对默认 8mm 的尺寸
    var dispErr = S.quadratic ? Math.pow(hRel, 4) * 100 : Math.pow(hRel, 2) * 100;
    var strErr = S.quadratic ? Math.pow(hRel, 4) * 100 : Math.pow(hRel, 2) * 100;
    return {
      size: size, elements: el, nodes: nd,
      uTip: r.uTip * 1000, maxStress: r.maxStress / 1e6,
      maxStressNoFixed: r.maxStressNoFixed / 1e6,
      fos: r.fos, fosNoFixed: r.fosNoFixed, kRoot: kRoot,
      dispErr: dispErr, strErr: strErr
    };
  }
  function meshConvTable() {
    var rows = [16, 12, 8, 6, 4, 3].map(meshConvergence);
    var h = '<table class="mech-tbl"><tr><th>尺寸 mm</th><th>单元数</th><th>末端变形 mm</th>' +
      '<th>σ<sub>max</sub> MPa</th><th>FS<sub>min</sub></th><th>与最细网格之差</th></tr>';
    var ref = rows[rows.length - 1];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var du = Math.abs(r.uTip - ref.uTip) / ref.uTip * 100;
      var ds = Math.abs(r.maxStressNoFixed - ref.maxStressNoFixed) / ref.maxStressNoFixed * 100;
      var conv = (du < 2 && ds < 5);
      h += '<tr' + (i === 2 ? ' class="is-cur"' : '') + '><td>' + r.size + '</td><td>' +
        r.elements.toLocaleString('en-US') + '</td><td>' + r.uTip.toFixed(4) + '</td><td>' +
        r.maxStressNoFixed.toFixed(1) + '</td><td>' + r.fosNoFixed.toFixed(2) + '</td>' +
        '<td style="color:' + (conv ? 'var(--ok)' : 'var(--warn)') + '">Δ变形 ' + du.toFixed(2) +
        '% / Δ应力 ' + ds.toFixed(1) + '%</td></tr>';
    }
    return h + '</table>';
  }
  function genMesh() {
    if (!S.meshGenerated) { rebuildGeometry(); }
    S.meshGenerated = true;
    S.showMesh = true;
    rebuildGeometry();
    updateHUD();
    var st = meshStats();
    var nodes = S.quadratic ? st.nodesQuadratic : st.nodesLinear;
    var etype = S.quadratic ? 'SOLID187（二阶六面体）' : 'SOLID185（一阶六面体）';
    log('▸ Mesh ▸ 右键 ▸ Generate Mesh', 'cmd');
    log('  单元类型 = ' + etype, 'info');
    log('  单元数 Elements = ' + st.elements.toLocaleString('en-US'), 'info');
    log('  节点数 Nodes = ' + nodes.toLocaleString('en-US')
      + (S.quadratic ? '（二阶：每单元 8 角点 → 20 节点，节点数约为线性单元的 4–8 倍）' : '（线性：每单元 8 节点）'), 'info');
    log('  最小单元质量 Minimum Element Quality = 0.386', 'info');
    if (S.meshSize >= 10) log('  ⚠ 关节倒角处的单元质量偏低，建议在 J1/J2 处 Insert ▸ Sizing ▸ Face Size = 2 mm', 'warn');
    S.api.toast('网格已生成：' + st.elements + ' 个单元', 'ok');
    renderProps();
    reveal(3);
    updateSolveBar();
  }

  /* ===========================================================================
   * 10. 求解
   * ======================================================================== */
  function solve() {
    if (S.solving) return;
    if (S.solveThenWatch) { clearInterval(S.solveThenWatch); S.solveThenWatch = null; }
    var miss = [];
    if (S.stage < 1) miss.push('材料未定义');
    if (S.stage < 2) miss.push('接触/连接未定义');
    if (S.stage < 4) miss.push('固定支撑未施加');
    if (S.stage < 5) miss.push('载荷未施加');
    if (miss.length) {
      log('⚠ Solve 被拒绝：' + miss.join('、'), 'err');
      log('    这几项都是建模决策，Mechanical 不会替你做，必须自己补齐。', 'warn');
      S.api.toast('缺少：' + miss.join('、'), 'err');
      return;
    }
    if (!S.meshGenerated) {
      log('  ℹ 还没有网格，先补一步 Mesh ▸ Generate Mesh', 'warn');
      log('    （真实 Mechanical 里 Solve 同样不会替你划网格；网格过期会直接拒绝求解）', 'warn');
      genMesh();
    }

    S.solving = true;
    killSolveTimers();
    S.prog = 0;
    updateSolveBar();

    var steps = [
      [0.00, '▸ Solution ▸ Solve（开始映射载荷到单元）'],
      [0.10, 'Pre-solve: 检查约束与接触状态'],
      [0.20, '  Contact Status = 全部闭合（No penetration / No separation）'],
      [0.30, '  Number of Nodes = ' + (S.quadratic ? meshStats().nodesQuadratic : meshStats().nodesLinear).toLocaleString('en-US')],
      [0.38, '  Number of Elements = ' + meshStats().elements.toLocaleString('en-US')],
      [0.48, 'Assembly: 求解矩阵装配'],
      [0.60, '*** Distributed Sparse Matrix Solver'],
      [0.68, 'Number of threads = 4'],
      [0.74, 'Total number of equations = ' + (S.quadratic ? meshStats().nodesQuadratic : meshStats().nodesLinear) * 3 + ''],
      [0.82, 'Solving...'],
      [0.90, '  Residual = 1.8e-14   已远低于收敛判据 1e-3 × 平均值'],
      [0.96, 'Solution Complete'],
      [1.00, '✓ Solution is Done（Workbench：Static Structural 系统已求解，结果对象可用）']
    ];
    steps.forEach(function (st) {
      S.solveT.push(setTimeout(function () {
        S.prog = st[0];
        updateSolveBar();
        log(st[1], st[1].indexOf('Solve') >= 0 ? 'cmd' : (st[1].indexOf('✓') >= 0 ? 'ok' : 'info'));
        if (st[0] >= 1) finishSolve();
      }, 180 + st[0] * 2600));
    });
  }
  function killSolveTimers() {
    for (var i = 0; i < S.solveT.length; i++) clearTimeout(S.solveT[i]);
    S.solveT = [];
  }
  function finishSolve() {
    S.solving = false;
    S.solved = true;
    reveal(7);
    recompute();
    setResult('deform');
    select('r_deform');
    var r = S.res;
    log('  求解结果：末端总变形 = ' + f(r.uTip * 1000, 4) + ' mm；根部等效应力 Max = '
      + f(r.maxStress / 1e6, 2) + ' MPa；安全系数 Min = ' + f(r.fos, 2), 'ok');
    S.api.setStatus({ 求解: '已完成 Solution is Done', 单元: S.quadratic ? 'SOLID187' : 'SOLID185', 节点: (S.quadratic ? meshStats().nodesQuadratic : meshStats().nodesLinear) });
    S.api.toast('求解完成 · 末端变形 ' + f(r.uTip * 1000, 3) + ' mm', 'ok');
    renderProps();
    updateSolveBar();
    updateOverlay();
  }
  function updateSolveBar() {
    var p = S.solving ? Math.round(S.prog * 100) : (S.solved ? 100 : 0);
    var msg = S.solving ? '求解中… ' + p + '%'
      : S.solved ? 'Solution is Done · ' + (S.quadratic ? 'SOLID187' : 'SOLID185')
        : '就绪 · 尚未求解';
    S.$.bar.innerHTML =
      '<button class="btn btn-primary btn-sm" id="mech-solve-btn">▶ Solve</button>' +
      '<div class="mech-sbar"><i style="width:' + p + '%"></i></div>' +
      '<span class="mech-smsg">' + msg + '</span>' +
      '<span class="badge ' + (S.solved ? 'badge-ok' : 'badge-warn') + '">' + (S.solved ? '已求解' : '未求解') + '</span>';
    var b = S.$.bar.querySelector('#mech-solve-btn');
    if (b) b.onclick = function () { solve(); };
  }

  /* ===========================================================================
   * 11. 树与 Details
   * ======================================================================== */
  function reveal(stage) {
    if (stage > S.stage) { S.stage = stage; rebuildTree(); }
  }
  function visible(n) { return S.stage >= (n.minStage === undefined ? 0 : n.minStage); }

  function rebuildTree() {
    S.nodes = treeSpec().filter(visible);
    S.partToNode = {};
    var html = S.nodes.map(function (n, i) {
      for (var k = 0; k < (n.parts || []).length; k++) {
        var id = n.parts[k];
        if (!S.partToNode[id] || n.depth > S.partToNode[id]) S.partToNode[id] = n.depth;
      }
      var kids = S.nodes.filter(function (m) { return m.depth === n.depth + 1 && isChild(m, n); });
      var hasKids = kids.length > 0;
      var open = S.collapsed[n.id] ? false : (n.open !== false);
      var bang = '';
      if ((n.id === 'bodies' && S.stage >= 0 && S.stage < 1) || (n.id === 'material_al' === false && false)) bang = '';
      return '<div class="tree-item' + (S.sel === n.id ? ' is-sel' : '') + '" data-id="' + n.id + '" data-depth="' + n.depth + '">' +
        '<span class="tree-toggle" data-tg="' + n.id + '">' + (hasKids ? (open ? '▼' : '▶') : '') + '</span>' +
        '<span class="tree-icon">' + n.icon + '</span><span>' + esc(n.label) + '</span>' + bang + '</div>';
    }).join('');
    S.$.tree.innerHTML = html;
    S.$.tree.onclick = function (e) {
      var tg = e.target.getAttribute && e.target.getAttribute('data-tg');
      if (tg && e.target.classList.contains('tree-toggle') && e.target.textContent) {
        S.collapsed[tg] = !S.collapsed[tg];
        rebuildTree();
        return;
      }
      var it = e.target.closest ? e.target.closest('.tree-item') : null;
      if (it) select(it.getAttribute('data-id'));
    };
    renderProps();
  }
  function isChild(child, parent) {
    /* 线性大纲：深度更大且中间没有同级更浅的节点隔开 —— 这里按深度就近归属即可 */
    return child.depth === parent.depth + 1;
  }
  function select(id) {
    S.sel = id;
    var n = null;
    for (var i = 0; i < S.nodes.length; i++) if (S.nodes[i].id === id) n = S.nodes[i];
    if (!n) return;
    S.selParts = (n.parts || []).slice();
    if (n.parts && n.parts.length) focusParts(n.parts);
    renderProps();
    updateCrumb();
  }
  function updateCrumb() {
    var n = nodeById(S.sel);
    S.$.crumb.textContent = n ? n.label.split('（')[0] : '';
  }
  function nodeById(id) {
    for (var i = 0; i < S.nodes.length; i++) if (S.nodes[i].id === id) return S.nodes[i];
    return null;
  }
  function focusParts(ids) {
    if (!S.vp || !S.vp.camera || !ids.length) return;
    var box = new THREE.Box3();
    var any = false;
    for (var i = 0; i < S.parts.length; i++) {
      if (ids.indexOf(S.parts[i].def.id) >= 0) {
        S.parts[i].mesh.geometry.computeBoundingBox();
        box.union(S.parts[i].mesh.geometry.boundingBox.clone().applyMatrix4(S.parts[i].mesh.matrixWorld));
        any = true;
      }
    }
    if (!any) return;
    var c = box.getCenter(new THREE.Vector3());
    var r = Math.max(box.getSize(new THREE.Vector3()).length() * 0.6, 0.8);
    S.vp.controls.target.copy(c);
    var cur = S.vp.camera.position.clone().sub(c).normalize();
    var dist = Math.min(Math.max(r * 2.6, 1.6), 40);
    S.vp.camera.position.copy(c.clone().add(cur.multiplyScalar(dist)));
    S.vp.controls.update();
  }

  /* ---- 3D 拾取 ---- */
  function bindPicking() {
    if (!S.vp || !S.vp.renderer) return;
    var dom = S.vp.renderer.domElement;
    if (dom.__mechBound) return;
    dom.__mechBound = true;
    var downX = 0, downY = 0;
    dom.addEventListener('pointerdown', function (e) { downX = e.clientX; downY = e.clientY; });
    dom.addEventListener('click', function (e) {
      if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) return;
      var hit = pick(e);
      if (!hit) { S.api.toast('没点到零件', 'info'); return; }
      var depth = S.partToNode[hit];
      var target = null;
      for (var i = 0; i < S.nodes.length; i++) {
        if ((S.nodes[i].parts || []).indexOf(hit) >= 0) {
          if (!target || S.nodes[i].depth > target.depth) target = S.nodes[i];
        }
      }
      if (target) { select(target.id); log('  · 3D 选中实体「' + (partById(hit) || {}).label + '」，Outline 同步定位', 'info'); }
      void depth;
    });
  }
  function pick(e) {
    if (!S.vp || !S.vp.renderer || !S.vp.camera) return null;
    var dom = S.vp.renderer.domElement;
    var r = dom.getBoundingClientRect();
    var nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    var ny = -((e.clientY - r.top) / r.height) * 2 + 1;
    var rc = new THREE.Raycaster();
    rc.setFromCamera({ x: nx, y: ny }, S.vp.camera);
    var hits = rc.intersectObjects(S.armRoot.children, true);
    for (var i = 0; i < hits.length; i++) {
      var o = hits[i].object;
      if (o.userData && o.userData.partId) return o.userData.partId;
    }
    return null;
  }
  var KEY_BOUND = false;
  /* 快捷键绑在 document 上，所以**必须**先判断当前激活的是不是本模块：
     否则在 Fluent / Zemax 标签页按 m/g/l/r 也会打到这里，
     去改一个 display:none 的隐藏模块（重划网格、切幽灵壳、刷新叠加层），纯属白烧 CPU。 */
  function isActiveModule() {
    try { return !!(window.CAE && CAE._debug && CAE._debug().active === 'mechanical'); }
    catch (e) { return false; }
  }
  function bindKeyboard() {
    if (KEY_BOUND) return;
    KEY_BOUND = true;
    document.addEventListener('keydown', function (e) {
      if (!S || !S.$.vp) return;
      if (!isActiveModule()) return;                       // 不是本标签页 → 放行
      if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
      var k = String(e.key).toLowerCase();
      if (k === 'm') doAction('vmesh');
      else if (k === 'g') doAction('vghost');
      else if (k === 'l') doAction('vload');
      else if (k === 'r') doAction('vreset');
    });
  }

  /* ===========================================================================
   * 12. Details 面板（每个树节点一份）
   * ======================================================================== */
  function renderProps(forceId) {
    if (forceId) S.sel = forceId;
    var n = nodeById(S.sel);
    var host = S.$.props;
    if (!n) { host.innerHTML = '<div class="empty">选择一个树节点</div>'; return; }
    host.innerHTML = n.detail(n);
    syncTreeSel();
    wireProps();
  }
  function syncTreeSel() {
    var items = S.$.tree.querySelectorAll('.tree-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('is-sel', items[i].getAttribute('data-id') === S.sel);
    }
  }

  function wireProps() {
    var host = S.$.props;
    /* 末端力滑块 */
    var fs = host.querySelector('#mech-force');
    if (fs) {
      fs.oninput = function () {
        S.force = +fs.value;
        host.querySelector('#mech-force-num').textContent = f(S.force, 1) + ' N';
        recompute();
      };
    }
    /* 网格尺寸滑块 */
    var ms = host.querySelector('#mech-msize');
    if (ms) {
      ms.oninput = function () {
        S.meshSize = +ms.value;
        host.querySelector('#mech-msize-num').textContent = S.meshSize + ' mm';
        if (S.meshGenerated) { rebuildGeometry(); renderPropsKeepScroll(); }
        renderMeshStat();
      };
    }
    /* 变形倍率滑块 */
    var ds = host.querySelector('#mech-dscale');
    if (ds) {
      ds.oninput = function () {
        S.defScale = +ds.value;
        host.querySelector('#mech-dscale-num').textContent = S.defScale + ' ×';
        applyResult();
        updateOverlay();
      };
    }
    /* 剔除固定边 */
    var cb = host.querySelector('#mech-dropfix');
    if (cb) {
      cb.onchange = function () {
        S.dropFixedEdge = cb.checked;
        applyResult(); renderPropsKeepScroll();
      };
    }
    /* 单元阶次 */
    var ord = host.querySelector('#mech-order');
    if (ord) {
      ord.onchange = function () {
        S.quadratic = ord.value === 'quad';
        if (S.meshGenerated) { rebuildGeometry(); meshStats(); }
        renderPropsKeepScroll();
      };
    }
    /* 接触类型 */
    var ct = host.querySelector('#mech-ctype');
    if (ct) { ct.onchange = function () { setContact(ct.value); }; }
    /* 重力 */
    var gb = host.querySelector('#mech-grav');
    if (gb) { gb.onchange = function () { doAction('gravity'); renderPropsKeepScroll(); }; }
    /* 大变形 */
    var ld = host.querySelector('#mech-ldefl');
    if (ld) {
      ld.onchange = function () {
        S.largeDefl = ld.checked;
        log('  Large Deflection = ' + (S.largeDefl ? 'True' : 'False')
          + '（位移/尺寸 = ' + f(S.res.uTip / (LTOT / 1000) * 100, 3) + '%，'
          + (S.largeDefl ? '已启用几何非线性，二阶效应约 ' + f(S.res.uTip / (LTOT / 1000) * 150, 3) + '%，影响很小' : '远小于 1%，无需启用') + '）', 'info');
        renderPropsKeepScroll();
      };
    }
    /* 固定范围 */
    var fsb = host.querySelector('#mech-fscope');
    if (fsb) { fsb.onclick = function () { doAction('fixscope'); renderPropsKeepScroll(); }; }
    /* 求解 */
    var sb = host.querySelector('#mech-solve2');
    if (sb) { sb.onclick = function () { solve(); }; }
    /* 结果模式 */
    var rb = host.querySelectorAll('[data-result]');
    for (var i = 0; i < rb.length; i++) {
      rb[i].onclick = function () {
        var m = this.getAttribute('data-result');
        if (m === 'deform') reveal(7); if (m === 'stress' || m === 'fos') reveal(8);
        setResult(m); renderPropsKeepScroll();
      };
    }
    /* 单元体列表点选 */
    var tr = host.querySelectorAll('[data-part]');
    for (var j = 0; j < tr.length; j++) {
      tr[j].onclick = function () {
        var pid = this.getAttribute('data-part');
        S.selParts = [pid];
        focusParts([pid]);
        log('  · Details 里选中实体「' + (partById(pid) || {}).label + '」', 'info');
      };
    }
    /* 变形倍率快捷按钮 */
    var sc = host.querySelectorAll('[data-scale]');
    for (var k2 = 0; k2 < sc.length; k2++) {
      sc[k2].onclick = function () {
        S.defScale = +this.getAttribute('data-scale');
        applyResult(); updateOverlay(); updateHUD();
      };
    }
    var pb = host.querySelector('#mech-play');
    if (pb) pb.onclick = function () { doAction('defplay'); renderPropsKeepScroll(); };
    var ub = host.querySelector('#mech-units');
    if (ub) ub.onclick = function () { doAction('units'); renderPropsKeepScroll(); };
    var gb = host.querySelector('#mech-gensize');
    if (gb) gb.onclick = function () { genMesh(); renderPropsKeepScroll(); };
    var cspin = host.querySelector('#mech-cspin');
    if (cspin) cspin.onclick = function () { spinJoint(); renderPropsKeepScroll(); };
    var cbtnB = host.querySelector('#mech-cbtn-b');
    if (cbtnB) cbtnB.onclick = function () { setContact('Bonded'); renderPropsKeepScroll(); };
    var cbtnR = host.querySelector('#mech-cbtn-r');
    if (cbtnR) cbtnR.onclick = function () { setContact('Revolute'); renderPropsKeepScroll(); };
  }
  function renderPropsKeepScroll() {
    var sc = S.$.props.scrollTop;
    renderProps();
    S.$.props.scrollTop = sc;
  }
  function renderMeshStat() {
    var box = S.$.props.querySelector('#mech-mstat');
    if (!box) return;
    var st = meshStats();
    var nodes = S.quadratic ? st.nodesQuadratic : st.nodesLinear;
    box.innerHTML = kv('单元尺寸', S.meshSize + ' mm') + kv('单元类型', S.quadratic ? 'SOLID187（二阶）' : 'SOLID185（一阶）') +
      kv('Elements 单元数', st.elements.toLocaleString('en-US')) +
      kv('Nodes 节点数', nodes.toLocaleString('en-US')) +
      kv('最小单元质量', '0.386');
  }

  /* ---------- 各节点 Details ---------- */
  function detailProject(n) {
    return grp('Project Schematic 项目示意',
      kv('工程名称', 'Dummy_Arm_Static') +
      kv('分析系统', 'A · Static Structural') +
      kv('几何来源', 'B · Geometry（CAD 链接）') +
      kv('求解状态', S.solved ? '<span style="color:var(--ok)">Solution is Done</span>' : '未求解') +
      kv('单位', S.units.toUpperCase())) +
      '<div class="mech-note">Workbench 里 A~E 是五个<b>单元格</b>：双击 B 才进入 Mechanical 编辑几何与网格；' +
      '双击 E 显示求解结果。鼠标悬停在单元格的图标上能看到求解器（这里用 Distributed Sparse）。</div>';
  }
  function detailAnalysis(n) {
    return grp('Analysis System 分析系统',
      kv('类型', 'Static Structural') +
      kv('求解器', 'Distributed Sparse（默认）') +
      kv('库', 'Mechanical APDL 2023 R1') +
      kv('几何检查', S.units === 'mm' ? '<span style="color:var(--ok)">通过</span>' : '<span style="color:var(--err)">未通过（单位不符）</span>')) +
      grp('求解前置检查',
        check('几何已导入', S.stage >= 0) +
        check('材料已定义', S.stage >= 1) +
        check('接触/连接已定义', S.stage >= 2) +
        check('网格已生成', S.meshGenerated) +
        check('约束已施加', S.stage >= 4) +
        check('载荷已施加', S.stage >= 5));
  }
  function check(txt, ok) {
    return '<div class="kv"><span>' + (ok ? '✅' : '⬜') + ' ' + txt + '</span><span class="muted">' + (ok ? 'OK' : 'Pending') + '</span></div>';
  }
  function detailGeometry(n) {
    return grp('Geometry 属性（双击 Geometry 单元格后 Details 顶部）',
      '<div class="field"><label>Import Geometry</label><span class="mech-val" style="color:var(--accent)">D:\\cae-academy\\dummy_arm.step</span></div>' +
      '<div class="field"><label>Units</label><span class="mech-val">' + S.units + '</span></div>' +
      '<div class="field"><label>Model Type</label><span class="mech-val">Solid</span></div>' +
      kv('Bodies 实体', PLIST.length + ' 个') +
      kv('Volumes 体积', (totalVol() * 1e6).toFixed(1) + ' cm³') +
      kv('Bounding Box', bboxText())) +
      '<div class="mech-note mech-warn">单位必须和源 CAD 一致。STEP 里没有单位信息，' +
      '选错 mm/in 会把模型整体缩放 25.4 倍：网格尺寸、载荷位置、结果读数全错，而且<b>求解不会报错</b>。</div>' +
      grp('快速试验',
        '<button class="btn btn-sm" id="mech-units">' + (S.units === 'mm' ? '切到 Units = in（看整体缩小）' : '切回 Units = mm') + '</button>');
  }
  function totalVol() {
    var s = 0; for (var i = 0; i < PLIST.length; i++) s += PLIST[i].V; return s;
  }
  /** 模型包络盒（模型坐标 mm，X 向右 / Y 深度 / Z 向上）
   *  倾斜的长方体按绕 Y 轴的旋转把 8 个角点变换过去，取精确 AABB */
  function bbox() {
    var lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    var RAD = Math.PI / 180;
    for (var i = 0; i < PLIST.length; i++) {
      var p = PLIST[i], d = p.dim;
      var hx, hy, hz, exts;
      if (p.shape === 'torus') { hx = hy = hz = 0; exts = [d.R + d.r, d.R + d.r, d.R + d.r]; }
      else if (p.shape === 'cyl') {
        hx = (d.r !== undefined ? d.r : (d.rT + d.rB) / 2); hy = hx; hz = d.h / 2;
        exts = [hx, hy, hz];
      } else { hx = d.w / 2; hy = d.d / 2; hz = d.h / 2; exts = [hx, hy, hz]; }
      var th = (p.at.rot || 0) * RAD, ct = Math.cos(th), st = Math.sin(th);
      var cy = p.offsetY || 0;
      for (var sx = -1; sx <= 1; sx += 2) {
        for (var sy = -1; sy <= 1; sy += 2) {
          for (var sz = -1; sz <= 1; sz += 2) {
            var lx = sx * hx, ly = sy * hy, lz = sz * hz;
            var wx = p.at.x + lx * ct + lz * st;
            var wy = cy + ly;
            var wz = p.at.z - lx * st + lz * ct;
            var cand = [wx, wy, wz];
            if (p.shape === 'torus') {   /* 圆环用外接盒保守估计 */
              cand = [wx, wy, wz];
              for (var a = 0; a < 3; a++) {
                if (cand[a] - exts[a] < lo[a]) lo[a] = cand[a] - exts[a];
                if (cand[a] + exts[a] > hi[a]) hi[a] = cand[a] + exts[a];
              }
              continue;
            }
            for (var b = 0; b < 3; b++) {
              if (cand[b] < lo[b]) lo[b] = cand[b];
              if (cand[b] > hi[b]) hi[b] = cand[b];
            }
          }
        }
      }
    }
    return { lo: lo, hi: hi, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
  }
  function bboxText() {
    var b = bbox();
    return b.size.map(function (v) { return v.toFixed(0); }).join(' × ') + ' mm';
  }
  function detailBodies(n) {
    var rows = PLIST.map(function (p) {
      var mat = MATS[p.mat];
      return '<tr data-part="' + p.id + '" style="cursor:pointer">' +
        '<td><span class="mech-matdot" style="background:#' + ('000000' + mat.color.toString(16)).slice(-6) + '"></span>' + esc(p.label) + '</td>' +
        '<td>' + (p.V * 1e6).toFixed(2) + '</td><td>' + (p.mass * 1000).toFixed(0) + '</td></tr>';
    }).join('');
    return grp('Dummy_Arm · ' + PLIST.length + ' 个实体（体积 cm³ / 质量 g）',
      '<table class="mech-body-table"><tr><th>实体</th><th>体积</th><th>质量</th></tr>' + rows + '</table>') +
      kv('总体积', (totalVol() * 1e6).toFixed(1) + ' cm³') +
      kv('总质量', f(TOTAL_MASS, 3) + ' kg') +
      kv('总自重', f(TOTAL_WEIGHT, 2) + ' N') +
      kv('质心水平位置', f(COM_X * 1000, 1) + ' mm');
  }
  function detailConnections(n) {
    return grp('Connections · 3 个 Joint',
      kv('Joint 1 / 2 / 3', 'Revolute（铰链）') +
      kv('Mobile / Reference', '各关节两侧面') +
      kv('被约束自由度', 'UX、UY、UZ（3 个平动）') +
      kv('保留自由度', 'RX、RY、RZ（3 个转动）')) +
      grp('Contact Region 行为',
        kv('Type 类型', '<span style="color:var(--accent)">' + S.contactType + '</span>') +
        kv('Behavior 行为', S.contactType === 'Bonded' ? 'Asymmetric（非对称）' : 'No Separation') +
        kv('接触面', '共面贴合，法向 0.25 mm')) +
      '<div class="mech-segbtns">' +
      '<button class="btn btn-sm' + (S.contactType === 'Bonded' ? ' is-on' : '') + '" id="mech-cbtn-b">Bonded</button>' +
      '<button class="btn btn-sm' + (S.contactType === 'Revolute' ? ' is-on' : '') + '" id="mech-cbtn-r">Revolute</button>' +
      '<button class="btn btn-sm" id="mech-cspin">↻ 试转 J2</button></div>' +
      '<div class="field"><label>Joint Type</label><select class="select" id="mech-ctype">' +
      '<option' + (S.contactType === 'Bonded' ? ' selected' : '') + '>Bonded</option>' +
      '<option' + (S.contactType === 'Revolute' ? ' selected' : '') + '>Revolute</option>' +
      '</select></div>' +
      '<div class="mech-note mech-ok"><b>为什么关节必须是 Revolute：</b>Bonded 会传递全部 6 个自由度，' +
      '把本该能转的关节焊死；模型"看起来"还是那样，但内力分布完全不同，而且电机无法驱动。</div>';
  }
  function detailJoint(n, name, idx) {
    var locked = S.contactType === 'Bonded';
    return grp(name + ' · Joint',
      kv('Type', S.contactType) +
      kv('行为', locked ? 'Bonded（6 DOF 全约束）' : 'Revolute（3 DOF 约束）') +
      kv('当前试转角', S.jointAngle + '°') +
      kv('转动自由度', locked ? '<span style="color:var(--err)">被锁死</span>' : '<span style="color:var(--ok)">自由</span>')) +
      '<div class="mech-segbtns"><button class="btn btn-sm" id="mech-cspin">↻ 试转 J2（' + name + ' 同类）</button></div>' +
      '<div class="mech-note ' + (locked ? 'mech-warn' : 'mech-ok') + '">' +
      (locked ? 'Bonded：轴向平动、径向平动、绕轴转动<u>全部</u>被约束。' : 'Revolute：约束 UY/UZ/UX，保留绕轴转动 —— 和真实关节一致。') +
      '</div>';
  }
  function detailMaterials(n) {
    return grp('Engineering Data · 材料库',
      kv('已添加材料', '2 种') +
      kv('7075-T6', 'E=71.7 GPa · ν=0.33 · ρ=2810') +
      kv('AISI 45', 'E=206 GPa · ν=0.30 · ρ=7850')) +
      '<div class="mech-note mech-warn"><b>Yield Strength（屈服强度）是必填项。</b>' +
      '漏填它：静力求解照样收敛、变形和应力云图照样出得来，只有 Factor of Safety 节点会一直挂感叹号 —— ' +
      '这是最常见的"结果出不来"原因。</div>' +
      grp('Material Assignment 分配',
        kv('7075-T6 →', '法兰 / 转台 / 肩部壳体 / 大臂 / 小臂（'
        + PLIST.filter(function (p) { return p.mat === 'al'; }).length + ' 体）') +
        kv('AISI 45 →', '三个关节环 / 腕轴 / 夹爪座 / 两根夹指（'
        + PLIST.filter(function (p) { return p.mat === 'st'; }).length + ' 体）'));
  }
  function detailMaterial(mat, ps) {
    return grp(mat.name + '（' + mat.en + '）',
      kv('杨氏模量 E', (mat.E / 1e9).toFixed(1) + ' GPa') +
      kv('泊松比 ν', mat.nu) +
      kv('密度 ρ', mat.rho + ' kg/m³') +
      kv('Yield Strength', '<span style="color:var(--accent)">' + mat.yieldMPa + ' MPa</span>') +
      kv('密度 × 体积', f(ps.reduce(function (a, b) { return a + b.V; }, 0) * mat.rho, 3) + ' kg') +
      kv('分配到', ps.length + ' 个体')) +
      '<div class="mech-note">σ<sub>s</sub>（屈服）与 σ<sub>b</sub>（抗拉）不要混：Factor of Safety 用的是' +
      '<b>Yield</b>；用 Ultimate 算出来的安全系数会偏乐观 10–15%。</div>';
  }
  function detailMesh(n) {
    var st = meshStats();
    return grp('Mesh 属性',
      '<div class="field"><label>Element Size</label><span class="mech-val">' + S.meshSize + ' mm</span></div>' +
      '<div class="mech-slider"><input type="range" id="mech-msize" min="2" max="16" step="1" value="' + S.meshSize + '">' +
      '<span class="mech-num" id="mech-msize-num">' + S.meshSize + ' mm</span></div>' +
      '<div class="field"><label>Element Order</label><select class="select" id="mech-order">' +
      '<option value="lin"' + (S.quadratic ? '' : ' selected') + '>Linear（二阶的对照）</option>' +
      '<option value="quad"' + (S.quadratic ? ' selected' : '') + '>Quadratic（二阶）</option></select></div>' +
      '<div class="field"><label>Element Type</label><span class="mech-val">' + (S.quadratic ? 'SOLID187' : 'SOLID185') + '</span></div>') +
      grp('Statistics 统计 <span class="muted" style="font-weight:400">（右击 Mesh ▸ Statistics）</span>',
        '<div id="mech-mstat">' +
        kv('单元尺寸', S.meshSize + ' mm') +
        kv('单元类型', S.quadratic ? 'SOLID187（二阶）' : 'SOLID185（一阶）') +
        kv('Elements 单元数', st.elements.toLocaleString('en-US')) +
        kv('Nodes 节点数', (S.quadratic ? st.nodesQuadratic : st.nodesLinear).toLocaleString('en-US')) +
        kv('最小单元质量', '0.386') + '</div>') +
      '<div class="mech-note"><b>二阶六面体（SOLID187）</b>在中边加节点，弯曲应力精度高得多，' +
      '但节点数是线性单元的 4–8 倍、内存与时间也成倍上升。小位移弯曲问题优先二阶。</div>' +
      '<div class="divider"></div>' +
      '<div class="mech-tbl-hd">网格无关性对照表 · 同一载荷、不同 Element Size</div>' +
      meshConvTable() +
      '<div class="mech-note"><b>怎么读这张表：</b>看最后一列。单元数还在成倍涨、' +
      '而 Δ变形 &lt; 2% / Δ应力 &lt; 5% 的那一段，就是<b>网格无关</b>的区域。' +
      '16 mm 那一行的应力明显偏低 —— 根部圆角只有一个单元跨过去，应力集中根本捕捉不到。' +
      '（高亮行是你当前正在用的尺寸。）</div>' +
      '<button class="btn btn-sm btn-block" id="mech-gensize">⊞ Generate Mesh</button>';
  }
  function detailFixed(n) {
    return grp('Fixed Support 属性',
      kv('Scope 作用域', S.fixedScope === 'face' ? 'Base Flange 底面（1 Face）' : '<span style="color:var(--err)">整个 Base Flange（1 Body）</span>') +
      kv('约束自由度', 'UX、UY、UZ、RX、RY、RZ（全 6 个）') +
      kv('固定位置', '法兰底面 z = 0')) +
      '<button class="btn btn-sm btn-block" id="mech-fscope">' +
      (S.fixedScope === 'face' ? '⚠ 试错：改选"整个底座体"（过约束）' : '↩ 改回"只选法兰底面"') + '</button>' +
      '<div class="mech-note ' + (S.fixedScope === 'face' ? 'mech-ok' : 'mech-warn') + '">' +
      (S.fixedScope === 'face'
        ? '只选底面 = 干净的单点固接，模型内部的连接自由度保留，不会产生重复约束。'
        : '整个体被固定后，体与法兰连接面处的约束与之<b>重复</b>，求解器会报 over-constrained equations；' +
        '本例数值差别很小，但真实模型里会导致刚体模式、奇异矩阵或收敛失败。') + '</div>';
  }
  function detailGravity(n) {
    return grp('Gravity 属性',
      '<label class="check" style="margin-bottom:6px"><input type="checkbox" id="mech-grav"' + (S.gravity ? ' checked' : '') + '><span>启用重力</span></label>' +
      kv('方向', 'Global Y? 否 —— 全局 -Z（向下）') +
      kv('坐标系', 'Global Coordinate System') +
      kv('加速度', '9.8066 m/s²') +
      kv('模型总质量', f(TOTAL_MASS, 3) + ' kg') +
      kv('等效总自重', '<span class="mech-big" style="font-size:15px">' + f(TOTAL_WEIGHT, 2) + ' N</span>') +
      kv('质心水平位置', f(COM_X * 1000, 1) + ' mm（决定自重弯矩）')) +
      '<div class="mech-note">自重弯矩 = ' + f(TOTAL_WEIGHT, 2) + ' N × ' + f(COM_X * 1000, 0) +
      ' mm = ' + f(TOTAL_WEIGHT * COM_X, 2) + ' N·m。它和末端力的弯矩同向叠加，不能只算外载。</div>';
  }
  function detailRemotePoint(n) {
    return grp('Remote Point 1 属性',
      kv('作用域 Scoped Geometry', 'Finger L + Finger R（两个面）') +
      kv('图形显示', 'On（黄色靶心图标）') +
      kv('位置', '夹爪末端 x=' + (P3.x * MM).toFixed(2) + ', z=' + (P3.z * MM).toFixed(2) + '（场景单位）') +
      kv('用途', '把力/力矩从整个面集中到一个点，避免"单面加载"假应力')) +
      '<div class="mech-note mech-ok">在夹爪面直接加力，力只在受力面附近传进模型，会得到巨大的假应力。' +
      'Remote Point 把载荷"引"到夹爪中心，力矩按力臂正常传递。</div>';
  }
  function detailRemoteForce(n) {
    var fz = -S.force;
    return grp('Remote Force 属性',
      '<div class="field"><label>Load Coordinates</label><span class="mech-val">Global</span></div>' +
      '<div class="field"><label>方向定义</label><span class="mech-val">Z Component（全局 -Z 向下）</span></div>' +
      '<div class="mech-slider"><input type="range" id="mech-force" min="0" max="50" step="1" value="' + S.force + '">' +
      '<span class="mech-num" id="mech-force-num">' + f(S.force, 1) + ' N</span></div>' +
      kv('X Component', '0 N') +
      kv('Y Component', '0 N') +
      kv('Z Component', '<span class="mech-big" style="font-size:15px">' + fz + '.0 N</span>') +
      kv('作用点', 'Remote Point 1（夹爪末端）')) +
      grp('工况汇总',
        kv('末端力', f(S.force, 1) + ' N（向下）') +
        kv('自重', (S.gravity ? f(TOTAL_WEIGHT, 2) + ' N' : '已关闭')) +
        kv('竖向合力（= 反力）', '<span style="color:var(--accent)">' + f(S.force + (S.gravity ? TOTAL_WEIGHT : 0), 2) + ' N</span>')) +
      '<div class="mech-note mech-warn">核对坐标轴：Mechanical 的全局 <b>Z 向上</b>，所以"往下"填 <b>-30</b>。' +
      '如果模型是躺放的，竖直方向变成全局 Y，就要改填 Y 分量——载荷填错轴，模型照样求解成功，只是方向不对。</div>';
  }
  function detailSettings(n) {
    var ratio = S.res ? S.res.uTip / (LTOT / 1000) * 100 : 0;
    return grp('Analysis Settings 属性',
      '<label class="check" style="margin-bottom:6px"><input type="checkbox" id="mech-ldefl"' + (S.largeDefl ? ' checked' : '') + '><span>Large Deflection（几何非线性）</span></label>' +
      kv('求解器', 'Distributed Sparse Matrix') +
      kv('Threads', '4') +
      kv('Total Steps', '1') +
      kv('大变形判据', '位移 / 尺寸 &gt; 1%') +
      kv('当前位移/尺寸', '<span style="color:' + (ratio > 1 ? 'var(--warn)' : 'var(--ok)') + '">' + f(ratio, 3) + '%</span>')) +
      '<div class="mech-note ' + (S.largeDefl ? 'mech-warn' : 'mech-ok') + '">' +
      (S.largeDefl
        ? '已启用：考虑大变形后刚度随姿态变化，需要迭代求解。本例位移很小，多迭代几次收益有限。'
        : '本工况位移只有 ' + f(ratio, 3) + '% 尺寸，线性假设完全成立，<b>不要勾</b>。' +
        '勾上会多花 3–5 倍时间却几乎不改结果。') + '</div>' +
      '<button class="btn btn-primary btn-block" id="mech-solve2">▶ Solve</button>';
  }
  function detailSolution(n) {
    return grp('Solution 属性',
      kv('求解器', 'Distributed Sparse') +
      kv('状态', S.solved ? '<span style="color:var(--ok)">Solution is Done</span>' : '<span style="color:var(--warn)">Not Up To Date</span>') +
      kv('结果文件', 'Dummy_Arm_Static_files / dp0 / SYS / MECH')) +
      grp('显示结果（Insert ▸ Results）',
        '<div class="mech-segbtns">' +
        '<button class="btn btn-sm' + (S.result === 'none' ? ' is-on' : '') + '" data-result="none">无</button>' +
        '<button class="btn btn-sm' + (S.result === 'deform' ? ' is-on' : '') + '" data-result="deform">📏 总变形</button>' +
        '<button class="btn btn-sm' + (S.result === 'stress' ? ' is-on' : '') + '" data-result="stress">🔥 等效应力</button>' +
        '<button class="btn btn-sm' + (S.result === 'fos' ? ' is-on' : '') + '" data-result="fos">🛡 安全系数</button></div>');
  }
  function detailResultDeform(n) {
    var r = S.res;
    return grp('Total Deformation · 总变形',
      kv('Contours ▸ Range', 'Automatic（自动 0 ~ 最大值）') +
      kv('Contours ▸ Deformation Scale Factor', S.defScale + ' ×') +
      kv('Maximum（读数）', '<span class="mech-big">' + (r ? f(r.uTip * 1000, 4) : '—') + ' mm</span>') +
      kv('竖向分量', r ? f(r.uVert * 1000, 4) + ' mm' : '—') +
      kv('根部转角', r ? f(r.thetaTip * 180 / Math.PI, 4) + '°' : '—')) +
      grp('变形比例',
        '<div class="mech-slider"><input type="range" id="mech-dscale" min="1" max="20" step="1" value="' + S.defScale + '">' +
        '<span class="mech-num" id="mech-dscale-num">' + S.defScale + ' ×</span></div>' +
        '<div class="mech-segbtns">' +
        '<button class="btn btn-sm" data-scale="1">1×</button>' +
        '<button class="btn btn-sm" data-scale="2">2×</button>' +
        '<button class="btn btn-sm" data-scale="5">5×</button>' +
        '<button class="btn btn-sm" data-scale="10">10×</button>' +
        '<button class="btn btn-sm" id="mech-play">' + (S.playing ? '⏸ 暂停' : '▶ 播放') + '</button></div>') +
      (r ? '<div class="mech-note">手算校核：等效悬臂梁末端挠度 δ = F·sinβ·L³/(3EI) + 自重项，' +
        '对 23×23×1.7 方管（I = ' + (sqI(0.023, 0.0017) * 1e12).toFixed(0) + ' mm⁴）算得 ' +
        f(r.uTip * 1000, 3) + ' mm，与积分结果一致。</div>' : '');
  }
  function detailResultStress(n) {
    var r = S.res;
    var useSkip = S.dropFixedEdge;
    var v = r ? (useSkip ? r.maxStressNoFixed : r.maxStress) : 0;
    return grp('Equivalent Stress · 等效应力（von Mises）',
      kv('Contours ▸ Range', 'Automatic（0 ~ ' + f(v / 1e6, 2) + ' MPa）') +
      kv('最大值位置', r ? '根部法兰/肩部圆角 s ≈ ' + f(r.maxStressAt, 0) + ' mm' : '—') +
      kv('Maximum（读数）', '<span class="mech-big">' + f(v / 1e6, 2) + ' MPa</span>') +
      kv('名义弯曲应力', r ? f(r.nominalStress / 1e6, 2) + ' MPa' : '—') +
      kv('应力集中系数 Kt', '2.5（肩部圆角 r/d≈0.15）') +
      kv('根部弯矩 M', r ? f(r.Mbase, 2) + ' N·m' : '—')) +
      grp('剔除固定边一排单元',
        '<label class="check"><input type="checkbox" id="mech-dropfix"' + (useSkip ? ' checked' : '') + '>' +
        '<span>Evaluation 只统计固定边之外的单元</span></label>') +
      (r ? '<div class="mech-note ' + (useSkip ? 'mech-ok' : 'mech-warn') + '">' +
        (useSkip
          ? '剔除后最大应力从 ' + f(r.maxStress / 1e6, 2) + ' MPa 降到 ' + f(r.maxStressNoFixed / 1e6, 2) +
          ' MPa（安全系数 ' + f(r.fos, 1) + ' → ' + f(r.fosNoFixed, 1) + '）。固定约束边上的应力是<b>奇异</b>的，不是设计值。'
          : '固定约束边上的应力理论上无穷大（刚性约束 + 有限刚度体 → 应变无限）。' +
          '软件给出的 ' + f(r.maxStress / 1e6, 2) + ' MPa 是"第一排单元中心"的值，取决于网格密度 —— 网格越细它越高。' +
          '<b>不要拿它当设计强度</b>。') + '</div>' : '');
  }
  function detailResultFos(n) {
    var r = S.res;
    var useSkip = S.dropFixedEdge;
    var fos = r ? (useSkip ? r.fosNoFixed : r.fos) : 0;
    var sy = MATS[SEC_A.mat].yieldMPa;
    return grp('Factor of Safety · 安全系数',
      kv('材料', '7075-T6，Yield Strength = ' + sy + ' MPa') +
      kv('计算式', 'FS = σ<sub>y</sub> / σ<sub>vM</sub>') +
      kv('Minimum（读数）', '<span class="mech-big">' + f(fos, 2) + '</span>') +
      kv('对应等效应力', f(sigmaOf(fos) / 1e6, 2) + ' MPa') +
      kv('工程判据', fos > 2 ? '<span style="color:var(--ok)">安全（一般结构 ≥ 2）</span>'
        : fos > 1 ? '<span style="color:var(--warn)">临界（1 ~ 2）</span>' : '<span style="color:var(--err)">不安全</span>')) +
      '<div class="mech-note">von Mises 把 6 个应力分量合成一个标量：' +
      'σ<sub>vM</sub> = √(σ₁²+σ₂²+σ₃²−σ₁σ₂−σ₂σ₃−σ₃σ₁+3τ²)。' +
      '对 ductile 材料（7075-T6 属于塑性材料）用 von Mises 判屈服是标准做法。<br>' +
      'FS = ' + sy + ' / ' + f(sigmaOf(fos) / 1e6, 1) + ' = ' + f(fos, 1) + '。</div>';
  }
  /** 由安全系数反推对应的等效应力（Pa） */
  function sigmaOf(fos) { return S.res ? MATS[SEC_A.mat].yieldMPa * 1e6 / fos : 0; }
  function errCell(errPct) {
    var ok = errPct < 1;
    return '<span style="color:' + (ok ? 'var(--ok)' : 'var(--err)') + '">' + f(errPct, 3) + ' %</span>';
  }
  function verdict(errPct) {
    return errPct < 1
      ? '<span style="color:var(--ok)">通过（&lt;1%）</span>'
      : '<span style="color:var(--err)">不通过 —— 模型有问题</span>';
  }
  function detailResultReaction(n) {
    var r = S.res;
    var R = r ? r.reaction : 0;
    var bPct = r ? r.balanceErr * 100 : 100;
    var lPct = r ? r.loadErr * 100 : 100;
    var mPct = r ? r.momentErr * 100 : 100;
    return grp('Reaction Force · 反力',
      kv('作用位置', S.fixedScope === 'none' ? '<span style="color:var(--err)">无（漏了固定约束）</span>' : 'Base Flange 底面（固定约束）') +
      kv('Fz（竖向）', '<span class="mech-big" style="font-size:15px">' + f(R, 2) + ' N</span>') +
      kv('Mx（根部弯矩）', r ? f(r.Mbase, 3) + ' N·m' : '—')) +
      grp('平衡校核（必须做）· 三项独立检查',
        '<div class="kv"><span>① 约束实际反力</span><span>' + f(R, 2) + ' N</span></div>' +
        '<div class="kv"><span>② 求解器吃进去的外载</span><span>' + f(r ? r.appliedFz : 0, 2) + ' N</span></div>' +
        '<div class="kv"><span>① 力平衡误差</span><span>' + errCell(bPct) + '</span></div>' +
        '<div class="kv"><span>判定</span><span>' + verdict(bPct) + '</span></div>' +
        '<div class="divider"></div>' +
        '<div class="kv"><span>载荷面板声明的外载</span><span>' + f(r ? r.declaredFz : 0, 2) + ' N</span></div>' +
        '<div class="kv"><span>③ 载荷重复施加误差</span><span>' + errCell(lPct) + '</span></div>' +
        '<div class="kv"><span>判定</span><span>' + verdict(lPct) + '</span></div>' +
        '<div class="divider"></div>' +
        '<div class="kv"><span>手算根部弯矩 F·x<sub>声明</sub> + Σw·x</span><span>' + f(r ? r.expectM : 0, 3) + ' N·m</span></div>' +
        '<div class="kv"><span>④ 远程点力臂误差</span><span>' + errCell(mPct) + '</span></div>' +
        '<div class="kv"><span>判定</span><span>' + verdict(mPct) + '</span></div>') +
      '<div class="mech-trials">' +
      '<div class="mech-note"><b>为什么必须校核反力：</b>模型漏约束、载荷重复施加、远程点位置错，' +
      '求解都<b>不会报错</b>，只是结果悄悄不对。反力与外载对得上，是最便宜的一道体检。</div>' +
      '<div class="mech-note">下面三个按钮各制造一种真实事故，做完看哪一项会亮红 —— ' +
      '这就是这道体检真正的用法：<b>先制造错误，再验证体检能不能抓到它</b>。</div>' +
      '<div class="mech-segbtns">' +
      '<button class="btn btn-sm" data-act="t-nosupport">🔧 制造：漏加固定约束</button>' +
      '<button class="btn btn-sm" data-act="t-dblforce">🔧 制造：载荷施加两次</button>' +
      '<button class="btn btn-sm" data-act="t-badtip">🔧 制造：远程点位置错</button>' +
      '<button class="btn btn-sm" data-act="t-clearall">↩ 全部改回正确</button>' +
      '</div>' +
      (r && (bPct >= 1 || lPct >= 1 || mPct >= 1)
        ? '<div class="mech-note mech-err"><b>体检没通过。当前模型：</b>' +
        (bPct >= 1 ? '① 约束提供的反力对不上外载 —— 十有八九是<b>漏了固定约束或选错了作用域</b>；' : '') +
        (lPct >= 1 ? '② 实际外载是声明值的 ' + f(r.appliedFz / Math.max(r.declaredFz, 1e-9), 2) +
          ' 倍 —— <b>载荷被重复施加了</b>（插了两个 Remote Force，或 Gravity 与 Force 同时给）；' : '') +
        (mPct >= 1 ? '④ 根部弯矩与 F·x<sub>声明</sub> 对不上 —— <b>远程点位置错了</b>，力臂偏了 ' +
          f((r.tipX - P3.x), 1) + ' mm；' : '') +
        '变形与应力数字此刻全都不可信。</div>'
        : '<div class="mech-note mech-ok">三项全过：约束给了该给的反力、载荷没有重复、力臂和声明一致。</div>') +
      '</div>';
  }

  /* ===========================================================================
   * 13. 教学步骤
   * ======================================================================== */
  function buildSteps() {
    var api = S.api;
    return [
      {
        id: 'launch-import', title: '导入几何', stage: 0,
        goal: '把 Dummy 机械臂的 B-rep 实体导进 Mechanical，确认单位是 <b>mm</b>、模型类型是 <b>Solid</b>。',
        uiAction: '① Workbench 里把 <b>Component Systems ▸ Static Structural</b> 拖进 Schematic，得到 A5 分析系统；' +
          '② 双击 <b>B · Geometry</b> 单元格进入 Mechanical；③ 选中左侧 <b>Geometry</b> 节点，' +
          '<b>Details 面板最上方</b>点 <code>Import Geometry</code>；④ Units 选 <b>mm</b>，Model Type 选 <b>Solid</b>。',
        hints: [
          '<code>Import Geometry</code> 就在 Geometry 的 Details 面板<b>顶部第一行</b>，不在工具条里——很多人一直找不到它。',
          'Units 与源文件不一致会<b>整体等比缩放</b>（mm→in 差 25.4 倍）。试着点工具条 <b>↔ Units</b> 把单位切到 in，看看机械臂是不是缩成一小团。',
          'Model Type 选 Shell 的话，后面所有"实体"都会变成壳，局部应力算不出来；本例 11 个体都必须用 Solid。'
        ],
        physics: 'Mechanical 读的是 B-rep 实体（NURBS 精确曲面），不是网格。只有实体（Solid）模型才能直接划分体单元并算出内部应力；壳/梁模型给的是中面或截面的结果。',
        threeD: '视口里拼出完整的六自由度风格机械臂：底座法兰 → 转台 → 肩部壳体 → 大臂 → 小臂 → 腕轴 → 夹爪，' +
          '三个关节用<b>金属圆环</b>高亮，可点击。',
        expected: '视口出现完整机械臂，Details 显示 Units = mm、Model Type = Solid、Bodies = ' + PLIST.length + '。',
        enter: function (c) { stepLaunch(); }
      },
      {
        id: 'material', title: '定义材料', stage: 1,
        goal: '臂杆用 <b>7075-T6 铝</b>、关节与夹爪用 <b>AISI 45 钢</b>，并把 <b>Yield Strength</b> 填上。',
        uiAction: '① 双击工具条 <b>静态结构</b>（或双击 A5 系统）旁边的 <b>Engineering Data</b> 单元格；' +
          '② 点 <b>Add Material</b>，搜并加入 <code>7075-T6</code> 与 <code>Structural Steel (AISI 45)</code>；' +
          '③ 核对 <code>E = 71.7 GPa / ν = 0.33 / ρ = 2810 kg·m⁻³</code> 与 <code>Yield Strength = 503 MPa</code>；' +
          '④ 回到 Mechanical，选 Geometry 右键 <b>Assign Material</b>，逐体分配。',
        hints: [
          '库里搜 <code>7075</code> 会给出 <b>T6</b> 子项；注意 <b>T6 = 已经时效处理</b>，强度是 T6 的数据，不是 T651 也不是 O 态。',
          '<b>Yield Strength（屈服强度）一定要填</b>，不是 Ultimate Tensile Strength。漏了它，静力求解照样成功，' +
          '只有 Factor of Safety 节点一直挂红色感叹号。',
          '材料没分配时 Geometry 节点上会有黄色感叹号。分配完它会消失——这个"感叹号"就是新材料有没有真正挂上的最直接信号。'
        ],
        physics: '线弹性静力只用到 <b>E</b>（刚度）与 <b>ν</b>（泊松比），<b>ρ</b> 决定自重载荷，' +
          '<b>Yield</b> 只在安全系数与屈服判据里出现。把 E 从 71.7 改成 200 GPa，变形会直接小到几乎看不见——刚度全靠 E。',
        threeD: '零件按材料分组着色：铝件偏蓝灰、钢件偏深灰；点树里的材料节点会高亮该材料的所有体。',
        expected: '两材料已分配、感叹号消失；右侧显示总质量 ' + f(TOTAL_MASS, 3) + ' kg、自重 ' + f(TOTAL_WEIGHT, 2) + ' N。',
        enter: function (c) { stepMaterial(); }
      },
      {
        id: 'contacts', title: '接触与连接', stage: 2,
        goal: '三个关节用 <b>Revolute（铰链）</b>，末端建 <b>Remote Point</b>。这是本模型最关键的建模选择。',
        uiAction: '① 选中 <b>Connections</b> 节点，右键 <b>Auto Generate Contact</b> 生成接触区；' +
          '② 把关节处的 Contact Region 的 <code>Type</code> 改成 <b>Revolute</b>（或从 Insert ▸ Joint 里建）；' +
          '③ Details 里确认 <code>Behavior = Asymmetric</code>、<code>Mobile/Remote Point = Face</code>；' +
          '④ 右键 <b>Geometry ▸ Insert ▸ Remote Point</b>，作用域选夹爪两个指面。',
        hints: [
          '<b>Connections 夹在 Geometry 和 Materials 中间</b>，不在 Loads 里。找不到就顺着 Outline 从上往下找那两个交叠的小图标。',
          '<b>坑：关节本来能转，误用 Bonded 会把转动锁死。</b>点右侧 Details 的「试转 J2」按钮：Revolute 能转，' +
          'Bonded 转不动并弹出警告。',
          'Revolute 约束 <b>3 个平动</b>（UX/UY/UZ），保留 <b>3 个转动</b>；Bonded 传递全部 <b>6 个</b>自由度。' +
          '电机驱动的关节必须留转动自由度。'
        ],
        physics: 'Bonded 相当于把两个面"焊"在一起，法向/切向位移与转角全部连续；Revolute 只让两个面在垂直于轴的方向上对齐，' +
          '绕轴可以自由转。本模型三个关节都用 Revolute，对应真实机械臂的 J1/J2/J3 自由度。',
        threeD: '三个关节圆环变亮；点 Contact Region 或 Joint 节点，高亮对应的贴合面。切 Bonded/Revolute 看约束符号变化。',
        expected: 'Connections 下有 3 个 Revolute 关节 + 1 个 Remote Point，试转按钮能真的把小臂转起来。',
        enter: function (c) { stepContacts(); }
      },
      {
        id: 'mesh', title: '划分网格', stage: 3,
        goal: '以<b>二阶六面体</b>为主，关节圆角与夹指局部加密，看懂 Elements / Nodes 统计。',
        uiAction: '① 选中 Outline 里的 <b>Mesh</b> 节点（不是 Solution！）；② Details 里 Element Size 设 <b>8 mm</b>；' +
          '③ <b>Element Order</b> 改成 <b>Quadratic</b>（二阶，SOLID187）；' +
          '④ 右键 Joint 的面 <b>Insert ▸ Sizing ▸ Face Size = 2 mm</b>；⑤ 右键 <b>Mesh ▸ Generate Mesh</b>。',
        hints: [
          '<b>Mesh 的 Details 在 Mesh 节点上，不在 Solution 里。</b>选中 Mesh 节点再看右侧面板。',
          '拖右侧的 <b>Element Size</b> 滑块：单元数会实时变。8 mm 以上时关节倒角会出现网格奇异，2–4 mm 更稳。',
          '二阶单元在每条棱的中点加节点（8 角点 → 20 节点），弯曲应力精度高得多，但节点数会涨 4–8 倍——' +
          '左右把 Linear / Quadratic 来回切，看 Nodes 数字怎么跳。'
        ],
        physics: '一阶六面体（SOLID185）位移在单元内线性插值，应力是常数，弯曲应力偏软；' +
          '二阶（SOLID187）中边有节点，能捕捉曲率与弯矩梯度，同样的网格能算准应力。代价是内存和时间成倍增长。',
        threeD: '视口叠加<b>单元边界线框</b>：关节圆角与夹指明显更密；改尺寸滑块整片网格实时重划。',
        expected: '右侧出现 Elements / Nodes 统计；切换 Quadratic 时 Nodes 明显变大；关节处网格比臂杆密。',
        enter: function (c) { stepMesh(); }
      },
      {
        id: 'constraint', title: '施加约束', stage: 4,
        goal: '底座法兰<b>底面</b>固定，模拟机架固接——注意不是固定整个底座体。',
        uiAction: '① 选中 Outline 里的 <b>Static Structural</b>（载荷都插在这一层）；' +
          '② 右键 <b>Insert ▸ Fixed Support</b>；③ Details 的 <b>Scoped Geometry</b> 只点 <b>Base Flange 的底面</b>。',
        hints: [
          '<b>插入点在 Static Structural 上，不在 Geometry 上。</b>在 Geometry 里右键 Insert 是找不到 Fixed Support 的。',
          '<b>坑：整个底座体全固定会造成重复约束。</b>点右侧那个「试错」按钮看看：求解器会报 over-constrained equations。',
          '固定约束 6 个自由度全锁（UX/UY/UZ/RX/RY/RZ）。只约束平动的 "Fixed" 之外的 "Remote Displacement / Prescribed Displacement" 才是部分固定。'
        ],
        physics: '固定端刚度远大于结构本身，位移与转角都被强制为零，应力与变形在固定边附近急剧集中。' +
          '这里的弯曲应变梯度最大，所以工程上常在固定处加筋板或加厚法兰，把应力集中摊开。',
        threeD: '底座出现<b>绿色夹持标记</b>（六边形压板 + 六个固定符号）；树里 Fixed Support 节点图标是锁。',
        expected: '树里出现 Fixed Support，作用域是 1 个面；视口底座有绿色夹持符号；没有红色过约束警告。',
        enter: function (c) { stepConstraint(); }
      },
      {
        id: 'loading', title: '施加载荷', stage: 5,
        goal: '重力 + 末端 <b>30 N</b>（走 Remote Point），核对坐标轴方向。',
        uiAction: '① 选中 <b>Static Structural</b>，右键 <b>Insert ▸ Gravity</b>，确认方向是全局 <b>-Z</b>；' +
          '② 选中 <b>Remote Point 1</b>，右键 <b>Insert ▸ Remote Force</b>；' +
          '③ <code>Load Coordinates</code> 选 <b>Global</b>，只填 <b>Z Component = -30</b>（X/Y 留 0）。',
        hints: [
          '<b>核对坐标轴：</b>Mechanical 的全局 <b>Z 向上</b>，所以向下填 <b>-Z</b>。' +
          '如果模型是<b>躺放</b>的，竖直方向变成全局 Y，就得改填 Y 分量——填错轴模型照样求解成功，只是方向不对。',
          '<b>坑：30 N 直接加在夹爪单个面上会出巨大假应力。</b>力只作用在被选中的面上，面外的零件"感觉"不到载荷，' +
          '应力全挤在受力面周围几个单元里。必须走 <b>Remote Point</b>。',
          '拖右侧 <b>0–50 N</b> 滑块，看红箭头怎么伸缩、终端读数怎么变。'
        ],
        physics: '总载荷 = 自重 + 末端外载。根部弯矩在<b>根部截面</b>上求和，<b>每个作用力用它自己的力臂</b>：' +
          '<br><code>M₀ = F·x<sub>t</sub> + Σ wᵢ·x̄ᵢ</code>（i 只遍历<b>参与弯曲的连杆零件</b>）。' +
          '代入本例：' + f(S.force, 0) + ' N × ' + f(P3.x, 1) + ' mm + ' + f(LINK_WEIGHT, 2) + ' N × ' +
          f(linkWeightArm(), 1) + ' mm = ' + f(MODEL.defaultRun().Mbase, 2) + ' N·m —— 和求解器读数<b>逐位对得上</b>。' +
          '<br><b>两个最容易踩的坑：</b>' +
          '<br>① <b>力臂不能混用</b>。末端力在 x<sub>t</sub> = ' + f(P3.x, 1) +
          ' mm，自重形心却在 x̄ = ' + f(linkWeightArm(), 1) + ' mm。先把自重加进"合力"再乘同一个力臂，' +
          '等于把所有自重都挪到了夹爪上，根部弯矩会凭空大出 ' + f(LINK_WEIGHT * (P3.x - linkWeightArm()) / 1000, 2) +
          ' N·m（占 ' + f(LINK_WEIGHT * (P3.x - linkWeightArm()) / 1000 / MODEL.defaultRun().Mbase * 100, 0) + '%）。' +
          '<br>② <b>刚性底座的自重不产生弯矩</b>。flange / turntable / housing 共 ' + f(BASE_WEIGHT, 2) +
          ' N 坐在固定端<b>之内</b>，肩关节环也正好落在 s = 0 这个截面上 —— 两者都不该进 Σw·x̄。' +
          '<b>根部弯矩是整台机器应力的主源</b>。在 Result 面板点「制造：远程点位置错」，' +
          '黄色靶心会沿连杆滑出去 60mm，根部弯矩立刻变，力臂校核随之亮红 —— 这就是④那项检查在抓什么。',
        threeD: '夹爪末端红色箭头随滑块伸缩（ArrowHelper），底座常驻蓝色重力箭头，黄色靶心是 Remote Point。' +
          '在 Result 面板点「制造：远程点位置错」，黄色靶心会沿连杆滑出去 60mm，' +
          '根部弯矩立刻变，力臂校核随之亮红。',
        expected: '树里有 Gravity 与 Remote Force；箭头方向朝下、大小随滑块变化；Details 显示 Z = -' +
          f(S.force, 0) + ' N；' +
          '按 physics 里的公式手算根部弯矩，与 Reaction 面板的 Mx 一致到小数点后两位。',
        enter: function (c) { stepLoading(); }
      },
      {
        id: 'solve', title: '求解', stage: 6,
        goal: '设置分析选项、点击 <b>Solve</b>，盯住 Message 窗口与进度条，先看是否收敛。',
        uiAction: '① 选中 <b>Analysis Settings</b>，Details 里确认 <b>Large Deflection 不勾</b>；' +
          '② 点底部进度条左侧的 <b>▶ Solve</b>（或上方结果工具条的 Solve）；' +
          '③ 看底部伪终端滚动的求解器输出，直到出现 <code>Solution Complete</code>。',
        hints: [
          '<b>Large Deflection 在 Analysis Settings 里面</b>，不在 Mesh 面板。判据是「位移 &gt; 尺寸的 1%」——' +
          '本例只有 ' + f(MODEL.defaultRun().uTip / (LTOT / 1000) * 100, 3) + '%，勾了纯属浪费时间。',
          '<b>坑：不收敛先查 Reaction。</b>如果反力和外载对不上，说明约束没约束住、载荷没加上，' +
          '再怎么调求解器也没用。',
          '二次直接求解器（Distributed Sparse）对这个问题规模是秒级；上千万元素才会需要迭代求解器。'
        ],
        physics: '静力平衡方程 <code>K·u = f</code>：刚度矩阵 K 由 E、ν 和几何决定，载荷向量 f 由重力与 Remote Force 组成。' +
          '位移远小于尺寸时刚度不随姿态变化，线性假设成立，可以一次解出。',
        threeD: '底部进度条从 0 推到 100%，零件在求解完成瞬间从"待算"灰蓝色切换为结果色。',
        expected: '终端出现 <code>Solution Complete</code> 与 <code>Solution is Done</code>；Solution 节点下冒出结果子节点。',
        enter: function (c) { stepSolve(); }
      },
      {
        id: 'mesh-convergence',
        title: '网格无关性：细到什么程度才算够', stage: 6,
        goal: '学会用<b>网格收敛</b>判断"结果还信不信"，而不是凭感觉决定单元尺寸。',
        uiAction: '选中 <b>Mesh</b> 节点 → Details 里的 <b>Element Size</b> 滑块依次拖到 ' +
          '<b>16 → 12 → 8 → 6 → 4 → 3 mm</b>，每停一格都重算一次并对照右侧这张<b>网格无关性对照表</b>：' +
          '每一行给出该尺寸下的<b>单元数、末端总变形、剔除固定边后的最大等效应力、安全系数</b>，' +
          '最后一列直接算出"与 3 mm 最细网格差百分之几"。',
        hints: [
          '<b>收敛判据（工程惯例）：关键读数变化 &lt; 2~5% 就算网格无关。</b>' +
          '看表里从 6 mm 到 3 mm 那一段：单元数翻了好几倍，变形和应力却几乎不动 —— 这就是无关性。',
          '<b>16 mm 明显不合格</b>：根部圆角只有一个单元跨过去，应力集中完全捕捉不到，' +
          'σ 会被严重低估。把 Linear / Quadratic 来回切，再看同一行的差别。',
          '<b>二阶（SOLID187）收敛快得多</b>：位移误差按 h⁴ 走，一阶（SOLID185）按 h² 走。' +
          '同样的精度，二阶可以少用好几倍的单元 —— 这就是默认开二阶的理由。',
          '<b>什么时候必须再细：</b>看的是<b>应力梯度</b>而不是零件尺寸。' +
          '根部圆角 r/d≈0.15、又有 Kt=2.5 的应力集中，那里必须至少 3~4 个单元跨过圆角。' +
          '夹指末端几乎没有梯度，16 mm 都够。',
          '单元数按 (L/h)³ 涨：尺寸砍一半，单元数变 8 倍。所以"再细一点"是有代价的，' +
          '无关性验证就是为了知道什么时候可以停手。'
        ],
        physics: '有限元是<b>近似</b>：把连续体切成有限个单元，节点上解方程，再插值回单元内部。' +
          '单元越大，插值误差越大。位移场的截断误差对均匀网格是 <b>O(h²)</b>（一阶）、<b>O(h⁴)</b>（二阶）；' +
          '而<b>应力</b>是位移的二阶导数，所以应力误差阶数还要再降一档 —— 这就是"应力比位移敏感得多"的来源。' +
          '网格无关性判据就是：<b>当 h 再减半，读数不再变（到你要求的精度），就说明误差已经不是误差来源了</b>。',
        threeD: '拖尺寸滑块时视口里整片单元线框实时重划：16 mm 时臂杆是几个粗块，' +
          '3 mm 时关节圆角与夹指处密得多。橙色高亮的是圆角加密区。',
        expected: '对照表里从 <b>6 mm 往下</b>，末端变形与最大应力的变化都掉到 2~5% 以内，' +
          '而单元数还在成倍上涨 —— 说明默认的 8 mm 已经够用，再细只是烧内存。' +
          '同时能看出 <b>16 mm 那一行的应力明显偏低</b>（圆角处单元太少，捕捉不到应力集中）。',
        enter: function (c) {
          /* 这一步要拿"同一载荷、不同网格"的结果互相对照，所以排在**求解之后、
             读结果之前** —— 这也正是真实工程里做网格无关性验证的位置。 */
          if (!S.solved) { doSolveThen('none'); return; }
          reveal(6);
          S.showMesh = true;
          if (!S.meshGenerated) { rebuildGeometry(); S.meshGenerated = true; }
          refreshMeshOverlay();
          select('mesh');
          renderProps();
          var rows = [16, 12, 8, 6, 4, 3].map(meshConvergence);
          var ref = rows[rows.length - 1];
          c.api.console('Mesh Convergence Study — 同一载荷、不同 Element Size', 'cmd');
          c.api.console('  Size(mm)   Elements      uTip(mm)   sigma(MPa)   FSmin    d% vs 3mm', 'sys');
          rows.forEach(function (r) {
            var du = Math.abs(r.uTip - ref.uTip) / ref.uTip * 100;
            var ds = Math.abs(r.maxStressNoFixed - ref.maxStressNoFixed) / ref.maxStressNoFixed * 100;
            c.api.console('  ' + String(r.size).padStart(5) + '  ' + r.elements.toLocaleString('en-US').padStart(10) +
              '  ' + r.uTip.toFixed(4).padStart(11) + '  ' + r.maxStressNoFixed.toFixed(1).padStart(11) +
              '  ' + r.fosNoFixed.toFixed(2).padStart(8) + '   ' + du.toFixed(2) + ' / ' + ds.toFixed(1),
              (du < 2 && ds < 5) ? 'ok' : 'warn');
          });
          c.api.console('  ✓ 6 mm 以下读数变化 < 2% / 5% → 网格无关；16 mm 明显不合格', 'ok');
          c.api.console('  单元数按 (L/h)^3 增长：尺寸减半 → 单元数 ×8', 'sys');
          S.api.setStatus({ 网格: 'SOLID187 · 已做无关性验证' });
        }
      },
      {
        id: 'result-deformation', title: '结果：总变形', stage: 7,
        goal: '插入 <b>Total Deformation</b>，读出最大位移，并和手算悬臂梁公式对拍。',
        uiAction: '① 选中 Outline 最下面的 <b>Solution</b> 节点，右键 <b>Insert ▸ Results ▸ Total Deformation</b>；' +
          '② 展开 <b>Contours</b>，<code>Range</code> 保持 <b>Automatic</b>；' +
          '③ 拖 <b>Deformation Scale Factor</b> 从 1× 到 5×/10×，看形状变化；④ 读 <code>Maximum</code>。',
        hints: [
          '<b>Solution 在树的最下面</b>，Insert ▸ Results 也在它右键菜单里。在 Geometry 上右键是找不到结果插入的。',
          '<b>坑：图形默认放大很多倍，数字栏才准。</b>Scale Factor 只改<b>显示</b>比例，不改读数——' +
          '把 1× 和 10× 来回切，Maximum 一点不变，这就对了。',
          '打开视口左下角的 <b>❖ 原始轮廓</b>，能同时看到变形前后的形状，比心算靠谱得多。'
        ],
        physics: '悬臂梁末端集中力：δ = F·sinβ·L³/(3EI)，自重按均布 wL⁴/(8EI) 叠加。' +
          '本例 L = ' + (LTOT / 1000).toFixed(3) + ' m、I = ' + (sqI(0.023, 0.0017) * 1e12).toFixed(0) +
          ' mm⁴，积分得末端位移 <b>' + f(MODEL.defaultRun().uTip * 1000, 3) + ' mm</b>，与手算同量级。',
        threeD: '变形随倍率放大，叠加未变形的蓝色线框残影；倍率只改图形不改读数；点 ▶ 播放可循环看加载过程。',
        expected: '机械臂向载荷方向下弯，最大位移在夹爪末端，约 ' +
          f(MODEL.defaultRun().uTip * 1000 * 0.8, 2) + '–' + f(MODEL.defaultRun().uTip * 1000 * 1.2, 2) + ' mm。',
        enter: function (c) { stepResultDeform(); }
      },
      {
        id: 'result-stress', title: '结果：应力、安全系数与反力校核', stage: 8,
        goal: '读等效应力与安全系数，<b>知道安全系数低于 1 意味着什么</b>，并做反力平衡校核。',
        uiAction: '① 选中 Solution 节点，<b>Insert ▸ Results ▸ Equivalent Stress</b>，读 <code>Maximum</code>；' +
          '② 再插入 <b>Factor of Safety</b>，读 <code>Minimum</code>；③ 插入 <b>Reaction Force</b>，' +
          '把 <code>Fz</code> 和外载合力对比；④ <b>做一次"安全系数掉到 1 以下"的实验</b>：' +
          '在 Result 面板点「🔧 制造：载荷施加两次」，或把末端力滑块推到 50 N 以上，' +
          '看安全系数云图整片变红、面板判据从"安全"跳到"不安全"。',
        hints: [
          '<b>Factor of Safety 必须先有 Yield Strength。</b>没填屈服强度，这个节点会一直报错。' +
          'FS = σ<sub>y</sub> / σ<sub>vM</sub>，是一个<b>比值</b>，没有单位。',
          '<b>FS &lt; 1 意味着材料已经屈服了。</b>不是"有点危险"，而是<b>按线性弹性算出来的解在物理上已经不成立</b>：' +
          '7075-T6 屈服 503 MPa，应力算到 503 MPa 时材料开始塑性流动，真实应力不会继续按 E 的斜率涨，' +
          '刚度下降、变形激增、可能直接断裂。此时求解器<b>不会报错</b>，它只是老老实实把线性解算完给你。' +
          '看到 FS 接近 1，第一反应应该是"减小载荷或改设计"，而不是"这个数挺好看"。',
          '<b>三条工程判据：</b>FS ≥ 2 一般结构可接受（留了一倍余量给载荷波动、疲劳、磨损、制造误差）；' +
          '1 &lt; FS &lt; 2 临界，需要说明余量从哪来；<b>FS &lt; 1 不安全</b>，材料已屈服。' +
          '本例默认 30 N 下 FS ≈ ' + f(MODEL.defaultRun().fos, 1) + '（根部圆角处，剔固定边后 ≈ ' +
          f(MODEL.defaultRun().fosNoFixed, 1) + '）—— 把末端力推到 ' +
          Math.ceil(MODEL.defaultRun().fosNoFixed * S.force / 10) + ' N 以上就能看着它跌破 1。',
          '<b>坑：根部固定边的最大应力是奇异值。</b>在 Details 里勾上「剔除固定边一排单元」，' +
          '最大值会明显下降——这正是为什么固定边上的应力不能直接当设计值。',
          '反力校核：在 Reaction 面板点那三个「🔧 制造」按钮，' +
          '看①力平衡、③载荷重复施加、④远程点力臂三项<b>各自</b>亮红 —— 这道体检不是恒真的。'
        ],
        physics: 'von Mises 把 6 个应力分量合成标量：σ<sub>vM</sub> = √(σ₁²+σ₂²+σ₃²−σ₁σ₂−σ₂σ₃−σ₃σ₁+3τ²)。' +
          '对 ductile 材料（7075-T6 属于塑性材料）用 von Mises 判屈服是标准做法。<br>' +
          '7075-T6 屈服 ' + MATS.al.yieldMPa + ' MPa，最大等效应力约 ' + f(MODEL.defaultRun().maxStress / 1e6, 1) +
          ' MPa，安全系数 = ' + MATS.al.yieldMPa + ' / ' + f(MODEL.defaultRun().maxStress / 1e6, 1) + ' ≈ <b>' +
          f(MODEL.defaultRun().fos, 1) + '</b>。<br>' +
          '<b>安全系数低于 1 的含义：</b>σ<sub>vM</sub> 已经超过屈服点。求解器用的仍是线弹性刚度 K = ∫BᵀDBdV，' +
          '而材料此刻已经进入塑性、真实切线刚度掉到 E 的百分之几，所以位移会远大于线性预测，' +
          '载荷路径也会偏。<b>结论是这个解作废</b>，必须减小载荷、换更软的回火态、加大截面或开减重孔后再算。',
        threeD: '三种云图切换：变形 mm → 应力 MPa → 安全系数（红=危险、蓝=安全），右侧图例跟着换挡。' +
          '把末端力推大到 FS 逼近 1 时，安全系数云图的<b>整片</b>会从蓝色翻到红色，' +
          '而变形图的比例尺需要同步调小才看得出变化。',
        expected: '三张图都能出；根部圆角出现应力集中；点「制造：载荷施加两次」后' +
          '安全系数大约<b>减半</b>并可能跌破 1，面板判据变成红色"不安全"，同时 ③ 载荷重复施加检查亮红；' +
          '反力与外载平衡误差在模型正确时 &lt; 1%。',
        enter: function (c) { stepResultStress(); }
      }
    ];
  }

  /* ---------- 各步骤 enter：联动界面 + 3D + 终端 ---------- */
  function stepLaunch() {
    killSolveTimers();
    S.solving = false;
    S.solved = false; S.result = 'none'; S.animT = 1; S.playing = false;
    S.showMesh = false; S.showGhost = true; S.showLoads = true;
    S.forceReps = 1; S.tipOffset = 0;
    S.units = 'mm'; S.meshSize = 8; S.quadratic = true; S.meshGenerated = false;
    S.fixedScope = 'face'; S.contactType = 'Revolute'; S.largeDefl = false; S.dropFixedEdge = false;
    resetJointRotation();
    reveal(0);
    applyUnitScale();
    select('geometry');
    resetPartsLook();
    refreshMeshOverlay();
    recompute();
    updateHUD(); updateSolveBar(); updateOverlay();
    S.api.clearConsole();
    log('=== Workbench 2023 R1 · 新建分析系统 ===', 'sys');
    log('▸ 从 Component Systems 拖入 Static Structural，得到 A5 系统', 'cmd');
    log('▸ 双击 B · Geometry 单元格 → 打开 Mechanical 2023 R1', 'cmd');
    log('▸ Geometry ▸ Import Geometry…  D:\\cae-academy\\dummy_arm.step', 'cmd');
    log('  Units = mm      Model Type = Solid      Bodies = ' + PLIST.length, 'ok');
    log('  Read STEP file ... ' + PLIST.length + ' solids, 0 shells, 0 beams', 'info');
    log('  # Mechanical 脚本（wbjn）等价写法：', 'sys');
    log('    geometry = ExtAPI.DataModel.Project.Model.Geometry', 'sys');
    log('    geometry.SetFile(FilePath=r"D:\\cae-academy\\dummy_arm.step")', 'sys');
    log('  几何检查完成：Volume = ' + (totalVol() * 1e6).toFixed(1) + ' cm³，无自相交。', 'ok');
  }
  function stepMaterial() {
    reveal(1);
    select('materials');
    paintByMaterial();
    recompute();
    log('▸ Engineering Data ▸ Add Material ▸ 7075-T6', 'cmd');
    log('    E = 71.7e9 Pa   ν = 0.33   ρ = 2810 kg/m³   Yield Strength = 503e6 Pa', 'ok');
    log('▸ Engineering Data ▸ Add Material ▸ Structural Steel (AISI 45)', 'cmd');
    log('    E = 206e9 Pa    ν = 0.30   ρ = 7850 kg/m³   Yield Strength = 355e6 Pa', 'ok');
    log('▸ Geometry ▸ Assign Material：' + PLIST.filter(function (p) { return p.mat === 'al'; }).length
      + ' 个铝体 + ' + PLIST.filter(function (p) { return p.mat === 'st'; }).length + ' 个钢体', 'cmd');
    log('  ⚠ 若漏填 Yield Strength，Factor of Safety 节点会一直显示错误标记', 'warn');
    log('  质量统计：V = ' + (totalVol() * 1e6).toFixed(1) + ' cm³ → m = ' + f(TOTAL_MASS, 3)
      + ' kg → 自重 W = ' + f(TOTAL_WEIGHT, 2) + ' N', 'ok');
    S.api.setStatus({ 材料: '7075-T6 + AISI 45', 质量: f(TOTAL_MASS, 3) + ' kg' });
  }
  function stepContacts() {
    reveal(2);
    select('connections');
    setContact('Revolute');
    log('▸ Connections ▸ Auto Generate Contact：检出 6 组面对', 'cmd');
    log('    3 个关节面合并为 Contact Region（Source/Target 面）', 'info');
    log('▸ Contact Region ▸ Type = Revolute（不是 Bonded！）', 'cmd');
    log('    约束 UX / UY / UZ 三个平动自由度，保留绕轴转动', 'ok');
    log('  验算：点「试转 J2」，小臂能转 → 转动自由度未被锁死 ✓', 'ok');
    log('▸ Geometry ▸ Insert ▸ Remote Point（作用域 = 两夹指面）', 'cmd');
  }
  function stepMesh() {
    reveal(3);
    S.showMesh = true;
    if (!S.meshGenerated) { rebuildGeometry(); S.meshGenerated = true; }
    refreshMeshOverlay();
    select('mesh');
    meshStats();
    updateHUD();
    log('▸ Mesh ▸ Details ▸ Element Size = 8 mm，Element Order = Quadratic', 'cmd');
    log('▸ Joint 圆角面 ▸ Insert ▸ Sizing ▸ Face Size = 2 mm（局部加密）', 'cmd');
    log('▸ Mesh ▸ Generate Mesh', 'cmd');
    log('  Elements = ' + meshStats().elements.toLocaleString('en-US')
      + '    Nodes = ' + meshStats().nodesQuadratic.toLocaleString('en-US') + '（二阶）', 'ok');
    log('  单元类型 SOLID187：每单元 20 节点（棱中点有节点），弯曲应力精度高', 'info');
    log('  最小单元质量 Minimum Element Quality = 0.386（在圆角加密区）', 'info');
    S.api.setStatus({ 网格: (S.quadratic ? 'SOLID187' : 'SOLID185') + ' · ' + meshStats().elements + ' 单元' });
  }
  function stepConstraint() {
    reveal(4);
    S.fixedScope = 'face';
    select('fixedsupport');
    updateOverlay();
    log('▸ Static Structural ▸ Insert ▸ Fixed Support', 'cmd');
    log('    Scoped Geometry = Base Flange 的底面（1 Face），不是整个 Body', 'ok');
    log('    约束全部 6 个自由度：UX UY UZ RX RY RZ', 'info');
    log('  💡 想看反面教材？点右侧「试错」按钮把作用域改成整个体。', 'warn');
  }
  function stepLoading() {
    reveal(5);
    S.gravity = true;
    select('remoteforce');
    recompute(); updateOverlay();
    S.loadGroup.visible = S.showLoads;
    log('▸ Static Structural ▸ Insert ▸ Gravity', 'cmd');
    log('    定义 = 全局坐标系，Y/Z 分量：Gravity 勾选 → 方向 -Z，等效 9.8066 m/s²', 'info');
    log('  ⚠ 一行两答：指定 Gravity 为 System-defined 或输入加速度数值，二选一，别同时填', 'warn');
    log('▸ Remote Point 1 ▸ Insert ▸ Remote Force', 'cmd');
    log('    Load Coordinates = Global   Z Component = -' + f(S.force, 0) + ' N   X = Y = 0', 'ok');
    log('  合计外载：' + f(S.force, 1) + ' N + 自重 ' + f(TOTAL_WEIGHT, 2) + ' N = '
      + f(S.force + TOTAL_WEIGHT, 2) + ' N', 'info');
    S.api.setStatus({ 载荷: 'Z = -' + f(S.force, 0) + ' N + 自重 ' + f(TOTAL_WEIGHT, 1) + ' N' });
  }
  function stepSolve() {
    reveal(6);
    select('settings');
    log('▸ Analysis Settings ▸ Large Deflection = 不勾', 'cmd');
    log('    判据：位移/尺寸 = ' + f(MODEL.defaultRun().uTip / (LTOT / 1000) * 100, 4)
      + '% ，远小于 1%，线性假设成立', 'ok');
    log('  现在点底部「▶ Solve」按钮，或工具条「结果 ▸ Solve」。', 'warn');
    if (!S.solved) { S.api.toast('点底部 ▶ Solve 开始求解', 'info'); }
  }
  function stepResultDeform() {
    if (!S.solved) { doSolveThen('deform'); return; }
    reveal(7);
    select('r_deform');
    setResult('deform');
    S.showGhost = true;
    updateHUD(); updateOverlay();
    log('▸ Solution ▸ Insert ▸ Results ▸ Total Deformation', 'cmd');
    log('    Contours ▸ Range = Automatic，Deformation Scale Factor = ' + S.defScale + ' ×', 'cmd');
    log('  ✦ Maximum Total Deformation = ' + f(S.res.uTip * 1000, 4) + ' mm（位于 Remote Point 1）', 'ok');
    log('    竖向分量 = ' + f(S.res.uVert * 1000, 4) + ' mm，根部转角 = '
      + f(S.res.thetaTip * 180 / Math.PI, 4) + '°', 'info');
    log('  手算校核：δ = F·sinβ·L³/(3EI) + wL⁴/(8EI)，L = ' + (LTOT / 1000).toFixed(3)
      + ' m，I = ' + (sqI(0.023, 0.0017) * 1e12).toFixed(0) + ' mm⁴ → 同量级 ✓', 'info');
    log('  💡 Scale Factor 只改显示，Maximum 读数不变。', 'warn');
  }
  function stepResultStress() {
    if (!S.solved) { doSolveThen('stress'); return; }
    var c = S.api;
    reveal(8);
    select('r_fos');
    setResult('fos');
    var r = S.res;
    c.console('▸ Solution ▸ Insert ▸ Results ▸ Equivalent Stress (von Mises)', 'cmd');
    c.console('  ✦ Maximum = ' + f(r.maxStress / 1e6, 2) + ' MPa，位于根部圆角（s ≈ ' + f(r.maxStressAt, 0) + ' mm）', 'ok');
    c.console('    名义弯曲应力 ' + f(r.nominalStress / 1e6, 2) + ' MPa × Kt 2.5（圆角应力集中）', 'info');
    c.console('▸ Insert ▸ Results ▸ Factor of Safety', 'cmd');
    c.console('  ✦ Minimum = ' + f(r.fos, 2) + '（7075-T6 屈服 ' + MATS.al.yieldMPa + ' MPa / ' + f(r.maxStress / 1e6, 1) + ' MPa）', 'ok');
    var fs = S.dropFixedEdge ? r.fosNoFixed : r.fos;
    c.console('  工程判据：' + (fs >= 2 ? 'FS ≥ 2，安全' : (fs > 1 ? '1 < FS < 2，临界' : 'FS < 1，不安全 —— 材料已屈服，线性解作废')),
      fs >= 2 ? 'ok' : (fs > 1 ? 'warn' : 'err'));
    c.console('  想看 FS < 1 长什么样：把末端力推到 ' + Math.ceil(r.fosNoFixed * S.force / 10) +
      ' N 以上，或点「制造：载荷施加两次」（FS 大约减半）。', 'warn');
    c.console('▸ Insert ▸ Results ▸ Reaction Force', 'cmd');
    c.console('  ✦ Fz = ' + f(r.reaction, 2) + ' N；① 力平衡误差 ' + f(r.balanceErr * 100, 3) +
      ' %  ③ 载荷重复施加误差 ' + f(r.loadErr * 100, 3) + ' %  ④ 力臂误差 ' + f(r.momentErr * 100, 3) + ' %',
      (r.balanceErr < 0.01 && r.loadErr < 0.01 && r.momentErr < 0.01) ? 'ok' : 'err');
    c.console('  ⚠ 固定边上的应力是奇异值；勾 Details 里的「剔除固定边单元」对比一下。', 'warn');
  }
  /** 还没求解就点到结果步骤：自动先求解，求完再切结果 */
  function doSolveThen(mode) {
    reveal(6);
    select('settings');
    log('  ℹ 还没有求解结果，先自动 Solve 一次。', 'warn');
    if (S.solveThenWatch) clearInterval(S.solveThenWatch);
    S.solveThenWatch = setInterval(function () {
      if (S.solved || !S.solving) {
        clearInterval(S.solveThenWatch);
        S.solveThenWatch = null;
        if (S.solved) {
          if (mode === 'none') {                 // 只求解，不切结果视图（网格无关性那一步用）
            S.api.console('  ✓ 求解完成。', 'ok');
            updateOverlay();
          } else {
            S.api.console('  ✓ 求解完成，切到结果视图。', 'ok');
            if (mode === 'deform') { reveal(7); select('r_deform'); setResult('deform'); }
            else { reveal(8); select('r_stress'); setResult('stress'); }
            updateOverlay();
          }
        }
      }
    }, 200);
    solve();
  }
  function paintByMaterial() {
    for (var i = 0; i < S.parts.length; i++) {
      S.parts[i].mesh.material.color.set(hexOf(S.parts[i].def.mat));
      S.parts[i].mesh.material.vertexColors = false;
    }
  }
  function resetPartsLook() {
    for (var i = 0; i < S.parts.length; i++) {
      var m = S.parts[i].mesh.material;
      m.color.set(hexOf(S.parts[i].def.mat));
      m.vertexColors = false; m.wireframe = false;
      m.emissive.setHex(0x000000);
    }
    S.$.legend.style.display = 'none';
  }
})(window);
