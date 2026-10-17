/**
 * bridge.js —— 隔离世界（ISOLATED world），document_start 注入。
 *
 * 主世界（engine.js）拿不到 chrome.* API，这个文件负责：
 *   1. 读取 chrome.storage 里的开关，算出「当前站点是否启用」；
 *   2. 把配置用 postMessage 递给主世界；
 *   3. 需要时通知后台把 joysound.sdk.js + engine.js 注入主世界；
 *   4. 把主世界的运行状态转报给后台（工具栏角标 / 弹窗）。
 */
(function () {
  "use strict";
  if (window.__joysoundBridge) return;
  window.__joysoundBridge = true;

  const HOST = location.host;

  /** @type {{enabled:boolean, askedEngine:number, status:object|null, engineReady:boolean, timer:number}} */
  const state = {
    enabled: false,
    askedEngine: 0,
    status: null,
    engineReady: false,
    timer: 0,
  };

  const post = (payload) =>
    window.postMessage({ source: "joysound-ext", type: "cmd", payload }, "*");

  function readSettings() {
    return chrome.storage.local.get({ globalEnabled: true, sites: {} });
  }

  function isEnabledFor(settings) {
    if (!settings || settings.globalEnabled === false) return false;
    const sites = settings.sites || {};
    return sites[HOST] === true;
  }

  function ensureEngine() {
    if (state.engineReady) return; // 已经注入过，不必重复解析 100KB 的引擎
    if (Date.now() - state.askedEngine < 4000) return;
    state.askedEngine = Date.now();
    chrome.runtime
      .sendMessage({ type: "ensure-engine", engineRequest: true })
      .then((res) => {
        if (res && res.ok === false) {
          state.askedEngine = 0;
          if (res.error === "sdk-missing") {
            // 仓库里不附带第三方引擎文件，需要用户先在本地生成
            state.status = {
              state: "sdk-missing",
              detail: "缺少音效引擎文件 vendor/joysound.sdk.js：请在扩展目录执行一次 node tools/extract-joysound.js，然后重新加载扩展",
              sessions: [],
              enabled: true,
            };
          } else {
            state.status = {
              state: "error",
              detail: "音效引擎注入失败：" + res.error,
              sessions: [],
              enabled: true,
            };
          }
          pushStatus();
        }
      })
      .catch(() => {
        // 注入失败时允许稍后重试
        state.askedEngine = 0;
      });
  }

  async function apply() {
    const settings = await readSettings().catch(() => null);
    const on = isEnabledFor(settings);
    state.enabled = on;
    post({ enabled: on, host: HOST });
    if (on) ensureEngine();
    pushStatus();
  }

  function pushStatus() {
    if (!state.status && !state.enabled) return;
    chrome.runtime
      .sendMessage({
        type: "frame-status",
        payload: {
          host: HOST,
          enabled: state.enabled,
          status: state.status,
        },
      })
      .catch(() => {});
  }

  // ---- 主世界 -> 隔离世界 ----
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "joysound-ext") return;

    if (data.type === "status") {
      state.status = data.payload || null;
      pushStatus();
    } else if (data.type === "hello") {
      // 主世界引擎已就绪：回一次当前配置
      state.engineReady = true;
      post({ enabled: state.enabled, host: HOST });
    }
  });

  // ---- 后台 -> 隔离世界 ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "settings-changed") {
      apply();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "push-status") {
      pushStatus();
      sendResponse({ ok: true, enabled: state.enabled, status: state.status });
      return;
    }
    if (msg.type === "reapply") {
      // 用户点了「立即生效」：强制重新解析配置
      state.askedEngine = 0;
      apply();
      sendResponse({ ok: true });
      return;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.globalEnabled || changes.sites) apply();
  });

  // 首帧尽快跑一次；DOM 就绪后再补一次（部分页面此时才写入 cookie/开关）
  apply();
  document.addEventListener("DOMContentLoaded", apply, { once: true });

  // 状态定时回传（主世界在切标签页、重建播放器时状态会变）
  state.timer = setInterval(() => {
    if (state.enabled) pushStatus();
  }, 5000);
})();
