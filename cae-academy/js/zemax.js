/* =============================================================================
 *  zemax.js —— Ansys Zemax OpticStudio 教学模块
 *  125-200mm F/5.7 长焦变焦镜头（序列模式，单移动组）
 *
 *  光学内核全部在本文件内实时计算：近轴追迹 + 真实球面光线追迹（Snell 定律），
 *  所有面板读数、点列图、MTF 曲线都由同一次追迹产生，因此前后永远自洽。
 * ============================================================================= */
(function () {
  'use strict';
  var CAE = window.CAE;

  /* ===========================================================================
   * 1. 玻璃与色散：两项 Cauchy 拟合，锚定 nd 与阿贝数 vd
   *    n_F - n_C = (n_d - 1)/v_d 严格成立，所以三色折射率差是自洽的
   * ======================================================================== */
  var LAM_F = 0.48613, LAM_C = 0.65627, LAM_d = 0.58756;
  function mkGlass(name, nd, vd) {
    var xF = 1 / (LAM_F * LAM_F), xC = 1 / (LAM_C * LAM_C), xd = 1 / (LAM_d * LAM_d);
    var B = (nd - 1) / (vd * (xF - xC)), A = nd - B * xd;
    return { name: name, nd: nd, vd: vd, n: function (l) { return A + B / (l * l); } };
  }
  var GLASS = {
    'N-BK7': mkGlass('N-BK7', 1.51680, 64.17),
    'N-SF5': mkGlass('N-SF5', 1.67270, 32.25),
    'N-LAK8': mkGlass('N-LAK8', 1.69100, 54.71),
    'N-SK16': mkGlass('N-SK16', 1.62040, 60.32),
    'N-F2': mkGlass('N-F2', 1.62004, 36.37),
    'N-BAF10': mkGlass('N-BAF10', 1.67000, 47.11)
  };
  var GLASS_ORDER = ['N-BK7', 'N-SF5', 'N-LAK8', 'N-SK16', 'N-F2', 'N-BAF10'];
  var LAM_LIST = [0.656, 0.588, 0.486];
  var LAM_NAME = ['红 0.656µm', '黄 0.588µm', '蓝 0.486µm'];
  var LAM_COLOR = [0xff5544, 0xffcc33, 0x4488ff];

  function refr(s, l) { return s.g ? GLASS[s.g].n(l) : 1.0; }

  /* ===========================================================================
   * 2. 镜头结构数据
   *    9 片 / 18 面 / 3 组（正-负-正）远摄变焦
   *      第 1-3 片  前固定正组
   *      第 4-6 片  负变倍组（Zoom 滑块驱动的就是它与前组的空气间隙 g1）
   *      第 7-9 片  后固定正组
   *    TT[i]  第 i 面的厚度；偶数下标 = 该片中心厚度，奇数下标 = 片间空气
   *    R[i]   第 i 面曲率半径（由形状族 × 组缩放 × 用户微调系数得到）
   * ======================================================================== */
  var TT = [12.0, 3.0, 8.0, 3.0, 12.0, 0, 13.0, 4.0, 15.0, 4.0, 12.0, 0, 10.0, 3.0, 8.0, 3.0, 13.0, 0];
  var GLASS_OF = ['N-BK7', 'N-SF5', 'N-LAK8', 'N-BK7', 'N-SF5', 'N-LAK8', 'N-BK7', 'N-SF5', 'N-LAK8'];
  var ELEM_GLASS = GLASS_OF.slice();
  var SHAPE = [
    [1.00, -7.00, -1.15, 1.60, 1.90, -1.00],
    [-1.00, 7.00, 1.15, -1.60, -1.90, 1.00],
    [1.00, -6.00, -1.10, 1.70, 1.80, -1.00]
  ];
  var LAMBDA = [86.0, 40.943, 52.0];
  var GROUP_OF = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2];
  var ELEM_OF = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8];
  var GROUP_NAME = ['前固定正组', '负变倍组', '后固定正组'];
  var NS = 18;

  /* 出厂状态：pert 全 1 是"录入的初始骨架"；下面这组是**本模块出厂评价函数跑出来的
     优化结果**（RMSP×3 + EFFL 200 + MNUM×3，坐标下降 + 变倍组行程约束）。
     200mm 长焦端实测：EFL 200.000 / F5.70 / BFD 73.9，三视场 57/57 条光线全通，
     RMS = 1.6 / 2.8 / 5.2 µm —— MTF 在 20 lp/mm 上是 90% / 86% / 74%，
     三条曲线分得开，学生比高低才有意义。 */
  var PERT_OPT = [0.7821, 0.5624, 0.9224, 2.9001, 1.7103, 1.0000, 1.1125, 0.1643,
    2.8064, 1.9219, 2.0998, 3.3974, 3.5333, 0.1293, 0.6943, 4.1255, 2.9495, 1.0000];
  /* 与 PERT_OPT 配套的后组空气间隙：优化时它是自由变量，必须一起交付，
     否则载入优化处方后 g1 解出来的焦距对不上（Zoom 求解用的是当前 g2）。 */
  var G2_OPT = 3.162;
  /* 骨架（未优化）处方配套的后组间隙：能让标称 125mm 广角端精确命中 */
  var G2_FACTORY = 45.0;

  var S = {
    /* 出厂就是**优化处方**：一进来点列图/MTF/一阶性质都有意义。
       想看"刚录进去、还没优化"的骨架，点工具条的「恢复初始」。 */
    pert: PERT_OPT.slice(),   // 每面半径微调系数（LDE 的 Radius 列就是它 × 基准）
    thick: TT.slice(),        // 每面厚度（LDE 的 Thickness 列）
    g2: G2_OPT,               // 变倍组↔后组 空气间隙（滑块可调；出厂值 = 优化处方配套值）
    epd: 35.0,                // 入瞳直径 mm（aperture='fixed' 时生效）
    aperture: 'fno',          // 'fno' 恒定光圈（EPD 随焦距缩放） / 'fixed' 固定入瞳
    fstop: 5.7,
    stop: 5,                  // 光阑面（0 基索引；畸变的主光线要穿过它）
    fstop: 5.7,
    zoomPos: 1.0,             // 1 = 长焦端，0 = 广角端
    eflTarget: 200.0,
    fieldMode: 'height',      // 'height' 用像高(mm)，'angle' 用角度(deg)
    imgH: 21.6,               // 全视场像高（135 画幅对角半高）
    semiD: new Array(NS).fill(0),   // 每面半口径；0 = 按光线包络自动（LDE 的 Semi-D 列可改写）
    eflOverride: null,        // 评价函数里 EFFL 行的 Target（非空时接管 Zoom 求解的目标焦距）
    wlMode: 'all',            // 'all' 三色 / 0,1,2 单色
    showRays: true,
    view: 'iso',
    solve: {}                 // 每面 Solve Type
  };
  /* 本结构（3 片/组的全球面骨架）实测可解的变焦区间 */
  var ZOOM_WIDE = 125.0, ZOOM_TELE = 200.0;
  for (var i0 = 0; i0 < NS; i0++) S.solve[i0] = (i0 === 5) ? 'Zoom' : (i0 === NS - 1 ? 'Focus' : 'Fix');
  var SOLVE_OPTS = { Fix: '固定', Variable: '变量', Pickup: '拾取', Zoom: '缩放', Focus: '近轴聚焦' };

  /* ===========================================================================
   * 3. 面表与追迹
   * ======================================================================== */
  function baseRadius(i) {
    var g = GROUP_OF[i], j = i - g * 6;
    return SHAPE[g][j] * LAMBDA[g];
  }
  function radiiOf(pert) {
    var R = [];
    for (var i = 0; i < NS; i++) R.push(baseRadius(i) * (pert ? pert[i] : 1));
    return R;
  }
  function buildSurfs(R, g1, g2, bfdOff) {
    var s = [], z = 0;
    for (var i = 0; i < NS; i++) {
      var t = S.thick[i];
      if (i === 5) t = g1;
      if (i === 11) t = g2;
      if (i === NS - 1) t = 0;
      s.push({ R: R[i], t: t, g: (i % 2 === 0) ? ELEM_GLASS[i >> 1] : null, z: z });
      z += t;
    }
    var p = paraxial(s, 10, 0);
    if (!isFinite(p.bfd) || Math.abs(p.bfd) > 2500) return null;
    s[NS - 1].t = p.bfd + (bfdOff || 0);
    s[NS - 1].BFD = p.bfd + (bfdOff || 0);      // 记下真正的后焦距（重建后再算会恒等于 0）
    var z2 = 0; for (var j = 0; j < NS; j++) { s[j].z = z2; z2 += s[j].t; }
    return s;
  }
  /* 近轴追迹：u 为约化角 n·u。y0/w 是"在第一面顶点处的高度与入射角" */
  function paraxial(s, y0, w) {
    return paraxialU(s, y0, y0 * Math.tan(w || 0));
  }
  /* 同上，但直接给定初始约化角 —— 主光线（y0=0, u0=tan w）必须走这一条 */
  function paraxialU(s, y0, u0) {
    var n = 1.0, y = y0, u = u0, tr = [];
    for (var i = 0; i < s.length; i++) {
      var phi = s[i].R ? (refr(s[i], LAM_d) - n) / s[i].R : 0;
      u = u - y * phi;
      tr.push({ z: s[i].z, y: y, u: u });
      n = refr(s[i], LAM_d);
      y = y + s[i].t * u;
    }
    return { efl: u !== 0 ? -y0 / u : Infinity, bfd: u !== 0 ? -y / u : Infinity, yEnd: y, uEnd: u, trace: tr };
  }
  /* 球面求交：R>0 顶点在球面左帽取近根，R<0 顶点在右帽取远根 */
  function hitSphere(P, D, s) {
    if (!s.R) {
      if (Math.abs(D.z) < 1e-12) return null;
      var tp = (s.z - P.z) / D.z;
      if (tp <= 1e-9) return null;
      return { z: s.z, y: P.y + tp * D.y };
    }
    var cz = s.z + s.R, oz = P.z - cz, oy = P.y;
    var b = 2 * (oz * D.z + oy * D.y), c = oz * oz + oy * oy - s.R * s.R;
    var disc = b * b - 4 * c;
    if (disc < 0) return null;
    var sq = Math.sqrt(disc);
    var t = (s.R > 0) ? ((-b - sq) / 2) : ((-b + sq) / 2);
    if (t <= 1e-9) return null;
    return { z: P.z + t * D.z, y: P.y + t * D.y };
  }
  function refractV(D, N, n1, n2) {
    var cosi = -(D.z * N.z + D.y * N.y);
    if (cosi < 0) { N = { z: -N.z, y: -N.y }; cosi = -cosi; var t = n1; n1 = n2; n2 = t; }
    var eta = n1 / n2, k = 1 - eta * eta * (1 - cosi * cosi);
    if (k < 0) return null;
    var f = eta * cosi - Math.sqrt(k);
    var tz = eta * D.z + f * N.z, ty = eta * D.y + f * N.y;
    var L = Math.hypot(tz, ty) || 1;
    return { z: tz / L, y: ty / L };
  }
  /* 真实追迹：从入瞳边缘按视场角方向入射，起点保证落在第一面之前
     semi 不为 null 时按半口径裁剪光线（这就是渐晕/ray trace error 的来源） */
  function traceRay(s, y0, dy, dz, l, backHint, semi) {
    var D = { z: dz, y: dy }, L = Math.hypot(D.z, D.y) || 1;
    D.z /= L; D.y /= L;
    var b0 = 3, R0 = s[0].R;
    if (R0) { var d = R0 * R0 - y0 * y0; if (d > 0) b0 = Math.abs(R0 - Math.sign(R0) * Math.sqrt(d)) + 2; }
    var back = backHint || b0;
    var P = { z: s[0].z - back * D.z, y: y0 - back * D.y };
    var path = [{ z: P.z, y: P.y }], n = 1.0;
    for (var i = 0; i < s.length; i++) {
      var su = s[i], h = hitSphere(P, D, su);
      if (!h) return null;
      /* 半口径裁剪：光线高度超出 Semi-Diameter 就被挡住（渐晕 / ray trace error） */
      if (semi && Math.abs(h.y) > semi[i]) return null;
      P = h; path.push({ z: P.z, y: P.y });
      var n2 = refr(su, l);
      var N = su.R ? { z: (P.z - (su.z + su.R)) / su.R, y: P.y / su.R } : { z: -1, y: 0 };
      var NL = Math.hypot(N.z, N.y) || 1; N = { z: N.z / NL, y: N.y / NL };
      var nd = refractV(D, N, n, n2);
      if (!nd) return null;                        // 全反射 —— 也是"光线追迹失败"的一种
      D = nd; n = n2;
    }
    return { path: path, D: D, n: n };
  }
  function imgHit(r, zIMG) {
    var last = r.path[r.path.length - 2];
    if (!last) return null;
    var t = (zIMG - last.z) / r.D.z;
    if (t < 0) return null;
    return last.y + t * r.D.y;
  }
  /* ZEMAX 用的瞳孔采样（归一化半径，含正负） */
  var PUPIL = [0, 0.1294, 0.2588, 0.3717, 0.4829, 0.5976, 0.7177, 0.8450, 0.9826, 1.0];
  function pupilList() {
    var out = [0];
    for (var k = 1; k < PUPIL.length; k++) { out.push(PUPIL[k]); out.push(-PUPIL[k]); }
    return out;
  }
  var PL = pupilList();

  /* ===========================================================================
   * 4. 视场 / 变焦 / 一次完整求值
   * ======================================================================== */
  function fieldAngles(efl) {
    if (S.fieldMode === 'angle') return [0, 0.7 * S.imgH, S.imgH];  // 复用 imgH 存角度
    return [0, 0.7 * S.imgH, S.imgH].map(function (h) { return Math.atan(h / efl) * 180 / Math.PI; });
  }
  function fieldLabels(efl) {
    return fieldAngles(efl).map(function (a) { return a.toFixed(2) + '°'; });
  }
  /* ⚠ g2 必须显式传进来：Zoom 求解要解的是「当前后组间隙下」的 EFL。
     早先这里写死 S.g2，于是把 g2 调小之后，求解器仍然按旧的 45mm 去解变倍间隙，
     解出来的 g1 配到实际 g2 上根本对不上目标焦距。 */
  function eflAtG1(R, g1, g2) {
    var s = buildSurfs(R, g1, (g2 === undefined ? S.g2 : g2), 0);
    if (!s) return NaN;
    return paraxial(s, 10, 0).efl;
  }
  /* 二分法解"变倍组空气间隙"，使系统焦距等于目标 —— 就是 Zemax 的 Zoom 求解。
     ⚠ 只能在 EFL **单调上升且为正**的那一段上括区间。
        变倍组拉太开之后 EFL 会冲高再翻成负数（那时结构已经不是能成像的系统了）。
        早期版本只查 isFinite，于是拿扫描区间里随便一对"异号"的 EFL 去二分，
        会解出一个完全错误的间隙 —— 表现就是"目标 126mm 却解出 152mm"。 */
  function eflOk(e) { return isFinite(e) && e > 40 && e < 1200; }
  function solveGap1(R, target, g2) {
    var G = (g2 === undefined ? S.g2 : g2);
    var prev = null, pr = 2;
    for (var g = 2; g <= 400; g += 1) {
      var e = eflAtG1(R, g, G);
      if (!eflOk(e)) { prev = null; continue; }
      if (prev !== null && (prev - target) * (e - target) <= 0) {
        var a = pr, b = g, fa = prev;
        for (var i = 0; i < 44; i++) {
          var m = (a + b) / 2, em = eflAtG1(R, m, G);
          if (!eflOk(em)) break;
          if ((fa - target) * (em - target) <= 0) b = m; else { a = m; fa = em; }
        }
        var g1 = (a + b) / 2, e1 = eflAtG1(R, g1, G);
        if (eflOk(e1)) return { g1: g1, ok: Math.abs(e1 - target) < 0.05 };
      }
      prev = e; pr = g;
      if (prev > target * 1.6) break;      // 已越过目标还单调涨 → 后面只会更远
    }
    /* 没括到区间：取扫描里离目标最近的有效采样点（= 行程极限），并如实标记未收敛 */
    var bestG = null, bestD = Infinity;
    for (var g3 = 2; g3 <= 400; g3 += 1) {
      var e3 = eflAtG1(R, g3, G);
      if (!eflOk(e3)) continue;
      var d3 = Math.abs(e3 - target);
      if (d3 < bestD) { bestD = d3; bestG = g3; }
    }
    if (bestG !== null) return { g1: bestG, ok: false };
    return { g1: S.g2, ok: false };
  }
  function targetEfl() { return ZOOM_WIDE + (ZOOM_TELE - ZOOM_WIDE) * S.zoomPos; }

  /* 一次完整求值：几何 + 焦距 + 三视场点列 */
  function evaluate(opt) {
    opt = opt || {};
    var pert = opt.pert || S.pert, g2 = (opt.g2 !== undefined) ? opt.g2 : S.g2;
    var eflT = opt.eflTarget || S.eflOverride || targetEfl();
    var R = radiiOf(pert);
    var gs = solveGap1(R, eflT, g2);
    var s = buildSurfs(R, gs.g1, g2, opt.defocus || 0);
    if (!s) return null;
    var p = paraxial(s, 10, 0);
    var zIMG = s[NS - 1].z + s[NS - 1].t;
    var flds = fieldAngles(p.efl);
    var lams = S.wlMode === 'all' ? LAM_LIST : [LAM_LIST[+S.wlMode]];
    /* 恒定光圈变焦：EPD 随焦距一起缩放，F# 全程不变；改成 'fixed' 就是变光圈 */
    var epd = opt.epd || (S.aperture === 'fixed' ? S.epd : p.efl / S.fstop);
    var spots = [];
    /* 每条光线在各面的高度包络 —— 半口径与边缘余量都从这里来。
       path[0] 是入射起点，path[j+1] 才是第 j 面的落点，别错位一格。 */
    var maxY = [], i;
    for (i = 0; i < NS; i++) maxY.push(0);
    for (var f = 0; f < 3; f++) {
      var w = flds[f] * Math.PI / 180, sy = 0, sy2 = 0, c = 0, tot = 0, mx = 0, pts = [];
      for (var li = 0; li < lams.length; li++) for (var k = 0; k < PL.length; k++) {
        tot++;
        var y0 = epd * 0.5 * PL[k];
        var r = traceRay(s, y0, -Math.sin(w), Math.cos(w), lams[li]);
        if (!r) continue;
        for (var q = 0; q < NS; q++) {
          var hy = Math.abs(r.path[q + 1].y);
          if (hy > maxY[q]) maxY[q] = hy;
        }
        var yi = imgHit(r, zIMG);
        if (yi === null) continue;
        sy += yi; sy2 += yi * yi; c++;
        if (Math.abs(yi) > mx) mx = Math.abs(yi);
        if (opt.wantPts) pts.push({ x: yi * 1000, p: PL[k], lam: li });
      }
      var mean = c ? sy / c : 0;
      var rms = c >= 8 ? Math.sqrt(Math.max(0, sy2 / c - mean * mean)) * 1000 : 0;
      spots.push({ rms: rms, n: c, tot: tot, mean: mean * 1000, max: mx * 1000, pts: pts, ang: flds[f], blocked: tot - c });
    }
    /* 半口径 Semi-D：用户手填的优先，否则按光线包络自动给（再被球面半径收一道） */
    var sd = [], manual = false;
    for (i = 0; i < NS; i++) {
      var rr = R[i];
      if (S.semiD[i] > 0) { sd[i] = S.semiD[i]; manual = true; continue; }
      var hh = maxY[i] * 1.02;
      if (rr && Math.abs(rr) < hh) hh = Math.abs(rr) * 0.98;   // 半径装不下就收到球面内
      sd[i] = Math.max(hh, 6);
    }
    /* 手动半口径 = 真的光阑：按它重新追一遍，挡掉的光线就是渐晕 */
    if (manual) {
      var live = [];
      for (i = 0; i < NS; i++) live.push(0);
      for (var f2 = 0; f2 < 3; f2++) {
        var w2 = flds[f2] * Math.PI / 180;
        var spots2 = spots[f2];
        spots2.n = 0; spots2.blocked = 0; spots2.rms = 0; spots2.mean = 0; spots2.max = 0;
        spots2.pts = opt.wantPts ? [] : spots2.pts;
        var a2 = 0, b2 = 0, c2 = 0, t2 = 0;
        for (var l2 = 0; l2 < lams.length; l2++) for (var k2 = 0; k2 < PL.length; k2++) {
          t2++;
          var r2 = traceRay(s, epd * 0.5 * PL[k2], -Math.sin(w2), Math.cos(w2), lams[l2], null, sd);
          if (!r2) continue;
          var y2 = imgHit(r2, zIMG);
          if (y2 === null) continue;
          a2 += y2; b2 += y2 * y2; c2++;
          if (Math.abs(y2) > spots2.max) spots2.max = Math.abs(y2);
          if (opt.wantPts) spots2.pts.push({ x: y2 * 1000, p: PL[k2], lam: l2 });
        }
        spots2.n = c2; spots2.blocked = t2 - c2;
        spots2.mean = c2 ? a2 / c2 * 1000 : 0;
        spots2.rms = c2 >= 8 ? Math.sqrt(Math.max(0, b2 / c2 - (a2 / c2) * (a2 / c2))) * 1000 : 0;
        for (var k3 = 0; k3 < PL.length; k3++) {
          var r3 = traceRay(s, epd * 0.5 * PL[k3], -Math.sin(w2), Math.cos(w2), LAM_d, null, sd);
          if (!r3) continue;
          for (var q3 = 0; q3 < NS; q3++) {
            var hy3 = Math.abs(r3.path[q3 + 1].y);
            if (hy3 > live[q3]) live[q3] = hy3;
          }
        }
      }
      maxY = live;
    }
    /* d 线单色 RMS（RMSR 操作数）与实光线畸变（DMVA 操作数）——都只追 0.588 µm，
       把色差从球差里剥出来。 */
    var dist = null, distPairs = 0;
    var w3 = flds[2] * Math.PI / 180;
    var idealPx = Math.abs(p.efl * Math.tan(w3)) * 1000;
    for (var f3 = 0; f3 < 3; f3++) {
      var w2 = flds[f3] * Math.PI / 180, a3 = 0, b3 = 0, c3 = 0;
      for (var k4 = 0; k4 < PL.length; k4++) {
        var r4 = traceRay(s, epd * 0.5 * PL[k4], -Math.sin(w2), Math.cos(w2), LAM_d, null, manual ? sd : null);
        if (!r4) continue;
        var y4 = imgHit(r4, zIMG);
        if (y4 === null) continue;
        a3 += y4; b3 += y4 * y4; c3++;
      }
      var m3 = c3 ? a3 / c3 : 0;
      spots[f3].nD = c3;
      spots[f3].rmsD = c3 >= 8 ? Math.sqrt(Math.max(0, b3 / c3 - m3 * m3)) * 1000 : 0;
    }
    /* 畸变：按 ±p **对称瞳孔带配对**求平均 —— 渐晕总是成对砍掉外圈，用对称带
       平均就不会像"存活光线质心"那样被漏光带偏。带数不足 5 对时宁可不给读数。 */
    if (idealPx > 1e-6) {
      var pairs = [];
      for (var k5 = 1; k5 < PL.length; k5 += 2) {         // pupilList 里正负成对存放
        var rp = PL[k5], rm = -PL[k5];
        var hA = imgHit0(traceRay(s, epd * 0.5 * rp, -Math.sin(w3), Math.cos(w3), LAM_d, null, manual ? sd : null), zIMG);
        var hB = imgHit0(traceRay(s, epd * 0.5 * rm, -Math.sin(w3), Math.cos(w3), LAM_d, null, manual ? sd : null), zIMG);
        if (hA === null || hB === null) continue;
        pairs.push((hA + hB) / 2);
      }
      distPairs = pairs.length;
      if (distPairs >= 5) {
        var sm = 0;
        for (var k6 = 0; k6 < pairs.length; k6++) sm += pairs[k6];
        dist = (Math.abs(sm / pairs.length) * 1000 / idealPx - 1) * 100;
      }
    }
    /* 边缘余量 MARG = 半口径 − 实际通过的光线高度。
       归零就是"这面正好卡住光束"，再开大光圈/加视场立刻开始掉光线。 */
    var mrg = 1e6;
    for (i = 0; i < NS; i++) {
      var mm2 = sd[i] - maxY[i];
      if (mm2 < mrg) mrg = mm2;
    }
    return {
      R: R, s: s, efl: p.efl, bfd: s[NS - 1].BFD, zIMG: zIMG, g1: gs.g1, g2: g2, g1ok: gs.ok,
      spots: spots, sd: sd, maxY: maxY, marg: mrg, fields: flds, epd: epd, fno: p.efl / epd,
      dist: dist, distPairs: distPairs, idealPx: idealPx, parax: p, len: s[NS - 1].z
    };
  }
  /* imgHit 的 null 安全版：追迹失败或不成像都算"这一条没有" */
  function imgHit0(r, zIMG) { return r ? imgHit(r, zIMG) : null; }
  /* 几何合法性：边缘光线在每片上的边厚必须为正 */
  function geoPenalty(ev) {
    if (!ev) return 1e9;
    var pen = 0, mr = traceRay(ev.s, ev.epd * 0.5, 0, 1, LAM_d);
    if (!mr) return 1e4;
    for (var k = 0; k < 9; k++) {
      var yf = Math.abs(mr.path[2 * k + 1].y), yb = Math.abs(mr.path[2 * k + 2].y);
      var et = S.thick[2 * k] + sagAt(yb, ev.R[2 * k + 1]) - sagAt(yf, ev.R[2 * k]);
      if (et < 0.8) pen += (0.8 - et) * (0.8 - et) * 4000;
    }
    return pen;
  }
  function sagAt(y, R) {
    if (!R || !isFinite(R)) return 0;
    var d = R * R - y * y;
    if (d <= 0) return Math.abs(R);
    return R - Math.sign(R) * Math.sqrt(d);
  }
  var MERIT_INFEASIBLE = 1e12;   // 不可行（光线被渐晕遮挡）的哨兵值，务必远离真实 MerF 量级

  /* ===========================================================================
   * 评价函数：真的按 Merit Function 窗口里那一行行算
   *   MerF = Σ wᵢ · (Operandᵢ − Targetᵢ)²  +  几何罚
   * 每个 Operand 都对应 evaluate() 里一个真能算出来的物理量，改权重/改目标立刻见效。
   * ========================================================================= */
  var MF_OPS = {
    RMSP: { name: 'RMSP · RMS 点列半径', unit: 'µm', arg: '视场号 1/2/3', desc: '该视场三波长合成的 RMS 弥散半径' },
    RMSR: { name: 'RMSR · d 线单色 RMS', unit: 'µm', arg: '视场号 1/2/3', desc: '只看 0.588 µm，把色差从球差里剥出来' },
    EFFL: { name: 'EFFL · 有效焦距', unit: 'mm', arg: '—', desc: '系统 EFL；Target 就是 Zoom 求解要追的目标' },
    MARG: { name: 'MARG · 最小边缘余量', unit: 'mm', arg: '面号 0 = 全部面', desc: '球面口径 |R| 减去光线实际高度，越小越接近渐晕' },
    MNUM: { name: 'MNUM · 光线阻断率', unit: '%', arg: '视场号 1/2/3', desc: '1.0 视场上被挡掉的瞳孔光线百分比' },
    DMVA: { name: 'DMVA · 畸变', unit: '%', arg: '视场号 1/2/3', desc: '近轴像高 / 理想像高 − 1，负值是桶形' }
  };
  var MF_LIST = ['RMSP', 'RMSR', 'EFFL', 'MARG', 'MNUM', 'DMVA'];
  /* 求某一行的操作数当前值；返回 null = 这一项目前算不出来（光线不足/参数非法） */
  function mfValue(op, p, ev) {
    if (!ev) return null;
    var f = Math.round(p || 1) - 1;
    if (f < 0 || f > 2) f = 2;
    var sp = ev.spots[f];
    if (op === 'RMSP') return sp.n >= 8 ? sp.rms : null;
    if (op === 'RMSR') return sp.nD >= 8 ? sp.rmsD : null;
    if (op === 'EFFL') return ev.efl;
    if (op === 'MARG') return ev.marg;
    if (op === 'MNUM') return sp.tot ? (sp.blocked / sp.tot) * 100 : null;
    if (op === 'DMVA') return ev.dist;
    return null;
  }
  function meritOf(ev, rows) {
    if (!ev) return MERIT_INFEASIBLE;
    var rs = rows || (typeof UI !== 'undefined' && UI.meritRows ? UI.meritRows : DEFAULT_MERIT);
    var m = 0, used = 0;
    for (var r = 0; r < rs.length; r++) {
      var row = rs[r];
      if (!row || !MF_OPS[row.op]) continue;
      var w = +row.w || 0;
      if (w <= 0) continue;                       // 权重 0 = 这一行不参与
      var v = mfValue(row.op, +row.p || 0, ev);
      if (v === null || !isFinite(v)) return MERIT_INFEASIBLE;   // 算不出来 = 不可行
      var t = +row.t || 0, d = v - t;
      m += w * d * d;
      used++;
    }
    if (!used) return MERIT_INFEASIBLE + 1;        // 一行都没启用：点优化必然没反应
    return m + geoPenalty(ev);
  }
  /** 评价函数里第一个启用的 EFFL 行 —— 它的 Target 就是 Zoom 求解要追的焦距 */
  function meritEflTarget(rows) {
    var rs = rows || (typeof UI !== 'undefined' && UI.meritRows ? UI.meritRows : DEFAULT_MERIT);
    for (var r = 0; r < rs.length; r++) {
      var row = rs[r];
      if (row && row.op === 'EFFL' && (+row.w || 0) > 0) {
        var t = +row.t || 0;
        if (t > 20) return t;                     // 小于 20mm 的焦距不是本结构能解的，忽略
      }
    }
    return null;
  }
  /* 出厂默认：三个视场的 RMS 都要压 + 锁住焦距 + 一个光都不许被挡（渐晕）。
     权重是"相对优先级"：RMSP 用 µm 量级所以 0.2~0.3，MNUM 是百分数量级所以更小但一
     旦掉一半光线（74% → 0.3·5476 ≈ 1640）就立刻压过所有 RMS 项 —— 这正是我们要的。 */
  var DEFAULT_MERIT = [
    { op: 'RMSP', p: 1, w: 0.30, t: 0 },
    { op: 'RMSP', p: 2, w: 0.25, t: 0 },
    { op: 'RMSP', p: 3, w: 0.20, t: 0 },
    { op: 'EFFL', p: 0, w: 1.00, t: 200 },
    { op: 'MNUM', p: 1, w: 0.30, t: 0 },
    { op: 'MNUM', p: 2, w: 0.25, t: 0 },
    { op: 'MNUM', p: 3, w: 0.30, t: 0 }
  ];
  var ZM = {};   // 模块私有状态容器
  ZM.S = S; ZM.GLASS = GLASS; ZM.evaluate = evaluate; ZM.solveGap1 = solveGap1;
  ZM.fieldAngles = fieldAngles; ZM.radiiOf = radiiOf; ZM.targetEfl = targetEfl;
  ZM.meritOf = meritOf; ZM.geoPenalty = geoPenalty; ZM.sagAt = sagAt;
  ZM.mfValue = mfValue; ZM.meritEflTarget = meritEflTarget;
  ZM.MF_OPS = MF_OPS; ZM.MF_LIST = MF_LIST; ZM.DEFAULT_MERIT = DEFAULT_MERIT;
  ZM.MERIT_INFEASIBLE = MERIT_INFEASIBLE;
  ZM.baseRadius = baseRadius; ZM.paraxial = paraxial; ZM.paraxialU = paraxialU; ZM.traceRay = traceRay;
  ZM.imgHit = imgHit; ZM.LAM_LIST = LAM_LIST; ZM.LAM_COLOR = LAM_COLOR;
  ZM.LAM_NAME = LAM_NAME; ZM.PL = PL; ZM.TT = TT; ZM.ELEM_GLASS = ELEM_GLASS;
  ZM.NS = NS; ZM.GROUP_OF = GROUP_OF; ZM.ELEM_OF = ELEM_OF; ZM.GROUP_NAME = GROUP_NAME;
  ZM.SOLVE_OPTS = SOLVE_OPTS; ZM.GLASS_ORDER = GLASS_ORDER; ZM.PERT_OPT = PERT_OPT;
  ZM.G2_OPT = G2_OPT; ZM.G2_FACTORY = G2_FACTORY;
  ZM.LAMBDA = LAMBDA; ZM.buildSurfs = buildSurfs;
  /* ===========================================================================
   * 5. 三维场景（全部程序化生成，不加载任何外部文件）
   * ======================================================================== */
  function sagZ(r, R) {   // 球面矢高：顶点为 0
    if (!R || !isFinite(R)) return 0;
    var d = R * R - r * r; if (d < 0) d = 0;
    return R - Math.sign(R) * Math.sqrt(d);
  }
  function makeLabel(text, color) {
    var cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    var g = cv.getContext('2d');
    g.fillStyle = 'rgba(13,16,21,0.82)';
    g.fillRect(0, 8, 256, 48);
    g.strokeStyle = color || '#7c6cf0'; g.lineWidth = 2;
    g.strokeRect(1, 9, 254, 46);
    g.fillStyle = color || '#cfd6e2';
    g.font = 'bold 26px Consolas, monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 128, 33);
    var tex = new THREE.CanvasTexture(cv);
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sp.scale.set(46, 11.5, 1);
    return sp;
  }
  function buildScene(vp, ev) {
    if (!vp || !vp.scene || vp.unavailable) return null;
    var root = new THREE.Group();
    vp.scene.add(root);
    var glassMats = {};
    GLASS_ORDER.forEach(function (gn) {
      var col = { 'N-BK7': 0x9fd8ff, 'N-SF5': 0xffd9a0, 'N-LAK8': 0xc9b6ff, 'N-SK16': 0xb8ecff, 'N-F2': 0xffc4a8, 'N-BAF10': 0xffe0a0 }[gn] || 0xaaccff;
      glassMats[gn] = new THREE.MeshStandardMaterial({
        color: col, metalness: 0.05, roughness: 0.08,
        transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false
      });
    });
    var rimMat = new THREE.MeshStandardMaterial({ color: 0x2c333d, metalness: 0.75, roughness: 0.32 });
    /* 9 片镜片：LatheGeometry 旋转成型 */
    var lensMeshes = [];
    for (var k = 0; k < 9; k++) {
      var gn = ELEM_GLASS[k];
      var mat = glassMats[gn].clone();
      var mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
      mesh.userData.elem = k;
      root.add(mesh); lensMeshes.push(mesh);
    }
    /* 镜筒 */
    var barrel = new THREE.Group();
    for (var bi = 0; bi < 3; bi++) {
      var ring = new THREE.Mesh(new THREE.CylinderGeometry(0.001, 0.001, 1, 40, 1, true), rimMat);
      ring.rotation.x = Math.PI / 2; ring.userData.band = bi;
      barrel.add(ring);
    }
    root.add(barrel);
    /* 光轴 */
    var axis = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 1, 8),
      new THREE.MeshBasicMaterial({ color: 0x4a5566, transparent: true, opacity: 0.55 }));
    axis.rotation.x = Math.PI / 2; root.add(axis);
    /* 光线 */
    var rayGeo = new THREE.BufferGeometry();
    var rayMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.92 });
    var rays = new THREE.LineSegments(rayGeo, rayMat); root.add(rays);
    /* 像面与焦点标记 */
    var imgPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0x7c6cf0, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
    root.add(imgPlane);
    var imgRing = new THREE.Mesh(new THREE.TorusGeometry(1, 0.35, 6, 40),
      new THREE.MeshBasicMaterial({ color: 0x7c6cf0 })); root.add(imgRing);
    var objLab = makeLabel('OBJ ∞', '#9aa5b4'); root.add(objLab);
    var imgLab = makeLabel('IMG', '#7c6cf0'); root.add(imgLab);
    var focusDot = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xffe066 })); root.add(focusDot);

    return {
      root: root, lens: lensMeshes, barrel: barrel, rays: rays,
      imgPlane: imgPlane, imgRing: imgRing, objLab: objLab, imgLab: imgLab,
      focusDot: focusDot, axis: axis, glassMats: glassMats
    };
  }
  function updateScene(sc, ev, selElem) {
    if (!sc || !ev) return;
    var s = ev.s, R = ev.R;
    for (var k = 0; k < 9; k++) {
      var iF = 2 * k, iB = 2 * k + 1;
      var h = Math.max(4, ev.sd[iF] + 1.5);
      var pts = [], NSEG = 26;
      pts.push(new THREE.Vector2(0, sagZ(0, R[iF])));
      for (var i = 1; i <= NSEG; i++) { var r = h * i / NSEG; pts.push(new THREE.Vector2(r, sagZ(r, R[iF]))); }
      for (var i2 = NSEG; i2 >= 0; i2--) { var r2 = h * i2 / NSEG; pts.push(new THREE.Vector2(r2, s[iB].z - s[iF].z + sagZ(r2, R[iB]))); }
      var geo = new THREE.LatheGeometry(pts, 56);
      var old = sc.lens[k];
      if (old.geometry) old.geometry.dispose();
      old.geometry = geo;
      old.rotation.x = Math.PI / 2;
      old.position.z = s[iF].z;
      var m = old.material;
      m.opacity = (selElem === k) ? 0.78 : 0.40;
      m.emissive = new THREE.Color(selElem === k ? 0x3a3070 : 0x000000);
    }
    /* 镜筒：沿光轴三段 */
    var bands = [[s[0].z - 14, s[5].z + 2], [s[6].z - 2, s[11].z + 2], [s[12].z - 2, ev.zIMG]];
    for (var b = 0; b < 3; b++) {
      var ring = sc.barrel.children[b];
      if (!ring) continue;
      var z0 = bands[b][0], z1 = bands[b][1], len = Math.max(4, z1 - z0);
      if (ring.geometry) ring.geometry.dispose();
      ring.geometry = new THREE.CylinderGeometry(1, 1, 1, 40, 1, true);
      ring.scale.set(48, len, 48);
      ring.position.z = (z0 + z1) / 2;
    }
    sc.axis.scale.y = (ev.zIMG + 60);
    sc.axis.position.z = ev.zIMG / 2;
    /* 光线：子午面内追迹后绕光轴旋转成 3D 光束 */
    var pos = [], col = [];
    var lams = S.wlMode === 'all' ? LAM_LIST : [LAM_LIST[+S.wlMode]];
    var lcol = S.wlMode === 'all' ? LAM_COLOR : [LAM_COLOR[+S.wlMode]];
    var fan = [0.0, 0.5, 0.82, 1.0];
    var az = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    if (S.showRays) {
      for (var f = 0; f < 3; f++) {
        var w = ev.fields[f] * Math.PI / 180;
        for (var li = 0; li < lams.length; li++) {
          for (var fi = 0; fi < fan.length; fi++) {
            var y0 = ev.epd * 0.5 * fan[fi];
            var rr = traceRay(s, y0, -Math.sin(w), Math.cos(w), lams[li]);
            if (!rr) continue;
            for (var a = 0; a < az.length; a++) {
              var ca = Math.cos(az[a]), sa = Math.sin(az[a]);
              for (var q = 0; q < rr.path.length - 1; q++) {
                var p1 = rr.path[q], p2 = rr.path[q + 1];
                pos.push(p1.y * ca, p1.y * sa, p1.z, p2.y * ca, p2.y * sa, p2.z);
                for (var cc = 0; cc < 2; cc++) {
                  var c6 = lcol[li];
                  col.push(((c6 >> 16) & 255) / 255, ((c6 >> 8) & 255) / 255, (c6 & 255) / 255);
                }
              }
            }
          }
        }
      }
    }
    var rg = sc.rays.geometry;
    rg.dispose();
    var ng = new THREE.BufferGeometry();
    ng.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    ng.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    sc.rays.geometry = ng;
    /* 像面 */
    var iw = 74;
    sc.imgPlane.scale.set(iw, iw, 1);
    sc.imgPlane.position.z = ev.zIMG;
    sc.imgRing.scale.set(iw * 0.16, iw * 0.16, iw * 0.16);
    sc.imgRing.position.z = ev.zIMG;
    sc.objLab.position.set(0, 44, s[0].z - 18);
    sc.imgLab.position.set(0, 52, ev.zIMG);
    /* 焦点位置：取当前视场 RMS 最小的近轴焦点附近 */
    var fz = ev.zIMG;
    sc.focusDot.scale.set(2.4, 2.4, 2.4);
    sc.focusDot.position.set(0, 0, fz);
    return sc;
  }
  /* ===========================================================================
   * 6. 分析画布：点列图 / MTF / 像面小屏
   * ======================================================================== */
  function fitCanvas(cv) {
    var w = cv.clientWidth || 200, h = cv.clientHeight || 140;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    var g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    return { g: g, w: w, h: h };
  }
  var FCOL = ['#8ad6ff', '#ffd166', '#ff7a7a'];
  function drawSpot(cv, ev, fieldIdx) {
    var c = fitCanvas(cv), g = c.g, w = c.w, h = c.h;
    g.fillStyle = '#0d1015'; g.fillRect(0, 0, w, h);
    if (!ev) return;
    var sp = ev.spots[fieldIdx];
    var cx = w / 2, cy = h / 2;
    /* 自适应量程 */
    var mx = 0.001;
    for (var f = 0; f < 3; f++) if (ev.spots[f].pts && ev.spots[f].pts.length) {
      for (var i = 0; i < ev.spots[f].pts.length; i++) mx = Math.max(mx, Math.abs(ev.spots[f].pts[i].x - ev.spots[f].mean));
    }
    var R = mx * 1.25 || 0.01;                 // mm
    var sc = Math.min(w, h) / 2 / R;
    /* 刻度圈 */
    g.strokeStyle = '#2b323d'; g.lineWidth = 1;
    for (var r = 1; r <= 3; r++) {
      g.beginPath(); g.arc(cx, cy, (Math.min(w, h) / 2) * r / 3, 0, 6.2832); g.stroke();
    }
    g.strokeStyle = '#3a4350';
    g.beginPath(); g.moveTo(cx - 8, cy); g.lineTo(cx + 8, cy); g.moveTo(cx, cy - 8); g.lineTo(cx, cy + 8); g.stroke();
    /* 光点 */
    for (var f2 = 0; f2 < 3; f2++) {
      var pts = ev.spots[f2].pts || [];
      for (var j = 0; j < pts.length; j++) {
        var p = pts[j];
        g.fillStyle = FCOL[p.lam] || '#fff';
        g.globalAlpha = 0.55;
        g.beginPath();
        g.arc(cx + (p.x - ev.spots[f2].mean) * sc, cy, 1.25, 0, 6.2832);
        g.fill();
      }
    }
    g.globalAlpha = 1;
    /* 读数 */
    g.fillStyle = '#9aa5b4'; g.font = '11px Consolas, monospace'; g.textAlign = 'left';
    g.fillText('量程 ±' + (R * 1000).toFixed(0) + ' µm', 6, 14);
    g.textAlign = 'right';
    g.fillText('Field ' + (fieldIdx + 1) + '  ' + sp.ang.toFixed(2) + '°', w - 6, 14);
    g.textAlign = 'left';
    g.fillStyle = sp.n < 8 ? '#e05c5c' : '#dfe4ea';
    g.fillText('RMS ' + (sp.n < 8 ? '—' : sp.rms.toFixed(1) + ' µm'), 6, h - 8);
    g.fillStyle = '#6b7686';
    g.fillText('光线 ' + sp.n + '/' + sp.tot + '  渐晕 ' + (100 * sp.n / sp.tot).toFixed(0) + '%', 6, h - 22);
  }
  function mtfGeo(sigmaMM, f, lamUM, fno) {
    var v = f * lamUM * 1e-3 * fno;            // f·λ·F/D
    if (v >= 1) return 0;
    var dif = (2 / Math.PI) * (Math.acos(v) - v * Math.sqrt(1 - v * v));
    var geo = Math.exp(-2 * Math.PI * Math.PI * sigmaMM * sigmaMM * f * f);
    return Math.max(0, Math.min(1, dif * geo));
  }
  function drawMTF(cv, ev) {
    var c = fitCanvas(cv), g = c.g, w = c.w, h = c.h;
    g.fillStyle = '#0d1015'; g.fillRect(0, 0, w, h);
    var L = 34, Rm = 10, T = 12, B = 22;
    var pw = w - L - Rm, ph = h - T - B;
    g.strokeStyle = '#2b323d'; g.lineWidth = 1;
    g.fillStyle = '#6b7686'; g.font = '10px Consolas, monospace'; g.textAlign = 'right';
    for (var i = 0; i <= 5; i++) {
      var y = T + ph * i / 5;
      g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke();
      g.fillText((100 - i * 20).toFixed(0), L - 5, y + 3);
    }
    g.textAlign = 'center';
    for (var f2 = 0; f2 <= 5; f2++) {
      var x = L + pw * f2 / 5;
      g.strokeStyle = '#232a33';
      g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke();
      g.fillText((f2 * 20).toFixed(0), x, h - 7);
    }
    g.fillStyle = '#6b7686'; g.textAlign = 'left';
    g.fillText('空间频率 lp/mm', L, h - 7 + 0);
    /* 30 lp/mm 参考线 */
    var x30 = L + pw * 30 / 100;
    g.strokeStyle = '#7c6cf0aa'; g.setLineDash([4, 3]);
    g.beginPath(); g.moveTo(x30, T); g.lineTo(x30, T + ph); g.stroke();
    g.setLineDash([]);
    if (!ev) return;
    var lamUM = 0.5876;
    for (var fi = 0; fi < 3; fi++) {
      var sp = ev.spots[fi];
      var sig = (sp.n >= 8 ? sp.rms : 3000) / 1000;
      g.strokeStyle = FCOL[fi]; g.lineWidth = 1.6; g.beginPath();
      for (var k = 0; k <= 100; k++) {
        var fr = k;                                    // lp/mm
        var v = mtfGeo(sig, fr, lamUM, ev.fno);
        var xx = L + pw * fr / 100, yy = T + ph * (1 - v);
        if (k === 0) g.moveTo(xx, yy); else g.lineTo(xx, yy);
      }
      g.stroke();
    }
    g.fillStyle = '#dfe4ea'; g.textAlign = 'right'; g.font = '10px Consolas, monospace';
    g.fillText('F/' + ev.fno.toFixed(2) + '  EFL ' + ev.efl.toFixed(1), w - 6, T + 10);
  }
  /* 像面小屏：三个波长在像面的落点随离焦移动 */
  function drawMonitor(cv, ev, defocus) {
    var c = fitCanvas(cv), g = c.g, w = c.w, h = c.h;
    g.fillStyle = '#0d1015'; g.fillRect(0, 0, w, h);
    if (!ev) return;
    var half = 0.35;                                   // ±0.35mm 视窗 (mm)
    var cx = w / 2, sc = (w / 2 - 8) / half;
    g.strokeStyle = '#2b323d';
    g.beginPath(); g.moveTo(0, cx * 0 + h / 2 - 0.5); g.lineTo(w, h / 2 - 0.5); g.stroke();
    g.strokeStyle = '#7c6cf066';
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    g.fillStyle = '#6b7686'; g.font = '10px Consolas, monospace'; g.textAlign = 'left';
    g.fillText('像面横截面  ±350 µm', 5, 12);
    var w0 = ev.fields[0] * Math.PI / 180;
    for (var li = 0; li < 3; li++) {
      for (var k = 0; k < PL.length; k++) {
        var y0 = ev.epd * 0.5 * PL[k];
        var r = traceRay(ev.s, y0, -Math.sin(w0), Math.cos(w0), LAM_LIST[li]);
        if (!r) continue;
        var yi = imgHit(r, ev.zIMG);
        if (yi === null) continue;
        var x = cx + Math.max(-half, Math.min(half, yi)) * sc;
        g.fillStyle = FCOL[li]; g.globalAlpha = 0.9;
        g.fillRect(x - 0.8, h / 2 - 7 - li * 0, 1.6, 14);
      }
    }
    g.globalAlpha = 1;
    g.fillStyle = '#9aa5b4';
    g.fillText('红/黄/蓝 = 656/588/486 nm', 5, h - 6);
    if (defocus) { g.fillStyle = '#e0a33c'; g.textAlign = 'right'; g.fillText('离焦 ' + defocus.toFixed(2) + ' mm', w - 5, 12); }
  }
  /* ===========================================================================
   * 7. 界面
   * ======================================================================== */
  var UI = {};
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function fmtR(v) {
    if (v === 0 || !isFinite(v)) return 'Infinity';
    return (Math.abs(v) >= 1000 ? v.toFixed(1) : v.toFixed(3));
  }

  function buildUI(ctx) {
    var api = ctx.api, root = ctx.root;
    var st = ZM.S;
    /* 私有样式的作用域锚点：所有 .zem-* 规则都挂在 #zem-module 下面，
       不会漏到别的模块去（ Zemax 是三个模块里唯一还没做限定的） */
    root.id = 'zem-module';
    root.innerHTML =
      '<div class="menu-bar zem-menu">' +
      '  <span class="menu-item" data-m="File">File</span><span class="menu-item" data-m="Edit">Edit</span>' +
      '  <span class="menu-item is-on" data-m="System">System</span><span class="menu-item" data-m="Lens">Lens</span>' +
      '  <span class="menu-item" data-m="Analysis">Analysis</span><span class="menu-item" data-m="Optimize">Optimize</span>' +
      '</div>' +
      '<div class="ribbon zem-ribbon">' +
      '  <div class="ribbon-group">' +
      '    <button class="ribbon-btn is-on" data-act="sysopt"><span class="ico">◎</span>系统选项</button>' +
      '    <button class="ribbon-btn" data-act="lde"><span class="ico">▤</span>镜头数据</button>' +
      '    <button class="ribbon-btn" data-act="layout"><span class="ico">◫</span>3D 布局</button>' +
      '  </div>' +
      '  <div class="ribbon-group">' +
      '    <button class="ribbon-btn" data-act="trace"><span class="ico">✳</span>单光线追迹</button>' +
      '    <button class="ribbon-btn" data-act="ffd"><span class="ico">ƒ</span>一阶性质</button>' +
      '    <button class="ribbon-btn" data-act="glass"><span class="ico">⌕</span>玻璃目录</button>' +
      '  </div>' +
      '  <div class="ribbon-group">' +
      '    <button class="ribbon-btn" data-act="spot"><span class="ico">⁘</span>点列图</button>' +
      '    <button class="ribbon-btn" data-act="mtf"><span class="ico">📈</span>MTF</button>' +
      '    <button class="ribbon-btn" data-act="merit"><span class="ico">Σ</span>评价函数</button>' +
      '  </div>' +
      '  <div class="ribbon-group">' +
      '    <button class="ribbon-btn" data-act="opt"><span class="ico">▶</span>开始优化</button>' +
      '    <button class="ribbon-btn" data-act="reset"><span class="ico">↺</span>恢复初始</button>' +
      '    <button class="ribbon-btn" data-act="optload"><span class="ico">★</span>已优化处方</button>' +
      '  </div>' +
      '</div>' +
      '<div class="zem-body">' +
      '  <div class="zem-sysexplorer props">' +
      '    <div class="props-title">System Explorer</div>' +
      '    <div class="zem-tabs">' +
      '      <button class="zem-tab is-on" data-tab="ap">Aperture</button>' +
      '      <button class="zem-tab" data-tab="wl">波长</button>' +
      '      <button class="zem-tab" data-tab="fd">视场</button>' +
      '    </div>' +
      '    <div class="zem-tabbody" id="zemTabBody"></div>' +
      '  </div>' +
      '  <div class="zem-center">' +
      '    <div class="zem-lde-wrap">' +
      '      <div class="zem-lde-hd">Lens Data Editor<span class="spacer"></span>' +
      '        <span class="muted" id="zemLdeHint">点击行选中镜片 · 单元格可直接改写</span></div>' +
      '      <div class="zem-lde" id="zemLde"></div>' +
      '    </div>' +
      '    <div class="zem-vp-row">' +
      '      <div class="viewport" id="zemVp"></div>' +
      '      <div class="zem-vp-btns">' +
      '        <button class="btn btn-sm" data-view="side">侧视</button>' +
      '        <button class="btn btn-sm" data-view="top">俯视</button>' +
      '        <button class="btn btn-sm" data-view="iso">轴测</button>' +
      '        <button class="btn btn-sm" data-act="rays">光线</button>' +
      '      </div>' +
      '    </div>' +
      '    <div class="zem-drawer" id="zemDrawer">' +
      '      <div class="zem-drawer-hd"><span id="zemDrawerTitle">分析窗口</span>' +
      '        <span class="spacer"></span>' +
      '        <button class="btn btn-sm btn-ghost" id="zemDrawerClose">收起 ×</button></div>' +
      '      <div class="zem-drawer-bd" id="zemDrawerBody"></div>' +
      '    </div>' +
      '  </div>' +
      '  <div class="zem-right props">' +
      '    <div class="props-title">视口控制 / 读数</div>' +
      '    <div class="group"><div class="group-hd">变焦与光圈</div><div id="zemSliders"></div></div>' +
      '    <div class="group"><div class="group-hd">选中面 <span id="zemSelName" class="muted">未选中</span></div>' +
      '      <div id="zemSelCtl"></div></div>' +
      '    <div class="group"><div class="group-hd">一阶性质 FFD</div><div id="zemFfd"></div></div>' +
      '    <div class="group"><div class="group-hd">像面小屏</div>' +
      '      <canvas id="zemMon" style="width:100%;height:96px;border:1px solid var(--line);border-radius:4px"></canvas></div>' +
      '    <div class="group"><div class="group-hd">状态</div><div id="zemStatusBox"></div></div>' +
      '  </div>' +
      '</div>';

    UI.root = root; UI.api = api;
    UI.optimizing = false;          // 优化器重入保护，见 optimize()
    UI.vpEl = root.querySelector('#zemVp');
    UI.lde = root.querySelector('#zemLde');
    UI.tabBody = root.querySelector('#zemTabBody');
    UI.sliders = root.querySelector('#zemSliders');
    UI.selCtl = root.querySelector('#zemSelCtl');
    UI.ffd = root.querySelector('#zemFfd');
    UI.statusBox = root.querySelector('#zemStatusBox');
    UI.mon = root.querySelector('#zemMon');
    UI.drawer = root.querySelector('#zemDrawer');
    UI.drawerBody = root.querySelector('#zemDrawerBody');
    UI.drawerTitle = root.querySelector('#zemDrawerTitle');
    UI.selName = root.querySelector('#zemSelName');
    UI.tab = 'ap';
    UI.sel = -1;
    UI.field = 0;
    /* 评价函数默认行：三个视场各一条 RMSP（都要压）+ 一条 EFFL（锁焦距）
       + 三条 MNUM（一个光都不许被挡）。meritOf() 逐行真算，改哪列都立刻见效。 */
    UI.meritRows = DEFAULT_MERIT.map(function (r) { return { op: r.op, p: r.p, w: r.w, t: r.t }; });
    UI.vars = {};
    for (var i = 0; i < NS; i++) UI.vars[i] = st.solve[i] === 'Variable';
    UI.optTimer = null; UI.optInterrupted = false;

    var vp = api.setViewport(UI.vpEl, {
      position: [40, 120, 320], target: [0, 0, 110], fov: 34,
      color: 0x171b21, fogNear: 600, fogFar: 2600, gridSize: 700, gridDiv: 70, groundY: -95,
      minDist: 60, maxDist: 1400
    });
    UI.vp = vp;
    if (vp && vp.scene && !vp.unavailable) {
      vp.camera.near = 40; vp.camera.far = 2400; vp.camera.updateProjectionMatrix();
      vp.controls.target.set(0, 0, 110);
      ZM.scene = buildScene(vp, ZM.evaluate());
    }
    root.querySelector('#zemDrawerClose').onclick = function () { UI.drawerOpen = false; layout(); refresh(true); };
    bindUI();
    return UI;
  }
  function layout() {
    if (!UI.root) return;
    var open = UI.drawerOpen;
    UI.drawer.style.height = open ? '236px' : '0px';
    UI.drawer.style.display = open ? '' : 'none';
    if (UI.vp && UI.vp.resize) setTimeout(function () { if (UI.vp.resize) UI.vp.resize(); }, 30);
  }
  /* ---- LDE 表格 ---- */
  function buildLDE(ev) {
    var st = ZM.S, h = ['#', 'R', 'T', 'Glass', 'Semi-D', 'Conic', 'Solve'];
    var html = '<table class="zem-lde-t"><tr>';
    h.forEach(function (x) { html += '<th>' + x + '</th>'; });
    html += '</tr>';
    html += '<tr class="is-obj"><td>OBJ</td><td>∞</td><td>' + (ev ? ev.s[0].z.toFixed(2) : '∞') +
      '</td><td></td><td></td><td></td><td></td></tr>';
    for (var i = 0; i < NS; i++) {
      var sel = (UI.sel === i) ? ' class="is-sel"' : '';
      var gname = st.solve[i] === 'Zoom' ? 'Zoom' : (i === NS - 1 ? 'Focus' : (UI.vars[i] ? 'Variable' : 'Fix'));
      html += '<tr' + sel + ' data-i="' + i + '">' +
        '<td class="c1">' + (i + 1) + (GROUP_OF[i] !== GROUP_OF[i - 1] ? ' <b class="zem-grp">G' + (GROUP_OF[i] + 1) + '</b>' : '') + '</td>' +
        '<td class="num" data-k="R">' + (ev ? fmtR(ev.R[i]) : '') + '</td>' +
        '<td class="num" data-k="T">' + (ev ? ev.s[i].t.toFixed(2) : '') + '</td>' +
        '<td data-k="G">' + (i % 2 === 0 ? ELEM_GLASS[i >> 1] : '') + '</td>' +
        '<td class="num" data-k="D">' + (ev ? ev.sd[i].toFixed(2) : '') + '</td>' +
        '<td data-k="C">0</td>' +
        '<td data-k="S"><span class="zem-solve ' + (gname === 'Fix' ? '' : 'is-var') + '">' + (SOLVE_OPTS[gname] || gname) + '</span></td>' +
        '</tr>';
    }
    html += '<tr class="is-img"><td>IMG</td><td>—</td><td>' + (ev ? (ev.s[NS - 1].z + ev.s[NS - 1].t).toFixed(2) : '') +
      '</td><td></td><td></td><td></td><td></td></tr></table>';
    UI.lde.innerHTML = html;
    var rows = UI.lde.querySelectorAll('tr[data-i]');
    for (var r = 0; r < rows.length; r++) (function (tr) {
      tr.onclick = function (e) {
        var k = e.target.getAttribute('data-k');
        UI.sel = +tr.getAttribute('data-i');
        if (k === 'S') { cycleSolve(UI.sel); return; }
        if (k === 'R') { editCell(+tr.getAttribute('data-i'), 'R'); return; }
        if (k === 'T') { editCell(+tr.getAttribute('data-i'), 'T'); return; }
        if (k === 'G') { pickGlass(+tr.getAttribute('data-i')); return; }
        if (k === 'D') { editSemiD(+tr.getAttribute('data-i')); return; }
        buildSelCtl(); refresh(true);
      };
    })(rows[r]);
  }
  /** 半口径是真正的光阑：改小它，光线会被这面挡掉（点列图上就是渐晕） */
  function editSemiD(i) {
    var auto = ZM.S.semiD[i] <= 0;
    var cur = (UI.ev && UI.ev.sd[i]) ? UI.ev.sd[i] : 0;
    var v = window.prompt('Surf ' + (i + 1) + '  Semi-Diameter (mm)\n' +
      '当前：' + (auto ? '自动 ' : '手动 ') + cur.toFixed(2) + '\n填 0 = 回到自动（照着光线包络给）',
      cur.toFixed(2));
    if (v === null) return;
    v = parseFloat(v);
    if (!isFinite(v) || v < 0) { UI.api.toast('半口径请填一个 ≥ 0 的数', 'warn'); return; }
    if (v > 0 && v < 2) { UI.api.toast('半口径小于 2mm 会把所有光线都挡掉', 'err'); return; }
    ZM.S.semiD[i] = v;
    log('LDE edit : Surf ' + (i + 1) + '  Semi-Diameter = ' + (v > 0 ? v.toFixed(2) : 'Auto') +
      (v > 0 ? '  (manual clear aperture)' : '  (auto from ray envelope)'));
    refresh(true);
  }
  function cycleSolve(i) {
    var cur = ZM.S.solve[i];
    if (i === 5) { ZM.S.solve[5] = 'Zoom'; UI.api.toast('第 6 面 Thickness 已设为 Zoom（缩放）—— 变焦滑块驱动的就是它', 'ok'); }
    else if (i === NS - 1) { ZM.S.solve[NS - 1] = 'Focus'; UI.api.toast('末面 Thickness 已设为近轴聚焦求解', 'ok'); }
    else { var nx = (cur === 'Variable') ? 'Fix' : 'Variable'; setVar(i, nx === 'Variable'); }
    log('Set Solve Type : Surf ' + (i + 1) + ' = ' + (ZM.S.solve[i] === 'Zoom' ? 'Zoom' : ZM.S.solve[i] === 'Focus' ? 'Paraxial Focus' : (UI.vars[i] ? 'Variable' : 'Fixed')));
    refresh(true);
  }
  /** UI.vars 与 S.solve 必须一起改，否则 LDE 显示与优化器判断会各说各话 */
  function setVar(i, on) {
    UI.vars[i] = !!on;
    if (i !== 5 && i !== NS - 1) ZM.S.solve[i] = on ? 'Variable' : 'Fix';
  }
  function editCell(i, kind) {
    var cur = kind === 'R' ? (UI.ev ? UI.ev.R[i] : 0) : (UI.ev ? UI.ev.s[i].t : 0);
    var v = window.prompt('Surf ' + (i + 1) + '  ' + (kind === 'R' ? 'Radius (mm)' : 'Thickness (mm)') + '\n当前值 ' + cur.toFixed(3), cur.toFixed(3));
    if (v === null) return;
    v = parseFloat(v);
    if (!isFinite(v)) { UI.api.toast('请输入一个数字', 'warn'); return; }
    if (kind === 'R') {
      if (v === 0) { UI.api.toast('半径填 0 表示无穷大（平面镜）', 'info'); ZM.S.pert[i] = 1e-6; }
      else ZM.S.pert[i] = v / ZM.baseRadius(i);
    } else {
      if (i === 5) { UI.api.toast('第 6 面厚度由 Zoom 求解接管，请拖动变焦滑块', 'warn'); return; }
      if (i === NS - 1) { UI.api.toast('末面厚度是近轴焦距，由系统自动求解', 'warn'); return; }
      if (v < 0.4) { UI.api.toast('厚度太小，镜片会自相割裂', 'err'); return; }
      ZM.S.thick[i] = v;
    }
    log('LDE edit : Surf ' + (i + 1) + '  ' + kind + ' = ' + v);
    refresh(true);
  }
  function pickGlass(i) {
    if (i % 2 !== 0) { UI.api.toast('只有元件的正面那一行才有 Material', 'info'); return; }
    var list = GLASS_ORDER.join('\n');
    var g = window.prompt('Surf ' + (i + 1) + ' Material：\n' + list + '\n（留空 = 空气）', ELEM_GLASS[i >> 1]);
    if (g === null) return;
    g = g.trim().toUpperCase();
    if (g === '') { ZM.S.thick[i] = ZM.S.thick[i]; ELEM_GLASS[i >> 1] = 'N-BK7'; }
    if (!GLASS[g]) { UI.api.toast('玻璃目录里没有 ' + g + '，已退回原玻璃', 'err'); return; }
    ELEM_GLASS[i >> 1] = g;
    log('LDE edit : Surf ' + (i + 1) + '  Material = ' + g);
    refresh(true);
  }
  /* ---- System Explorer ---- */
  function buildSysEx(ev) {
    var st = ZM.S, b = UI.tabBody, h = '';
    if (UI.tab === 'ap') {
      h += '<div class="field"><label>入瞳直径</label><input class="input" id="zemEpd" value="' + (ev ? ev.epd.toFixed(2) : '35.00') + '"></div>';
      h += '<div class="field"><label>光圈 F/</label><input class="input" id="zemFno" value="' + (ev ? ev.fno.toFixed(2) : '5.70') + '"></div>';
      h += '<div class="field"><label>光圈模式</label><select class="select" id="zemApMode">' +
        '<option value="fno">恒定 F 数（EPD 随焦距缩放）</option><option value="fixed">固定 EPD（变光圈）</option></select></div>';
      h += '<div class="field"><label>Stop 面</label><select class="select" id="zemStop">' +
        '<option value="11">Surf 11（变倍组后）</option><option value="5">Surf 6（变倍组前）</option><option value="0">Surf 1（入瞳）</option></select></div>';
      h += '<div class="field"><label>物距</label><input class="input" value="Infinity" readonly></div>';
      h += '<div class="divider"></div><div class="kv"><span>当前焦距</span><span>' + (ev ? ev.efl.toFixed(2) + ' mm' : '—') + '</span></div>';
      h += '<div class="kv"><span>实际 F 数</span><span>' + (ev ? 'F/' + ev.fno.toFixed(2) : '—') + '</span></div>';
      h += '<div class="kv"><span>衍射极限</span><span>' + (ev ? (1 / (0.000588 * ev.fno)).toFixed(0) + ' lp/mm' : '—') + '</span></div>';
    } else if (UI.tab === 'wl') {
      h += '<table class="zem-wt"><tr><th>λ (µm)</th><th>Primary</th></tr>';
      for (var i = 0; i < 3; i++) {
        h += '<tr><td>' + LAM_LIST[i].toFixed(3) + '</td><td>' + (i === 1 ? '☑' : '☐') + '</td></tr>';
      }
      h += '</table>';
      h += '<div class="field" style="margin-top:8px"><label>显示波长</label><select class="select" id="zemWl">' +
        '<option value="all">三色全显示</option>' +
        '<option value="0">仅 0.656 µm（红）</option>' +
        '<option value="1">仅 0.588 µm（黄）</option>' +
        '<option value="2">仅 0.486 µm（蓝）</option></select></div>';
      h += '<div class="divider"></div><div class="muted" style="font-size:11px;line-height:1.6">' +
        'λ 单位是 <b>µm</b>。填 486 会把 0.486µm 放大一千倍，折射率全错。</div>';
    } else {
      h += '<div class="field"><label>视场类型</label><select class="select" id="zemFMode">' +
        '<option value="height">物方像高 (mm)</option><option value="angle">物方角度 (deg)</option></select></div>';
      h += '<div class="field"><label>全视场 ω</label><input class="input" id="zemImgH" value="' + st.imgH.toFixed(2) + '"></div>';
      h += '<div class="divider"></div><div class="zem-frow"><span>0.0 ω</span><span id="zemF0">—</span></div>';
      h += '<div class="zem-frow"><span>0.7 ω</span><span id="zemF1">—</span></div>';
      h += '<div class="zem-frow"><span>1.0 ω</span><span id="zemF2">—</span></div>';
      h += '<div class="divider"></div><div class="muted" style="font-size:11px;line-height:1.6">' +
        '长焦的物在无穷远，用<b>角度</b>更自然；本模块默认按<b>像高</b>给，换算式 ω=arctan(h/f)，' +
        '所以 200mm 端视场角小（约 6.2°）、125mm 端大（约 9.8°）——和真实变焦一样。</div>';
    }
    b.innerHTML = h;
    var epd = b.querySelector('#zemEpd'), fn = b.querySelector('#zemFno'), ap = b.querySelector('#zemApMode');
    if (ap) { ap.value = st.aperture; ap.onchange = function () { st.aperture = ap.value; refresh(true); }; }
    if (epd) epd.onchange = function () {
      var v = parseFloat(epd.value);
      if (!isFinite(v) || v < 5 || v > 90) { UI.api.toast('入瞳直径请填 5–90 mm', 'warn'); return; }
      st.aperture = 'fixed'; st.epd = v; st.fstop = (ev ? ev.efl : 200) / v;
      log('System Explorer > Aperture : Entrance Pupil Diameter = ' + v.toFixed(2) + ' mm  (mode switched to fixed)');
      refresh(true);
    };
    if (fn) fn.onchange = function () {
      var v = parseFloat(fn.value);
      if (!isFinite(v) || v < 1.4 || v > 16) { UI.api.toast('F 数请填 1.4–16', 'warn'); return; }
      st.fstop = v; st.aperture = 'fno';
      log('System Explorer > Aperture : F/# = ' + v + '  (constant-aperture zoom)');
      refresh(true);
    };
    var wl = b.querySelector('#zemWl'); if (wl) { wl.value = st.wlMode; wl.onchange = function () { st.wlMode = wl.value; refresh(true); }; }
    var fm = b.querySelector('#zemFMode'); if (fm) { fm.value = st.fieldMode; fm.onchange = function () { st.fieldMode = fm.value; refresh(true); }; }
    var ih = b.querySelector('#zemImgH');
    if (ih) ih.onchange = function () {
      var v = parseFloat(ih.value);
      if (!isFinite(v) || v <= 0) { UI.api.toast('请填一个正的视场值', 'warn'); return; }
      st.imgH = v; log('System Explorer > Fields : ' + (st.fieldMode === 'angle' ? v.toFixed(2) + ' deg' : v.toFixed(2) + ' mm'));
      refresh(true);
    };
    if (ev) {
      var f0 = b.querySelector('#zemF0'), f1 = b.querySelector('#zemF1'), f2 = b.querySelector('#zemF2');
      if (f0) { f0.textContent = ev.fields[0].toFixed(2) + '°'; f1.textContent = ev.fields[1].toFixed(2) + '°'; f2.textContent = ev.fields[2].toFixed(2) + '°'; }
    }
  }
  /* ---- 右侧滑块与读数 ---- */
  function slider(id, label, min, max, step, val, fmt, onch) {
    return '<div class="zem-sl"><div class="zem-sl-hd"><span>' + label + '</span><b id="' + id + 'v">' + fmt(val) + '</b></div>' +
      '<input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '"></div>';
  }
  function buildSliders(ev) {
    var st = ZM.S, efl = ev ? ev.efl : 200;
    var h = '';
    h += slider('zemZoom', '变焦位置（焦距）', 0, 1, 0.002, st.zoomPos,
      function (v) { return targetEfl().toFixed(1) + ' mm'; }, null);
    h += slider('zemEpdS', '入瞳直径 EPD（固定模式）', 12, 71.5, 0.5, st.epd,
      function (v) { return v.toFixed(1) + ' mm  (F/' + (efl / v).toFixed(2) + ')'; }, null);
    h += slider('zemG2', '后组空气间隙 g2', 2, 120, 0.2, st.g2, function (v) { return v.toFixed(1) + ' mm'; }, null);
    h += slider('zemDf', '像面离焦', -8, 8, 0.05, st.defocus || 0, function (v) { return v.toFixed(2) + ' mm'; }, null);
    UI.sliders.innerHTML = h;
    UI.sliders.querySelector('#zemZoom').oninput = function () {
      st.zoomPos = +this.value;
      var ev2 = ZM.evaluate({ wantPts: true });
      var lbl = document.getElementById('zemZoomv');
      if (ev2) {
        lbl.textContent = ev2.efl.toFixed(1) + ' mm';
        log('Zoom position ' + st.zoomPos.toFixed(3) + ' -> 求解变倍组空气间隙 = ' + ev2.g1.toFixed(3) +
          ' mm，EFL = ' + ev2.efl.toFixed(2) + ' mm' + (ev2.g1ok ? '' : '（未收敛，见提示）'));
      }
      refresh(true);
    };
    UI.sliders.querySelector('#zemEpdS').oninput = function () {
      st.aperture = 'fixed'; st.epd = +this.value; refresh(true);
    };
    UI.sliders.querySelector('#zemG2').oninput = function () { st.g2 = +this.value; refresh(true); };
    UI.sliders.querySelector('#zemDf').oninput = function () { st.defocus = +this.value; refresh(true); };
  }
  function buildSelCtl() {
    var i = UI.sel, s = UI.selCtl;
    if (i < 0) { s.innerHTML = '<div class="muted" style="font-size:11px">在左侧 LDE 点一行，这里会出现该面的滑块</div>'; UI.selName.textContent = '未选中'; return; }
    var ev = UI.ev; if (!ev) return;
    var gname = (i === 5) ? 'Zoom' : (i === NS - 1 ? 'Paraxial Focus' : (UI.vars[i] ? 'Variable' : 'Fixed'));
    UI.selName.textContent = 'Surf ' + (i + 1) + ' · ' + GROUP_NAME[GROUP_OF[i]];
    var R = Math.abs(ev.R[i]) || 1, minR = Math.max(18, R * 0.45), maxR = R * 2.4;
    var pct = ev.R[i] / ZM.baseRadius(i);
    s.innerHTML =
      '<div class="kv"><span>Solve Type</span><span>' + gname + '</span></div>' +
      '<div class="kv"><span>所属元件</span><span>第 ' + (ELEM_OF[i] + 1) + ' 片</span></div>' +
      slider('zemSelR', '半径微调', -0.45, 0.45, 0.002, Math.max(-0.45, Math.min(0.45, pct - 1)),
        function (v) { return (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%  → R=' + fmtR(ev.R[i]) ; }, null) +
      (i === 5 ? '<div class="muted" style="font-size:11px">这一面的厚度是 Zoom 变量，请用左侧变焦滑块</div>' :
        (i === NS - 1 ? '<div class="muted" style="font-size:11px">末面厚度 = 近轴焦距，自动求解</div>' :
          slider('zemSelT', '厚度', 0.6, Math.max(4, S.thick[i] * 2.2), 0.05, S.thick[i],
            function (v) { return v.toFixed(2) + ' mm'; }, null)));
    var sr = s.querySelector('#zemSelR');
    if (sr) sr.oninput = function () { ZM.S.pert[i] = 1 + (+this.value); refresh(true); };
    var stl = s.querySelector('#zemSelT');
    if (stl) stl.oninput = function () { ZM.S.thick[i] = +this.value; refresh(true); };
  }
  function buildFfd(ev) {
    if (!ev) { UI.ffd.innerHTML = '<div class="muted">—</div>'; return; }
    var h = '';
    h += kv('EFF  有效焦距', ev.efl.toFixed(3) + ' mm');
    h += kv('BFD  后焦距', ev.bfd.toFixed(2) + ' mm');
    h += kv('F/#  光圈数', 'F/' + ev.fno.toFixed(3));
    h += kv('EPD  入瞳直径', ev.epd.toFixed(2) + ' mm');
    h += kv('总长', (ev.len + ev.s[NS - 1].t).toFixed(1) + ' mm');
    h += kv('畸变 (1.0ω)', distStr(ev));
    h += kv('g1 变倍间隙', ev.g1.toFixed(2) + ' mm');
    h += kv('最小边缘余量', ev.marg.toFixed(2) + ' mm');
    UI.ffd.innerHTML = h;
  }
  function kv(k, v) { return '<div class="kv"><span>' + k + '</span><span>' + v + '</span></div>'; }
  function buildStatus(ev) {
    if (!ev) return;
    var h = '';
    h += kv('0.0ω RMS', ev.spots[0].rms.toFixed(2) + ' µm');
    h += kv('0.7ω RMS', ev.spots[1].n >= 8 ? ev.spots[1].rms.toFixed(2) + ' µm' : '渐晕 ' + ev.spots[1].blocked + '/' + ev.spots[1].tot);
    h += kv('1.0ω RMS', ev.spots[2].n >= 8 ? ev.spots[2].rms.toFixed(2) + ' µm' : '渐晕 ' + ev.spots[2].blocked + '/' + ev.spots[2].tot);
    h += kv('1.0ω 畸变', distStr(ev));
    h += kv('几何罚', geoPenalty(ev).toFixed(1));
    h += kv('MerF', (function () { var m = meritOf(ev); return (m < MERIT_INFEASIBLE) ? m.toExponential(3) : '不可用'; })());
    UI.statusBox.innerHTML = h;
  }
  /* ---- 主刷新 ---- */
  var refreshPending = false;
  function refresh(rebuildScene) {
    if (refreshPending) return;
    refreshPending = true;
    setTimeout(function () {
      refreshPending = false;
      doRefresh(rebuildScene);
    }, 0);
  }
  function doRefresh(rs) {
    var st = ZM.S;
    /* 处方一变，写死在文案里的 BFD 缓存就过期了 —— 清掉，下一次取用时现算 */
    _bfdCache = {};
    var ev = ZM.evaluate({ wantPts: true, defocus: st.defocus || 0 });
    UI.ev = ev;
    buildLDE(ev);
    buildSysEx(ev);
    buildSliders(ev);
    buildSelCtl();
    buildFfd(ev);
    buildStatus(ev);
    drawMonitor(UI.mon, ev, st.defocus || 0);
    if (rs && ZM.scene) updateScene(ZM.scene, ev, UI.sel >= 0 ? ELEM_OF[UI.sel] : -1);
    if (UI.drawerOpen) buildDrawer(ev);
    if (UI.api) {
      UI.api.setStatus({
        '焦距': ev ? ev.efl.toFixed(2) + ' mm' : '—',
        'F数': ev ? 'F/' + ev.fno.toFixed(2) : '—',
        'RMS(0ω)': ev ? ev.spots[0].rms.toFixed(1) + ' µm' : '—',
        '镜片': '9 片 / 18 面',
        '状态': st.solve[5] === 'Zoom' ? 'Zoom 求解已启用' : 'Zoom 未启用'
      });
    }
    return ev;
  }
  function log(msg) { if (UI.api) UI.api.console(msg, 'cmd'); }
  /* ---- 分析抽屉：点列图 / MTF / 评价函数 / 一阶性质 ---- */
  function buildDrawer(ev) {
    var d = UI.drawer, t = UI.drawerTitle, body = UI.drawerBody;
    if (UI.drawerMode === 'spot') {
      t.textContent = 'Spot Diagram · 点列图（Type = Ray Trace，渐晕 0.9）';
      body.innerHTML = '<div class="zem-an">' +
        '<div class="zem-an-b"><canvas id="zemSpotCv"></canvas></div>' +
        '<div class="zem-an-s">' +
        '<div class="zem-fbtn"><button class="btn btn-sm" data-fi="0">Field 1</button>' +
        '<button class="btn btn-sm" data-fi="1">Field 2</button>' +
        '<button class="btn btn-sm" data-fi="2">Field 3</button></div>' +
        '<div id="zemSpotInfo" class="zem-info"></div></div></div>';
      var cv = body.querySelector('#zemSpotCv');
      drawSpot(cv, ev, UI.field);
      var info = body.querySelector('#zemSpotInfo'), hh = '';
      if (ev) for (var f = 0; f < 3; f++) {
        var sp = ev.spots[f];
        hh += '<div class="kv"><span>Field ' + (f + 1) + ' (' + sp.ang.toFixed(2) + '°)</span><span>' +
          (sp.n >= 8 ? sp.rms.toFixed(1) + ' µm / max ' + sp.max.toFixed(0) : '光线不足 ' + sp.n + '/' + sp.tot) + '</span></div>';
      }
      info.innerHTML = hh;
      var bs = body.querySelectorAll('[data-fi]');
      for (var i = 0; i < bs.length; i++) (function (b) {
        b.onclick = function () { UI.field = +b.getAttribute('data-fi'); buildDrawer(ev); };
      })(bs[i]);
    } else if (UI.drawerMode === 'mtf') {
      t.textContent = 'MTF · 调制传递函数（几何 × 衍射，λ=0.5876µm）';
      body.innerHTML = '<div class="zem-an"><div class="zem-an-b" style="flex:1 1 auto">' +
        '<canvas id="zemMtfCv" style="width:100%;height:100%"></canvas></div>' +
        '<div class="zem-an-s" style="flex:0 0 190px"><div id="zemMtfInfo" class="zem-info"></div></div></div>';
      drawMTF(body.querySelector('#zemMtfCv'), ev);
      var inf = body.querySelector('#zemMtfInfo'), h2 = '';
      if (ev) {
        var cut = 1 / (0.000588 * ev.fno);
        h2 += '<div class="kv"><span>衍射截止 fc</span><span>' + cut.toFixed(0) + ' lp/mm</span></div>';
        h2 += '<div class="kv"><span>135 对角极限</span><span>≈ 25 lp/mm</span></div>';
        h2 += '<div class="divider"></div>';
        /* 三个有意义的频段都给出数：不只看 30 lp/mm（那里通常已经贴地了） */
        [10, 20, 30].forEach(function (frq) {
          h2 += '<div class="kv"><span><b>' + frq + ' lp/mm</b></span><span>' +
            ev.spots.map(function (sp) {
              var sig = (sp.n >= 8 ? sp.rms : 3000) / 1000;
              var t = frq / cut;
              return '<span style="color:' + FCOL[ev.spots.indexOf(sp)] + '">' +
                (mtfGeo(sig, frq, 0.5876, ev.fno) * 100).toFixed(1) + (t > 1 ? '*' : '') + '</span>';
            }).join(' / ') + ' %</span></div>';
        });
        h2 += '<div class="divider"></div>';
        h2 += '<div class="kv"><span>RMS(0/0.7/1.0ω)</span><span>' +
          ev.spots.map(function (sp) { return sp.n >= 8 ? sp.rms.toFixed(1) : '渐晕'; }).join(' / ') + ' µm</span></div>';
        h2 += '<div class="kv"><span>通过光线</span><span>' +
          ev.spots.map(function (sp) { return sp.n + '/' + sp.tot; }).join(' / ') + '</span></div>';
        h2 += '<div class="muted" style="font-size:11px;line-height:1.6;margin-top:4px">' +
          '数字依次是 <span style="color:' + FCOL[0] + '">0ω</span> / <span style="color:' + FCOL[1] + '">0.7ω</span> / ' +
          '<span style="color:' + FCOL[2] + '">1.0ω</span>；带 <b>*</b> 的已超过衍射截止，本身就该是 0。<br>' +
          'MTF 随离焦塌得极快（0.02mm 就到底），所以别顺手拖末面厚度 —— 它是求解量，不是自由量。<br>' +
          'RMS 越大 MTF 掉得越狠：RMS 20µm 在 20 lp/mm 上只剩几个百分点，这就是"点列图和 MTF 是同一件事"的含义。</div>';
      }
      inf.innerHTML = h2;
    } else if (UI.drawerMode === 'merit') {
      t.textContent = 'Merit Function · 评价函数';
      var mh = '<div class="zem-mf"><table class="zem-mf-t"><tr><th>#</th><th>Operand</th><th>参数</th><th>Weight</th><th>Target</th><th>Value</th></tr>';
      for (var r = 0; r < UI.meritRows.length; r++) {
        var row = UI.meritRows[r];
        var v = mfValue(row.op, row.p, UI.ev);
        var val = (v === null || !isFinite(v)) ? '—' : v.toFixed(3);
        var argTxt = (row.op === 'EFFL' || row.op === 'MARG') ? (row.p === 0 ? '全部' : String(row.p)) : String(row.p);
        mh += '<tr><td>' + (r + 1) + '</td>' +
          '<td><select class="select" data-mf="' + r + '" data-k="op">' +
          MF_LIST.map(function (o) {
            return '<option' + (o === row.op ? ' selected' : '') + '>' + o + '</option>';
          }).join('') + '</select></td>' +
          '<td><input class="input" style="width:46px" data-mf="' + r + '" data-k="p" value="' + argTxt + '"></td>' +
          '<td><input class="input" style="width:52px" data-mf="' + r + '" data-k="w" value="' + row.w + '"></td>' +
          '<td><input class="input" style="width:58px" data-mf="' + r + '" data-k="t" value="' + row.t + '"></td>' +
          '<td class="mono">' + val + '</td></tr>';
      }
      mh += '<tr><td colspan="3"><button class="btn btn-sm" id="zemMfAdd" style="width:100%">＋ 加一行</button></td>' +
        '<td colspan="3"></td></tr>';
      mh += '</table>' +
        '<div class="zem-mf-ft">MerF = <b id="zemMerf">—</b>' +
        '<span class="spacer"></span>' +
        '<span class="muted">变量面：<b id="zemVarCount">0</b> / 16</span></div>' +
        '<div class="zem-mf-formula">MerF = Σ wᵢ · (Operandᵢ − Targetᵢ)² &nbsp;+&nbsp; 几何罚</div>' +
        '<div class="zem-mf-legend">' + MF_LIST.map(function (o) {
          return '<div><b>' + o + '</b>（' + MF_OPS[o].unit + '）' + MF_OPS[o].desc +
            '<span class="muted"> · 参数 = ' + MF_OPS[o].arg + '</span></div>';
        }).join('') + '</div>' +
        '<div class="muted" style="font-size:11px;line-height:1.6">优化器<b>只在 Solve Type = Variable 的面上搜</b>；' +
        '没设 Variable 的面完全不动 —— 这就是"点了优化没反应"的首要原因。<br>' +
        'Weight 填 0 = 这一行不参与；Target 0 表示"越小越好"。' +
        '把 <b>EFFL 的 Target</b> 从 200 改成别的数，整支镜头会跟着重新变焦到那个焦距。</div></div>';
      body.innerHTML = mh;
      var mf = meritOf(UI.ev);
      var mfEl = body.querySelector('#zemMerf');
      if (mfEl) mfEl.textContent = (isFinite(mf) && mf < MERIT_INFEASIBLE) ? mf.toExponential(4) : '不可用（有线被 Semi-Diameter 或全反射挡掉）';
      var vc = body.querySelector('#zemVarCount');
      if (vc) vc.textContent = varFaces().length;
      var add = body.querySelector('#zemMfAdd');
      if (add) add.onclick = function () {
        UI.meritRows.push({ op: 'RMSP', p: 1, w: 0.1, t: 0 });
        buildDrawer(UI.ev);
      };
      var sels = body.querySelectorAll('[data-mf]');
      for (var q = 0; q < sels.length; q++) (function (inp) {
        inp.onchange = function () {
          var r2 = +inp.getAttribute('data-mf'), k = inp.getAttribute('data-k');
          var row2 = UI.meritRows[r2];
          if (!row2) return;
          if (k === 'op') row2.op = inp.value;
          else if (k === 'w') row2.w = parseFloat(inp.value);
          else if (k === 't') row2.t = parseFloat(inp.value);
          else {
            var pv = parseInt(inp.value, 10);
            row2.p = (isFinite(pv) && pv > 0) ? Math.min(pv, row2.op === 'MARG' ? NS : 3) : 0;
          }
          if (row2.w !== row2.w) { row2.w = 0; }   // NaN 守卫：输入框留空
          if (row2.t !== row2.t) { row2.t = 0; }
          syncEflOverride();
          refresh(true);
        };
      })(sels[q]);
    } else {
      t.textContent = 'First-Order Data · 一阶性质（近轴）';
      body.innerHTML = '<div class="zem-an"><div class="zem-an-b" style="flex:1 1 auto;overflow:auto">' +
        '<div id="zemFfdTbl" class="zem-ffd"></div></div></div>';
      if (ev) {
        var p = ev.parax;
        var g = '<table class="zem-mf-t"><tr><th>Surf</th><th>z (mm)</th><th>y (mm)</th><th>u′ (rad)</th></tr>';
        for (var i2 = 0; i2 < p.trace.length; i2++) {
          g += '<tr><td>' + (i2 + 1) + '</td><td>' + p.trace[i2].z.toFixed(2) + '</td><td>' +
            p.trace[i2].y.toFixed(4) + '</td><td>' + p.trace[i2].u.toExponential(3) + '</td></tr>';
        }
        g += '</table>';
        body.querySelector('#zemFfdTbl').innerHTML = g;
      }
    }
  }
  function openDrawer(mode) {
    UI.drawerMode = mode; UI.drawerOpen = true; layout(); buildDrawer(UI.ev);
  }
  /* ---- 优化器：坐标下降，几何非法直接拒绝 ---- */
  function optimize() {
    var st = ZM.S, api = UI.api;
    if (UI.optimizing) {           // 上一轮还在跑：忽略重复点击，否则会叠加多个定时器把页面卡死
      api.toast('优化还在进行中，请等它跑完', 'warn');
      return;
    }
    /* ⚠ 只有 Solve Type = Variable 的面才是自由度。没放开变量就点优化，
       Zemax 会直接报 "no variables" 而不是替你动所有面 —— 这里如实照做。 */
    var vars = varFaces();
    if (!vars.length) {
      api.console('Optimization: aborted — no variables.  当前没有任何一面的 Solve Type = Variable。', 'err');
      api.toast('一个变量面都没有：先在 LDE 里点 Solve 单元格把要动的面设为「变量」', 'err');
      return;
    }
    syncEflOverride();
    var base = evaluateNow();
    if (!base) { api.toast('当前系统无法求值', 'err'); return; }
    var cur = { pert: st.pert.slice(), v: meritOf(base) };
    if (!(cur.v < MERIT_INFEASIBLE)) {
      api.console('Optimization: aborted — MerF unavailable.  有视场的光线被 Semi-Diameter 或全反射挡掉了。', 'err');
      api.toast('当前结构有线被挡住，MerF 算不出来 —— 先把 EPD 调小、半口径调大，或点「恢复初始」', 'warn');
      return;
    }
    var startV = cur.v;
    var step = [], i;
    for (i = 0; i < NS; i++) step.push(0.06);
    var evals = 0, best = cur;
    UI.optimizing = true;
    api.console('Optimization: Start.  MerF = ' + cur.v.toExponential(4) + '，变量面 ' + vars.length + ' 个：Surf ' +
      vars.map(function (v2) { return v2 + 1; }).join(', '), 'cmd');
    api.console('  固定面（不参与）：' + freeFacesText(vars), 'sys');
    var iv = setInterval(function () {
      var moved = false;
      for (var vi = 0; vi < vars.length; vi++) {
        i = vars[vi];
        for (var sgn = 1; sgn >= -1; sgn -= 2) {
          var p2 = best.pert.slice();
          p2[i] = p2[i] * (1 + sgn * step[i]);
          if (p2[i] <= 0.05 || p2[i] >= 8) continue;
          var e2 = ZM.evaluate({ pert: p2 });
          evals++;
          if (!e2) continue;
          if (geoPenalty(e2) > 0) continue;
          var v2 = meritOf(e2);
          if (v2 < best.v - 1e-9) { best = { pert: p2, v: v2 }; st.pert = p2; moved = true; break; }
        }
      }
      if (!moved) { var mx = 0; for (i = 0; i < NS; i++) { step[i] *= 0.55; if (step[i] > mx) mx = step[i]; } if (mx < 0.0015) { stopOptTimer(); finish(); } }
      refresh(false);
    }, 40);
    UI.optTimer = iv;
    function finish() {
      UI.optimizing = false;
      UI.optTimer = null;
      st.pert = best.pert;
      /* EFFL 行若把焦距拉走了，同步回变焦滑块，让 UI 与实际读数一致 */
      if (ZOOM_TELE > ZOOM_WIDE) st.zoomPos = clampNum((UI.ev ? UI.ev.efl : st.zoomPos), ZOOM_WIDE, ZOOM_TELE);
      var ev = doRefresh(true);
      if (ev) st.zoomPos = clampNum((ev.efl - ZOOM_WIDE) / (ZOOM_TELE - ZOOM_WIDE), 0, 1);
      api.console('Optimization: Done.  ' + evals + ' merit evaluations.', 'cmd');
      api.console('  MerF  ' + startV.toExponential(4) + '  ->  ' + best.v.toExponential(4), 'ok');
      if (ev) {
        for (var f = 0; f < 3; f++) {
          api.console('  Field ' + (f + 1) + '  ' + ev.fields[f].toFixed(2) + ' deg   RMS radius = ' +
            (ev.spots[f].n >= 8 ? ev.spots[f].rms.toFixed(2) + ' um' : 'vignetted ' + ev.spots[f].n + '/' + ev.spots[f].tot) +
            ',  max radius = ' + ev.spots[f].max.toFixed(2) + ' um', 'ok');
        }
        api.console('  EFL = ' + ev.efl.toFixed(3) + ' mm,  F/# = ' + ev.fno.toFixed(3) +
          ',  BFD = ' + ev.bfd.toFixed(2) + ' mm,  Distortion = ' + distStr(ev), 'ok');
      }
      api.toast('优化结束：MerF ' + startV.toExponential(2) + ' → ' + best.v.toExponential(2), 'ok');
    }
  }
  function clampNum(v, a, b) { return v < a ? a : (v > b ? b : v); }
  /** 真正参与优化的面（0 基索引） */
  function varFaces() {
    var out = [];
    for (var i = 0; i < NS; i++) {
      if (i === 5 || i === NS - 1) continue;      // Zoom 面与像面由求解量接管，不是自由度
      if (UI.vars[i]) out.push(i);
    }
    return out;
  }
  function freeFacesText(vars) {
    var out = [];
    for (var i = 0; i < NS; i++) {
      if (i === 5) { out.push('Surf 6 (Zoom)'); continue; }
      if (i === NS - 1) { out.push('Surf ' + NS + ' (Paraxial Focus)'); continue; }
      if (vars.indexOf(i) < 0) out.push('Surf ' + (i + 1));
    }
    return out.join(', ');
  }
  /** 评价函数里启用的 EFFL 行接管 Zoom 求解的目标焦距（null = 交给变焦滑块） */
  function syncEflOverride() {
    var t = meritEflTarget();
    if (t !== null) {
      ZM.S.eflOverride = t;
      if (ZM.S.zoomPos !== undefined) {
        /* 让滑块位置与目标焦距对得上，学生才不会以为滑块失灵 */
        ZM.S.zoomPos = clampNum((t - ZOOM_WIDE) / (ZOOM_TELE - ZOOM_WIDE), 0, 1);
      }
    } else ZM.S.eflOverride = null;
  }
  function stopOptTimer() {
    if (UI.optTimer) { clearInterval(UI.optTimer); UI.optTimer = null; }
  }
  /** 切走标签页时叫停优化循环，回来再续（不丢已经压下去的 MerF） */
  function pauseOpt() {
    if (!UI.optimizing) return;
    stopOptTimer();
    UI.optimizing = false;
    UI.optInterrupted = true;     // 记住"是被切走的，不算优化完"
  }
  function resumeOpt() {
    if (!UI.optInterrupted) return;
    UI.optInterrupted = false;
    optimize();                   // 从当前（已压下去的）处方继续，不回退
  }
  /** 畸变读数：光线不足时如实说"读不出来"，不拿 0 冒充 */
  function distStr(ev) {
    if (!ev) return '—';
    if (ev.dist === null || ev.dist === undefined) return '不可用（对称瞳孔带不足 5 对，光线被挡）';
    return ev.dist.toFixed(2) + ' %';
  }
  function evaluateNow() { return ZM.evaluate({ defocus: ZM.S.defocus || 0 }); }
  function countVar() { var n = 0; for (var v = 0; v < NS; v++) if (UI.vars[v]) n++; return n; }
  /* ---- 事件绑定 ---- */
  function bindUI() {
    var root = UI.root;
    var tabs = root.querySelectorAll('.zem-tab');
    for (var i = 0; i < tabs.length; i++) (function (b) {
      b.onclick = function () {
        for (var k = 0; k < tabs.length; k++) tabs[k].classList.remove('is-on');
        b.classList.add('is-on'); UI.tab = b.getAttribute('data-tab');
        buildSysEx(UI.ev);
      };
    })(tabs[i]);
    var acts = root.querySelectorAll('[data-act]');
    for (var a = 0; a < acts.length; a++) (function (b) {
      b.onclick = function () { doAction(b.getAttribute('data-act')); };
    })(acts[a]);
    var vs = root.querySelectorAll('[data-view]');
    for (var v = 0; v < vs.length; v++) (function (b) {
      b.onclick = function () { setView(b.getAttribute('data-view')); };
    })(vs[v]);
  }
  /* 视角切换：轨道控制器把相机位姿封在闭包里，只能在每帧 controls.update() 之后覆写。
     因此这里设一个 1.6 秒的"视角保持"，期间每帧强制相机位姿，松开后交还用户自由旋转。 */
  function setView(v) {
    ZM.S.view = v;
    var vp = UI.vp;
    if (!vp || !vp.camera) return;
    var zc = (UI.ev && UI.ev.len) ? UI.ev.len * 0.55 : 110;
    var span = (UI.ev && UI.ev.zIMG) ? Math.max(240, UI.ev.zIMG * 0.62) : 320;
    var pos, tgt;
    if (v === 'side') { pos = [0, 26, span * 1.55]; tgt = [0, 0, zc]; }
    else if (v === 'top') { pos = [0, span * 1.7, zc]; tgt = [0, 0, zc]; }
    else { pos = [-span * 0.62, span * 0.42, span * 1.30]; tgt = [0, 0, zc]; }
    UI.viewHold = {
      until: new Date().getTime() + 1600,
      pos: new THREE.Vector3(pos[0], pos[1], pos[2]),
      tgt: new THREE.Vector3(tgt[0], tgt[1], tgt[2])
    };
  }
  function installViewHold(vp) {
    if (!vp || !vp.onFrame) return;
    vp.onFrame(function () {
      if (!UI.viewHold) return;
      if (new Date().getTime() > UI.viewHold.until) { UI.viewHold = null; return; }
      vp.camera.position.copy(UI.viewHold.pos);
      vp.camera.lookAt(UI.viewHold.tgt);
      vp.controls.target.copy(UI.viewHold.tgt);
      vp.camera.updateMatrixWorld();
    });
  }
  function doAction(act) {
    var st = ZM.S, api = UI.api;
    if (act === 'sysopt') { UI.tab = 'ap'; syncTabUI(); buildSysEx(UI.ev); api.console('System Explorer > Aperture / Wavelengths / Fields', 'cmd'); }
    else if (act === 'lde') { api.console('Lens Data Editor — 点击行选中镜片，双击数值单元格改写', 'cmd'); UI.api.toast('在 LDE 里点任意一行，右侧会出现该面的滑块', 'info'); }
    else if (act === 'layout') { setView('iso'); api.console('3D Layout — 拖动旋转 / 滚轮缩放 / 右键平移', 'cmd'); }
    else if (act === 'trace') { singleRayTrace(); }
    else if (act === 'ffd') { openDrawer('ffd'); api.console('First-Order Data: EFL / BFD / F# / Distortion', 'cmd'); }
    else if (act === 'glass') { glassCatalog(); }
    else if (act === 'spot') { openDrawer('spot'); api.console('Spot Diagram: Type = Ray Trace, Grid = 10 zones, Vignetting = 0.9', 'cmd'); }
    else if (act === 'mtf') { openDrawer('mtf'); api.console('MTF: λ = 0.5876 um, 0 - 100 lp/mm', 'cmd'); }
    else if (act === 'merit') { openDrawer('merit'); api.console('Merit Function — Operand / Weight / Target', 'cmd'); }
    else if (act === 'opt') { optimize(); }
    else if (act === 'reset') {
      st.pert = new Array(NS).fill(1);
      st.g2 = G2_FACTORY;
      st.semiD = new Array(NS).fill(0);
      api.console('Restore initial prescription (all radii = nominal)', 'warn');
      api.toast('已恢复到录入的初始骨架 —— 正好看看优化能把 RMS 压多少', 'info');
      doRefresh(true);
    }
    else if (act === 'optload') {
      st.pert = PERT_OPT.slice();
      st.g2 = G2_OPT;          // 连后组间隙一起还原，否则 Zoom 求解会对不上焦距
      st.semiD = new Array(NS).fill(0);
      var evo = doRefresh(true);
      api.console('Load pre-optimized prescription (18 radii + rear group gap g2 = ' + G2_OPT.toFixed(3) + ' mm)', 'cmd');
      if (evo) api.console('  EFL = ' + evo.efl.toFixed(3) + ' mm,  RMS(0w) = ' + evo.spots[0].rms.toFixed(1) +
        ' um,  rays = ' + evo.spots[0].n + '/' + evo.spots[0].tot, 'ok');
      api.toast('已载入本文件烘焙的优化处方 —— 和「恢复初始」对比看差异', 'ok');
    }
    else if (act === 'rays') { st.showRays = !st.showRays; refresh(true); }
  }
  function syncTabUI() {
    var ts = UI.root.querySelectorAll('.zem-tab');
    for (var i = 0; i < ts.length; i++) ts[i].classList.toggle('is-on', ts[i].getAttribute('data-tab') === UI.tab);
  }
  function singleRayTrace() {
    var ev = UI.ev, api = UI.api;
    if (!ev) return;
    var f = window.prompt('单光线追迹 (Single Ray Trace)\n视场 Field 编号 1/2/3：', '3');
    if (f === null) return;
    f = Math.max(1, Math.min(3, parseInt(f, 10) || 3));
    var yv = window.prompt('归一化瞳孔高度 Y（0=近轴，1=边缘光线）：', '1.0');
    if (yv === null) return;
    yv = Math.max(-1, Math.min(1, parseFloat(yv) || 0));
    var w = ev.fields[f - 1] * Math.PI / 180, y0 = ev.epd * 0.5 * yv;
    api.console('Single Ray Trace:  Field ' + f + ' (' + ev.fields[f - 1].toFixed(2) + ' deg),  Y = ' + yv.toFixed(3), 'cmd');
    for (var li = 0; li < 3; li++) {
      var r = ZM.traceRay(ev.s, y0, -Math.sin(w), Math.cos(w), LAM_LIST[li]);
      if (!r) { api.console('  ' + LAM_NAME[li] + '  ->  ray trace error / vignetted', 'err'); continue; }
      var yi = ZM.imgHit(r, ev.zIMG);
      api.console('  ' + LAM_NAME[li] + '  ->  image y = ' + (yi === null ? 'virtual' : (yi * 1000).toFixed(1) + ' um') +
        ',  exit angle = ' + (r.D.y * 1000).toFixed(3) + ' mrad', 'ok');
    }
    api.toast('单光线追迹结果已写入伪终端', 'ok');
  }
  function glassCatalog() {
    var h = '<div style="font-size:11px;margin-bottom:5px">Glass Catalog（Schott N 系列，子集）</div>' +
      '<table class="zem-cat"><tr><th>Name</th><th>nd</th><th>vd</th><th>n(0.486)</th><th>n(0.656)</th></tr>';
    for (var i = 0; i < GLASS_ORDER.length; i++) {
      var g = GLASS[GLASS_ORDER[i]];
      h += '<tr><td>' + g.name + '</td><td>' + g.nd.toFixed(4) + '</td><td>' + g.vd.toFixed(2) + '</td>' +
        '<td>' + g.n(0.48613).toFixed(4) + '</td><td>' + g.n(0.65627).toFixed(4) + '</td></tr>';
    }
    h += '</table><div class="muted" style="font-size:11px;margin-top:5px">vd 越小色散越强（火石），提供反向色差去抵消冕牌。</div>';
    UI.drawerMode = 'cat'; UI.drawerOpen = true;
    UI.drawerTitle.textContent = 'Glass Catalog · 玻璃目录';
    UI.drawerBody.innerHTML = h;
    layout();
    UI.api.console('Glass Catalog: 6 glasses, columns = nd / vd', 'cmd');
  }
  /* ===========================================================================
   * 8. 教学步骤
   * ======================================================================== */
  /* 变焦两端的 BFD 随处方变，写死在文案里迟早会对不上 —— 一律现算现写 */
  var _bfdCache = {};   // 每 doRefresh 清空，避免优化后文案还报旧值
  function bfdAt(F) {
    if (_bfdCache[F] === undefined) {
      var ev = ZM.evaluate({ eflTarget: F });
      _bfdCache[F] = (ev && isFinite(ev.bfd)) ? ev.bfd : NaN;
    }
    return _bfdCache[F];
  }
  function bfdTxt(F) { var v = bfdAt(F); return isFinite(v) ? v.toFixed(1) + ' mm' : '—'; }
  /** 当前处方实际能解到的广角端（变倍组行程用完为止），不是标称值 */
  function wideActual() {
    var r = ZM.solveGap1(ZM.radiiOf(ZM.S.pert), ZOOM_WIDE, ZM.S.g2);
    var ev = ZM.evaluate({ eflTarget: ZOOM_WIDE });
    return (ev && isFinite(ev.efl)) ? ev.efl : ZOOM_WIDE;
  }
  function bfdSwing() {
    var a = bfdAt(ZOOM_TELE), b = bfdAt(ZOOM_WIDE);
    return (isFinite(a) && isFinite(b)) ? Math.abs(b - a).toFixed(1) + ' mm' : '—';
  }
  function mkSteps(ctx) {
    var api = ctx.api;
    return [
      {
        id: 'open-workspace',
        title: '新建序列模式文件与三窗布局',
        goal: '新建一支空的 125-200mm F/5.7 长焦变焦文件，认清 System Explorer / 镜头数据编辑器 / 3D 布局 三者的分工。',
        uiAction: '顶部 <b>File &gt; New &gt; Optics…</b> 选 <b>Lens File</b>（不要选 Black Box），文件名 <code>125-200F57.zmx</code>。' +
          '本模块已经把这套三窗布局搭好了：<b>左侧 System Explorer</b>（Aperture / 波长 / 视场 三个页签）、' +
          '<b>中间上方的镜头数据编辑器（LDE）</b>、<b>中间的 3D 布局视口</b>。点一下 LDE 任意一行再点右侧滑块区，试试选中不同镜片。',
        hints: [
          '三窗不见了：顶栏 View 菜单重新勾选 Layout / System Explorer / Lens Data Editor。',
          '别选 Black Box —— 那是"把整支镜头当一个黑盒导入"，学不到任何东西。要单光路序列模式。',
          'LDE 是<b>数据表</b>，3D 布局才是镜片<b>实体</b>。改表不动图，说明两者没联动。'
        ],
        physics: '一条光路从 OBJ（物方无穷远）出发，每穿过一个球面按 Snell 折射一次，' +
          '18 个面的参数累积起来，最终决定光线聚到 IMG 的哪里。设计镜头就是把这 18 行数字调到"聚得又准又小"。',
        threeD: '视口里已经摆出 9 片球面镜片（LatheGeometry 旋转成型、半透明玻璃质感）、三段镜筒和一条光轴。' +
          '可以直接用左键拖动旋转、滚轮缩放、右键平移；右上角三个按钮切换侧视 / 俯视 / 轴测。',
        expected: 'LDE 出现 18 行（Surf 1…18）+ 顶部的 OBJ 行和末端的 IMG 行；' +
          '点任意一行，右侧"选中面"面板显示该面的半径微调滑块，3D 视口里对应镜片变亮。',
        notes: '真实 OpticStudio 里文件名是 <code>.zmx</code>，序列模式是默认模式；' +
          '本模块所有数字都存在内存里，刷新即重来，放心折腾。',
        enter: function (c) {
          setView('iso');
          c.api.clearConsole();
          c.api.console('File > New > Optics…  →  Lens File  →  125-200F57.zmx', 'cmd');
          c.api.console('Sequential mode, 18 surfaces, object at infinity.', 'sys');
          c.api.console('Layout: System Explorer | Lens Data Editor | 3D Layout', 'sys');
          c.api.toast('先点 LDE 里任意一行，看看右侧会变出什么', 'info');
        }
      },
      {
        id: 'system-specs',
        title: '系统选项：入瞳、波长、视场',
        goal: '在 System Explorer 的三个页签里定死口径、光谱与视场口径。',
        uiAction: '<b>Aperture</b> 页：Entrance Pupil Diameter 填 <code>35.00</code>（= 200/5.7，恒定光圈），Stop Surface 选变倍组后的那一面。' +
          '<b>波长</b> 页：0.656 / 0.588（Primary）/ 0.486 µm，可用"显示波长"下拉切成单色。' +
          '<b>视场</b> 页：选<b>物方像高</b>，全视场 ω 填 <code>21.60</code>（135 画幅对角半高），0.7ω 自动是 15.12。' +
          '右侧"变焦与光圈"区的<b>入瞳直径滑块</b>可以现场把光圈从 F/5.7 开到 F/2.8。',
        hints: [
          '漏设 Stop Surface 会算错通光量：光阑决定哪一面限制光束，EPD 只是"看起来的口径"。',
          '波长单位是 <b>µm</b>，填 486 会把 0.486µm 放大一千倍，折射率全错。',
          '长焦物在无穷远 —— 本模块默认用<b>像高</b>给视场，角度按 ω=arctan(h/f) 自动换算，所以 200mm 端视场角小（约 6.2°）、125mm 端大（约 9.8°），和真实变焦一模一样。'
        ],
        physics: '入瞳直径直接锁定 F 数：F# = EFL/EPD。35mm 入瞳配 200mm 焦距就是 F/5.7。' +
          '球差随<b>口径</b>急剧恶化：纵向球差 LSA ∝ D³（D 是入瞳直径，N = f/D）。' +
          '所以从 F/5.7 开到 F/2.8 相当于 D 翻一倍，LSA 变 8 倍，点列图上的光斑会明显胀大 —— 拖滑块自己看。' +
          '反过来说，<b>收光圈能让球差按 D⁻³ 减小</b>，这就是小光圈拍什么都更清楚的根本原因。' +
          'F(0.486)/d(0.588)/C(0.656) 三个波长复现人眼最灵敏的谱段，消色差必须三色同时满足。',
        threeD: '拖"入瞳直径"滑块：光束口径实时变粗变细，镜筒内出现渐晕边缘；' +
          '把"显示波长"切成单色，3D 光束只剩一种颜色，能直接看出红黄蓝三条焦线分家（色散）。',
        expected: '三个页签都没有空行；拖动 EPD 滑块时右侧 F 数读数同步变化，3D 光束粗细与之一致。',
        enter: function (c) {
          c.api.console('System Explorer > Aperture   : Entrance Pupil Diameter = ' + ZM.S.epd.toFixed(2) + ' mm,  Stop Surface = 11', 'cmd');
          c.api.console('System Explorer > Wavelengths: 0.486 / 0.588 (Primary) / 0.656 um', 'cmd');
          c.api.console('System Explorer > Fields     : Object Space Height, 0 / 15.12 / 21.60 mm', 'cmd');
          var ev = UI.ev || ZM.evaluate();
          if (ev) {
            var f = ev.fields;
            c.api.console('  → 换算成物方角度: 0.00 / ' + f[1].toFixed(2) + ' / ' + f[2].toFixed(2) + ' deg  (EFL = ' + ev.efl.toFixed(2) + ' mm)', 'ok');
            c.api.console('  → F/# = EFL/EPD = ' + ev.efl.toFixed(2) + '/' + ev.epd.toFixed(2) + ' = F/' + ev.fno.toFixed(3), 'ok');
          }
          c.api.toast('试试把入瞳直径拉到 71 —— F/2.8 会怎样？', 'info');
        }
      },
      {
        id: 'lde-basics',
        title: '读懂 LDE 各列：半径、厚度、玻璃、半口径',
        goal: '弄明白 LDE 每一列改的是光学上的什么量，并看到"改一个数 → 光路立刻变"的因果链。',
        uiAction: 'LDE 的列依次是 <b>Surf / R / T / Glass / Semi-D / Conic / Solve</b>。' +
          '先点 <b>Surf 1</b> 那一行（正中间的 3D 视口里第 1 片会变亮），再在右侧"选中面"面板拖<b>半径微调</b>滑块；' +
          '也可以直接点 LDE 里的 <b>R</b> 单元格改写数值、点 <b>T</b> 单元格改厚度、点 <b>Glass</b> 单元格换牌号。' +
          '点 <b>Solve</b> 单元格可以在 固定 / 变量 之间切换。',
        hints: [
          'R 填 0（或 Infinity）表示<b>平面镜</b>，按回车即无穷远 —— 这是最省事的"先把它变平"手法。',
          '玻璃后面的负厚度表示虚间距；本模块的 Zoom 面厚度由求解器接管，直接改会被拒绝并提示。',
          'Semi-D 过小会报 ray trace error。本模块的半口径是按边缘光线自动算的，拖 EPD 滑块时它会跟着变。'
        ],
        physics: '半径定光焦度：φ=(n′−n)/R，R 越大面越平、φ 越小；R 变号 φ 变号（凸↔凹）。' +
          '玻璃决定折射率 n 与色散；厚度决定下一面的轴向距离，直接改变光束的收敛快慢。',
        threeD: '拖半径滑块：对应镜片在 3D 里实时重新成型（变鼓 / 变凹），而右侧"一阶性质"里的 EFL 与 BFD 同步变化，' +
          '像面小屏上三色落点同步移动。',
        expected: '拖动 Surf 1 的半径微调，3D 镜片形状与 FFD 读数同帧变化，伪终端能记下每一次改写。',
        enter: function (c) {
          c.api.console('Lens Data Editor — columns: R / T / Glass / Semi-D / Conic / Solve', 'cmd');
          c.api.console('  点一行选中镜片；点 R / T / Glass 单元格改写；点 Solve 在 Fix 与 Variable 间切换', 'sys');
          UI.sel = 0; buildSelCtl(); doRefresh(true);
          c.api.toast('已选中 Surf 1，拖右侧「半径微调」滑块试试', 'info');
        }
      },
      {
        id: 'glass-semidiameter',
        title: '玻璃目录与半口径',
        goal: '查玻璃的折射率与色散，理解冕牌与火石怎么配，以及半口径为什么只影响通光不影响焦距。',
        uiAction: '点顶部 <b>玻璃目录</b> 按钮（或 Glass 单元格直接键入牌号回车更快）→ 弹出 <b>Glass Catalog</b> 窗口，' +
          '里面列出 nd / vd 以及两端谱线的折射率：<b>N-BK7</b>(1.5168 / 64.17)、<b>N-SF5</b>(1.6727 / 32.25)、<b>N-LAK8</b>(1.6910 / 54.71)。' +
          '把 <b>Surf 1</b> 的 Glass 改成 N-SF5 或改回 N-BK7，对比"像面小屏"上三色落点的分离程度。',
        hints: [
          'Glass 单元格直接键入牌号回车更快；<b>拼错会退回原玻璃</b>，不会有任何提示，所以看 LDE 有没有变。',
          'vd 越小色散越强。冕牌（N-BK7，vd=64）色散基底平缓，火石（N-SF5，vd=32）提供反向色差把三波长拉回同一点。',
          '半口径只影响<b>通光</b>（渐晕），不影响理想焦距 —— 改 Semi-D 不会动 EFL。'
        ],
        physics: '冕牌低色散是消色差的基底，火石色散强提供反向色差。' +
          '本模块用两项 Cauchy 曲线拟合每种玻璃，并强制满足 n_F − n_C = (n_d−1)/v_d，' +
          '所以三色折射率差与阿贝数严格自洽 —— 你在像面小屏上看到的红蓝分离量就是这条关系式。',
        threeD: '把某一片换成火石：3D 视口里该片颜色变化，光束穿过它之后三条焦线张开或收拢；' +
          '色差是"焦点沿光轴分开"，在侧视图里看得最清楚。',
        expected: '玻璃目录里每个牌号都查得到 nd/vd；换玻璃后像面小屏上红黄蓝三条落点间距明显变化，而 EFL 读数几乎不动。',
        enter: function (c) {
          c.api.console('Glass Catalog — Columns: nd, vd', 'cmd');
          GLASS_ORDER.forEach(function (g) {
            var x = GLASS[g];
            c.api.console('  ' + x.name.padEnd(8) + ' nd=' + x.nd.toFixed(4) + '  vd=' + x.vd.toFixed(2) +
              '  n(0.486)=' + x.n(0.48613).toFixed(4) + '  n(0.656)=' + x.n(0.65627).toFixed(4), 'sys');
          });
          c.api.console('  nF - nC = (nd-1)/vd 严格成立 → 三色折射率自洽', 'ok');
          glassCatalog();
        }
      },
      {
        id: 'enter-prescription',
        title: '正-负-正远摄的初始结构',
        goal: '认清 9 片 18 面三组式远摄变焦的骨架，并亲手"打回原形"看看它有多糟。',
        uiAction: '本模块的结构：<b>第 1–3 片 前固定正组</b>、<b>第 4–6 片 负变倍组</b>、<b>第 7–9 片 后固定正组</b>。' +
          'LDE 里带 <b>G1/G2/G3</b> 标记的行就是三组的分界；第 6 面的 Thickness 是<b>前组↔变倍组</b>的空气间隙，' +
          '第 12 面的是<b>变倍组↔后组</b>的空气间隙 —— 这两个"可动间隙"就是变焦的全部自由度。' +
          '点顶部 <b>恢复初始</b>，可以回到"刚录进去、还没优化"的骨架状态，用来看优化到底做了什么。',
        hints: [
          '插入/删除面在真实软件里是 <b>Edit &gt; Insert Surface</b> / Delete Surface，光标行决定插在谁的前面。',
          '空 Glass 表示空气，不是漏填。本模块每个元件占两行：正面那行填牌号，背面那行留空。',
          '组间空气间隙（Zoom 面和 g2）是变焦的<b>自由度</b>，不是"漏掉的厚度"。'
        ],
        physics: '反远摄是正-负-正：中间的负组把主平面推到镜筒之后，' +
          '后截距 BFD 虽然只有几十毫米、远小于 200mm 焦距，说明后主面 H′ 落在镜筒<b>后面</b>，' +
          '这就是长焦的判据 —— 短镜筒里塞得下 200mm。',
        threeD: '3D 布局里胖-瘦-胖三组玻璃清晰可见；把"后组空气间隙 g2"滑块从 4 拖到 120，' +
          '后组会整体沿光轴滑出去，EFL 读数与 BFD 同步变化。',
        expected: 'LDE 共 18 行 + OBJ/IMG；FFD 面板给出非零 EFL；点"恢复初始"后 RMS 明显变差，' +
          '这正是优化要解决的问题。',
        notes: '真实 70-200 f/2.8 需要 11~13 片并用非球面/低色散 ED 玻璃，才做得出 2.86× 的变倍比；' +
          '本模块刻意用 <b>9 片全球面 + F/5.7</b>，把焦段收到 125–200（1.6×），' +
          '让每一个结果都能被你在浏览器里亲手复算。',
        enter: function (c) {
          c.api.console('LDE: 9 elements / 18 surfaces / 3 groups (positive-negative-positive)', 'cmd');
          c.api.console('  Group 1  Surf 1-6   fixed positive', 'sys');
          c.api.console('  Group 2  Surf 7-12  negative variator  <-- Zoom slide drives the gap before it', 'sys');
          c.api.console('  Group 3  Surf 13-18  rear positive', 'sys');
          var ev = ZM.evaluate();
          if (ev) c.api.console('  EFL = ' + ev.efl.toFixed(3) + ' mm,  BFD = ' + ev.bfd.toFixed(2) +
            ' mm  (BFD << EFL  →  telephoto, rear principal plane sits behind the barrel)', 'ok');
          c.api.toast('点「恢复初始」再点「开始优化」，看 RMS 掉多少', 'info');
        }
      },
      {
        id: 'layout-3d',
        title: '3D 布局图：把 LDE 那一列数字看成实物',
        goal: '学会在 <b>3D Layout</b> 窗口里读镜片实体，理解它和镜头数据编辑器是同一份数据的两种画法，并认出渐晕。',
        uiAction: '点顶部 <b>3D 布局</b> 按钮（或右上角 <b>侧视 / 俯视 / 轴测</b>三个按钮切机位）。' +
          '在布局窗口里做三件事：<b>①</b> 切到 <b>侧视</b>，数一数能看见几片镜片，对上 LDE 的 18 行；' +
          '<b>②</b> 点 LDE 里任意一行，中间的镜片会<b>变亮</b>，在 3D 里跟着认出它是第几片；' +
          '<b>③</b> 点 LDE 的 <b>Semi-D</b> 单元格改小某一面的半口径，看 3D 里那一片<b>真的把外圈光线切掉</b>。',
        hints: [
          '<b>3D 布局是"结果视图"，不是"输入视图"</b>。在真实 OpticStudio 里你不能在布局图上拖动镜片面形，' +
          '必须回 LDE 改数 —— 改完布局图立刻跟着变。',
          '<b>俯视图最容易被骗</b>：俯视只能看出镜片直径和间距，看不出弯不弯。要判断面形必须切侧视。',
          '半口径改小之后，3D 里那一片的边缘会先"吃掉"光束：光锥在该面被截平，后面几片的亮斑突然变大。' +
          '这就是渐晕（Vignetting）—— 它不是像差，是<b>光被挡住了</b>，本模块在点列图上记作"光线 n/tot"。',
          '本模块的半口径默认是<b>自动</b>的（照着光线包络给，Semi-D 列显示 Auto）。想手动控制就点那一格改数值，' +
          '填 0 回到自动。这在真实软件里同样是手工定半口径、用于控制镜片成本与重量的常规操作。'
        ],
        physics: '布局图是按 <b>R（曲率半径）、T（厚度）、Semi-D（半口径）</b> 三个数旋转成型出来的：' +
          '球面矢高 z = R − √(R² − y²)，把 y 从 0 扫到 Semi-D 就得到那一片的截面轮廓，绕光轴一转就是镜片实体。' +
          '所以 Semi-D 决定镜片有多大（成本与重量），R 决定它弯不弯（光焦度 φ=(n′−n)/R）。',
        threeD: '9 片半透明玻璃 + 三段镜筒 + 一条光轴。胖-瘦-胖的三组结构一眼可见；' +
          '改半径滑块时镜片实时重新成型（每轮重建 LatheGeometry），改 Semi-D 时那一片的外圈被切平。',
        expected: '侧视下能数出 9 片镜片、3 组空气间隔；点 LDE 某行时对应镜片变亮；' +
          '把某一面 Semi-D 改到 8mm 后，点列图上该视场的光线数 n/tot 立刻下降、1.0ω 的 RMS 变差。',
        enter: function (c) {
          setView('side');
          c.api.console('3D Layout — 布局窗口只是 LDE 数据的另一张画法，不能在图上直接改面形', 'sys');
          c.api.console('  侧视数镜片 / 俯视看直径与间距 / 轴测看整体比例', 'cmd');
          var ev = UI.ev || ZM.evaluate();
          if (ev) {
            c.api.console('  当前半口径（自动，按光线包络）:', 'cmd');
            for (var i = 0; i < NS; i += 3) {
              c.api.console('    Surf ' + (i + 1) + '–' + (i + 3) + '  Semi-D = ' +
                ev.sd[i].toFixed(1) + ' / ' + ev.sd[i + 1].toFixed(1) + ' / ' + ev.sd[i + 2].toFixed(1) + ' mm', 'info');
            }
            c.api.console('  最小边缘余量 = ' + ev.marg.toFixed(2) + ' mm（归零就该开大光圈了）', 'ok');
          }
          c.api.toast('点 LDE 的 Semi-D 单元格，把某一面改到 8mm 看渐晕', 'info');
        }
      },
      {
        id: 'raytrace-first-order',
        title: '单光线追迹与一阶性质',
        goal: '追一根边缘光线，把"账面焦距"和"真实交点"分开看。',
        uiAction: '点顶部 <b>单光线追迹</b>：输入视场编号（1/2/3）和归一化瞳孔高度 Y（0=近轴，1=边缘），' +
          '三个波长的追迹结果（像面落点、出射角）会写进底部伪终端。' +
          '再点 <b>一阶性质</b> 按钮打开 FFD 窗口，里面有逐面的近轴光线高度表；右侧"一阶性质"面板给出 EFL / BFD / F# / 畸变。',
        hints: [
          'FFD 只算<b>近轴</b>，所以 EFL 永远比 3D 布局里高次光线的实际交叉点长 —— 这段差就是球差。',
          'Y=1.0 是边缘光线，Y=0.1 更接近近轴。两者落点之差直接量出了纵向球差。',
          'F# 用当前入瞳直径算，变焦时会变；本模块 EPD 默认随焦距保持恒定，所以全焦段 F 数不变。'
        ],
        physics: '近轴光按面光焦度线性累加算；高次光在真实球面上偏折更少，' +
          '所以边缘光线的交点比近轴焦点<b>更靠前</b>（或更靠后）—— 这段纵向差 LSA 就是球差，' +
          '而 1.0ω 视场上还会叠加彗差、像散与场曲。',
        threeD: '3D 布局里能看到高次光线斜穿全系统；在<b>侧视</b>下转视角，能看见光束在 IMG 之前的实际交叉位置，' +
          '以及红黄蓝三条焦线沿光轴分开的距离。',
        expected: 'FFD 窗口给出 EFL、BFD、F#、Distortion 四个数；单光线追迹给出三个波长的像面落点，' +
          '三者能互相印证。',
        enter: function (c) {
          var ev = ZM.evaluate({ wantPts: true });
          c.api.console('First-Order Data (paraxial, lambda-d = 0.5876 um)', 'cmd');
          if (ev) {
            c.api.console('  EFL        = ' + ev.efl.toFixed(4) + ' mm', 'ok');
            c.api.console('  BFD        = ' + ev.bfd.toFixed(3) + ' mm', 'ok');
            c.api.console('  F/#        = ' + ev.fno.toFixed(4), 'ok');
            c.api.console('  Distortion = ' + ev.dist.toFixed(3) + ' %  (1.0 field)', 'ok');
            c.api.console('  RMS spot   = ' + ev.spots[0].rms.toFixed(2) + ' um (0 field, real rays)', 'ok');
            c.api.console('  Real marginal ray crosses the axis BEFORE the paraxial focus → longitudinal spherical aberration.', 'sys');
          }
          openDrawer('ffd');
        }
      },
      {
        id: 'spot-baseline',
        title: '点列图：把"糊"变成数字',
        goal: '建立优化前的基线，用 RMS 弥散半径作为之后一切比较的起点。',
        uiAction: '点顶部 <b>点列图</b>：Type 必须是 <b>Ray Trace</b>（不是 Diffraction），' +
          '瞳孔分区 10 圈、渐晕 0.9。窗口里三个 Field 按钮可以切换，点列图上红/黄/蓝分别是三个波长，' +
          '三个同心刻度圈是自动量程。注意窗口下方会显示<b>「光线 n/tot」</b>，那是渐晕统计 —— ' +
          '不足 8 条光线时 RMS 显示为"—"，因为统计已经没有意义了。',
        hints: [
          '必须选 Ray Trace 而非 Diffraction：衍射会叠加艾里斑盖住几何像差，评价函数就失去指导意义。',
          '渐晕填 0.9 留边，1.0 时边缘光线容易不稳。',
          'RMS 比最大光斑稳健，不容易被个别异常点带跑；但<b>前提是光线数够</b>，被渐晕挡掉一半时 RMS 会骗人。'
        ],
        physics: '理想点落成一片斑，RMS 半径就是评价函数的靶子。' +
          '0 视场暴露球差与色差，0.7ω/1.0ω 暴露彗差、像散与场曲；' +
          '色差在图上是"红蓝两个同心环分离"，纯几何像差则是"整个斑变形、拉出彗尾"。',
        threeD: '3D 视口与点列图是同一批光线：拖半径滑块时，点列图上的斑形会同步胀缩；' +
          '把 EPD 从 35 拉到 71（口径翻倍），球差按 <b>D³</b> 恶化，光斑会明显炸开。',
        expected: '三个视场各有一组 RMS 数值（0 视场最小、1.0ω 最大），' +
          '同时能看到"光线 n/tot"的渐晕百分比 —— 这是判断结构是否物理可用的第一道闸门。',
        enter: function (c) {
          openDrawer('spot');
          var ev = ZM.evaluate({ wantPts: true });
          c.api.console('Spot Diagram: Type = Ray Trace, Grid = 10 x 10 zones, Vignetting = 0.9', 'cmd');
          if (ev) ev.spots.forEach(function (sp, f) {
            c.api.console('  Field ' + (f + 1) + '  ' + sp.ang.toFixed(2) + ' deg   RMS radius = ' +
              (sp.n >= 8 ? sp.rms.toFixed(2) + ' um' : 'vignetted ' + sp.n + '/' + sp.tot) +
              ',  max radius = ' + sp.max.toFixed(2) + ' um', sp.n >= 8 ? 'ok' : 'warn');
          });
          c.api.console('  Baseline recorded. 下一步把它写成评价函数。', 'sys');
        }
      },
      {
        id: 'mtf-read',
        title: 'MTF 曲线：分辨率到底有多少',
        goal: '学会读 MTF（调制传递函数）曲线，找出<b>衍射截止</b>与<b>135 画幅极限</b>，并把曲线高低和上一步的 RMS 点列半径对上号。',
        uiAction: '点顶部 <b>MTF</b> 打开分析窗口。右侧表格按 <b>10 / 20 / 30 lp/mm</b> 三行给出三个视场的 MTF 数值' +
          '（颜色依次是 0ω 蓝、0.7ω 黄、1.0ω 红），曲线上那条<b>紫色虚线是 30 lp/mm</b>。' +
          '先看「衍射截止 fc」这一行：超过 fc 的频段再好的镜头也只能是 0。' +
          '然后把 F/5.7 和 F/2.8 各测一次，看 0ω 曲线在 10 lp/mm 上差多少。',
        hints: [
          '<b>MTF 越低不代表"看不见"，代表"对比度损失"。</b>50% 是肉眼可辨的门槛，' +
          '低于 20% 基本只剩轮廓，低于 5% 在照片上就是一块糊斑。',
          '<b>超过衍射截止 fc 的读数带 * 号</b>，那不是镜头差，是物理上不可能再有响应 —— ' +
          'λ=0.5876µm、F/5.7 时 fc ≈ 290 lp/mm，135 画幅对角只需要 25 lp/mm，所以 30 lp/mm 那一行还在能力范围内。',
          '<b>MTF 和点列图是同一件事的两种说法</b>：RMS 半径 σ(mm) 直接进几何项 ' +
          'exp(−2π²σ²ν²)，σ 翻倍，20 lp/mm 上的 MTF 会塌掉一个数量级。上一步记下的 RMS 数字在这里立刻兑现。',
          '拖右侧 <b>入瞳直径</b> 滑块把光圈开大：MTF 会先因球差下降，接近衍射极限后再回升一点 —— ' +
          '小光圈永远更"干净"，大光圈更"有味道"，这就是为什么小光圈要拍 8 张再叠图。'
        ],
        physics: 'MTF(f) = 几何像差项 × 衍射项，两项相乘而不是相加：<br>' +
          '<code>衍射项</code> = (2/π)(arccos v − v√(1−v²))，v = f·λ·F#，v ≥ 1 时恒为 0（这就是截止 fc = 1/(λ·F#)）；<br>' +
          '<code>几何项</code> = exp(−2π²σ²f²)，σ 是以 mm 记的 RMS 弥散半径、f 是 lp/mm 的空间频率。<br>' +
          '物镜的 MTF 就是把物镜 MTF 与传感器 MTF 相乘 —— 镜头再完美也换不回传感器读不出的细节。',
        threeD: '开大光圈时 3D 里的光束变粗、像面光斑同步变大，MTF 曲线的 0ω 线跟着塌 —— ' +
          '视口、点列图、MTF 三者始终来自<b>同一次追迹</b>，所以三者永远对得上。',
        expected: '「衍射截止 fc」约 290 lp/mm；10 lp/mm 那一行 0ω 明显高于 0.7ω 与 1.0ω；' +
          '把 EPD 从 35 拉到 71（F/5.7 → F/2.8）后 0ω 在 10 lp/mm 上明显下降 —— 与点列图上光斑胀大是同一件事。',
        enter: function (c) {
          openDrawer('mtf');
          var ev = ZM.evaluate({ wantPts: true });
          c.api.console('MTF: lambda = 0.5876 um, 0 - 100 lp/mm, 几何 x 衍射', 'cmd');
          if (ev) {
            var cut = 1 / (0.000588 * ev.fno);
            c.api.console('  Diffraction cutoff fc = 1/(lambda * F#) = 1/(0.000588 * ' + ev.fno.toFixed(2) + ') = '
              + cut.toFixed(0) + ' lp/mm', 'ok');
            c.api.console('  135 画幅对角 ~2400 px / 43.3 mm → 奈奎斯特频率约 25 lp/mm', 'sys');
            [10, 20, 30].forEach(function (fr) {
              c.api.console('  MTF @' + fr + ' lp/mm  = ' + ev.spots.map(function (sp) {
                var sig = (sp.n >= 8 ? sp.rms : 3000) / 1000;
                return 'Field ' + (ev.spots.indexOf(sp) + 1) + ' ' + (mtfGeo(sig, fr, 0.5876, ev.fno) * 100).toFixed(1) + '%';
              }).join('   '), ev.spots.every(function (sp) { return sp.n >= 8; }) ? 'ok' : 'warn');
            });
          }
          c.api.toast('把入瞳直径拉到 71（F/2.8）再看 10 lp/mm 那一行', 'info');
        }
      },
      {
        id: 'merit-function',
        title: '写评价函数：把"想要什么"翻译成一个数',
        goal: '理解优化器只认一个标量 MerF，以及 Operand / 参数 / Weight / Target 四列各自管什么。',
        uiAction: '点 <b>评价函数</b> 打开 Merit Function 窗口。默认七行，Operand 共 6 种，每一行都在真的参与计算：' +
          '<b>RMSP</b>（指定视场的 RMS 弥散半径，µm，Target 0 压到最小）× 3 视场；' +
          '<b>EFFL</b>（有效焦距，mm，Target <b>200</b> 锁住焦距）；' +
          '<b>MNUM</b>（该视场被挡掉的光线百分比，%，Target 0 = 一个光都不许丢）× 3 视场。' +
          '四列都能直接改，底部的 <b>MerF</b> 立刻重算，「Value」列显示这一行当前的真实读数。',
        hints: [
          '<b>先改一个 Weight 试手感</b>：把第 1 行 RMSP 的 Weight 从 0.3 改成 3.0，MerF 立刻跳一个量级 —— ' +
          '权重就是优先级。填 <b>0</b> 表示这一行完全不参与。',
          '<b>EFFL 的 Target 就是变焦滑块的目标焦距</b>。把它从 200 改成 180，整支镜头会重新变焦到 180mm；' +
          '留 0 的话这一行没有意义（EFL 不可能为 0），本模块会忽略它。',
          '<b>MNUM 是防渐晕的那道闸</b>。1.0ω 掉一半瞳孔就是 50%，0.3×50² = 750，' +
          '会立刻压过所有 RMS 项 —— 优化器宁可牺牲点画质也不肯让光被挡掉。',
          '「参数」列对 RMSP/RMSR/MNUM/DMVA 是<b>视场号</b>（1/2/3），对 MARG 是<b>面号</b>（0 = 全部面取最小）。',
          '下方灰框里有每个 Operand 的单位与含义，别猜。'
        ],
        physics: '优化每一轮只算一个标量 MerF 并把它压小：<code>MerF = Σ wᵢ·(Operandᵢ − Targetᵢ)² + 几何罚</code>。' +
          '权重表达优先级，Target 表达"硬约束"（Target 0 就是"越小越好"）。' +
          '平方是关键：如果只用一次方，正负误差会互相抵消，优化器就"开心"了。' +
          '本模块的几何罚在 MerF 之外单独加：边厚一旦算成负数（镜片自相割裂）就返回一个巨大的哨兵值，' +
          '那类解会被直接判为不可行 —— 相当于真实软件里 Variables 窗口的上下限。',
        threeD: '点"开始优化"后，视口里 9 片镜片的面形会逐轮微调，' +
          '同时右侧 RMS 读数、MerF 数值与抽屉里的点列图、MTF 曲线同步刷新 —— 四者始终来自同一次追迹。',
        expected: '七行 MerF 都有具体数值；「Value」列显示各行真实读数；' +
          '把任意一个 Weight 改大或改小，MerF 立刻跟着变（这一列不是摆设）。',
        enter: function (c) {
          openDrawer('merit');
          c.api.console('Merit Function: MerF = SUM w*(Operand - Target)^2 + geometry penalty', 'cmd');
          c.api.console('  RMSP x3 (0/0.7/1.0 field)   EFFL (target 200 mm)   MNUM x3 (target 0 %)', 'sys');
          var ev = ZM.evaluate();
          if (ev) {
            var m0 = meritOf(ev);
            c.api.console('  MerF = ' + (m0 < MERIT_INFEASIBLE ? m0.toExponential(4) : 'unavailable (rays blocked)'),
              m0 < MERIT_INFEASIBLE ? 'ok' : 'warn');
            c.api.console('  EFFL operand = ' + ev.efl.toFixed(3) + '  (target 200) → 把 Target 改成 180 看镜头会不会跟着变焦', 'cmd');
            c.api.console('  MNUM operand = ' + [0, 1, 2].map(function (fi) {
              return ev.spots[fi].blocked + '/' + ev.spots[fi].tot;
            }).join('  '), ev.spots[2].blocked === 0 ? 'ok' : 'warn');
          }
          c.api.console('  💡 改 Weight 立刻看 MerF 变不变 —— 这一列是真在算的。', 'sys');
        }
      },
      {
        id: 'optimize',
        title: '给自由度并开始优化',
        goal: '用 LDE 的 <b>Solve Type</b> 告诉优化器哪些面可以动，然后看它把 MerF 压下去。',
        uiAction: '在 LDE 里点 <b>Solve</b> 单元格可以在 <b>固定 / 变量</b>之间切换 —— <b>只有设为「变量」的面才会被优化器碰</b>。' +
          '本步的 enter 已经帮你把 Surf 1–14、16、17 放开成 Variable，<b>Surf 15 故意留成 Fix</b> 给你做对照。' +
          '然后点顶部 <b>开始优化</b>。优化器是坐标下降：每轮挑一个变量面、按当前步长试正负两个方向，' +
          'MerF 下降就接受、几何变成非法（边厚为负）就拒绝；一轮都没进步就把步长缩小 0.55 倍，收敛后自动停。' +
          '想看全程就把 <b>点列图</b> 和 <b>MTF</b> 抽屉同时打开。',
        hints: [
          '<b>没设 Variable 的面完全不动，这是"点了优化没反应"的首要原因。</b>' +
          '如果一个变量面都没有，优化器会直接报 <code>aborted — no variables</code> 并停下，' +
          '而不是偷偷把所有面都动一遍。真软件也是这个行为。',
          '<b>做一次对照实验：</b>先点 <b>恢复初始</b>，记下 MerF；点 <b>开始优化</b> 看它降；' +
          '再点 LDE 第 15 行的 Solve 把它切成 Variable，重跑一次 —— 这次的 MerF 一定降得更多。',
          '半径无界。本模块的坐标下降步长上限 8×，几何硬屏障（边厚 ≥ 0.8mm）会挡住跑飞的解 —— ' +
          '真实软件靠 Variables 窗口的上下限做同一件事。',
          '切到别的标签页时优化会<b>自动暂停</b>，切回来继续，不会白烧 CPU，也不会把 MerF 弹回去。'
        ],
        physics: '半径是全局耦合的：动一面时，前后间隔、焦点位置和三个视场的彗差会一起变。' +
          '所以"压小某一个面的球差"往往会让别处变差 —— 这正是必须用标量 MerF 全局权衡、而不是逐面手调的原因。' +
          '而"哪些面能动"是<b>你</b>的决策：给多了 MerF 更好但镜组失去设计意图，给少了 MerF 卡在局部最优。',
        threeD: '优化动画：镜片面形逐轮变形（每轮重建 LatheGeometry），像面光斑同步收缩，红黄蓝三条焦线逐渐对齐。',
        expected: '优化结束后伪终端打印 MerF 的前后对比、变量面清单，以及三个视场的新 RMS；' +
          '几何罚必须保持 0（否则解跑到了物理上做不出来的区域）；固定面在 LDE 里的 Radius 读数<b>一字不变</b>。',
        enter: function (c) {
          /* 放开变量面：Surf 1–14、16、17 设为 Variable，Surf 15 留 Fix 做对照 */
          for (var i = 0; i < NS; i++) setVar(i, (i < 14) || (i === 15) || (i === 16));
          c.api.console('Optimization > Start Optimization', 'cmd');
          c.api.console('  Algorithm: coordinate descent over Solve Type = Variable surfaces only', 'sys');
          var vs = varFaces();
          c.api.console('  Variables (' + vs.length + '): Surf ' + vs.map(function (v) { return v + 1; }).join(', '), 'ok');
          c.api.console('  Fixed (not touched): ' + freeFacesText(vs), 'info');
          c.api.console('  Geometry hard-barrier: edge thickness >= 0.8 mm', 'sys');
          refresh(true);
          c.api.toast('Surf 15 故意留成 Fix —— 优化完去看它的 Radius 有没有变', 'info');
          openDrawer('spot');
        }
      },
      {
        id: 'verify',
        title: '变焦复核：长焦端到广角端 + 点列图与 MTF',
        goal: '在变焦行程两端各复核一次，用点列图和 MTF 两条独立证据确认结构可用。',
        uiAction: '拖右侧 <b>变焦位置</b> 滑块。滑块驱动的是<b>第 6 面的空气间隙</b>：' +
          '本模块每次都跑一次二分法，求出让 EFL 精确等于目标的间隙值（这就是 Zemax 里 Thickness 的 <b>Zoom</b> 求解），' +
          '末面厚度则由<b>近轴聚焦</b>自动求解，保证始终合焦。' +
          '每停一格读右侧 FFD 的 EFL 与 BFD，再开 <b>点列图</b> 与 <b>MTF</b> 对照：' +
          'MTF 抽屉里那条紫色虚线是 30 lp/mm，看三视场曲线在它上面的相对高低。',
        hints: [
          '<b>标称行程 125–200mm，但能不能走到 125 取决于处方。</b>' +
          '单移动组的变焦区间完全由当前这 18 个半径决定：烘焙的优化处方在广角端大约停在 <b>130mm</b>，' +
          '而点「恢复初始」回到骨架处方时能精确走到 125.00mm —— 终端里两行会分别打印出来。' +
          '滑到底看到 g1 读数停住不动，那就是<b>变倍组行程用完了</b>。真实 70-200 用更强的负组 + 一个补偿组' +
          '（常用 11~13 片、低色散 ED 玻璃）把 2.86× 的变倍比做出来，这正是凸轮机构存在的理由。',
          'EPD 默认随焦距保持恒定（恒定光圈变焦），所以全焦段 F 数都是 F/5.7。' +
          '想看"变光圈"就把 System Explorer 的 EPD 手动改成固定值，125mm 端会变成 F/3.6，光束立刻过曝。',
          'MTF 离焦 0.02mm 就塌，所以别顺手拖末面厚度 —— 它是求解量，不是自由量。',
          '135 画幅对角的奈奎斯特频率约 25 lp/mm，30 lp/mm 已超画幅极限，<b>只看三条曲线的相对高低</b>。'
        ],
        physics: '本模块用单移动组（变倍组）变焦：焦距是这个间隙的<b>单调函数</b>，所以二分法总能解出唯一解，' +
          '但单调区间的两端就是<b>行程极限</b>。真实变焦用两个移动组做<b>联动凸轮</b>：' +
          '拖滑块时盯着 FFD 的 <b>BFD</b> 读数 —— 本结构在 ' + ZOOM_TELE + 'mm 端是 <b>' + bfdTxt(ZOOM_TELE) +
          '</b>，到 ' + ZOOM_WIDE + 'mm 端变成 <b>' + bfdTxt(ZOOM_WIDE) + '</b>，一镜之内摆动 <b>' +
          bfdSwing() + '</b>。这段变化就是单组变焦的"代价"：变焦时后主面 H′ 在镜筒里来回跑，远摄端尤其明显。' +
          '补偿组存在的意义正是把这段变化压回零 —— 所以真实变焦镜头要靠凸轮曲线同时驱动两个组，' +
          '机构上多一套零件，换来 BFD 基本不动（机械设计上后截距不能乱变，否则对焦行程会跟着变）。',
        threeD: '变焦滑块驱动中间负组沿光轴平移：' + ZOOM_WIDE + '↔' + ZOOM_TELE + 'mm 连续插值，3D 里能直接看到负组滑动，' +
          '光束腰形与像面光斑同步变化，EFL 读数与滑块同步。',
        expected: '长焦端 EFL 精确等于 ' + ZOOM_TELE.toFixed(2) + ' mm（Zoom 求解判据 ±0.05mm）；' +
          '广角端读到的是本处方<b>实际行程能到的</b>焦距（终端里会逐行打印，' +
          'baked 处方约 130mm、恢复初始的骨架能精确到 ' + ZOOM_WIDE.toFixed(2) + 'mm）；' +
          'BFD 从 ' + bfdTxt(ZOOM_TELE) + ' 变到 ' + bfdTxt(wideActual()) + '；' +
          '点列图三视场都有 RMS 数值；MTF 表格在 10 lp/mm 那一行 0ω 明显高于 0.7ω 与 1.0ω，' +
          '30 lp/mm 那一行仍能看出三条曲线的高低次序（而不是全部贴在 x 轴上）。',
        enter: function (c) {
          c.api.console('Zoom & Analysis — 变焦复核', 'cmd');
          c.api.console('  Zoom solve on Surf 6 thickness (bisection, |dEFL| < 0.05 mm)', 'sys');
          c.api.console('  Image plane thickness = Paraxial Focus solve', 'sys');
          [ZOOM_TELE, 175, 150, ZOOM_WIDE].forEach(function (F) {
            var ev = ZM.evaluate({ eflTarget: F, wantPts: true });
            if (ev) c.api.console('  EFL target ' + F + ' mm  ->  gap = ' + ev.g1.toFixed(3) +
              ' mm,  actual EFL = ' + ev.efl.toFixed(3) + ' mm,  BFD = ' + ev.bfd.toFixed(2) +
              ' mm,  total = ' + (ev.len + ev.s[NS - 1].t).toFixed(1) + ' mm,  RMS(0w) = ' + ev.spots[0].rms.toFixed(2) +
              ' um,  rays(1.0w) = ' + ev.spots[2].n + '/' + ev.spots[2].tot,
              Math.abs(ev.efl - F) < 0.5 ? 'ok' : 'warn');
          });
          c.api.console('  实际可解广角端 = ' + wideActual().toFixed(2) + ' mm（标称 ' + ZOOM_WIDE +
            ' mm；单移动组的行程由这 18 个半径决定）', 'warn');
          c.api.console('  单移动组变焦的代价：BFD 从 ' + bfdTxt(ZOOM_TELE) + '（长焦端）变到 ' +
            bfdTxt(wideActual()) + '（广角端），摆动 ' + bfdSwing() + '。', 'warn');
          c.api.console('  真实变焦用两个移动组 + 凸轮联动，把这段 BFD 摆动压到几毫米以内。', 'sys');
          openDrawer('mtf');
          c.api.toast('现在拖「变焦位置」滑块，两端都能精确对上', 'ok');
        }
      }
    ];
  }

  /* ===========================================================================
   * 9. 注册
   * ======================================================================== */
  CAE.registerModule({
    id: 'zemax',
    name: 'Zemax OpticStudio',
    tagline: '光学设计 · 几何光线追迹',
    accent: '#7c6cf0',
    build: function (ctx) {
      injectStyle();
      buildUI(ctx);
      ctx.api.setSteps(mkSteps(ctx));
      var ev = doRefresh(true);
      if (ev) {
        ctx.api.console('Lens file: 125-200F57.zmx   (Sequential, 18 surfaces, 9 elements, single moving group)', 'sys');
        ctx.api.console('EFL = ' + ev.efl.toFixed(3) + ' mm,  F/# = ' + ev.fno.toFixed(2) +
          ',  BFD = ' + ev.bfd.toFixed(2) + ' mm,  total track = ' + (ev.len + ev.s[NS - 1].t).toFixed(1) + ' mm', 'ok');
        ctx.api.console('Tip: 点 LDE 任意一行选中镜片；拖右侧滑块实时重追迹。', 'sys');
      }
      if (ZM.vp && ZM.vp.onFrame) installViewHold(ZM.vp);
      /* 切走标签页：停视口 RAF + 叫停优化循环。
         不停优化的话，那个 40ms 的 setInterval 会继续对 display:none 的宿主
         重建 LatheGeometry 与 LDE 表格，白烧 CPU。切回来 resumeOpt() 续上。 */
      ctx.api.onDeactivate(function () { if (ZM.vp) ZM.vp.stop(); pauseOpt(); });
      ctx.api.onActivate(function () { if (ZM.vp) ZM.vp.start(); resumeOpt(); });
    }
  });
  /* ---- 模块私有样式：全部挂在 #zem-module 作用域下，前缀统一为 zem- ----
         buildUI() 里给 root 挂了 id='zem-module'，所以这些规则不会漏到别的模块；
         列表里写的是「选择器 + 声明」，由 injectStyle() 统一加上作用域前缀。 ---- */
  var ZEM_CSS = [
    ['.zem-body', 'display:flex;gap:6px;padding:6px;flex:1 1 auto;min-height:0;'],
    ['.zem-sysexplorer', 'flex:0 0 208px;overflow:auto;'],
    ['.zem-center', 'flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:6px;min-height:0;'],
    ['.zem-right', 'flex:0 0 244px;overflow:auto;'],
    ['.zem-tabs', 'display:flex;gap:2px;margin-bottom:6px;'],
    ['.zem-tab', 'flex:1 1 0;font:inherit;font-size:11px;padding:3px 2px;border:1px solid var(--line-2);' +
      'border-radius:3px;background:var(--bg-3);color:var(--txt-3);cursor:pointer;'],
    ['.zem-tab.is-on', 'background:var(--accent-dim);border-color:var(--accent);color:var(--accent);'],
    ['.zem-frow', 'display:flex;justify-content:space-between;font:11px Consolas,monospace;color:var(--txt-2);padding:1px 0;'],
    ['.zem-wt', 'width:100%;border-collapse:collapse;font:11px Consolas,monospace;'],
    ['.zem-wt th,.zem-mf-t th', 'background:#1b212a;color:var(--txt-3);font-weight:600;padding:3px 4px;text-align:left;'],
    ['.zem-wt td', 'padding:2px 4px;color:var(--txt-2);border-bottom:1px solid var(--line);'],
    ['.zem-lde-wrap', 'flex:0 0 auto;display:flex;flex-direction:column;min-height:0;'],
    ['.zem-lde-hd', 'font-size:11px;color:var(--txt-2);background:#1b212a;border:1px solid var(--line);' +
      'border-radius:4px 4px 0 0;padding:3px 8px;display:flex;align-items:center;'],
    ['.zem-lde', 'height:186px;overflow:auto;background:#151a20;border:1px solid var(--line);border-top:0;border-radius:0 0 4px 4px;'],
    ['.zem-lde-t', 'width:100%;border-collapse:collapse;font:11px Consolas,monospace;'],
    ['.zem-lde-t th', 'position:sticky;top:0;background:#20262f;color:var(--txt-3);padding:3px 5px;text-align:left;z-index:2;'],
    ['.zem-lde-t td', 'padding:1px 5px;color:var(--txt-2);border-bottom:1px solid #1e242c;white-space:nowrap;'],
    ['.zem-lde-t tr', 'cursor:pointer;'],
    ['.zem-lde-t tr:hover td', 'background:#1e242c;'],
    ['.zem-lde-t tr.is-sel td', 'background:var(--accent-dim);color:var(--txt);'],
    ['.zem-lde-t tr.is-obj td,.zem-lde-t tr.is-img td', 'color:var(--txt-3);background:#191f26;font-style:italic;'],
    ['.zem-lde-t td.c1', 'color:var(--txt-3);'],
    ['.zem-lde-t td.num', 'color:#a8e6cf;'],
    ['.zem-grp', 'color:var(--accent);font-size:9px;margin-left:2px;'],
    ['.zem-solve', 'color:var(--txt-3);'],
    ['.zem-solve.is-var', 'color:var(--accent);'],
    ['.zem-vp-row', 'position:relative;flex:1 1 auto;min-height:150px;display:flex;'],
    ['.zem-vp-row .viewport', 'flex:1 1 auto;'],
    ['.zem-vp-btns', 'position:absolute;right:8px;top:8px;display:flex;gap:4px;z-index:3;'],
    ['.zem-drawer', 'flex:0 0 auto;background:#151a20;border:1px solid var(--line);border-radius:4px;' +
      'display:flex;flex-direction:column;overflow:hidden;'],
    ['.zem-drawer-hd', 'display:flex;align-items:center;font-size:11px;color:var(--txt-2);' +
      'background:#1b212a;padding:3px 8px;border-bottom:1px solid var(--line);'],
    ['.zem-drawer-bd', 'flex:1 1 auto;min-height:0;overflow:auto;padding:6px;'],
    ['.zem-an', 'display:flex;gap:8px;height:100%;min-height:0;'],
    ['.zem-an-b', 'flex:0 0 236px;min-width:0;'],
    ['.zem-an-b canvas', 'width:100%;height:178px;border:1px solid var(--line);border-radius:4px;display:block;'],
    ['.zem-an-s', 'flex:1 1 auto;min-width:0;overflow:auto;'],
    ['.zem-fbtn', 'display:flex;gap:4px;margin-bottom:6px;'],
    ['.zem-info', 'font-size:11px;'],
    ['.zem-mf-t', 'width:100%;border-collapse:collapse;font:11px Consolas,monospace;'],
    ['.zem-mf-t td', 'padding:2px 4px;border-bottom:1px solid var(--line);color:var(--txt-2);'],
    ['.zem-mf-ft', 'display:flex;align-items:center;margin:6px 0;font-size:12px;color:var(--txt-2);'],
    ['.zem-mf-formula', 'font:12px Consolas,monospace;color:var(--accent);background:rgba(124,108,240,.10);' +
      'border:1px solid var(--line);border-radius:4px;padding:4px 8px;margin:2px 0 8px;'],
    ['.zem-mf-legend', 'font-size:11px;line-height:1.65;color:var(--txt-2);background:#11151b;' +
      'border:1px solid var(--line);border-radius:4px;padding:6px 8px;margin-bottom:8px;'],
    ['.zem-mf-legend b', 'color:var(--accent);font-family:Consolas,monospace;'],
    ['.zem-mf .input', 'padding:1px 4px;font:11px Consolas,monospace;'],
    ['.zem-mf .select', 'padding:1px 4px;font:11px Consolas,monospace;'],
    ['.zem-sl', 'margin-bottom:8px;'],
    ['.zem-sl-hd', 'display:flex;justify-content:space-between;font-size:11px;color:var(--txt-3);margin-bottom:2px;'],
    ['.zem-sl-hd b', 'color:var(--txt);font-family:Consolas,monospace;font-weight:600;'],
    ['.zem-sl input[type=range]', 'width:100%;accent-color:var(--accent);height:16px;'],
    ['.zem-cat', 'width:100%;border-collapse:collapse;font:11px Consolas,monospace;'],
    ['.zem-cat th', 'background:#1b212a;color:var(--txt-3);padding:3px 5px;text-align:left;'],
    ['.zem-cat td', 'padding:2px 5px;border-bottom:1px solid var(--line);color:var(--txt-2);'],
    ['.zem-ffd', 'font-size:11px;']
  ];
  function injectStyle() {
    if (document.getElementById('zemStyle')) return;
    var css = ZEM_CSS.map(function (r) {
      /* 逗号分隔的多个选择器要逐个加前缀，不能只加一次 */
      var sels = r[0].split(',').map(function (x) { return '#zem-module ' + x.trim(); });
      return sels.join(',') + '{' + r[1] + '}';
    }).join('');
    var st = document.createElement('style');
    st.id = 'zemStyle'; st.textContent = css;
    document.head.appendChild(st);
  }
})();
