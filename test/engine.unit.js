'use strict';
/**
 * 引擎状态机单元测试。
 *
 * 用一个极小的假 DOM / 假 AudioContext / 假 SDK 把 src/content/engine.js 跑起来，
 * 验证「关闭开关」「切标签页」「播放器重建」「上下文挂起」「跨域静音」等场景。
 * 真实浏览器行为见 test/e2e.js。
 *
 *   node test/engine.unit.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 8000, label = '') {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = fn();
    if (last) return last;
    await sleep(50);
  }
  throw new Error('等待超时：' + label + '（最后值 ' + JSON.stringify(last) + '）');
}

/* ------------------------------------------------------------------ */
/* 假环境                                                              */
/* ------------------------------------------------------------------ */

function createEnv() {
  const videos = [];
  const messages = [];
  const docListeners = {};
  const winListeners = {};
  const ctxInstances = [];
  let level = 0.35;

  class FakeNode {
    constructor(name) {
      this.name = name || "node";
      this.outputs = [];
    }
    connect(target) {
      if (this.outputs.indexOf(target) < 0) this.outputs.push(target);
      return this;
    }
    disconnect() {
      this.outputs.length = 0;
    }
  }

  class FakeAnalyser extends FakeNode {
    constructor() {
      super("analyser");
      this.fftSize = 1024;
    }
    getFloatTimeDomainData(buf) {
      // 只有音源接到了 destination（直通或音效链）时才有信号
      for (let i = 0; i < buf.length; i++) buf[i] = level * Math.sin((i / buf.length) * Math.PI * 4);
    }
  }

  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.destination = new FakeNode("destination");
      this.onstatechange = null;
      this.capturedEls = [];
      this.audioWorklet = { addModule: () => Promise.resolve() };
      ctxInstances.push(this);
    }
    fire() {
      if (typeof this.onstatechange === 'function') this.onstatechange();
    }
    resume() {
      return new Promise((resolve) => {
        setTimeout(() => {
          if (this.state === 'suspended') {
            this.state = 'running';
            this.fire();
          }
          resolve();
        }, 5);
      });
    }
    suspend() {
      this.state = 'suspended';
      this.fire();
      return Promise.resolve();
    }
    close() {
      if (this.state !== 'closed') {
        this.state = 'closed';
        for (const el of this.capturedEls) el.__captured = false;
        this.fire();
      }
      return Promise.resolve();
    }
    createGain() {
      return new FakeNode("gain");
    }
    createAnalyser() {
      return new FakeAnalyser();
    }
    createMediaElementSource(el) {
      if (el.__captured) {
        const err = new Error('HTMLMediaElement already connected previously');
        err.name = 'InvalidStateError';
        throw err;
      }
      el.__captured = true;
      this.capturedEls.push(el);
      return new FakeNode("source");
    }
  }

  /** 简化版 Joysound SDK：异步建源 + statuChange 回执 + 与引擎一致的内部结构 */
  class FakeSDK {
    constructor() {
      this._ctx = new FakeAudioContext();
      this._source = null;
      this._listeners = {};
      this._enabled = false;
      this._input = new FakeNode("input");
      this._output = new FakeNode("output");
      this._jsNode = {
        source: this._input, // SDK 暴露的 getter
        _input: this._input,
        _output: this._output,
        _workletBlob: 'blob:fake',
      };
    }
    on(event, fn) {
      (this._listeners[event] = this._listeners[event] || []).push(fn);
    }
    emit(event, arg) {
      (this._listeners[event] || []).forEach((fn) => fn(arg));
    }
    init(el) {
      this._el = el;
      setTimeout(() => {
        if (this._ctx.state === 'closed') return;
        try {
          this._source = this._ctx.createMediaElementSource(el);
        } catch (e) {
          this._sourceError = e;
          return;
        }
        // 模拟 SDK 的 _connect()：source → input，output → destination
        this._source.connect(this._input);
        this._output.connect(this._ctx.destination);
        if (this._enabled) setTimeout(() => this.emit('statuChange', { enabled: 1 }), 5);
      }, 20);
      return true;
    }
    setEnabled(value) {
      this._enabled = !!value;
      if (this._enabled && this._source) {
        setTimeout(() => {
          if (this._ctx.state !== 'closed') this.emit('statuChange', { enabled: 1 });
        }, 5);
      }
    }
    destroy() {
      this._ctx.close();
    }
  }

  const document = {
    visibilityState: 'visible',
    documentElement: {},
    addEventListener(type, fn) {
      (docListeners[type] = docListeners[type] || []).push(fn);
    },
    removeEventListener() {},
    dispatchEvent(event) {
      (docListeners[event.type] || []).slice().forEach((fn) => fn(event));
      return true;
    },
    querySelectorAll(sel) {
      if (sel === 'video') return videos.filter((v) => v.isConnected);
      return [];
    },
  };

  class MutationObserver {
    observe() {}
    disconnect() {}
  }

  const win = {
    document,
    location: { host: 'test.local', origin: 'http://test.local', href: 'http://test.local/' },
    performance: { now: () => Date.now() },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    Blob: class Blob {
      constructor(parts) {
        this.parts = parts;
      }
    },
    // 真 URL 构造器 + 扩展需要的静态方法（engine 里用 new URL 判断跨域）
    URL: class FakeURL extends URL {
      static createObjectURL() {
        return 'blob:fake-' + Math.random().toString(16).slice(2);
      }
      static revokeObjectURL() {}
    },
    MutationObserver,
    AudioContext: FakeAudioContext,
    AudioWorkletNode: function AudioWorkletNode() {},
    addEventListener(type, fn) {
      (winListeners[type] = winListeners[type] || []).push(fn);
    },
    removeEventListener() {},
    dispatchEvent(event) {
      (winListeners[event.type] || []).slice().forEach((fn) => fn(event));
      return true;
    },
    postMessage(msg) {
      messages.push(msg);
    },
  };
  win.window = win;
  win.globalThis = win;
  win.self = win;

  const context = vm.createContext(win);

  // 在 vm 内部安装消息通道：event.source 必须是 vm 自己的 window
  vm.runInContext(
    `(function () {
      var origAdd = window.addEventListener;
      window.__msgListeners = [];
      window.addEventListener = function (type, fn, opts) {
        if (type === "message") window.__msgListeners.push(fn);
        return origAdd.call(window, type, fn, opts);
      };
      window.__sendCmd = function (payload) {
        var ev = {
          type: "message",
          data: { source: "joysound-ext", type: "cmd", payload: payload },
          source: window,
        };
        window.__msgListeners.slice().forEach(function (fn) { fn(ev); });
      };
    })();`,
    context
  );

  const env = {
    win,
    document,
    videos,
    messages,
    ctxInstances,
    SDK: FakeSDK,
    load(file) {
      const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
      vm.runInContext(code, context, { filename: file });
    },
    setLevel(v) {
      level = v;
    },
    startDecoding(el, step = 4096) {
      const timer = setInterval(() => {
        if (el.isConnected === false) return;
        el.webkitAudioDecodedByteCount += step;
      }, 100);
      return () => clearInterval(timer);
    },
    addVideo(overrides) {
      const v = Object.assign(
        {
          tagName: 'VIDEO',
          isConnected: true,
          paused: false,
          ended: false,
          readyState: 4,
          muted: false,
          volume: 0.8,
          crossOrigin: null,
          currentSrc: 'http://test.local/tone.wav',
          src: 'http://test.local/tone.wav',
          srcObject: null,
          webkitAudioDecodedByteCount: 1000,
          querySelector() {
            return null;
          },
          remove() {
            this.isConnected = false;
          },
        },
        overrides
      );
      videos.push(v);
      return v;
    },
    replaceVideo(old) {
      old.isConnected = false;
      return env.addVideo({});
    },
    sendCmd(payload) {
      vm.runInContext('window.__sendCmd(' + JSON.stringify(payload) + ')', context);
    },
    fireVisibilityChange(visible) {
      document.visibilityState = visible ? 'visible' : 'hidden';
      document.dispatchEvent({ type: 'visibilitychange', target: document });
    },
    run(code) {
      return vm.runInContext(code, context);
    },
    api() {
      return vm.runInContext('window.__joysoundEngineApi', context);
    },
    status() {
      const api = env.api();
      return api ? api.status() : null;
    },
    sessions() {
      const api = env.api();
      return api ? api.sessions() : [];
    },
  };

  return env;
}

/* ------------------------------------------------------------------ */
/* 场景                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  console.log('Joysound 引擎状态机单元测试\n');

  const env = createEnv();
  env.load('src/content/early.js');
  env.win.__JOYSOUND_SDK__ = env.SDK;
  env.load('src/content/engine.js');

  await sleep(120);

  console.log('\x1b[1m[1] 初始状态\x1b[0m');
  check('引擎已加载', !!env.api());
  check('默认不接管任何视频', env.status().state === 'off' && env.sessions().length === 0);

  console.log('\n\x1b[1m[2] 启用后接管\x1b[0m');
  const v1 = env.addVideo();
  const stopDecode1 = env.startDecoding(v1);
  env.sendCmd({ enabled: true });

  const active1 = await waitFor(
    () => {
      const s = env.status();
      return s.state === 'active' ? s : false;
    },
    8000,
    'active'
  );
  check('状态变为 active', active1.state === 'active', active1.state);
  check('接管了 1 个视频', env.sessions().length === 1);
  check('收到 AudioWorklet 回执', env.sessions()[0].applied === true);
  check('AudioContext 为 running', env.sessions()[0].ctx.state === 'running');
  await waitFor(() => env.win.__JOYSOUND_NS__.owned.has(v1), 3000, '元素登记为已接管');
  await waitFor(() => env.sessions()[0].src, 3000, '音源建立');
  check('音源走音效链', env.sessions()[0].src.outputs.includes(env.sessions()[0].js._jsNode.source));

  console.log('\n\x1b[1m[3] 站点再次捕获同一元素\x1b[0m');
  let recaptureError = null;
  try {
    const pageCtx = new env.win.AudioContext();
    pageCtx.createMediaElementSource(v1);
    pageCtx.close();
  } catch (e) {
    recaptureError = e.name;
  }
  check('不抛 InvalidStateError', recaptureError === null, recaptureError);

  console.log('\n\x1b[1m[4] 关闭开关：必须保活旁路，不能销毁上下文\x1b[0m');
  const s1 = env.sessions()[0];
  const ctxBefore = s1.ctx;
  env.sendCmd({ enabled: false });
  await sleep(200);

  check('状态为 off', env.status().state === 'off', env.status().state);
  check('会话仍然保留（不能销毁）', env.sessions().length === 1, env.sessions().length);
  check('上下文没有被关闭', s1.ctx && s1.ctx.state !== 'closed', s1.ctx && s1.ctx.state);
  check('上下文没有被替换', s1.ctx === ctxBefore);
  check('音效已旁路', s1.bypassed === true);
  check(
    '音源直连 destination（原始音频）',
    s1.src.outputs.indexOf(ctxBefore.destination) >= 0,
    s1.src.outputs.map((n) => n.name)
  );
  check('元素仍被扩展持有（Chromium 限制）', v1.__captured === true);

  console.log('\n\x1b[1m[5] 重新开启\x1b[0m');
  env.sendCmd({ enabled: true });
  const active2 = await waitFor(
    () => {
      const st = env.status();
      return st.state === 'active' ? st : false;
    },
    8000,
    '重新开启后 active'
  );
  check('重新开启后恢复 active', active2.state === 'active', active2.state);
  check('音源重新接回音效链', s1.src.outputs.indexOf(s1.js._jsNode.source) >= 0);
  check('没有新建 AudioContext', env.sessions()[0].ctx === ctxBefore);

  console.log('\n\x1b[1m[6] 切出 / 切回标签页\x1b[0m');
  env.fireVisibilityChange(false);
  await sleep(200);
  env.fireVisibilityChange(true);
  await sleep(600);
  check('切回来仍是 active', env.status().state === 'active', env.status().state);

  console.log('\n\x1b[1m[7] 播放器重建 <video>（音效消失的典型原因）\x1b[0m');
  const v2 = env.replaceVideo(v1);
  const stopDecode2 = env.startDecoding(v2);
  const rebuilt = await waitFor(() => {
    const list = env.sessions();
    return list.length === 1 && list[0].el === v2 && list[0].applied ? list[0] : false;
  }, 8000, '新节点被接管');
  check('新 <video> 已被接管', rebuilt.el === v2);
  check('新会话重新拿到回执', rebuilt.applied === true);
  check('旧会话已清理', env.sessions().length === 1);
  check('旧元素已被释放', v1.__captured === false);

  console.log('\n\x1b[1m[8] AudioContext 被挂起\x1b[0m');
  const s2 = env.sessions()[0];
  s2.ctx.suspend();
  check('已制造 suspended', s2.ctx.state === 'suspended', s2.ctx.state);
  await waitFor(() => s2.ctx.state === 'running', 6000, '自动 resume');
  check('引擎自动拉起上下文', s2.ctx.state === 'running');

  console.log('\n\x1b[1m[9] 跨域媒体：接管后始终零采样\x1b[0m');
  env.setLevel(0);
  const degraded = await waitFor(
    () => {
      const st = env.status();
      return st.state === 'silent' ? st : false;
    },
    20000,
    '识别为静音并降级'
  );
  check('识别出「拿不到音频数据」', degraded.state === 'silent', degraded.state);
  check('降级为旁路而不是销毁', env.sessions().length === 1 && env.sessions()[0].bypassed === true);
  check('降级后上下文仍然存活（画面不会卡住）', env.sessions()[0].ctx.state === 'running');
  check('降级后音源直连 destination', env.sessions()[0].src.outputs.indexOf(env.sessions()[0].ctx.destination) >= 0);

  console.log('\n\x1b[1m[10] 跨域媒体：从一开始就不该碰\x1b[0m');
  env.setLevel(0.35);
  env.sendCmd({ enabled: false });
  await sleep(150);
  for (const v of env.videos) v.isConnected = false;
  await waitFor(() => env.sessions().length === 0, 8000, '清理');
  const cross = env.addVideo({
    currentSrc: 'http://cdn.example.com/tone.wav',
    src: 'http://cdn.example.com/tone.wav',
  });
  env.sendCmd({ enabled: true });
  const skipped = await waitFor(
    () => {
      const st = env.status();
      return st.state === 'cross-origin' ? st : false;
    },
    8000,
    '识别为跨域污染'
  );
  check('跨域无 CORS 的视频没有被捕获', skipped.state === 'cross-origin', skipped.state);
  check('没有建立任何会话', env.sessions().length === 0);
  check('元素未被占用', !cross.__captured);

  console.log('\n\x1b[1m[11] 视频被移除\x1b[0m');
  cross.isConnected = false;
  const local = env.addVideo({ currentSrc: 'http://test.local/tone.wav', src: 'http://test.local/tone.wav' });
  env.startDecoding(local);
  const back = await waitFor(
    () => {
      const st = env.status();
      return st.state === 'active' ? st : false;
    },
    10000,
    '本地视频重新接管'
  );
  check('重新出现可处理的视频后恢复 active', back.state === 'active', back.state);
  local.isConnected = false;
  const empty = await waitFor(() => (env.sessions().length === 0 ? 'empty' : false), 8000, '会话清理');
  check('移除后会话被清理', empty === 'empty');
  check('状态回到 no-media', env.status().state === 'no-media', env.status().state);
  check('移除时上下文被关闭（安全）', env.ctxInstances.every((c) => c.state === 'closed'));

  stopDecode1();
  stopDecode2();

  console.log(`\n结果：\x1b[32m${passed} 通过\x1b[0m，${failed ? '\x1b[31m' : ''}${failed} 失败\x1b[0m`);
  if (failed) {
    console.log('失败项：\n  - ' + failures.join('\n  - '));
  }
  process.exit(failed ? 1 : 0);
}

module.exports = { createEnv };

if (require.main === module) {
  main().catch((e) => {
    console.error('\n测试中止：' + (e && e.stack ? e.stack : e));
    process.exit(1);
  });
}
