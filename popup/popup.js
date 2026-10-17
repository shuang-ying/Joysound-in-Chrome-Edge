"use strict";

const $ = (id) => document.getElementById(id);

const STATUS_TEXT = {
  active: { text: "已生效", cls: "ok" },
  pending: { text: "正在接管音频…", cls: "warn" },
  "no-media": { text: "页面暂无视频", cls: "" },
  idle: { text: "等待视频", cls: "" },
  off: { text: "未启用", cls: "" },
  blocked: { text: "无法启用", cls: "err" },
  csp: { text: "被站点 CSP 限制", cls: "err" },
  "sdk-missing": { text: "缺少音效引擎", cls: "err" },
  "cross-origin": { text: "媒体受跨域保护，已跳过", cls: "warn" },
  owned: { text: "音频已被页面占用", cls: "err" },
  silent: { text: "拿不到音频数据", cls: "err" },
  "no-ack": { text: "音效线程未响应", cls: "err" },
  suspend: { text: "音频被浏览器挂起", cls: "err" },
  closed: { text: "音频上下文已被关闭", cls: "err" },
  error: { text: "发生错误", cls: "err" },
};

let tab = null;
let host = "";
let supported = true;
let pollTimer = 0;

async function init() {
  $("version").textContent = chrome.runtime.getManifest().version;

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = tabs[0] || null;

  if (tab && tab.url) {
    try {
      const url = new URL(tab.url);
      supported = url.protocol === "http:" || url.protocol === "https:";
      host = url.host;
    } catch (e) {
      supported = false;
    }
  } else {
    supported = false;
  }

  if (!supported) {
    $("host").textContent = "当前页面不支持";
    $("site-toggle").disabled = true;
    $("global-toggle").disabled = true;
    $("reapply").disabled = true;
    setStatus("off", "只能在普通网页（http / https）上启用");
    return;
  }

  $("host").textContent = host;

  const settings = await chrome.storage.local.get({ globalEnabled: true, sites: {} });
  $("site-toggle").checked = (settings.sites || {})[host] === true;
  $("global-toggle").checked = settings.globalEnabled !== false;

  $("site-toggle").addEventListener("change", onSiteToggle);
  $("global-toggle").addEventListener("change", onGlobalToggle);
  $("reapply").addEventListener("click", onReapply);
  $("reload").addEventListener("click", () => tab && chrome.tabs.reload(tab.id));

  await refresh();
  pollTimer = setInterval(refresh, 800);
}

async function onSiteToggle(e) {
  const on = e.target.checked;
  const { sites } = await chrome.storage.local.get({ sites: {} });
  const next = Object.assign({}, sites);
  if (on) next[host] = true;
  else delete next[host];
  await chrome.storage.local.set({ sites: next });
  notifyTab();
  refresh();
}

async function onGlobalToggle(e) {
  await chrome.storage.local.set({ globalEnabled: e.target.checked });
  notifyTab();
  refresh();
}

function notifyTab() {
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: "reapply" }).catch(() => {});
}

function onReapply() {
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: "reapply" }).catch(() => {});
  setTimeout(refresh, 150);
}

async function refresh() {
  if (!supported || !tab) return;

  const settings = await chrome.storage.local.get({ globalEnabled: true, sites: {} });
  const siteOn = (settings.sites || {})[host] === true;
  const globalOn = settings.globalEnabled !== false;

  let summary;
  try {
    summary = await chrome.runtime.sendMessage({ type: "tab-status", tabId: tab.id });
  } catch (e) {
    summary = null;
  }
  if (!summary || !summary.ok) summary = { state: "idle", detail: "", sessions: 0, running: 0, frames: 0 };

  if (!globalOn) {
    setStatus("off", "总开关已关闭，所有网站都不会接管音频");
    $("reload").hidden = true;
    return;
  }
  if (!siteOn) {
    setStatus("off", "打开上面的开关即可接管本页视频音频");
    $("reload").hidden = true;
    return;
  }

  // 开关已开，但页面里还没有扩展在跑：多半是本扩展安装前就已经打开的标签页
  if (!summary.frames) {
    setStatus("warn", "页面需要刷新一次，扩展才能接管音频");
    $("reload").hidden = false;
    return;
  }

  const info = STATUS_TEXT[summary.state] || { text: summary.state, cls: "" };
  let detail = summary.detail || "";
  const counts = [];
  if (summary.sessions) counts.push(`${summary.sessions} 个视频`);
  if (summary.running) counts.push(`${summary.running} 个已生效`);
  if (counts.length) detail = counts.join(" · ") + (detail ? "， " + detail : "");

  setStatus(info.cls, info.text, detail);
  $("reload").hidden = !["owned", "error", "closed"].includes(summary.state);
}

function setStatus(cls, text, detail) {
  const dot = $("dot");
  dot.className = "dot" + (cls ? " " + cls : "");
  $("status-text").textContent = text || "";
  $("detail").textContent = detail || "";

  const badge = $("badge");
  if (cls === "ok") {
    badge.hidden = false;
    badge.textContent = "ON";
    badge.style.background = "";
  } else if (cls === "err") {
    badge.hidden = false;
    badge.textContent = "!";
    badge.style.background = "var(--err)";
  } else {
    badge.hidden = true;
  }
}

window.addEventListener("unload", () => {
  if (pollTimer) clearInterval(pollTimer);
});

init();
