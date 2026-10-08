/* =============================================================================
 * three-setup.js —— 3D 视口基础设施
 * 提供 window.CAE.createViewport(el) → 视口句柄
 *
 * 契约（详见 app.js 顶部 CONTRACT）：
 *   CAE.createViewport(el, opts) -> {
 *     scene, camera, renderer, controls, domElement,
 *     onFrame(cb)      注册每帧回调 cb(dt, elapsed)，返回取消函数
 *     start() / stop() / isRunning()
 *     resize()         按容器尺寸重算相机与渲染器
 *     dispose()        释放全部资源（RAF / 事件 / 几何 / 渲染器 / canvas）
 *     setBackground(c) 设置视口背景色
 *     clear()          清空场景里用户添加的对象（不动灯光与地面）
 *   }
 *   opts = { fov, color, gridSize, gridDiv, showGrid, shadows, minDist, maxDist,
 *            position: [x,y,z], target: [x,y,z], targetY, groundY, fogNear, fogFar }
 *     · position / target 都是世界坐标；target 不给时才退回 groundY + targetY 的旧约定。
 *
 *   controls = { target, enabled, update(), reset(), setEnabled(bool),
 *                setView(theta, phi, radius, target?) }
 *     setView 的 theta / phi 用**弧度**（绕 Y 的方位角 / 与 +Y 的夹角），radius 是视距，
 *     target 可选 [x,y,z]。它只改"期望值"，阻尼照旧，调用后每帧 update() 平滑逼近过去。
 *
 * 纪律：轨道控制器自己实现（左键旋转 / 滚轮缩放 / 右键平移 / 双指缩放），
 *       不依赖 three.js examples 目录里的 OrbitControls。
 * ============================================================================= */
(function (global) {
  'use strict';

  var CAE = (global.CAE = global.CAE || {});

  /* ---------------------------------------------------------------------------
   * 轨道控制器：约 80 行，纯手写，无第三方依赖
   * 左键拖 = 绕 target 旋转；滚轮/双指捏合 = 推拉；右键或中键拖 = 平移
   * 用「期望值 + 阻尼逼近」实现惯性手感
   * ------------------------------------------------------------------------- */
  function createOrbitControls(camera, dom, opt) {
    opt = opt || {};
    var target = new THREE.Vector3().copy(opt.target || new THREE.Vector3(0, 0, 0));

    // 当前值（实际生效）与目标值（阻尼逼近）
    var cur = { theta: 0, phi: 0.9, radius: 12, tx: 0, ty: 0, tz: 0 };
    var des = { theta: 0, phi: 0.9, radius: 12, tx: 0, ty: 0, tz: 0 };

    // 由相机初始位置反推球坐标
    var off = camera.position.clone().sub(target);
    cur.radius = des.radius = off.length();
    cur.theta = des.theta = Math.atan2(off.x, off.z);
    cur.phi = des.phi = Math.acos(Math.max(-1, Math.min(1, off.y / cur.radius)));
    cur.tx = des.tx = target.x; cur.ty = des.ty = target.y; cur.tz = des.tz = target.z;
    // 初始机位快照：reset() 靠它回到"刚建好视口时"的角度与视距
    var init = { theta: des.theta, phi: des.phi, radius: des.radius, tx: des.tx, ty: des.ty, tz: des.tz };

    var minDist = opt.minDist || 0.4, maxDist = opt.maxDist || 2000;
    var minPhi = 0.05, maxPhi = Math.PI - 0.05;   // 防止翻转
    var rotateSpeed = 0.0055, panSpeed = 1.0, zoomSpeed = 0.12, damping = 0.18;

    var enabled = true, dragging = 0 /* 0 无 / 1 旋转 / 2 平移 */;
    var lastX = 0, lastY = 0, pinchDist = 0, pointers = {};
    var _right = new THREE.Vector3(), _up = new THREE.Vector3(), _fwd = new THREE.Vector3();

    function onDown(e) {
      if (!enabled) return;
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var n = Object.keys(pointers).length;
      if (n === 2) { pinchDist = pinchSpan(); dragging = 0; return; }
      lastX = e.clientX; lastY = e.clientY;
      dragging = (e.button === 2 || e.button === 1 || e.shiftKey) ? 2 : 1;
      dom.setPointerCapture && dom.setPointerCapture(e.pointerId);
    }
    function pinchSpan() {
      var k = Object.keys(pointers), a = pointers[k[0]], b = pointers[k[1]];
      return Math.hypot(a.x - b.x, a.y - b.y);
    }
    function onMove(e) {
      if (!enabled) return;
      if (pointers[e.pointerId]) { pointers[e.pointerId].x = e.clientX; pointers[e.pointerId].y = e.clientY; }
      // 双指：捏合缩放 + 上下平移
      if (Object.keys(pointers).length === 2) {
        var d = pinchSpan();
        if (pinchDist > 0) des.radius *= (1 + (pinchDist - d) * 0.004);
        des.phi = clamp(des.phi + (e.clientY - lastY) * 0.004, minPhi, maxPhi);
        lastX = e.clientX; lastY = e.clientY; pinchDist = d;
        des.radius = clamp(des.radius, minDist, maxDist);
        return;
      }
      if (!dragging) return;
      var dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (dragging === 1) {
        des.theta -= dx * rotateSpeed;
        des.phi = clamp(des.phi - dy * rotateSpeed, minPhi, maxPhi);
      } else {
        // 平移量随视距缩放，保证远近手感一致
        var h = dom.clientHeight || 1, k2 = 2 * cur.radius * Math.tan((camera.fov * Math.PI) / 360) / h;
        camera.matrixWorld.extractBasis(_right, _up, _fwd);
        des.tx -= (_right.x * dx - _up.x * dy) * k2 * panSpeed;
        des.ty -= (_right.y * dx - _up.y * dy) * k2 * panSpeed;
        des.tz -= (_right.z * dx - _up.z * dy) * k2 * panSpeed;
      }
    }
    function onUp(e) {
      delete pointers[e.pointerId];
      var left = Object.keys(pointers).length;
      if (left < 2) pinchDist = 0;
      if (left === 0) dragging = 0;
      try { if (dom.releasePointerCapture) dom.releasePointerCapture(e.pointerId); } catch (err) { /* 已释放 */ }
    }
    function onWheel(e) {
      if (!enabled) return;
      e.preventDefault();
      var s = Math.pow(1 + zoomSpeed, Math.sign(e.deltaY) * Math.min(3, Math.abs(e.deltaY) / 100 + 0.5));
      des.radius = clamp(des.radius * s, minDist, maxDist);
    }
    function onContext(e) { e.preventDefault(); }
    function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('pointercancel', onUp);
    dom.addEventListener('pointerleave', onUp);
    dom.addEventListener('wheel', onWheel, { passive: false });
    dom.addEventListener('contextmenu', onContext);

    var api = {
      target: target,
      enabled: true,
      minDistance: minDist,
      maxDistance: maxDist,
      /** 每帧调用：把当前值阻尼逼近目标值，并写回相机 */
      update: function () {
        cur.theta += (des.theta - cur.theta) * damping;
        cur.phi += (des.phi - cur.phi) * damping;
        cur.radius += (des.radius - cur.radius) * damping;
        cur.tx += (des.tx - cur.tx) * damping;
        cur.ty += (des.ty - cur.ty) * damping;
        cur.tz += (des.tz - cur.tz) * damping;
        target.set(cur.tx, cur.ty, cur.tz);
        var sp = Math.sin(cur.phi);
        camera.position.set(
          target.x + cur.radius * sp * Math.sin(cur.theta),
          target.y + cur.radius * Math.cos(cur.phi),
          target.z + cur.radius * sp * Math.cos(cur.theta)
        );
        camera.lookAt(target);
        camera.updateMatrixWorld();
      },
      /** 复位到初始取景（角度、视距、目标点一起回到建视口时的状态） */
      reset: function () {
        des.theta = init.theta; des.phi = init.phi; des.radius = init.radius;
        des.tx = init.tx; des.ty = init.ty; des.tz = init.tz;
      },
      /** 直接设定机位：theta/phi 用弧度，radius 是视距，target 可选 [x,y,z]。
          与 reset() 一样只改期望值，阻尼照旧，每帧 update() 平滑逼近 */
      setView: function (theta, phi, radius, t) {
        if (typeof theta === 'number' && isFinite(theta)) des.theta = theta;
        if (typeof phi === 'number' && isFinite(phi)) des.phi = clamp(phi, minPhi, maxPhi);
        if (typeof radius === 'number' && isFinite(radius)) des.radius = clamp(radius, minDist, maxDist);
        if (t && t.length === 3) { des.tx = t[0]; des.ty = t[1]; des.tz = t[2]; }
      },
      setEnabled: function (v) { enabled = !!v; if (!v) dragging = 0; },
      dispose: function () {
        dom.removeEventListener('pointerdown', onDown);
        dom.removeEventListener('pointermove', onMove);
        dom.removeEventListener('pointerup', onUp);
        dom.removeEventListener('pointercancel', onUp);
        dom.removeEventListener('pointerleave', onUp);
        dom.removeEventListener('wheel', onWheel);
        dom.removeEventListener('contextmenu', onContext);
        pointers = {};
      }
    };
    api.update();
    return api;
  }

  /* ---------------------------------------------------------------------------
   * 主入口：createViewport
   * ------------------------------------------------------------------------- */
  CAE.createViewport = function (el, opts) {
    opts = opts || {};

    // 1) 缺 THREE 或缺 WebGL：返回"空壳句柄"，保证模块代码不会崩
    if (!global.THREE) return stub(el, 'three.js 未加载：请检查 libs/three.min.js');
    if (!el) return stub(null, '视口容器为空');
    var probe = document.createElement('canvas');
    var gl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (!gl) return stub(el, '当前浏览器未启用 WebGL，无法显示三维视图');

    // 2) 渲染器（画布尺寸交给 CSS，用 setSize(w,h,false) 避免内联尺寸打架）
    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch (err) {
      return stub(el, 'WebGL 初始化失败：' + (err && err.message ? err.message : err));
    }
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.outputEncoding = THREE.sRGBEncoding;          // r128 用 outputEncoding
    if (opts.shadows !== false) {
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    var dom = renderer.domElement;
    dom.style.display = 'block';
    dom.style.touchAction = 'none';                        // 让双指手势可用
    el.appendChild(dom);

    // 3) 场景 / 相机
    var scene = new THREE.Scene();
    scene.background = new THREE.Color(opts.color || 0x171b21);
    scene.fog = new THREE.Fog(0x171b21, opts.fogNear || 40, opts.fogFar || 200);

    var camera = new THREE.PerspectiveCamera(opts.fov || 45, 1, 0.05, 5000);
    var p0 = opts.position || [8, 5.5, 9];
    camera.position.set(p0[0], p0[1], p0[2]);

    // 4) 三点布光：主光 key + 补光 fill + 轮廓光 rim（外加一盏很暗的环境光兜底）
    scene.add(new THREE.AmbientLight(0xffffff, 0.28));

    var key = new THREE.DirectionalLight(0xffffff, 1.05);
    key.position.set(9, 14, 8);
    key.castShadow = opts.shadows !== false;
    if (key.shadow) {
      key.shadow.mapSize.width = key.shadow.mapSize.height = 1024;
      key.shadow.camera.near = 1; key.shadow.camera.far = 80;
      key.shadow.camera.left = -20; key.shadow.camera.right = 20;
      key.shadow.camera.top = 20; key.shadow.camera.bottom = -20;
      key.shadow.bias = -0.0015;
    }
    scene.add(key);

    var fill = new THREE.DirectionalLight(0xbfd4ff, 0.42);
    fill.position.set(-11, 6, -5);
    scene.add(fill);

    var rim = new THREE.DirectionalLight(0x9fd8ff, 0.7);
    rim.position.set(-4, 7, 13);
    scene.add(rim);

    // 5) 地面 + 网格（网格边缘靠雾淡出）
    if (opts.showGrid !== false) {
      var size = opts.gridSize || 40, div = opts.gridDiv || 40;
      var grid = new THREE.GridHelper(size, div, 0x4a5c6e, 0x2a3441);
      grid.position.y = opts.groundY || 0;
      grid.material.transparent = true;
      grid.material.opacity = 0.55;
      scene.add(grid);

      var ground = new THREE.Mesh(
        new THREE.PlaneGeometry(size * 2, size * 2),
        new THREE.ShadowMaterial({ opacity: 0.32 })
      );
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = opts.groundY || 0;
      ground.receiveShadow = opts.shadows !== false;
      scene.add(ground);
    }

    // 6) 控制器
    //    目标点：opts.target = [x,y,z] 优先（模块想对准自己的模型中心时用这个）；
    //    没给才退回 groundY + targetY 的旧约定，避免改动没传 target 的老模块。
    var tgt = (opts.target && opts.target.length === 3)
      ? new THREE.Vector3(opts.target[0], opts.target[1], opts.target[2])
      : new THREE.Vector3(0, (opts.groundY || 0) + (opts.targetY || 0.8), 0);
    var controls = createOrbitControls(camera, dom, {
      target: tgt,
      minDist: opts.minDist || 0.4,
      maxDist: opts.maxDist || 2000
    });

    // 7) 尺寸同步
    function resize() {
      var w = el.clientWidth || 1, h = el.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    }
    resize();
    var ro = null;
    if (global.ResizeObserver) {
      ro = new global.ResizeObserver(resize);
      ro.observe(el);
    } else {
      global.addEventListener('resize', resize);
    }

    // 8) 渲染循环
    var frameCbs = [], rafId = 0, running = false, last = 0, elapsed = 0, disposed = false;

    function loop(now) {
      if (!running) return;
      rafId = global.requestAnimationFrame(loop);
      var dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016;   // 卡顿时钳制，避免动画跳变
      last = now;
      elapsed += dt;
      controls.update();
      for (var i = 0; i < frameCbs.length; i++) {
        try { frameCbs[i](dt, elapsed); } catch (err) { console.error('[CAE] onFrame 回调异常', err); }
      }
      renderer.render(scene, camera);
    }
    function start() { if (disposed || running) return; running = true; last = 0; rafId = global.requestAnimationFrame(loop); }
    function stop() { if (!running) return; running = false; global.cancelAnimationFrame(rafId); rafId = 0; }

    start();

    // 9) 句柄
    var vp = {
      scene: scene,
      camera: camera,
      renderer: renderer,
      controls: controls,
      domElement: dom,
      lights: { key: key, fill: fill, rim: rim },
      onFrame: function (cb) {
        if (typeof cb !== 'function') return function () {};
        frameCbs.push(cb);
        return function () { var i = frameCbs.indexOf(cb); if (i >= 0) frameCbs.splice(i, 1); };
      },
      start: start,
      stop: stop,
      isRunning: function () { return running; },
      resize: resize,
      setBackground: function (c) { scene.background = new THREE.Color(c); if (scene.fog) scene.fog.color = new THREE.Color(c); },
      setAccent: function (hex) { rim.color.set(hex); },
      /** 清空用户对象（保留灯光与地面网格） */
      clear: function () {
        var keep = [];
        scene.children.forEach(function (o) {
          var isLight = o.isLight;
          /* r128 的 GridHelper 不带 isGridHelper 标志,必须连 type 一起判,
             否则第一次 assemble 就会把地面网格当用户对象清掉 */
          var isGrid = o.isGridHelper || o.type === "GridHelper" ||
            (o.isMesh && o.material && o.material.isShadowMaterial);
          if (!isLight && !isGrid) { disposeObject(o); } else { keep.push(o); }
        });
        scene.children = keep;
      },
      dispose: function () {
        if (disposed) return;
        disposed = true;
        stop();
        frameCbs.length = 0;
        if (ro) ro.disconnect(); else global.removeEventListener('resize', resize);
        controls.dispose();
        scene.traverse(function (o) { disposeObject(o, false); });
        try { renderer.dispose(); } catch (e) { /* 忽略 */ }
        if (dom.parentNode) dom.parentNode.removeChild(dom);
      }
    };
    return vp;
  };

  /** 递归释放几何体、材质与贴图。
   *  ⚠ 必须**真的递归**：模块习惯把整车挂在 scene 下的一个 THREE.Group 里
   *    （Group 自己没有 .geometry / .material），不递归就等于什么都不释放，
   *    每切一次教学步骤泄漏一整台车的几何体与 CanvasTexture。 */
  function disposeMaterial(m) {
    if (!m) return;
    if (Array.isArray(m)) { m.forEach(disposeMaterial); return; }
    /* 贴图也要释放：CanvasTexture 每一张都占一块显存，不释放会一路涨到标签页崩溃 */
    for (var k in m) {
      var v = m[k];
      if (v && v.isTexture && typeof v.dispose === 'function') v.dispose();
    }
    if (typeof m.dispose === 'function') m.dispose();
  }
  function disposeObject(obj, deep) {
    if (!obj) return;
    if (obj.geometry && obj.geometry.dispose) obj.geometry.dispose();
    if (obj.material) disposeMaterial(obj.material);
    /* Group / Object3D 没有 geometry/material，子树里的东西只能靠遍历拿到。
       调用方已经 traverse 过的就别再遍历一次（deep=false）。 */
    if (deep !== false && typeof obj.traverse === 'function') {
      obj.traverse(function (child) {
        if (child === obj) return;
        if (child.geometry && child.geometry.dispose) child.geometry.dispose();
        if (child.material) disposeMaterial(child.material);
      });
    }
  }

  /** 无 WebGL 时的降级句柄：所有方法都安全空转，模块代码不必写 if 判断 */
  function stub(el, msg) {
    if (el) {
      var d = document.createElement('div');
      d.className = 'viewport-fallback';
      d.textContent = '⚠ ' + msg;
      el.appendChild(d);
    }
    var noop = function () {};
    return {
      scene: null, camera: null, renderer: null, controls: null, domElement: null,
      unavailable: true, message: msg,
      onFrame: function () { return noop; },
      start: noop, stop: noop, isRunning: function () { return false; }, resize: noop,
      setBackground: noop, setAccent: noop, clear: noop, dispose: function () {}
    };
  }
})(window);
