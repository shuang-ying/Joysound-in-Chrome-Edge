'use strict';
/**
 * 从 AcFun 播放器插件包里重新提取 Joysound 音效引擎。
 *
 * 原版油猴脚本是「下载整包 (2.8MB) → 字符串插入 → eval」，这在 MV3 里既不合规
 * （禁止远程代码）又太浪费。这里把其中自包含的 webpack 模块 #17 抽出来，落成
 * vendor/joysound.sdk.js（约 98KB），通过 chrome.scripting 注入主世界。
 *
 *   node tools/extract-joysound.js                       # 从官网下载并生成
 *   node tools/extract-joysound.js --input bundle.js     # 用本地文件
 *   node tools/extract-joysound.js --check               # 只校验现有文件
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'vendor', 'joysound.sdk.js');
const REMOTE = 'https://static.yximgs.com/udata/pkg/acfun-player/asyncPlayerPlugins.b678fa.js';
const TARGET_MODULE = 17;

/* ---------------- 一个够用的 JS 扫描器（跳过字符串/模板/正则/注释） ---------------- */

function scanTopLevelArray(src, start) {
  let i = start;
  let depth = 0;
  const stack = [];
  const slices = [];
  let sliceStart = start;
  let lastSig = '';
  let lastWord = '';
  const KW = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'throw']);

  const readString = (q) => {
    i++;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === q) {
        i++;
        return;
      }
      i++;
    }
  };

  const readTemplate = () => {
    i++;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        i++;
        return;
      }
      if (c === '$' && src[i + 1] === '{') {
        i += 2;
        let d = 1;
        while (i < src.length && d > 0) {
          const ch = src[i];
          if (ch === '{') {
            d++;
            i++;
          } else if (ch === '}') {
            d--;
            i++;
          } else if (ch === '`') readTemplate();
          else if (ch === '"' || ch === "'") readString(ch);
          else i++;
        }
        continue;
      }
      i++;
    }
  };

  const readRegex = () => {
    i++;
    let inClass = false;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        i++;
        break;
      } else if (c === '\n') break;
      i++;
    }
    while (i < src.length && /[a-z]/i.test(src[i])) i++;
  };

  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      lastSig = c;
      readString(c);
      continue;
    }
    if (c === '`') {
      lastSig = '`';
      readTemplate();
      continue;
    }
    if (c === '/') {
      const n1 = src[i + 1];
      if (n1 === '/') {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (n1 === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      const canRegex = !lastSig || /[\(\[\{,;:=\!\&\|\?\{\}\+\-\*\/%<>~^]/.test(lastSig) || KW.has(lastWord);
      if (canRegex) {
        readRegex();
        continue;
      }
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      lastWord = src.slice(i, j);
      lastSig = 'a';
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      i++;
      while (i < src.length && /[0-9a-zA-Z._]/.test(src[i])) i++;
      lastSig = '0';
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      stack.push(c);
      lastSig = c;
      i++;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      stack.pop();
      if (stack.length === 0) {
        slices.push([sliceStart, i + 1]);
        return slices;
      }
      lastSig = c;
      i++;
      continue;
    }
    if (c === ',' && stack.length === 1 && stack[0] === '[') {
      slices.push([sliceStart, i]);
      sliceStart = i + 1;
      lastSig = ',';
      i++;
      continue;
    }
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  throw new Error('模块数组没有闭合');
}

function matchBrace(text, openPos) {
  let i = openPos + 1;
  let depth = 1;
  let lastSig = '';
  let lastWord = '';
  const KW = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'throw']);

  const readString = (q) => {
    i++;
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === q) {
        i++;
        return;
      }
      i++;
    }
  };
  const readTemplate = () => {
    i++;
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        i++;
        return;
      }
      if (c === '$' && text[i + 1] === '{') {
        i += 2;
        let d = 1;
        while (i < text.length && d > 0) {
          const ch = text[i];
          if (ch === '{') {
            d++;
            i++;
          } else if (ch === '}') {
            d--;
            i++;
          } else if (ch === '`') readTemplate();
          else if (ch === '"' || ch === "'") readString(ch);
          else i++;
        }
        continue;
      }
      i++;
    }
  };
  const readRegex = () => {
    i++;
    let inClass = false;
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        i++;
        break;
      } else if (c === '\n') break;
      i++;
    }
    while (i < text.length && /[a-z]/i.test(text[i])) i++;
  };

  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      readString(c);
      continue;
    }
    if (c === '`') {
      readTemplate();
      continue;
    }
    if (c === '/') {
      const n1 = text[i + 1];
      if (n1 === '/') {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (n1 === '*') {
        i += 2;
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      const canRegex = !lastSig || /[\(\[\{,;:=\!\&\|\?\{\}\+\-\*\/%<>~^]/.test(lastSig) || KW.has(lastWord);
      if (canRegex) {
        readRegex();
        continue;
      }
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_$]/.test(text[j])) j++;
      lastWord = text.slice(i, j);
      lastSig = 'a';
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      i++;
      while (i < text.length && /[0-9a-zA-Z._]/.test(text[i])) i++;
      lastSig = '0';
      continue;
    }
    if (c === '{') {
      depth++;
      i++;
      lastSig = c;
      continue;
    }
    if (c === '}') {
      depth--;
      if (depth === 0) return i;
      i++;
      lastSig = c;
      continue;
    }
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  throw new Error('模块表没有闭合');
}

/* ---------------- 提取 ---------------- */

function extract(bundle) {
  const arrayStart = bundle.indexOf('([function(') + 1;
  if (arrayStart <= 0) throw new Error('找不到 webpack 模块数组');

  const slices = scanTopLevelArray(bundle, arrayStart);
  if (slices.length <= TARGET_MODULE) throw new Error('模块数量异常：' + slices.length);

  const mod = bundle.slice(slices[TARGET_MODULE][0], slices[TARGET_MODULE][1]);
  if (mod.indexOf('./src/index.ts') < 0) throw new Error('模块 #17 里没有 joysound 入口，插件包可能改版了');

  const runtimeStart = mod.indexOf('function(t){', mod.indexOf('return function(t){var e={};'));
  const invoke = mod.indexOf('}({', runtimeStart);
  if (runtimeStart < 0 || invoke < 0) throw new Error('找不到内部 bundle 的调用点');

  const mapStart = invoke + 2;
  const mapEnd = matchBrace(mod, mapStart);
  const bundleIIFE = mod.slice(runtimeStart, mapEnd + 1);
  const closedByCall = mod.slice(mapEnd + 1, mapEnd + 3).indexOf(')') === 0;

  const header = `/*! Joysound audio engine (extracted from AcFun asyncPlayerPlugins)
 *  Original: ${REMOTE}
 *  Extracted bundle: webpack module #${TARGET_MODULE} (./src/index.ts) - self contained,
 *  no remote code, worker is built from an inlined Blob.
 */
(function () {
  "use strict";
  var api = ${bundleIIFE}${closedByCall ? ')' : ''};
  var Joysound = api && (api.default || api);
  if (typeof Joysound !== "function") throw new Error("Joysound SDK failed to load");
  Object.defineProperty(window, "__JOYSOUND_SDK__", {
    value: Joysound,
    configurable: true,
    writable: true,
    enumerable: false,
  });
})();
`;
  return { code: header, size: header.length };
}

async function main() {
  const args = process.argv.slice(2);
  const inputIdx = args.indexOf('--input');

  if (args.includes('--check')) {
    if (!fs.existsSync(OUT)) throw new Error('vendor/joysound.sdk.js 不存在');
    console.log('已存在的文件：' + fs.statSync(OUT).size + ' 字节');
    const code = fs.readFileSync(OUT, 'utf8');
    console.log('包含入口：' + (code.indexOf('./src/index.ts') >= 0));
    return;
  }

  await regenerate({ input: inputIdx >= 0 ? args[inputIdx + 1] : null });
}

/**
 * 下载（或用本地文件）重新生成 vendor/joysound.sdk.js。
 * 供 CLI 和测试复用。
 * @param {{input?: string|null}} [options]
 */
async function regenerate(options) {
  const input = (options && options.input) || null;
  let bundle = null;

  if (input) {
    bundle = fs.readFileSync(input, 'utf8');
    console.log('使用本地文件：' + input);
  } else {
    console.log('下载：' + REMOTE);
    const res = await fetch(REMOTE);
    if (!res.ok) throw new Error('下载失败：HTTP ' + res.status);
    bundle = await res.text();
    console.log('已下载 ' + bundle.length + ' 字节');
  }

  const { code, size } = extract(bundle);

  // 语法自检：必须在只有 window 的环境里能加载
  const vm = require('vm');
  const sandbox = {
    window: { navigator: { userAgent: 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36' } },
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox.window);
  sandbox.window.self = sandbox.window;
  vm.runInContext(code, sandbox.window);
  const sdk = vm.runInContext('window.__JOYSOUND_SDK__', sandbox.window);
  if (typeof sdk !== 'function' || typeof sdk.prototype.init !== 'function') {
    throw new Error('提取出来的 SDK 结构不对');
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, code);
  console.log('已写入 vendor/joysound.sdk.js（' + size + ' 字节），版本 ' + sdk.version);
  return { path: OUT, size: size };
}

if (require.main === module) {
  main().catch((e) => {
    console.error('失败：' + e.message);
    process.exitCode = 1;
  });
}

module.exports = { extract, regenerate };
