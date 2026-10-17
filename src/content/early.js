/**
 * early.js —— 页面主世界（MAIN world），document_start 注入。
 *
 * 职责只有一个：给「已经被本扩展接管的 <video>」加一层保护。
 *
 * 背景：一个 <video> 在同一个 AudioContext 里只能被 createMediaElementSource()
 * 捕获一次。扩展接管后，如果站点自己的播放器再次调用该方法，Chrome 会抛
 * InvalidStateError，进而把站点自己的初始化流程打断（音效 "消失"、播放器异常
 * 的常见诱因之一）。
 *
 * 这里在原方法上包一层：只有被扩展接管的元素才返回一个静音替身节点，
 * 其余情况原样透传，因此对未启用的站点是完全无副作用的。
 */
(function () {
  "use strict";
  const W = window;
  if (W.__JOYSOUND_NS__) return;

  const NS = {
    version: "1.0.0",
    /** 已被扩展接管的媒体元素 */
    owned: new WeakSet(),
    /** 原版 createMediaElementSource，扩展自己要用 */
    originalCreateMediaElementSource: null,
    patched: false,
  };

  const Proto = (W.AudioContext || W.webkitAudioContext || {}).prototype;
  if (Proto && typeof Proto.createMediaElementSource === "function") {
    const original = Proto.createMediaElementSource;
    NS.originalCreateMediaElementSource = original;
    Proto.createMediaElementSource = function createMediaElementSource(element) {
      if (NS.owned.has(element)) {
        // 站点想再次捕获同一元素：给它一个静音节点，让它自己的代码继续跑。
        try {
          return this.createGain();
        } catch (e) {
          /* 上下文已关闭等异常情况，退回原始实现 */
        }
      }
      const node = original.call(this, element);
      // 扩展自己的 AudioContext 会带上 __joysound 标记：在捕获的同一瞬间
      // 就把元素登记为已接管，避免「扩展刚捕获 / 站点又捕获」之间出现空窗。
      if (this.__joysound) NS.owned.add(element);
      return node;
    };
    NS.patched = true;
  }

  Object.defineProperty(W, "__JOYSOUND_NS__", {
    value: NS,
    configurable: true,
    enumerable: false,
  });
})();
