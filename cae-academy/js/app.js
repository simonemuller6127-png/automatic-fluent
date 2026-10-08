/* =============================================================================
 *  app.js —— CAE 虚拟仿真实训平台 · 平台骨架与教学引擎
 *  暴露全局命名空间 window.CAE
 *
 * ############################################################################
 * #  模块工程师对接契约 (CONTRACT)  —— 请在动手写 js/*.js 之前通读一遍
 * ############################################################################
 *
 * ## 0. 纪律（最重要）
 *   D1. 三位模块工程师各写各的文件：js/fluent.js、js/mechanical.js、js/zemax.js。
 *       **只许改自己那一个文件**，不要改 app.js / three-setup.js / app.css / index.html。
 *   D2. 全部经典 <script>，禁止 ES module、禁止 import/export、禁止打包器。
 *       所有东西挂在 window.CAE 上，不要污染全局其他名字（模块私有变量用 IIFE 包起来）。
 *   D3. 不加载任何外部模型/贴图文件，三维几何一律用 THREE 代码程序化生成。
 *   D4. 文案全中文；提示要"给足"，别只丢一句"点击完成"。
 *
 * ## 1. 注册模块
 *   CAE.registerModule({
 *     id:      'fluent',              // 唯一标识，与 index.html 里 data-module 一致
 *     name:    'ANSYS Fluent',        // 标签页显示名
 *     tagline: '外流场 · 流体仿真',   // 标签页副标题
 *     accent:  '#19b5a5',             // 主题色，同时写进 .tab 的 --tab-accent
 *     build:   function (ctx) { ... }  // 标签页【首次】激活时调用一次
 *   })
 *   ctx = { root, api, module }
 *     root   : HTMLElement —— .sim-stage 里的模块容器（只属于你，直接改）
 *     api    : 见下文的 api 对象
 *     module : { id, name, tagline, accent } 的副本
 *   build 里做两件事：① 画出伪软件界面（用共享 CSS 类）；② api.setSteps(steps)。
 *
 * ## 2. 步骤数据结构
 *   api.setSteps([
 *     {
 *       id:      'geometry',        // 必填，模块内唯一，进度持久化按它记账
 *       title:   '导入与检查几何',   // 必填，左侧步骤名 + 教学卡标题
 *       goal:    '本步要达成什么',   // 必填
 *       uiAction:'鼠标要点的位置',   // 必填，讲清在哪个面板点哪个控件
 *       hints:   ['提示1', '提示2'], // 选填，渐进式：默认只露第 1 条
 *       physics: '背后的物理原理',   // 选填
 *       threeD:  '视口里会看到什么', // 选填
 *       expected:'做完后的现象/数值',// 选填
 *       notes:   '补充说明',         // 选填（额外小节，不占强提示位）
 *       enter:   function (ctx) { ... }  // 选填，切换到该步时调用
 *     }, ...
 *   ])
 *   除 id/title/goal/uiAction 外都可省略；文本内容按 **HTML** 渲染
 *   （可用 <b>、<code>、<br>），也可用数组，每项渲染成一段。
 *
 *   enter(ctx) 的 ctx：
 *     api      —— 同下文的 api
 *     viewport —— 当前视口句柄（还没调 setViewport 时为 null）
 *     root     —— 你的模块容器
 *     step     —— 当前步骤对象
 *     index    —— 0 基序号
 *     total    —— 总步数
 *   ⚠ enter 会被【反复调用】：切步骤、来回切标签页、刷新后恢复进度都会再走一次。
 *     所以 enter 必须**幂等**——每次进来先把上一轮建的网格清掉再重建。
 *
 * ## 3. api 全部方法（签名以 js/app.js 实现为准）
 *   // —— 教学流程 ——
 *   api.setSteps(steps)                注册步骤；重复调用会重置到第 0 步
 *   api.getSteps()                     返回步骤数组
 *   api.gotoStep(indexOrId)            跳到第 n 步（0 基）或指定 id；返回落点 index
 *   api.next() / api.prev()            上/下一步，越界自动钳制
 *   api.getCurrentStep()               返回 { step, index, total } 或 null
 *   api.markDone(stepId?)              标记完成；不传参 = 标记当前步
 *   api.isDone(stepId)                 查完成状态
 *   api.getProgress()                  返回 { done: [...id], total, percent }
 *   api.resetProgress()                清空本模块进度（带确认）
 *   // —— 视口与渲染 ——
   *   api.setViewport(el, opts?)         在 el 里建 3D 视口，返回句柄；
   *                                     传同一个 el 会复用；换 el 会释放旧视口
   *                                     opts.keepPrevious = true 时旧视口**不释放**，
   *                                     但仍由平台托管：切走标签页会停它的 RAF，
   *                                     api.clearViewport() 会连它一起 dispose。
   *                                     句柄可以丢掉，但别指望平台找不到它。
   *                                     每个模块各自持有一个，互不干扰（哪怕调用时本模块没被激活）
 *   api.clearViewport()                释放当前视口
 *   api.onActivate(fn)                 标签页被激活时回调 fn(ctx)，返回取消函数
 *   api.onDeactivate(fn)               标签页被切走时回调 fn(ctx)，返回取消函数
 *   // —— 界面小工具 ——
 *   api.toast(msg, kind?)              右上角浮条，kind: 'ok'|'warn'|'err'|'info'
 *   api.console(msg, kind?)            写底部伪终端，kind 同上
 *   api.clearConsole()                 清空伪终端
 *   api.setStatus(text | obj)          写状态栏；传字符串=整体替换，传对象=按键合并
 *   api.getModule()                    { id, name, tagline, accent }
 *   api.getRoot()                      你的模块容器
 *   api.version                        平台版本号（字符串）
 *
 *   视口句柄（CAE.createViewport 的返回值）：
 *     { scene, camera, renderer, controls, domElement,
 *       onFrame(cb)   注册每帧回调 cb(dt, elapsed)，返回取消函数，
 *       start(), stop(), isRunning(), resize(),
 *       setBackground(color), setAccent(hex), clear(), dispose() }
 *     controls: { target, enabled, update(), reset(), setEnabled(bool),
 *                 setView(theta, phi, radius, target?) }
 *       setView 的 theta / phi 用弧度、radius 是视距；它只改期望值，阻尼照旧。
 *     ⚠ 没有 WebGL 时 createViewport 返回同形状的**降级句柄**（unavailable:true），
 *       方法全是空转，所以模块代码不必写 if 判断，照常用即可。
 *
 * ## 4. CSS 共享类（css/app.css 顶部有完整清单，这里是高频的）
 *   .sim-window 伪软件窗口外壳   .sim-titlebar 窗口标题栏
 *   .menu-bar 菜单栏 / .menu-item 菜单项
 *   .ribbon 工具栏 / .ribbon-group 组 / .ribbon-btn 工具按钮
 *   .tree 模型树 / .tree-item 树节点(.is-sel 选中, .is-off 隐藏) / .tree-toggle 箭头
 *   .props 属性面板 / .field 表单行 / .input .select .check .kv
 *   .console 伪终端（app.js 已建好并挂在窗口底部，别重复建）
 *   .viewport 3D 视口容器 / .legend .legend-bar .legend-ticks 云图彩条
 *   .step-card 教学卡 / .hint 提示条 / .btn 按钮 / .badge 徽标
 *   辅助：.panel .panel-hd .panel-bd .group .group-hd .row .kv .mono .muted
 *        .scroll .empty .tag .divider
 *   需要新样式请用**模块前缀**写在自己的内联 style 里（如 .flu-xxx / .zem-xxx），
 *   不要往 app.css 里加你的私有类。
 *
 * ## 5. 骨架与职责边界
 *   app.js 拥有：品牌栏、标签页、三栏布局、步骤列表、教学卡、伪终端、状态栏、
 *                Toast、进度持久化、视口生命周期（启停 RAF）。
 *   你拥有：.sim-stage 里的一切 —— 菜单栏、ribbon、左树、右属性面板、
 *           视口容器、图例、以及你模块的私有状态。
 *
 * ## 6. 进度持久化
 *   localStorage 键：cae-academy:progress:v1
 *   结构：{ "fluent": { "done": ["geometry","domain"], "pos": 2 }, ... }
 *   平台启动时自动恢复到你上次的位置。
 * ############################################################################
 * ============================================================================= */
(function (global) {
  'use strict';

  var CAE = (global.CAE = global.CAE || {});

  var VERSION = '1.0.0';
  var STORE_KEY = 'cae-academy:progress:v1';
  var CONSOLE_MAX = 600;

  /* ===========================================================================
   * 0. DOM 索引与全局状态
   * ======================================================================== */
  var D = {
    tabs: null, stepList: null, stepCard: null, progressFill: null, progressText: null,
    resetBtn: null, simTitle: null, simTagline: null, moduleHost: null,
    simConsole: null, statusBar: null, toastWrap: null, bootMask: null
  };

  var modules = {};      // id -> 模块定义
  var order = [];        // 注册顺序
  var runtimes = {};     // id -> 运行时状态
  var activeId = null;
  var inited = false;
  var CONSOLE_EL = null; // 全平台唯一的伪终端元素
  var store = loadStore();

  function q(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ===========================================================================
   * 1. 进度持久化（localStorage 可能被 file:// 或隐私模式禁用，全程 try/catch）
   * ======================================================================== */
  function loadStore() {
    try {
      var raw = global.localStorage.getItem(STORE_KEY);
      var obj = raw ? JSON.parse(raw) : {};
      return (obj && typeof obj === 'object') ? obj : {};
    } catch (e) { return {}; }
  }
  function saveStore() {
    try { global.localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* 忽略 */ }
  }
  function modStore(id) {
    if (!store[id] || typeof store[id] !== 'object') store[id] = { done: [], pos: 0 };
    if (!Array.isArray(store[id].done)) store[id].done = [];
    if (typeof store[id].pos !== 'number') store[id].pos = 0;
    return store[id];
  }
  function newRuntime(def) {
    return {
      def: def, built: false, host: null,
      steps: [], idx: 0, viewport: null, viewportEl: null,
      parked: [],               // 被 keepPrevious 保留的旧视口（仍归本模块管）
      actFns: [], deactFns: [], hints: {}, status: {}, logs: []
    };
  }
  function rt(id) {
    if (!runtimes[id]) runtimes[id] = newRuntime(modules[id]);
    return runtimes[id];
  }

  /* ===========================================================================
   * 2. Toast
   * ======================================================================== */
  function toast(msg, kind) {
    if (!D.toastWrap) return;
    var t = document.createElement('div');
    t.className = 'toast t-' + (kind || 'info');
    t.textContent = msg;
    D.toastWrap.appendChild(t);
    global.setTimeout(function () {
      t.classList.add('out');
      global.setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, 2600);
  }

  /* ===========================================================================
   * 3. 伪终端
   *    整个平台只有**一个** .console 元素（固定在伪软件窗口底部）。
   *    每个模块各存一份日志缓冲，切标签页时把缓冲重画进去——
   *    否则三个模块的终端会往下摞成一列。
   * ======================================================================== */
  function ensureConsole() {
    if (CONSOLE_EL) return CONSOLE_EL;
    var box = document.createElement('div');
    box.className = 'console';
    CONSOLE_EL = box;
    var win = D.simConsole && D.simConsole.parentNode;
    if (win) win.insertBefore(box, D.simConsole);
    else if (D.moduleHost && D.moduleHost.parentNode) D.moduleHost.parentNode.appendChild(box);
    return box;
  }
  function appendLine(box, text, kind) {
    var line = document.createElement('div');
    line.className = 'console-line c-' + (kind || 'info');
    line.textContent = (text === undefined || text === null) ? '' : String(text);
    box.appendChild(line);
  }
  /** 把某个模块的整段日志重画到终端里（切模块 / 首次激活时调用） */
  function renderConsole(id) {
    var box = ensureConsole();
    var r = rt(id);
    box.innerHTML = '';
    for (var i = 0; i < r.logs.length; i++) appendLine(box, r.logs[i].t, r.logs[i].k);
    box.scrollTop = box.scrollHeight;
  }
  function writeConsole(id, msg, kind) {
    var r = rt(id);
    r.logs.push({ t: (msg === undefined || msg === null) ? '' : String(msg), k: kind || 'info' });
    while (r.logs.length > CONSOLE_MAX) r.logs.shift();
    if (id === activeId) {
      var box = ensureConsole();
      appendLine(box, msg, kind);
      while (box.childNodes.length > CONSOLE_MAX) box.removeChild(box.firstChild);
      box.scrollTop = box.scrollHeight;
    }
  }

  /* ===========================================================================
   * 4. 状态栏
   * ======================================================================== */
  function renderStatus(id) {
    if (!D.statusBar) return;
    var r = rt(id);
    var keys = Object.keys(r.status);
    D.statusBar.textContent = keys.length
      ? keys.map(function (k) { return k + ': ' + r.status[k]; }).join('   ·   ')
      : (r.def.name + '  ' + r.def.tagline);
  }

  /* ===========================================================================
   * 5. 主题色
   * ======================================================================== */
  function applyAccent(hex) {
    var root = document.documentElement;
    var h = (hex || '#19b5a5').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) h = '19b5a5';
    root.style.setProperty('--accent', '#' + h);
    root.style.setProperty('--accent-dim', '#' + h + '33');
  }

  /* ===========================================================================
   * 6. 模块注册与标签页路由
   * ======================================================================== */
  CAE.registerModule = function (def) {
    if (!def || !def.id) { console.error('[CAE] registerModule 缺 id'); return; }
    if (typeof def.build !== 'function') { console.error('[CAE] ' + def.id + ' 缺 build 函数'); return; }
    if (modules[def.id]) { console.warn('[CAE] 模块重复注册：' + def.id); return; }

    def.accent = def.accent || '#7f8c99';
    def.name = def.name || def.id;
    def.tagline = def.tagline || '';
    modules[def.id] = def;
    order.push(def.id);
    runtimes[def.id] = newRuntime(def);
    syncTab(def);
    maybeAutoActivate();
  };

  CAE.listModules = function () {
    return order.map(function (id) {
      var d = modules[id];
      return { id: d.id, name: d.name, tagline: d.tagline, accent: d.accent };
    });
  };

  /** 让 index.html 里写好的 tab 与注册的模块保持一致（缺了就补，多了就忽略） */
  function syncTab(def) {
    if (!D.tabs) return;
    var btn = D.tabs.querySelector('.tab[data-module="' + def.id + '"]');
    if (!btn) {
      btn = document.createElement('button');
      btn.className = 'tab';
      btn.type = 'button';
      btn.setAttribute('data-module', def.id);
      D.tabs.appendChild(btn);
    }
    btn.style.setProperty('--tab-accent', def.accent);
    btn.innerHTML = '<span class="tab-dot"></span><span class="tab-name"></span>' +
      '<span class="tab-tag"></span><span class="tab-progress"></span>';
    btn.querySelector('.tab-name').textContent = def.name;
    btn.querySelector('.tab-tag').textContent = def.tagline;
    btn.onclick = function () { activate(def.id); };
    refreshTabProgress(def.id);
  }

  function refreshTabProgress(id) {
    if (!D.tabs) return;
    var btn = D.tabs.querySelector('.tab[data-module="' + id + '"]');
    if (!btn) return;
    var p = btn.querySelector('.tab-progress');
    if (!p) return;
    var r = rt(id);
    if (!r.steps.length) { p.textContent = ''; return; }
    var done = doneList(id).length;
    p.textContent = done + '/' + r.steps.length;
  }

  function maybeAutoActivate() {
    if (!inited) return;   // 等 init() 跑完再激活，那之前 D.* 才取得到
    if (activeId) return;
    if (!order.length) return;
    var want = String(global.location.hash || '').replace(/^#/, '');
    activate(modules[want] ? want : order[0]);
  }

  /** 激活模块：切走旧的 → 切进新的 → 首次则跑 build → 渲染当前步 */
  function activate(id) {
    if (!modules[id]) return;
    if (activeId === id) { if (runtimes[id] && !runtimes[id].built) runBuild(id); return; }

    if (activeId) deactivateModule(activeId);

    activeId = id;
    var def = modules[id], r = rt(id);

    applyAccent(def.accent);
    if (D.tabs) {
      var btns = D.tabs.querySelectorAll('.tab');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('is-active', btns[i].getAttribute('data-module') === id);
      }
    }
    if (global.location.hash !== '#' + id) {
      try { global.location.hash = '#' + id; } catch (e) { /* file:// 下个别浏览器会拒绝 */ }
    }
    if (D.simTitle) D.simTitle.textContent = def.name;
    if (D.simTagline) D.simTagline.textContent = def.tagline;

    // 切换模块容器显隐：非激活的保持 display:none（省内存 + 防误触）
    for (var k in runtimes) {
      if (runtimes[k].host) runtimes[k].host.style.display = (k === id) ? '' : 'none';
    }

    runBuild(id);                 // 首次激活才真正执行
    renderStatus(id);
    renderConsole(id);            // 把该模块的日志重画进唯一那一个伪终端
    renderStepList();
    renderCard();
    runEnter(rt(id));             // 当前步的 enter()（契约第 2 节：切回标签页也要再走一次）

    if (r.viewport) {
      r.viewport.start();
      /* 模块面板、滚动条、字体都可能让布局晚一两帧才定下来；
         只在 rAF 里量一次尺寸会把 canvas 尺寸定在旧值上（画面被拉伸），
         所以再补一次延时校正。 */
      global.requestAnimationFrame(function () { if (r.viewport) r.viewport.resize(); });
      global.setTimeout(function () { if (r.viewport) r.viewport.resize(); }, 150);
    }
    var ctx = makeCtx(id);
    for (var j = 0; j < r.actFns.length; j++) {
      try { r.actFns[j](ctx); } catch (e) { console.error('[CAE] onActivate 回调异常', e); }
    }
  }

  function deactivateModule(id) {
    var r = rt(id);
    var ctx = makeCtx(id);
    for (var i = 0; i < r.deactFns.length; i++) {
      try { r.deactFns[i](ctx); } catch (e) { console.error('[CAE] onDeactivate 回调异常', e); }
    }
    if (r.viewport) r.viewport.stop();   // 关键：三个页面不能同时跑 RAF
    /* keepPrevious 留下的旧视口也要停 —— 它同样属于这个模块 */
    for (var j = 0; j < r.parked.length; j++) { try { r.parked[j].stop(); } catch (e) { /* 忽略 */ } }
  }

  function runBuild(id) {
    var r = rt(id);
    if (r.built) return;
    r.built = true;                        // 先置位，防止 build 里再触发造成递归
    var host = document.createElement('div');
    host.className = 'mod-host';
    host.style.cssText = 'height:100%;display:flex;flex-direction:column;min-height:0;';
    r.host = host;
    if (D.moduleHost) D.moduleHost.appendChild(host);
    ensureConsole();
    /* ⚠ 必须在 build() **之前**把上次的位置读出来。
       build() 里的 api.setSteps() 会把 modStore(id).pos 清零（见 makeApi.setSteps），
       之后再读就永远是 0，"刷新后恢复进度" 会整条失效。 */
    var savedPos = modStore(id).pos;
    writeConsole(id, '[' + r.def.name + '] 会话开始', 'sys');
    try {
      r.def.build({ root: host, api: makeApi(id), module: pick(r.def) });
    } catch (e) {
      console.error('[CAE] ' + id + ' build 失败', e);
      host.innerHTML = '<div class="empty">模块加载出错：' + esc(e && e.message ? e.message : e) + '</div>';
      writeConsole(id, 'build 失败：' + (e && e.message ? e.message : e), 'err');
    }
    // build 之后才可能有步骤；用 build 前存下来的位置恢复
    if (r.steps.length) {
      r.idx = (savedPos >= 0 && savedPos < r.steps.length) ? savedPos : 0;
      /* 落回存储：setSteps 已经把它清成 0，这里写回真实位置，
         免得下一次 markDone/gotoStep 又把 0 当成"上次停在哪"存回去 */
      if (r.idx !== 0) { modStore(id).pos = r.idx; saveStore(); }
    }
  }

  function pick(def) {
    return { id: def.id, name: def.name, tagline: def.tagline, accent: def.accent };
  }
  function doneList(id) { return modStore(id).done; }

  /* ===========================================================================
   * 7. 教学引擎：步骤列表 / 教学卡 / 提示
   * ======================================================================== */
  function renderStepList() {
    if (!D.stepList) return;
    var id = activeId, r = rt(id);
    D.stepList.innerHTML = '';
    if (!r.steps.length) {
      D.stepList.innerHTML = '<div class="empty">本模块尚未注册步骤</div>';
      return;
    }
    var done = doneList(id);
    r.steps.forEach(function (s, i) {
      var li = document.createElement('li');
      li.className = 'step-item' + (i === r.idx ? ' is-active' : '') + (done.indexOf(s.id) >= 0 ? ' is-done' : '');
      li.innerHTML = '<span class="step-no">' + (done.indexOf(s.id) >= 0 ? '✓' : (i + 1)) + '</span>' +
        '<span class="step-name"></span>';
      li.querySelector('.step-name').textContent = s.title || s.id;
      li.title = s.goal || '';
      li.onclick = function () { gotoStep(i); };
      D.stepList.appendChild(li);
    });
    updateProgress();
  }

  function updateProgress() {
    if (!activeId) return;
    var r = rt(activeId);
    var done = doneList(activeId).filter(function (id) {
      for (var i = 0; i < r.steps.length; i++) if (r.steps[i].id === id) return true;
      return false;
    });
    var total = r.steps.length;
    var pct = total ? Math.round((done.length / total) * 100) : 0;
    if (D.progressFill) D.progressFill.style.width = pct + '%';
    if (D.progressText) D.progressText.textContent = total ? (done.length + ' / ' + total + ' 步 · ' + pct + '%') : '暂无步骤';
    refreshTabProgress(activeId);
  }

  /** 把字段渲染成教学卡小节；数组每项一段 */
  function section(icon, title, value) {
    if (!value) return '';
    var body = Array.isArray(value)
      ? value.map(function (v) { return '<p>' + v + '</p>'; }).join('')
      : '<p>' + value + '</p>';
    return '<div class="sc-sec"><h3>' + icon + ' ' + title + '</h3>' + body + '</div>';
  }

  function renderCard() {
    if (!D.stepCard || !activeId) return;
    var r = rt(activeId);
    if (!r.steps.length) {
      D.stepCard.innerHTML = '<div class="step-card"><div class="empty">教学卡待填充</div></div>';
      return;
    }
    var s = r.steps[r.idx], total = r.steps.length;
    if (r.hints[s.id] === undefined) r.hints[s.id] = 1;         // 默认只露第 1 条

    var card = document.createElement('div');
    card.className = 'step-card';

    var head = document.createElement('div');
    head.className = 'sc-head';
    head.innerHTML = '<span class="sc-index">步骤 ' + (r.idx + 1) + ' / ' + total + '</span>' +
      '<label class="sc-done"><input type="checkbox"><span>我已完成</span></label>';
    card.appendChild(head);

    var h = document.createElement('h2');
    h.className = 'sc-title';
    h.textContent = s.title || s.id;
    card.appendChild(h);

    // 五个标准小节（+ notes）
    var html = section('🎯', '本步目标', s.goal) +
      section('🖱', '界面操作', s.uiAction) +
      section('📐', '物理原理', s.physics) +
      section('🧊', '三维可视', s.threeD) +
      section('✅', '预期结果', s.expected) +
      section('📌', '补充说明', s.notes);
    if (html) {
      var frag = document.createElement('div');
      frag.innerHTML = html;
      while (frag.firstChild) card.appendChild(frag.firstChild);
    }

    // 提示区（渐进展开）
    var hints = Array.isArray(s.hints) ? s.hints : [];
    if (hints.length) {
      var hbox = document.createElement('div');
      hbox.className = 'sc-hints';
      var hh = document.createElement('h3');
      hh.style.cssText = 'font-size:12px;margin:0 0 6px;color:var(--txt-2);font-weight:600;';
      hh.textContent = '💡 提示（' + Math.min(r.hints[s.id], hints.length) + ' / ' + hints.length + '）';
      hbox.appendChild(hh);
      renderHints(hbox, s, hints);
      card.appendChild(hbox);
    }

    // 导航条
    var nav = document.createElement('div');
    nav.className = 'sc-nav';
    var prev = mkBtn('上一步', 'btn btn-ghost', r.idx > 0);
    prev.onclick = function () { prevStep(); };
    var next = mkBtn(r.idx >= total - 1 ? '🎉 已到最后一步' : '下一步', 'btn btn-primary', r.idx < total - 1);
    next.onclick = function () { nextStep(); };
    nav.appendChild(prev);
    nav.appendChild(next);
    card.appendChild(nav);

    // 勾选框
    var cb = head.querySelector('input');
    cb.checked = doneList(activeId).indexOf(s.id) >= 0;
    cb.onchange = function () { cb.checked ? markDone(s.id) : unmarkDone(s.id); renderStepList(); };

    D.stepCard.innerHTML = '';
    D.stepCard.appendChild(card);
  }

  function mkBtn(text, cls, enabled) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    if (!enabled) b.disabled = true;
    return b;
  }

  function renderHints(hbox, step, hints) {
    var r = rt(activeId);
    var shown = Math.min(r.hints[step.id], hints.length);
    // 去掉旧的提示行与按钮，保留标题
    var keep = hbox.firstChild;
    hbox.innerHTML = '';
    if (keep) hbox.appendChild(keep);
    for (var i = 0; i < shown; i++) {
      var d = document.createElement('div');
      d.className = 'hint';
      d.innerHTML = '<span class="hint-n">H' + (i + 1) + '</span><span class="hint-text"></span>';
      d.querySelector('.hint-text').innerHTML = hints[i];
      hbox.appendChild(d);
    }
    if (shown < hints.length) {
      var b = mkBtn('再给一条提示（还有 ' + (hints.length - shown) + ' 条）', 'btn btn-ghost btn-sm hint-more', true);
      b.onclick = function () {
        r.hints[step.id] = shown + 1;
        renderHints(hbox, step, hints);
        if (r.hints[step.id] >= hints.length) toast('提示已全部给出，动手做吧！', 'ok');
      };
      hbox.appendChild(b);
    } else {
      var all = document.createElement('div');
      all.className = 'muted';
      all.style.cssText = 'font-size:11px;';
      all.textContent = '以上提示已全部给出。';
      hbox.appendChild(all);
    }
  }

  /* ===========================================================================
   * 8. 步骤跳转
   * ======================================================================== */
  function gotoStep(target) {
    var r = rt(activeId);
    if (!r || !r.steps.length) return r ? r.idx : 0;
    var i = (typeof target === 'string')
      ? indexOfStep(r, target)
      : Math.round(target);
    if (i < 0) i = 0;
    if (i > r.steps.length - 1) i = r.steps.length - 1;
    r.idx = i;
    modStore(activeId).pos = i;
    saveStore();
    renderStepList();
    renderCard();
    runEnter(r);
    return i;
  }
  function indexOfStep(r, id) {
    for (var i = 0; i < r.steps.length; i++) if (r.steps[i].id === id) return i;
    return -1;
  }
  function runEnter(r) {
    var s = r.steps[r.idx];
    if (!s || typeof s.enter !== 'function') return;
    try { s.enter(makeCtx(activeId)); }
    catch (e) { console.error('[CAE] ' + activeId + ' 第' + (r.idx + 1) + '步 enter 出错', e); toast('该步 enter 执行出错，详见控制台', 'err'); }
  }
  function nextStep() {
    var r = rt(activeId);
    if (r.idx < r.steps.length - 1) { gotoStep(r.idx + 1); return; }
    var d = doneList(activeId).length, t = r.steps.length;
    if (t && d >= t) toast('恭喜！本模块全部步骤已完成 🎉', 'ok');
  }
  function prevStep() { var r = rt(activeId); if (r.idx > 0) gotoStep(r.idx - 1); }

  function markDone(stepId) {
    var r = rt(activeId);
    var id = stepId || (r.steps[r.idx] && r.steps[r.idx].id);
    if (!id) return;
    var list = doneList(activeId);
    if (list.indexOf(id) < 0) { list.push(id); saveStore(); }
    updateProgress();
  }
  function unmarkDone(stepId) {
    var r = rt(activeId);
    var id = stepId || (r.steps[r.idx] && r.steps[r.idx].id);
    var list = doneList(activeId);
    var i = list.indexOf(id);
    if (i >= 0) { list.splice(i, 1); saveStore(); }
    updateProgress();
  }

  /* ===========================================================================
   *  9. 视口管理（一个模块同时只保留一个"主视口"）
   *     ⚠ 所有函数都吃一个显式的模块 id：视口是「每个模块一个」的，
   *       如果按 activeId 取运行时，非激活模块的回调（例如 setSteps → enter）
   *       就会把视口挂到当前标签页头上，把别的模块的视口顶掉。
   * ======================================================================== */
  function setViewport(id, el, opts) {
    var r = rt(id);
    opts = opts || {};
    if (el && el === r.viewportEl && r.viewport) {
      if (id === activeId) r.viewport.start();
      return r.viewport;
    }
    if (r.viewport && !opts.keepPrevious) {
      try { r.viewport.dispose(); } catch (e) { /* 忽略 */ }
    } else if (r.viewport && opts.keepPrevious) {
      /* keepPrevious：旧视口不释放，但**必须继续由本模块托管**。
         直接把 r.viewport 置 null 会把句柄丢掉，之后 deactivateModule /
         clearViewport 再也够不到它，它的 RAF 会永远跑下去。 */
      try { r.viewport.stop(); } catch (e) { /* 忽略 */ }
      r.parked.push(r.viewport);
    }
    r.viewport = null;
    r.viewportEl = el || null;
    if (!el) return null;
    if (!CAE.createViewport) {
      toast('three-setup.js 未加载', 'err');
      return null;
    }
    try {
      r.viewport = CAE.createViewport(el, opts);
      if (activeId !== id) r.viewport.stop();
      if (r.viewport.unavailable) toast('三维视口不可用：' + r.viewport.message, 'warn');
    } catch (e) {
      console.error('[CAE] setViewport 失败', e);
      r.viewport = null;
      toast('视口创建失败：' + (e && e.message ? e.message : e), 'err');
    }
    return r.viewport;
  }
  function clearViewport(id) {
    var r = rt(id);
    if (r.viewport) { try { r.viewport.dispose(); } catch (e) { /* 忽略 */ } }
    for (var i = 0; i < r.parked.length; i++) {
      try { r.parked[i].dispose(); } catch (e) { /* 忽略 */ }
    }
    r.parked.length = 0;
    r.viewport = null;
    r.viewportEl = null;
  }

  /* ===========================================================================
   * 10. ctx / api 工厂
   * ======================================================================== */
  function makeCtx(id) {
    var r = rt(id);
    return {
      api: makeApi(id),
      viewport: r.viewport,
      root: r.host,
      step: r.steps[r.idx] || null,
      index: r.idx,
      total: r.steps.length,
      module: pick(r.def)
    };
  }

  function makeApi(id) {
    var r = rt(id);
    return {
      version: VERSION,

      /* —— 教学流程 —— */
      setSteps: function (steps) {
        if (!Array.isArray(steps)) { console.error('[CAE] setSteps 需要数组'); return; }
        r.steps = steps.filter(function (s) { return s && s.id; });
        r.idx = 0;
        r.hints = {};
        modStore(id).pos = 0;
        renderStepList();
        renderCard();
        runEnter(r);
      },
      getSteps: function () { return r.steps.slice(); },
      gotoStep: gotoStep,
      next: nextStep,
      prev: prevStep,
      getCurrentStep: function () { return r.steps.length ? { step: r.steps[r.idx], index: r.idx, total: r.steps.length } : null; },
      markDone: function (stepId) { markDone(stepId); renderCard(); },
      unmarkDone: function (stepId) { unmarkDone(stepId); renderCard(); },
      isDone: function (stepId) { return doneList(id).indexOf(stepId) >= 0; },
      getProgress: function () {
        var total = r.steps.length, done = doneList(id).length;
        return { done: doneList(id).slice(), total: total, percent: total ? Math.round(done / total * 100) : 0 };
      },
      resetProgress: function () {
        if (!global.confirm('确定要清空「' + r.def.name + '」的学习进度吗？')) return;
        store[id] = { done: [], pos: 0 };
        saveStore();
        r.idx = 0; r.hints = {};
        renderStepList();
        gotoStep(0);
        toast('进度已重置', 'ok');
      },

      /* —— 视口 —— */
      setViewport: function (el, opts) { return setViewport(id, el, opts); },
      clearViewport: function () { clearViewport(id); },
      onActivate: function (fn) {
        if (typeof fn !== 'function') return function () {};
        r.actFns.push(fn);
        return function () { var i = r.actFns.indexOf(fn); if (i >= 0) r.actFns.splice(i, 1); };
      },
      onDeactivate: function (fn) {
        if (typeof fn !== 'function') return function () {};
        r.deactFns.push(fn);
        return function () { var i = r.deactFns.indexOf(fn); if (i >= 0) r.deactFns.splice(i, 1); };
      },

      /* —— 界面小工具 —— */
      toast: toast,
      console: function (msg, kind) { writeConsole(id, msg, kind); },
      clearConsole: function () { r.logs.length = 0; if (id === activeId) renderConsole(id); },
      setStatus: function (v) {
        if (typeof v === 'string') { r.status = { 状态: v }; }
        else if (v && typeof v === 'object') {
          var ks = Object.keys(v);
          for (var i = 0; i < ks.length; i++) {
            if (v[ks[i]] === null || v[ks[i]] === undefined) delete r.status[ks[i]];
            else r.status[ks[i]] = v[ks[i]];
          }
        }
        if (activeId === id) renderStatus(id);
      },
      getModule: function () { return pick(r.def); },
      getRoot: function () { return r.host; }
    };
  }

  /* ===========================================================================
   * 11. 启动
   * ======================================================================== */
  function init() {
    if (inited) return;
    inited = true;
    D.tabs = q('moduleTabs');
    D.stepList = q('stepList');
    D.stepCard = q('stepCard');
    D.progressFill = q('progressFill');
    D.progressText = q('progressText');
    D.resetBtn = q('resetProgress');
    D.simTitle = q('simTitle');
    D.simTagline = q('simTagline');
    D.moduleHost = q('moduleHost');
    D.simConsole = q('simConsole');
    D.statusBar = q('statusBar');
    D.toastWrap = q('toastWrap');
    D.bootMask = q('bootMask');

    if (D.resetBtn) {
      D.resetBtn.onclick = function () { if (activeId) makeApi(activeId).resetProgress(); };
    }
    // 补同步：模块脚本在 DOMContentLoaded 之前就注册完了，
    // 那时 D.tabs 还是 null，syncTab 直接跳过，所以必须在这里补一遍。
    order.forEach(function (id) { syncTab(modules[id]); });
    global.addEventListener('hashchange', function () {
      var want = String(global.location.hash || '').replace(/^#/, '');
      if (modules[want] && want !== activeId) activate(want);
    });
    // 键盘快捷键：Alt+←/→ 切步骤
    global.addEventListener('keydown', function (e) {
      if (!e.altKey || !activeId) return;
      if (e.key === 'ArrowRight') { nextStep(); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { prevStep(); e.preventDefault(); }
    });

    maybeAutoActivate();
    if (D.bootMask) D.bootMask.classList.add('hide');
    if (!order.length) {
      console.error('[CAE] 没有任何模块注册成功，请检查 js/fluent.js、js/mechanical.js、js/zemax.js');
    }
  }

  // app.js 自身也在 body 末尾同步加载，readyState 通常是 'loading'；
  // 两种情况都覆盖，兼容被改成 async/defer 的情况。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 内部调试出口（模块工程师排查问题时可以在控制台看）
  CAE._debug = function () {
    return {
      version: VERSION, active: activeId, order: order.slice(),
      modules: order.map(function (id) {
        var r = rt(id);
        // vp 就是那个视口句柄：需要查场景对象时用 CAE._debug().modules[i].vp.scene
        return { id: id, built: r.built, steps: r.steps.length, idx: r.idx, viewport: !!r.viewport, vp: r.viewport };
      })
    };
  };
})(window);
