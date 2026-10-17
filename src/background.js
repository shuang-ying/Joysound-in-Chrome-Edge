/**
 * background.js —— MV3 service worker。
 *
 * 只做三件事：
 *   1. 按需把 vendor/joysound.sdk.js + src/content/engine.js 注入到某个 frame 的主世界
 *      （用 chrome.scripting 注入可以绕过站点 CSP，且不需要落地 <script> 标签）；
 *   2. 汇总各 frame 上报的运行状态，更新工具栏角标；
 *   3. 开关变化时通知所有标签页重新求值。
 */
"use strict";

const DEFAULTS = { globalEnabled: true, sites: {} };

/** tabId -> frameId -> { host, enabled, status, at } */
const tabFrames = new Map();

const ENGINE_FILES = ["vendor/joysound.sdk.js", "src/content/engine.js"];

/** 引擎文件是否已生成（仓库里不带，需要用户跑一次 tools/extract-joysound.js） */
let sdkReady = null;
async function hasSdk() {
  if (sdkReady !== null) return sdkReady;
  try {
    const res = await fetch(chrome.runtime.getURL(ENGINE_FILES[0]), { cache: "no-store" });
    sdkReady = res.ok;
  } catch (e) {
    sdkReady = false;
  }
  return sdkReady;
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const patch = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (current[key] === undefined) patch[key] = value;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
});

/* ------------------------------------------------------------------ */
/* 状态汇总 / 角标                                                      */
/* ------------------------------------------------------------------ */

function liveFrames(tabId) {
  const frames = tabFrames.get(tabId);
  if (!frames) return [];
  const now = Date.now();
  const out = [];
  for (const [frameId, entry] of frames) {
    if (now - entry.at > 10000) {
      frames.delete(frameId);
      continue;
    }
    out.push({ frameId, ...entry });
  }
  return out;
}

function summarize(tabId) {
  const frames = liveFrames(tabId);
  const enabledFrames = frames.filter((f) => f.enabled);
  const sessions = [];
  for (const frame of enabledFrames) {
    const status = frame.status;
    if (!status) continue;
    (status.sessions || []).forEach((s) => sessions.push(s));
  }

  const states = enabledFrames.map((f) => (f.status ? f.status.state : null)).filter(Boolean);
  let state = "off";
  if (enabledFrames.length) {
    if (states.includes("active")) state = "active";
    else if (states.includes("pending")) state = "pending";
    else if (states.includes("no-media")) state = "no-media";
    else if (states.length) state = states[0];
    else state = "pending";
  }

  const detailFrame = enabledFrames.find((f) => f.status && f.status.state === state);
  return {
    state,
    enabled: enabledFrames.length > 0,
    frames: enabledFrames.length,
    sessions: sessions.length,
    running: sessions.filter((s) => s.ack).length,
    detail: (detailFrame && detailFrame.status && detailFrame.status.detail) || "",
  };
}

async function updateBadge(tabId) {
  const summary = summarize(tabId);
  let text = "";
  let color = "#3d8b5f";
  if (summary.state === "active") text = "ON";
  else if (summary.state === "pending") text = "…";
  else if (summary.state === "no-media" || summary.state === "idle" || summary.state === "cross-origin") text = "";
  else if (summary.state !== "off") {
    text = "!";
    color = "#b4541f";
  }
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch (e) {
    /* 标签页可能已关闭 */
  }
}

/* ------------------------------------------------------------------ */
/* 注入引擎                                                             */
/* ------------------------------------------------------------------ */

async function injectEngine(tabId, frameId) {
  if (!(await hasSdk())) {
    return { ok: false, error: "sdk-missing" };
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: "MAIN",
      injectImmediately: true,
      files: ENGINE_FILES,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ------------------------------------------------------------------ */
/* 消息                                                                 */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "ensure-engine") {
    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false, error: "no-tab" });
      return;
    }
    injectEngine(tabId, sender.frameId ?? 0).then(sendResponse);
    return true;
  }

  if (msg.type === "frame-status") {
    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId === "number") {
      if (!tabFrames.has(tabId)) tabFrames.set(tabId, new Map());
      tabFrames.get(tabId).set(sender.frameId ?? 0, {
        host: (msg.payload && msg.payload.host) || "",
        enabled: !!(msg.payload && msg.payload.enabled),
        status: (msg.payload && msg.payload.status) || null,
        at: Date.now(),
      });
      updateBadge(tabId);
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "tab-status") {
    const tabId = msg.tabId;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false });
      return;
    }
    // 顺手催一下各 frame 上报，减少过期数据
    chrome.tabs.sendMessage(tabId, { type: "push-status" }).catch(() => {});
    setTimeout(() => sendResponse({ ok: true, ...summarize(tabId) }), 120);
    return true;
  }
});

/* ------------------------------------------------------------------ */
/* 生命周期                                                             */
/* ------------------------------------------------------------------ */

chrome.tabs.onRemoved.addListener((tabId) => tabFrames.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && info.url) tabFrames.delete(tabId);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!changes.globalEnabled && !changes.sites) return;
  chrome.tabs.query({}).then((tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: "settings-changed" }).catch(() => {});
    }
  });
});
