/**
 * engine.js —— 页面主世界（MAIN world），按需注入。
 *
 * 把 <video> 的声音接到 Joysound 音效链上，并持续做健康检查。
 *
 * ── 两条来自 Chromium 实测的硬约束 ───────────────────────────────
 * 1) 一个媒体元素一旦被 createMediaElementSource 捕获，它的播放时钟就由
 *    音频图驱动：**只要断开输出或关闭 AudioContext，播放会立刻冻住**
 *    （currentTime 不再前进），而且关闭后元素仍被「死上下文」占着，
 *    Chrome 不会把声音还给原生输出。实测四种拆链方式，只有
 *    「保留上下文 + 直接把音源接到 destination」能让播放继续。
 *    → 所以本引擎**从不关闭仍挂在文档里的上下文**，
 *      「关闭音效」= 旁路（source → destination），而不是销毁。
 *
 * 2) 跨域且未走 CORS 的媒体，捕获后必定是静音（实测 peak 恒为 0），
 *    而且无法回退成原生播放。→ 在捕获**之前**就识别出来，直接不碰它。
 *
 * ── 自愈（本次要修的核心问题）───────────────────────────────────
 * 站点在切出/切回标签页、全屏进出、切清晰度时常做：重建 <video>、
 * 重新挂 AudioContext、页面被冻结。对应处理：
 *   - MutationObserver + 定时巡检 + 媒体事件 → 新节点立刻接管；
 *   - visibilitychange / pageshow / focus / resume → 多轮重扫校验；
 *   - AudioContext 被挂起 → 反复 resume()（不能重建，见约束 1）；
 *   - 工作线程没回执 / 捕获后零采样 → 降级为旁路并说明原因，
 *     保证画面继续播、不会卡死。
 */
(function () {
  "use strict";

  const W = window;
  if (W.__joysoundEngine) return;
  W.__joysoundEngine = true;

  const VERSION = "1.1.0";
  const SDK = W.__JOYSOUND_SDK__;
  const NS = W.__JOYSOUND_NS__;
  const AC = W.AudioContext || W.webkitAudioContext;

  const MAX_SESSIONS = 3;
  const SWEEP_MS = 1500;
  const DEEP_SCAN_MS = 8000;
  const ACK_TIMEOUT_MS = 5000;
  const SUSPEND_GRACE_MS = 5000;
  const SILENCE_MS = 2500;

  const now = () => (W.performance && W.performance.now ? W.performance.now() : Date.now());

  const state = {
    enabled: false,
    started: false,
    /** @type {Map<HTMLVideoElement, Session>} */
    tracked: new Map(),
    /** @type {null | {ok:boolean, reason?:string, detail?:string, mode?:string}} */
    probe: null,
    probePromise: null,
    /** @type {null | {reason:string, detail:string, at:number}} */
    failure: null,
    /** 已被判定为「不碰」的站点级原因（跨域污染等） */
    skip: null,
    hooksInstalled: false,
    sweepTimer: 0,
    scanTimer: 0,
    reportTimer: 0,
    lastReportAt: 0,
    lastDeepScan: 0,
    lastScanAt: 0,
    lastGestureAt: 0,
    scanDeepPending: false,
    observer: null,
  };

  /* ================================================================ */
  /* 上报                                                              */
  /* ================================================================ */

  function post(type, payload) {
    try {
      W.postMessage({ source: "joysound-ext", type: type, payload: payload }, "*");
    } catch (e) {
      /* ignore */
    }
  }

  function report(force) {
    const t = now();
    if (!force && t - state.lastReportAt < 250) {
      if (!state.reportTimer) {
        state.reportTimer = setTimeout(function () {
          state.reportTimer = 0;
          report(true);
        }, 260);
      }
      return;
    }
    state.lastReportAt = t;
    post("status", buildStatus());
  }

  function buildStatus() {
    const sessions = [];
    let applied = 0;
    let bypassed = 0;
    state.tracked.forEach(function (s) {
      const item = {
        ack: !!s.applied,
        bypassed: !!s.bypassed,
        ctx: s.ctx ? s.ctx.state : "none",
        playing: !!s.el && !s.el.paused && !s.el.ended,
        state: s.state,
        failed: s.failed || "",
      };
      if (item.ack && !item.bypassed) applied++;
      if (item.bypassed) bypassed++;
      sessions.push(item);
    });

    let code = "idle";
    let detail = "";
    const failedSession = sessions.filter(function (s) {
      return s.failed;
    })[0];

    if (!state.enabled) {
      code = "off";
      if (state.tracked.size) detail = "已关闭音效处理，音频已切回原始直通";
    } else if (applied > 0) {
      code = "active";
    } else if (state.skip) {
      code = state.skip.reason;
      detail = state.skip.detail;
    } else if (state.probe && !state.probe.ok) {
      code = "blocked";
      detail = state.probe.detail || "音效引擎无法启动";
    } else if (applied > 0) {
      code = "active";
    } else if (failedSession) {
      code = failedSession.failed;
      detail = (state.failure && state.failure.detail) || "已切回原始直通音频";
    } else if (sessions.length) {
      code = "pending";
      detail = "正在初始化音效…";
    } else if (state.failure && now() - state.failure.at < 120000) {
      code = state.failure.reason;
      detail = state.failure.detail;
    } else {
      code = "no-media";
      detail = "当前页面未找到视频";
    }

    return {
      state: code,
      detail: detail,
      sessions: sessions,
      bypassed: bypassed,
      enabled: state.enabled,
      host: location.host,
      version: VERSION,
    };
  }

  function fail(reason, detail) {
    state.failure = { reason: reason, detail: detail, at: now() };
    report(true);
  }

  function errText(e) {
    if (!e) return "未知错误";
    return String((e.name ? e.name + " : " : "") + (e.message || e));
  }

  /* ================================================================ */
  /* 能力探测：AudioWorklet / Worker 是否被站点 CSP 掐住               */
  /* ================================================================ */

  function ensureProbe() {
    if (state.probe) return Promise.resolve(state.probe);
    if (state.probePromise) return state.probePromise;

    state.probePromise = (async function () {
      let ctx = null;
      try {
        ctx = new AC();
      } catch (e) {
        return { ok: false, reason: "error", detail: "无法创建 AudioContext" };
      }
      try {
        if (ctx.audioWorklet && typeof W.AudioWorkletNode === "function") {
          const url = URL.createObjectURL(
            new Blob(
              [
                "registerProcessor('joysound-probe', class extends AudioWorkletProcessor { process() { return true; } });",
              ],
              { type: "application/javascript" }
            )
          );
          try {
            await ctx.audioWorklet.addModule(url);
          } catch (e) {
            return { ok: false, reason: "csp", detail: "站点安全策略（CSP）禁止了 AudioWorklet，音效无法启用" };
          } finally {
            URL.revokeObjectURL(url);
          }
          return { ok: true, mode: "worklet" };
        }

        const wurl = URL.createObjectURL(
          new Blob(["self.onmessage = function () {};"], { type: "application/javascript" })
        );
        try {
          const worker = new Worker(wurl);
          worker.terminate();
        } catch (e) {
          return { ok: false, reason: "csp", detail: "站点安全策略（CSP）禁止了 Worker，音效无法启用" };
        } finally {
          URL.revokeObjectURL(wurl);
        }
        return { ok: true, mode: "script" };
      } finally {
        try {
          if (ctx && ctx.state !== "closed") ctx.close();
        } catch (e) {
          /* ignore */
        }
      }
    })().then(function (result) {
      state.probe = result;
      return result;
    });

    return state.probePromise;
  }

  /* ================================================================ */
  /* 跨域污染预检：捕获这种媒体必定静音，所以干脆不碰                  */
  /* ================================================================ */

  function isCaptureTainted(el) {
    const src = el.currentSrc;
    if (!src) return false;
    let url;
    try {
      url = new URL(src, location.href);
    } catch (e) {
      return false;
    }
    // blob: / data: / mediasource: 都算同源
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.origin === location.origin) return false;
    // 跨域但显式声明了 CORS，且确实加载成功（currentSrc 有值）→ 不污染
    if (el.crossOrigin === "anonymous" || el.crossOrigin === "use-credentials") return false;
    return true;
  }

  /* ================================================================ */
  /* 单个 <video> 的会话                                               */
  /* ================================================================ */

  class Session {
    constructor(el) {
      this.el = el;
      this.js = null;
      this.ctx = null;
      this.src = null;
      this.analyser = null;
      this.samples = null;
      this.openedAt = 0;
      this.lastApplyAt = 0;
      this.ackAt = 0;
      this.applied = false;
      /** 当前是否处于直通旁路（不做任何处理） */
      this.bypassed = false;
      /** 粘性失败原因：no-ack / silent / closed / owned */
      this.failed = null;
      this.silenceStrikes = 0;
      this.reopenTimer = 0;
      this.attachTimer = 0;
      this.suspendSince = 0;
      this.silentSince = 0;
      this.decoded = -1;
      this.disposed = false;
      this.state = "new";
    }

    /* ---------- 建立 ---------- */

    open() {
      if (this.disposed) return;
      if (!this.el.isConnected) {
        this.detach();
        return;
      }

      this.state = "starting";
      this.openedAt = now();
      this.applied = false;
      this.ackAt = 0;
      this.suspendSince = 0;
      this.silentSince = 0;
      this.decoded = -1;

      const self = this;
      let js;
      try {
        js = new SDK({});
      } catch (e) {
        this.state = "broken";
        this.failed = "error";
        fail("error", "音效引擎初始化失败：" + errText(e));
        return;
      }
      this.js = js;

      js.on("statuChange", function (ev) {
        if (self.disposed) return;
        if (ev && ev.enabled) {
          self.applied = true;
          self.ackAt = now();
          self.state = "running";
          report();
        }
      });

      // SDK 只接受 HTMLMediaElement：内部会 new AudioContext() 并捕获元素
      if (js.init(this.el) === false) {
        this.state = "broken";
        this.failed = "error";
        fail("error", "音效引擎拒绝接管该视频");
        return;
      }

      this.attachContext();
      this.attachSource();
      this.attachTimer = setInterval(function () {
        self.attachSource();
        if (self.src || self.disposed) {
          clearInterval(self.attachTimer);
          self.attachTimer = 0;
        }
      }, 100);
      setTimeout(function () {
        if (self.attachTimer) {
          clearInterval(self.attachTimer);
          self.attachTimer = 0;
        }
      }, 3000);

      this.apply();
      report();
    }

    attachContext() {
      const js = this.js;
      if (!js || this.ctx || !js._ctx) return;
      const ctx = js._ctx;
      this.ctx = ctx;
      try {
        // early.js 的补丁据此识别「这是扩展自己的捕获」
        ctx.__joysound = true;
      } catch (e) {
        /* ignore */
      }
      const self = this;
      try {
        ctx.onstatechange = function () {
          if (self.disposed || self.ctx !== ctx) return;
          if (ctx.state === "running") self.suspendSince = 0;
          report();
        };
      } catch (e) {
        /* ignore */
      }
      this.resume();
    }

    attachSource() {
      const js = this.js;
      if (!js || this.src || !js._source) return;
      this.src = js._source;
      try {
        NS.owned.add(this.el);
      } catch (e) {
        /* ignore */
      }

      // 在音效链出口挂分析器：用来判断「到底有没有声音」
      try {
        const out = js._jsNode && js._jsNode._output;
        const ctx = this.ctx || js._ctx || null;
        if (ctx && out && typeof out.connect === "function") {
          this.analyser = ctx.createAnalyser();
          this.analyser.fftSize = 1024;
          this.samples = new Float32Array(this.analyser.fftSize);
          out.connect(this.analyser);
        }
      } catch (e) {
        this.analyser = null;
        this.samples = null;
      }

      this.state = "running";
      this.resume();
      this.syncMode();
      report();
    }

    /* ---------- 路由 ---------- */

    /**
     * 把音源接到目标节点。
     * @param {boolean} throughEffect true = 走音效链，false = 直通 destination
     */
    wire(throughEffect) {
      const src = this.src;
      const ctx = this.ctx;
      const js = this.js;
      if (!src || !ctx) return false;
      try {
        src.disconnect();
      } catch (e) {
        /* ignore */
      }
      try {
        if (throughEffect) {
          const input = js && js._jsNode && js._jsNode.source; // SDK 暴露的 getter
          if (!input) return false;
          src.connect(input);
        } else {
          src.connect(ctx.destination);
        }
        return true;
      } catch (e) {
        return false;
      }
    }

    syncMode() {
      if (state.enabled) this.enableEffect();
      else this.disableEffect();
    }

    enableEffect() {
      if (this.disposed || !this.src) return;
      this.failed = null;
      this.bypassed = false;
      if (!this.wire(true)) {
        this.bypassed = true;
        return;
      }
      this.apply();
    }

    disableEffect() {
      if (this.disposed) return;
      this.bypassed = true;
      this.applied = false;
      if (this.src) this.wire(false);
      if (this.js) {
        try {
          this.js.setEnabled(0);
        } catch (e) {
          /* ignore */
        }
      }
      report();
    }

    /** 降级为直通：保证画面继续播，只是不再处理音频 */
    degrade(reason, detail) {
      if (this.disposed) return;
      this.failed = reason;
      this.state = "degraded";
      this.disableEffect();
      fail(reason, detail);
    }

    apply() {
      if (this.disposed || !this.js) return;
      this.lastApplyAt = now();
      try {
        this.js.setEnabled(state.enabled && !this.bypassed ? 1 : 0);
      } catch (e) {
        /* ignore */
      }
    }

    resume() {
      const ctx = this.ctx;
      if (!ctx || ctx.state === "running" || ctx.state === "closed") return;
      try {
        const p = ctx.resume();
        if (p && typeof p.catch === "function") p.catch(function () {});
      } catch (e) {
        /* ignore */
      }
    }

    /* ---------- 健康检查 ---------- */

    tick() {
      if (this.disposed) return;
      const t = now();

      // 元素离开文档：这时关闭上下文是安全的
      if (!this.el.isConnected) {
        this.detach();
        return;
      }

      if (!this.ctx) this.attachContext();
      if (!this.src) this.attachSource();

      if (!this.ctx) {
        if (t - this.openedAt > ACK_TIMEOUT_MS) {
          this.failed = "error";
          this.state = "broken";
          fail("error", "音效引擎未能建立音频上下文");
        }
        return;
      }

      if (this.ctx.state === "closed") {
        // 上下文被外部关掉了：元素已被占用，无法恢复，只能如实上报
        this.failed = "closed";
        this.state = "broken";
        fail("closed", "音频上下文被关闭，音效无法恢复（可刷新页面）");
        return;
      }

      // 挂起的上下文会让播放冻住，必须持续拉起
      if (this.ctx.state !== "running") {
        this.resume();
        if (!this.el.paused && !this.el.ended) {
          if (!this.suspendSince) this.suspendSince = t;
          else if (t - this.suspendSince > SUSPEND_GRACE_MS) {
            this.suspendSince = 0;
            fail("suspend", "浏览器一直挂起音频上下文，点击页面可继续恢复");
          }
        }
      } else {
        this.suspendSince = 0;
      }

      if (!state.enabled) return; // 关闭状态下只做保活
      if (this.bypassed) return; // 已降级，等用户再次开启时重试
      if (!this.src) {
        if (t - this.openedAt > ACK_TIMEOUT_MS) {
          this.degrade("owned", "该视频的音频已被页面自带的 Web Audio 占用");
        }
        return;
      }

      if (!this.applied && t - this.lastApplyAt > 800) this.apply();
      if (!this.applied && t - this.openedAt > ACK_TIMEOUT_MS) {
        this.degrade("no-ack", "音效工作线程没有响应，已切回原始直通音频");
        return;
      }

      if (this.ctx.state === "running") this.checkAudio();
    }

    /** 当前音效链出口的峰值（调试 / 自检用） */
    meter() {
      const analyser = this.analyser;
      const samples = this.samples;
      if (!analyser || !samples) return 0;
      analyser.getFloatTimeDomainData(samples);
      let peak = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = samples[i];
        if (v > peak) peak = v;
        else if (-v > peak) peak = -v;
      }
      return peak;
    }

    /** 零采样检测：接管后长静音说明拿不到音频（跨域 / DRM / 线程异常） */
    checkAudio() {
      const el = this.el;
      const analyser = this.analyser;
      const samples = this.samples;
      if (!analyser || !samples) return;
      if (el.paused || el.ended || el.muted || el.volume === 0 || el.readyState < 2) {
        this.silentSince = 0;
        return;
      }

      analyser.getFloatTimeDomainData(samples);
      let peak = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = samples[i];
        if (v > peak) peak = v;
        else if (-v > peak) peak = -v;
      }

      const decoded = el.webkitAudioDecodedByteCount;
      let progressing = false;
      if (typeof decoded === "number") {
        if (this.decoded < 0) this.decoded = decoded;
        progressing = decoded > this.decoded;
        this.decoded = decoded;
      }

      if (progressing && peak === 0) {
        if (!this.silentSince) {
          this.silentSince = now();
        } else if (now() - this.silentSince > SILENCE_MS) {
          this.silentSince = 0;
          this.silenceStrikes++;
          if (this.silenceStrikes >= 2) {
            this.degrade("silent", "拿不到音频数据（媒体受跨域保护或受 DRM 限制），已切回原始直通音频");
          } else {
            this.wire(true); // 先尝试重新接线，不要直接放弃
            this.apply();
          }
        }
      } else {
        this.silentSince = 0;
        if (peak > 0) this.silenceStrikes = 0;
      }
    }

    /**
     * 彻底拆掉。**只有元素已经离开文档时才允许**：
     * 否则关闭上下文会把还在播的视频冻住（Chromium 行为，见文件头）。
     */
    detach() {
      if (this.disposed) return;
      this.disposed = true;
      this.state = "closed";

      if (this.attachTimer) {
        clearInterval(this.attachTimer);
        this.attachTimer = 0;
      }
      if (this.reopenTimer) {
        clearTimeout(this.reopenTimer);
        this.reopenTimer = 0;
      }

      const js = this.js;
      this.js = null;
      if (js) {
        try {
          const node = js._jsNode;
          if (node && node._workletBlob) URL.revokeObjectURL(node._workletBlob);
        } catch (e) {
          /* ignore */
        }
        try {
          js.destroy(); // 内部会 close 上下文；此时元素已不在文档里，安全
        } catch (e) {
          /* ignore */
        }
      }

      const ctx = this.ctx;
      this.ctx = null;
      if (ctx && ctx.state !== "closed") {
        try {
          ctx.close();
        } catch (e) {
          /* ignore */
        }
      }
      if (this.analyser) {
        try {
          this.analyser.disconnect();
        } catch (e) {
          /* ignore */
        }
      }

      this.src = null;
      this.analyser = null;
      this.samples = null;
      this.applied = false;
      this.bypassed = false;
      this.ackAt = 0;

      try {
        NS.owned.delete(this.el);
      } catch (e) {
        /* ignore */
      }
      state.tracked.delete(this.el);
      report();
    }
  }

  /* ================================================================ */
  /* 扫描 / 接管                                                       */
  /* ================================================================ */

  function collectVideos(deep) {
    const out = [];
    const first = document.querySelectorAll("video");
    for (let i = 0; i < first.length; i++) out.push(first[i]);
    if (!deep) return out;

    // 开放影子树里的视频（原版脚本覆盖不到）
    const seen = new Set();
    const walk = function (root, depth) {
      if (depth > 4 || !root.querySelectorAll) return;
      const all = root.querySelectorAll("*");
      for (let i = 0; i < all.length; i++) {
        const host = all[i];
        const shadow = host.shadowRoot;
        if (!shadow || seen.has(shadow)) continue;
        seen.add(shadow);
        const inner = shadow.querySelectorAll("video");
        for (let j = 0; j < inner.length; j++) out.push(inner[j]);
        walk(shadow, depth + 1);
      }
    };
    walk(document, 0);
    return out;
  }

  function hasSource(el) {
    if (el.currentSrc || el.src || el.srcObject) return true;
    return !!el.querySelector("source[src]");
  }

  function scan(deep) {
    if (!state.enabled || !state.started) return;
    if (state.probe && !state.probe.ok) return;
    state.lastScanAt = now();
    if (deep) state.lastDeepScan = state.lastScanAt;

    const list = collectVideos(deep);
    const candidates = [];
    let tainted = null;

    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      if (!el.isConnected || state.tracked.has(el)) continue;
      if (!hasSource(el) && el.paused && el.readyState === 0) continue;
      if (isCaptureTainted(el)) {
        tainted = el;
        continue;
      }
      candidates.push(el);
    }

    if (tainted && !candidates.length && !state.tracked.size) {
      state.skip = {
        reason: "cross-origin",
        detail: "该视频受跨域保护（未开启 CORS），接管后必定静音，已跳过",
      };
      report(true);
      return;
    }
    if (!tainted) state.skip = null;

    if (!candidates.length) return;

    // 正在播放的优先
    const score = function (el) {
      return (!el.paused && !el.ended ? 0 : 10) + (el.readyState >= 2 ? 0 : 1);
    };
    candidates.sort(function (a, b) {
      return score(a) - score(b);
    });

    for (let i = 0; i < candidates.length; i++) {
      if (state.tracked.size >= MAX_SESSIONS) break;
      const el = candidates[i];
      if (state.tracked.has(el)) continue;
      const session = new Session(el);
      state.tracked.set(el, session);
      session.open();
    }
    if (state.tracked.size) state.skip = null;
    report();
  }

  function scheduleScan(deep) {
    if (deep) state.scanDeepPending = true;
    if (state.scanTimer) return;
    state.scanTimer = setTimeout(function () {
      state.scanTimer = 0;
      const wantDeep = !!state.scanDeepPending;
      state.scanDeepPending = false;
      scan(wantDeep);
    }, 200);
  }

  /* ================================================================ */
  /* 事件钩子                                                          */
  /* ================================================================ */

  function verifyAll() {
    const list = [];
    state.tracked.forEach(function (s) {
      list.push(s);
    });
    for (let i = 0; i < list.length; i++) list[i].tick();
  }

  function onVisibility() {
    if (document.visibilityState !== "visible" || !state.enabled || !state.started) return;
    restore();
  }

  /**
   * 「切回来」的恢复流程。播放器重建 DOM 往往比 visibilitychange 晚一点，
   * 所以分几个时间点反复校验，而不是只做一次。
   */
  function restore() {
    verifyAll();
    scheduleScan(true);
    [120, 600, 1600, 3200].forEach(function (delay) {
      setTimeout(function () {
        if (!state.enabled || !state.started) return;
        scan(true);
        verifyAll();
      }, delay);
    });
  }

  function onResumeEvent() {
    if (!state.enabled || !state.started) return;
    restore();
  }

  function onMediaEvent(event) {
    if (!state.enabled || !state.started) return;
    const target = event.target;
    if (!target || target.tagName !== "VIDEO") return;
    const session = state.tracked.get(target);
    if (session) session.tick();
    else scheduleScan(false);
  }

  /** 用户交互：自动播放策略可能让 AudioContext 起不来，交互后值得重试 */
  function onUserGesture() {
    if (!state.enabled || !state.started) return;
    const t = now();
    if (t - state.lastGestureAt < 2000) return;
    state.lastGestureAt = t;
    verifyAll();
    scheduleScan(true);
  }

  function installHooks() {
    if (state.hooksInstalled) return;
    state.hooksInstalled = true;

    document.addEventListener("visibilitychange", onVisibility, true);
    W.addEventListener("pageshow", onResumeEvent, true);
    W.addEventListener("focus", onResumeEvent, true);
    document.addEventListener("resume", onResumeEvent, true);

    ["play", "playing", "loadedmetadata", "emptied", "abort", "canplay"].forEach(function (type) {
      document.addEventListener(type, onMediaEvent, true);
    });

    document.addEventListener("pointerdown", onUserGesture, true);
    document.addEventListener("keydown", onUserGesture, true);

    try {
      state.observer = new MutationObserver(function () {
        // 重页面（聊天、弹幕）的 DOM 变动非常频繁，这里做一层节流
        if (now() - state.lastScanAt < 700) return;
        scheduleScan(false);
      });
      state.observer.observe(document, { childList: true, subtree: true });
    } catch (e) {
      state.observer = null;
    }
  }

  function sweep() {
    // 关闭状态下如果还有旁路会话，仍需要周期保活（上下文一挂起画面就冻住）
    if (!state.enabled && state.tracked.size === 0) {
      stopSweep();
      return;
    }
    verifyAll();
    if (!state.enabled || !state.started) return;

    scan(false);
    if (now() - state.lastDeepScan > DEEP_SCAN_MS) scheduleScan(true);
  }

  function startSweep() {
    if (state.sweepTimer) return;
    state.sweepTimer = setInterval(sweep, SWEEP_MS);
  }

  function stopSweep() {
    if (state.sweepTimer) {
      clearInterval(state.sweepTimer);
      state.sweepTimer = 0;
    }
    if (state.scanTimer) {
      clearTimeout(state.scanTimer);
      state.scanTimer = 0;
    }
    if (state.reportTimer) {
      clearTimeout(state.reportTimer);
      state.reportTimer = 0;
    }
  }

  /* ================================================================ */
  /* 开关                                                              */
  /* ================================================================ */

  function bootstrap() {
    ensureProbe().then(function (probe) {
      if (!state.enabled || !state.started) return;
      if (!probe.ok) {
        fail(probe.reason || "csp", probe.detail || "音效引擎无法启动");
        return;
      }
      state.failure = null;
      scan(true);
      startSweep();
      report(true);
    });
  }

  function start() {
    if (state.started) return;
    state.started = true;
    installHooks();
    state.skip = null;

    // 已有会话（之前旁路着）重新接回音效链
    const list = [];
    state.tracked.forEach(function (s) {
      list.push(s);
    });
    for (let i = 0; i < list.length; i++) list[i].enableEffect();

    bootstrap();
  }

  /** 用户手动「重新检测」：连能力探测一起重来 */
  function retryNow() {
    if (!state.started) {
      state.enabled = true;
      start();
      return;
    }
    if (state.probe && !state.probe.ok) {
      state.probe = null;
      state.probePromise = null;
    }
    state.skip = null;
    const list = [];
    state.tracked.forEach(function (s) {
      list.push(s);
    });
    for (let i = 0; i < list.length; i++) list[i].enableEffect();
    bootstrap();
  }

  function stop() {
    state.started = false;
    state.failure = null;
    state.skip = null;

    // 关键：不销毁上下文，只切到直通，保证视频继续播放、声音回到原始
    const list = [];
    state.tracked.forEach(function (s) {
      list.push(s);
    });
    for (let i = 0; i < list.length; i++) {
      list[i].failed = null;
      list[i].disableEffect();
    }
    if (list.length) startSweep(); // 继续做保活
    else stopSweep();

    report(true);
  }

  function setEnabled(on) {
    on = !!on;
    if (state.enabled === on) {
      if (on) retryNow();
      return;
    }
    state.enabled = on;
    if (on) start();
    else stop();
    report(true);
  }

  /* ================================================================ */
  /* 与隔离世界通信                                                    */
  /* ================================================================ */

  W.addEventListener("message", function (event) {
    if (event.source !== W) return;
    const data = event.data;
    if (!data || data.source !== "joysound-ext" || data.type !== "cmd") return;
    const payload = data.payload || {};
    if (typeof payload.enabled === "boolean") setEnabled(payload.enabled);
  });

  /* ================================================================ */
  /* 启动                                                              */
  /* ================================================================ */

  if (!NS || typeof NS.originalCreateMediaElementSource !== "function") {
    post("status", { state: "error", detail: "页面环境不支持 AudioContext", enabled: false, sessions: [] });
    return;
  }
  if (typeof SDK !== "function") {
    post("status", { state: "error", detail: "音效引擎未加载", enabled: false, sessions: [] });
    return;
  }
  if (!AC) {
    post("status", { state: "error", detail: "浏览器不支持 Web Audio", enabled: false, sessions: [] });
    return;
  }

  // 调试 / 自动化测试接口
  Object.defineProperty(W, "__joysoundEngineApi", {
    configurable: true,
    enumerable: false,
    value: {
      version: VERSION,
      status: buildStatus,
      sessions: function () {
        const list = [];
        state.tracked.forEach(function (s) {
          list.push(s);
        });
        return list;
      },
      meter: function () {
        const list = [];
        state.tracked.forEach(function (s) {
          list.push({
            peak: s.meter ? s.meter() : 0,
            ctx: s.ctx ? s.ctx.state : "none",
            ack: !!s.applied,
            bypassed: !!s.bypassed,
            playing: !s.el.paused,
          });
        });
        return list;
      },
      rescan: function () {
        return scan(true);
      },
      setEnabled: setEnabled,
      probe: function () {
        return ensureProbe();
      },
    },
  });

  // 告诉隔离世界我们已就绪，它会回一次当前开关
  post("hello", {});
  document.addEventListener("DOMContentLoaded", function () {
    post("hello", {});
  });
})();
