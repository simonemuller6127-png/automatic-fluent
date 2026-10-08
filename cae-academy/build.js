/* =============================================================================
 *  build.js —— 单文件离线版打包器
 *
 *  用法：
 *      node cae-academy/build.js            默认输出 cae-academy/standalone.html
 *      node cae-academy/build.js 输出.html   指定输出路径
 *
 *  行为：
 *    1) 读 index.html
 *    2) 把 **本地** <link rel="stylesheet" href="...">  内联成 <style>…</style>
 *    3) 把 **本地** <script src="...">…</script>      内联成 <script>…</script>
 *       （包括 libs/three.min.js）
 *    4) 外链（http:// https:// // data:）的 CSS/JS **保持外链不内联**
 *    5) 内联 JS 时转义 "</script"、"<!--"、"-->"，防止提前截断或被当成 HTML 注释
 *    6) 任何被引用的本地文件缺失 → 打印缺哪个 → process.exit(1)，不产出半成品
 *
 *  全程使用同步 fs（硬性要求：零依赖、双击即用）。
 * ============================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const ENTRY = path.join(ROOT, 'index.html');
const DEFAULT_OUT = path.join(ROOT, 'CAE虚拟仿真实训平台-离线版.html');
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUT;

/* ---------- 小工具 ---------- */

/** 是否外部资源（不内联） */
function isExternal(url) {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(url) || /^data:/i.test(url);
}

/** 本地路径 → 绝对路径 */
function resolveLocal(url) {
  const clean = url.split(/[?#]/)[0];
  return path.resolve(ROOT, clean.replace(/^\.\//, '').replace(/^\//, ''));
}

/** 内联 JS 的转义：避免 </script> 提前闭合、以及 <!-- / --> 造成 HTML 注释解析
 *
 *  ⚠ `<!--` 这一条是有代价的：它在 JS 里既是 Annex B 允许的 HTML-like 注释，
 *    也可能只是字符串字面量里的普通字符。把它一律改写成 `<\!--`，
 *    字符串里没问题（`\!` 是 IdentityEscape），但如果它出现在**真正的注释**里，
 *    改写后的 `<` 前面没有语句，new Function 会直接抛
 *    "SyntaxError: Unexpected token '<'"，构建却仍然静默成功、产出一个坏文件。
 *    所以这里改完必须真的 parse 一遍；解析失败就报错退出，不产出坏包。
 */
function escapeInlineJS(src) {
  return src
    .replace(/<\/(script)/gi, '<\\/$1')
    .replace(/<!--/g, '<\\!--')
    .replace(/-->/g, '--\\>');
}

/** 把内联后的 JS 真的解析一遍 —— 抓"转义把代码改坏"这类静默失败 */
function verifyInlineJS(src, label) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(src);
  } catch (e) {
    throw new Error(
      `${label} 内联之后无法解析：${e && e.message ? e.message : e}\n` +
      '  常见原因：源码里有 HTML-like 注释（<!-- 或 -->），escapeInlineJS 的改写破坏了语法。\n' +
      '  请把该注释改成 // 或 /* */ 形式后重新构建。'
    );
  }
}

/** 内联 CSS：唯一危险序列是 </style>，只警告不乱改 */
function escapeInlineCSS(src) {
  if (/<\/style/i.test(src)) {
    console.warn('  [警告] CSS 里出现了 </style 序列，请检查 ' + '（已原样内联）');
  }
  return src;
}

function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

function readFileOrFail(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error('[build] 缺少文件或无法读取：' + path.relative(ROOT, file) + '  (' + err.code + ')');
    return null;
  }
}

/* ---------- 主流程 ---------- */

console.log('[build] 入口：' + path.relative(process.cwd(), ENTRY));
if (!fs.existsSync(ENTRY)) {
  console.error('[build] 找不到 index.html，请确认在 cae-academy 目录下运行。');
  process.exit(1);
}

let html = fs.readFileSync(ENTRY, 'utf8');
const inlined = [];        // 已成功内联的相对路径
const skipped = [];        // 保持外链的 URL
const missing = [];       // 缺失的本地文件

/* --- 1) 内联本地 CSS：<link rel="stylesheet" href="css/app.css"> --- */
html = html.replace(
  /<link\b[^>]*?href=["']([^"']+)["'][^>]*?>/gi,
  (tag, url) => {
    if (!/stylesheet/i.test(tag)) return tag;        // 只处理样式表（favicon 之类原样留着）
    if (isExternal(url)) { skipped.push(url); return tag; }
    const file = resolveLocal(url);
    const css = readFileOrFail(file);
    if (css === null) { missing.push(file); return tag; }
    inlined.push(url);
    return '<style>/* ' + url + ' */\n' + escapeInlineCSS(css) + '\n</style>';
  }
);

/* --- 2) 内联本地 JS：<script src="libs/three.min.js"></script> --- */
html = html.replace(
  /<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script\s*>/gi,
  (tag, pre, url, post) => {
    if (isExternal(url)) { skipped.push(url); return tag; }
    const file = resolveLocal(url);
    const js = readFileOrFail(file);
    if (js === null) { missing.push(file); return tag; }
    inlined.push(url);
    const safe = escapeInlineJS(js);
    /* 转义完必须真的能解析：否则就是"构建报成功、产物一打开就白屏"。
       escapeInlineJS 对 <!-- 的改写在字符串里无害、在真注释里会直接语法错。 */
    verifyInlineJS(safe, url);
    return '<script>/* ' + url + ' */' + '\n' + safe + '\n' + '</' + 'script>';
  }
);

/* --- 3) three.js 已内联时,移除 index.html 里的 CDN 兜底脚本 ---
   那段 document.write 只在「本地 three.min.js 加载失败」时有意义;
   单文件版里 three 已经打包进去,留着它会让文件里残留一个外部 URL,
   某些严格环境(企业代理/安全扫描)会因此拦截整个文件。
   ⚠ 锚点必须用字面前缀 "<script>window.THREE ||"——兜底脚本以它开头、
   全文唯一;若用宽松的正则,懒惰匹配会从第一个 <script> 一路吞掉
   CSS 与 three.min.js,产出 500KB 的残缺文件还不报错。 */
if (inlined.indexOf('libs/three.min.js') >= 0) {
  const beforeStrip = html.length;
  html = html.replace(
    /<script>window\.THREE\s*\|\|\s*document\.write[\s\S]*?<\/script\s*>/i,
    '<!-- three.js 已完整内联,CDN 兜底已移除:本文件不依赖任何网络资源 -->'
  );
  if (html.length === beforeStrip) {
    console.error('[build] 警告:未找到 CDN 兜底脚本,跳过剥离(不影响产物正确性)。');
  }
}

/* --- 4) 缺文件就不产出半成品 --- */
if (missing.length) {
  console.error('[build] 构建失败，以下本地资源缺失：');
  missing.forEach((f) => console.error('  - ' + path.relative(ROOT, f)));
  console.error('[build] 请先创建这些文件（或把 index.html 改成 CDN 外链）后重试。');
  process.exit(1);
}

if (!inlined.length) {
  console.error('[build] 没有内联任何本地资源，请检查 index.html 的 <link> / <script src> 写法。');
  process.exit(1);
}

/* --- 5) 产物完整性自检:关键组成部分缺一不可,防止"构建报成功、打开就白屏" --- */
const SANITY = [
  'THREE.WebGLRenderer',      // three.min.js 内联完整
  '.sim-window',              // 共享 CSS 内联完整
  'CAE.registerModule',       // 平台骨架完整
  'CAE.createViewport',       // 3D 引擎完整
  'bootError'                 // 开机自诊断完整
];
for (const needle of SANITY) {
  if (html.indexOf(needle) < 0) {
    console.error('[build] 产物完整性自检失败:输出里缺少 "' + needle + '",已中止,不写出残缺文件。');
    process.exit(1);
  }
}

fs.writeFileSync(OUT, html, 'utf8');

/* --- 5) 报告 --- */
const outSize = fs.statSync(OUT).size;
const entrySize = fs.statSync(ENTRY).size;
console.log('[build] 已内联 ' + inlined.length + ' 个本地资源：');
inlined.forEach((u) => console.log('    ✓ ' + u));
if (skipped.length) {
  console.log('[build] 保留 ' + skipped.length + ' 个外链（离线环境可能不可用）：');
  skipped.forEach((u) => console.log('    ↗ ' + u));
}
console.log('[build] ' + path.relative(process.cwd(), ENTRY) + '  ' + humanSize(entrySize) +
            '  →  ' + path.relative(process.cwd(), OUT) + '  ' + humanSize(outSize) +
            '  (' + outSize + ' 字节)');
console.log('[build] 完成，双击 "' + path.basename(OUT) + '" 即可离线运行——单文件、零外部依赖，可直接发送给他人。');
