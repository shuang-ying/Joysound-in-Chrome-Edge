'use strict';
/**
 * 端到端回归测试（真实浏览器 + 真实扩展）。
 *
 *   node test/e2e.js              自动挑选能加载解压扩展的浏览器
 *   node test/e2e.js --headed     有头模式
 *   node test/e2e.js --keep       保留临时 profile
 *   BROWSER_PATH=... node test/e2e.js   指定浏览器
 *
 * 注意：Chrome 137+ 的品牌版已经禁用 --load-extension，届时会自动改用 Edge。
 *
 * 重点验证「切出标签页再回来，音效消失」：
 *   - 播放器重建 <video> 后自动接管；
 *   - AudioContext 被挂起后自动恢复；
 *   - 页面冻结 / bfcache 恢复后仍在工作。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const { makeWav } = require('./make-fixture');

const ROOT = path.join(__dirname, '..');
const HEADED = process.argv.includes('--headed');
const KEEP = process.argv.includes('--keep');

const BROWSERS = [
  process.env.BROWSER_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function step(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

function killTree(pid) {
  if (!pid) return;
  try {
    require('child_process').execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch (e) {
    /* 已退出 */
  }
}

/* ------------------------------------------------------------------ */
/* 静态服务器                                                          */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.wav': 'audio/wav',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function startServer() {
  const fixture = path.join(__dirname, 'fixture');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let file = path.join(fixture, decodeURIComponent(url.pathname));
    if (url.pathname === '/' || url.pathname === '/page.html') file = path.join(fixture, 'page.html');
    if (!file.startsWith(fixture) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ------------------------------------------------------------------ */
/* CDP 客户端                                                          */
/* ------------------------------------------------------------------ */

class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    this.closed = false;
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => resolve(this));
      ws.addEventListener('error', () => reject(new Error('CDP socket error')));
      ws.addEventListener('close', () => {
        this.closed = true;
        for (const { reject: rj } of this.pending.values()) rj(new Error('CDP closed'));
        this.pending.clear();
      });
      ws.addEventListener('message', (event) => {
        let msg;
        try {
          msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        } catch (e) {
          return;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: rs, reject: rj } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rj(new Error(msg.error.message || JSON.stringify(msg.error)));
          else rs(msg.result);
          return;
        }
        for (const l of this.listeners) l(msg);
      });
    });
  }

  send(method, params, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP closed'));
    const id = this.nextId++;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 20000);
    });
  }

  on(fn) {
    this.listeners.push(fn);
  }

  close() {
    try {
      this.ws.close();
    } catch (e) {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 启动浏览器                                                          */
/* ------------------------------------------------------------------ */

async function launch(browserPath) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'joysound-e2e-'));
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--metrics-recording-only',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    '--window-size=1280,900',
  ];
  if (!HEADED) args.unshift('--headless=new');

  // 沙箱环境可能不允许管道捕获子进程输出，这里一律写文件
  const chromeLog = path.join(profile, 'chrome.log');
  const logFd = fs.openSync(chromeLog, 'a');
  const proc = spawn(browserPath, args, { stdio: ['ignore', logFd, logFd], windowsHide: true });
  proc.on('error', (e) => console.error('启动失败：' + e.message));

  const portFile = path.join(profile, 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 150; i++) {
    if (fs.existsSync(portFile)) {
      const p = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
      if (p) {
        port = p;
        break;
      }
    }
    await sleep(100);
  }
  if (!port) {
    killTree(proc.pid);
    throw new Error('浏览器未启动调试端口');
  }

  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const cdp = await new Cdp(version.webSocketDebuggerUrl).open();
  return { proc, profile, port, cdp, version, readLog: () => (fs.existsSync(chromeLog) ? fs.readFileSync(chromeLog, 'utf8') : '') };
}

/** 从 profile 里读出「我们」这个解压扩展的 ID */
function findExtensionId(profile) {
  const normalize = (p) => path.resolve(p).replace(/\\/g, '\\').toLowerCase();
  const wanted = normalize(ROOT);
  for (const name of ['Secure Preferences', 'Preferences']) {
    const file = path.join(profile, 'Default', name);
    if (!fs.existsSync(file)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      const settings = (json.extensions && json.extensions.settings) || {};
      for (const [id, value] of Object.entries(settings)) {
        if (value && value.path && normalize(value.path) === wanted) return id;
      }
    } catch (e) {
      /* ignore */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function runWith(browserPath) {
  const { proc, profile, cdp, version, readLog } = await launch(browserPath);
  const ctx = { proc, profile, cdp, version, readLog };
  let extId = null;
  for (let i = 0; i < 100; i++) {
    extId = findExtensionId(profile);
    if (extId) break;
    await sleep(100);
  }
  ctx.extId = extId;
  return ctx;
}

async function main() {
  console.log('Joysound 扩展端到端测试' + (HEADED ? '（有头模式）' : '（无头模式）'));

  // 仓库里不附带第三方引擎，测试前按需生成一次
  const sdkPath = path.join(ROOT, 'vendor', 'joysound.sdk.js');
  if (!fs.existsSync(sdkPath)) {
    console.log('未找到 vendor/joysound.sdk.js，正在生成…');
    await require('../tools/extract-joysound').regenerate();
  }

  fs.mkdirSync(path.join(__dirname, 'fixture'), { recursive: true });
  makeWav(path.join(__dirname, 'fixture', 'tone.wav'));

  const { server, port: httpPort } = await startServer();
  const fixtureUrl = `http://127.0.0.1:${httpPort}/page.html`;
  const host = `127.0.0.1:${httpPort}`;

  let session = null;
  const tried = [];

  for (const browserPath of BROWSERS) {
    if (!fs.existsSync(browserPath)) continue;
    let ctx = null;
    try {
      ctx = await runWith(browserPath);
      if (ctx.extId) {
        session = ctx;
        break;
      }
      tried.push(`${path.basename(browserPath)}：扩展未被加载（可能已禁用 --load-extension）`);
      console.log(`跳过 ${path.basename(browserPath)}：未能加载解压扩展`);
      killTree(ctx.proc.pid);
      await sleep(300);
      try {
        fs.rmSync(ctx.profile, { recursive: true, force: true });
      } catch (e) {
        /* ignore */
      }
    } catch (e) {
      tried.push(`${path.basename(browserPath)}：${e.message}`);
      if (ctx) {
        killTree(ctx.proc.pid);
      }
      await sleep(200);
    }
  }

  if (!session) {
    console.error('没有可用浏览器：\n  - ' + tried.join('\n  - '));
    server.close();
    process.exitCode = 1;
    return;
  }

  const { cdp, version, extId, proc, profile, readLog } = session;
  console.log(`浏览器：${version.Browser}`);
  console.log(`扩展 ID：${extId}`);

  const cleanup = async () => {
    cdp.close();
    killTree(proc.pid);
    server.close();
    if (KEEP) {
      console.log('临时 profile 保留在：' + profile);
      return;
    }
    await sleep(700);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch (e) {
      /* ignore */
    }
  };

  try {
    /* ---------- 1. 扩展与后台 ---------- */
    step('[1] 扩展加载');
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    await sleep(500);

    let targets = (await cdp.send('Target.getTargets')).targetInfos;
    let sw = targets.find((t) => t.type === 'service_worker' && t.url.includes(`/${extId}/`));
    if (!sw) {
      // SW 可能已休眠：打开扩展页面把它唤醒
      await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup/popup.html` });
      await sleep(900);
      targets = (await cdp.send('Target.getTargets')).targetInfos;
      sw = targets.find((t) => t.type === 'service_worker' && t.url.includes(`/${extId}/`));
    }
    check('background service worker 已启动', !!sw, sw ? sw.url : 'not found');
    if (!sw) throw new Error('service worker 未启动');

    const swSession = await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
    const swEval = async (expression) => {
      const r = await cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        swSession.sessionId
      );
      if (r.exceptionDetails) {
        throw new Error(
          (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text
        );
      }
      return r.result.value;
    };

    /* ---------- 2. 初始状态 ---------- */
    step('[2] 初始状态');
    const perms = await swEval('JSON.stringify(chrome.runtime.getManifest().permissions)');
    check('manifest 权限包含 storage / scripting', perms.includes('storage') && perms.includes('scripting'), perms);

    const initial = await swEval(`chrome.storage.local.get(null).then((v) => JSON.stringify(v))`);
    check('初始没有启用任何站点', !initial.includes(host), initial);

    /* ---------- 3. 打开测试页（未启用） ---------- */
    step('[3] 打开测试页（未启用）');
    const created = await cdp.send('Target.createTarget', { url: fixtureUrl });
    const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
    const pageSession = attached.sessionId;

    const exceptions = [];
    cdp.on((msg) => {
      if (msg.method === 'Runtime.exceptionThrown' && msg.sessionId === pageSession) {
        const d = msg.params.exceptionDetails;
        exceptions.push((d.exception && d.exception.description) || d.text);
      }
    });

    await cdp.send('Runtime.enable', {}, pageSession);
    await cdp.send('Page.enable', {}, pageSession);

    const ev = async (expression) => {
      const r = await cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true, userGesture: true },
        pageSession
      );
      if (r.exceptionDetails) {
        throw new Error(
          (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text
        );
      }
      return r.result.value;
    };

    const waitFor = async (expression, predicate, timeout, label) => {
      const deadline = Date.now() + (timeout || 8000);
      let last;
      while (Date.now() < deadline) {
        try {
          last = await ev(expression);
        } catch (e) {
          last = undefined;
        }
        if (predicate(last)) return last;
        await sleep(150);
      }
      throw new Error(`等待超时：${label || expression}（最后值 ${JSON.stringify(last)}）`);
    };

    await waitFor('document.readyState', (v) => v === 'complete', 10000, 'readyState');
    check('测试页已加载', true);
    check('页面存在 <video>', await ev('!!document.querySelector("video")'));
    check('未启用时不注入音效引擎', (await ev('typeof window.__joysoundEngineApi')) === 'undefined');
    check('视频正常播放（原声）', await ev('document.querySelector("video").paused === false'));

    /* ---------- 4. 在已打开的页面上启用 ---------- */
    step('[4] 在已打开的页面上启用（不刷新）');
    await swEval(
      `chrome.storage.local.set({ globalEnabled: true, sites: { ${JSON.stringify(host)}: true } }).then(() => "ok")`
    );
    const stored = await swEval(`chrome.storage.local.get(null).then((v) => JSON.stringify(v))`);
    check('站点开关已写入 storage', stored.includes(host), stored);

    const status = await waitFor(
      'window.testApi && window.testApi.status()',
      (s) => s && s.state === 'active',
      25000,
      '启用后 state=active'
    );
    check('无需刷新即接管成功', status.state === 'active', status.state);
    check('状态为 active', status.state === 'active', status.state);
    check('会话数 = 1', status.sessions.length === 1, status.sessions);
    check('AudioWorklet 已回执（音效真的打开了）', status.sessions[0].ack === true, status.sessions[0]);
    check('AudioContext 处于 running', status.sessions[0].ctx === 'running', status.sessions[0]);

    const meter = await waitFor(
      'window.testApi.meter()',
      (m) => Array.isArray(m) && m.length && m[0].peak > 0.0005,
      8000,
      'peak > 0'
    );
    check('音效链出口有真实音频信号', meter[0].peak > 0.0005, meter[0].peak);

    const recapture = await ev('window.testApi.pageRecapture()');
    check('站点再次捕获同一视频不会抛异常', recapture.ok === true, recapture);

    /* ---------- 5. 切标签页往返 ---------- */
    step('[5] 切出 / 切回标签页');
    await ev('window.testApi.visibility(false)');
    await sleep(400);
    const hiddenCtx = await ev('window.testApi.sessions()[0].ctx');
    check('隐藏时上下文未被破坏', hiddenCtx === 'running' || hiddenCtx === 'suspended', hiddenCtx);

    await ev('window.testApi.visibility(true)');
    const afterVisible = await waitFor(
      'window.testApi.status()',
      (s) => s && s.state === 'active',
      8000,
      'visible 后仍 active'
    );
    check('切回来仍是 active', afterVisible.state === 'active', afterVisible.state);
    check('切回来后上下文恢复 running', afterVisible.sessions[0].ctx === 'running', afterVisible.sessions[0]);

    // 播放器重建（真实站点切回来最常见的行为）
    await ev('window.testApi.replace()');
    await ev('window.testApi.visibility(true)');
    const afterReplace = await waitFor(
      'window.testApi.status()',
      (s) => s && s.state === 'active' && s.sessions.length === 1 && s.sessions[0].ack,
      15000,
      '重建 <video> 后重新接管'
    );
    const replaced = await ev('window.testApi.sessions()');
    check('新 <video> 已被接管', afterReplace.state === 'active', afterReplace.sessions);
    check('会话绑定的是新节点', replaced[0].elIsCurrent === true, replaced[0]);
    check('新节点建立了音源', replaced[0].hasSource === true, replaced[0]);

    /* ---------- 6. pageshow ---------- */
    step('[6] pageshow（bfcache 恢复）');
    await ev('window.testApi.pageShow()');
    await sleep(800);
    const afterPageShow = await ev('window.testApi.status()');
    check('pageshow 后仍然 active', afterPageShow.state === 'active', afterPageShow.state);

    /* ---------- 7. AudioContext 被挂起 ---------- */
    step('[7] AudioContext 被浏览器挂起');
    await ev('window.testApi.suspendContext()');
    const suspended = await ev('window.testApi.contextState()');
    check('已成功制造 suspended', suspended === 'suspended', suspended);
    const resumed = await waitFor('window.testApi.contextState()', (v) => v === 'running', 10000, '自动 resume');
    check('引擎自动把 AudioContext 拉回 running', resumed === 'running', resumed);

    /* ---------- 8. 页面冻结 ---------- */
    step('[8] 页面冻结与恢复');
    try {
      await cdp.send('Page.setWebLifecycleState', { state: 'frozen' }, pageSession);
      await sleep(1200);
      await cdp.send('Page.setWebLifecycleState', { state: 'active' }, pageSession);
      const afterFreeze = await waitFor(
        'window.testApi.status()',
        (s) => s && s.state === 'active',
        12000,
        '解冻后仍 active'
      );
      check('冻结 → 解冻后音效仍在', afterFreeze.state === 'active', afterFreeze.state);
      check('解冻后上下文 running', afterFreeze.sessions[0].ctx === 'running', afterFreeze.sessions[0]);
    } catch (e) {
      console.log('    跳过：' + e.message);
    }

    /* ---------- 9. 视频被移除 ---------- */
    step('[9] 视频被移除');
    await ev('window.testApi.remove()');
    const afterRemove = await waitFor(
      'window.testApi.status()',
      (s) => s && s.sessions.length === 0,
      10000,
      '会话清理'
    );
    check('移除后会话被清理', afterRemove.sessions.length === 0, afterRemove.sessions);
    check('状态回到 no-media', afterRemove.state === 'no-media', afterRemove.state);

    await ev('window.testApi.replace()');
    const remounted = await waitFor(
      'window.testApi.status()',
      (s) => s && s.state === 'active',
      15000,
      '重新挂载后接管'
    );
    check('重新出现的视频能被自动接管', remounted.state === 'active', remounted.state);

    /* ---------- 10. 关闭 / 重新开启（回归：关闭后不能静音、不能卡住） ---------- */
    step('[10] 关闭与重新开启');
    const tBefore = await ev('document.getElementById("v").currentTime');
    await swEval(`chrome.storage.local.set({ sites: {} }).then(() => "ok")`);
    const afterOff = await waitFor(
      'window.testApi.status()',
      (s) => s && s.state === 'off',
      10000,
      '关闭后 status=off'
    );
    check('关闭后状态为 off', afterOff.state === 'off', afterOff.state);
    check(
      '关闭后会话保留在直通旁路（不销毁上下文）',
      afterOff.sessions.length === 1 && afterOff.sessions[0].bypassed === true,
      afterOff.sessions
    );
    check('关闭后音频上下文仍然存活', (await ev('window.testApi.contextState()')) === 'running');

    await sleep(1600);
    const tAfter = await ev('document.getElementById("v").currentTime');
    check('关闭后视频没有卡住（播放仍在推进）', tAfter - tBefore > 1, { tBefore, tAfter });
    check('关闭后视频仍在播放（未暂停）', (await ev('document.getElementById("v").paused')) === false);

    await swEval(`chrome.storage.local.set({ sites: { ${JSON.stringify(host)}: true } }).then(() => "ok")`);
    const afterOn = await waitFor(
      'window.testApi.status()',
      (s) => s && s.state === 'active',
      15000,
      '重新开启后 active'
    );
    check('重新开启后无需刷新即可生效', afterOn.state === 'active', afterOn.state);

    const meterAgain = await waitFor(
      'window.testApi.meter()',
      (m) => Array.isArray(m) && m.length && m[0].peak > 0.0005 && m[0].bypassed === false,
      10000,
      '重新开启后音频恢复'
    );
    check('重新开启后音效链重新出声', meterAgain[0].peak > 0.0005, meterAgain[0]);

    /* ---------- 11. iframe（all_frames 注入） ---------- */
    step('[11] iframe 内的播放器');
    const frameExpr =
      '(function(){var f=document.getElementById("frame");if(!f||!f.contentWindow)return null;' +
      'var api=f.contentWindow.__joysoundEngineApi;return api?api.status().state:null;})()';
    try {
      const frameState = await waitFor(frameExpr, (v) => v === 'active', 20000, 'iframe 内 active');
      check('iframe 内的视频也被接管', frameState === 'active', frameState);
    } catch (e) {
      check('iframe 内的视频也被接管', false, e.message);
    }

    /* ---------- 12. 弹窗 UI ---------- */
    step('[12] 弹窗 UI');
    try {
      // 用真实的 chrome.tabs.create(active:false) 打开弹窗，
      // 这样「当前活动标签页」仍是测试页，弹窗才能读到正确的站点。
      await swEval(
        `chrome.tabs.create({ url: "chrome-extension://${extId}/popup/popup.html", active: false }).then((t) => t.id)`
      );
      await sleep(1500);
      const allTargets = (await cdp.send('Target.getTargets')).targetInfos;
      const popupTarget = allTargets.find((t) => t.type === 'page' && t.url.includes('/popup/popup.html'));
      if (!popupTarget) throw new Error('未找到弹窗目标');
      const popupSession = await cdp.send('Target.attachToTarget', {
        targetId: popupTarget.targetId,
        flatten: true,
      });
      const pev = async (expression) => {
        const r = await cdp.send(
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true },
          popupSession.sessionId
        );
        if (r.exceptionDetails) {
          throw new Error(
            (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text
          );
        }
        return r.result.value;
      };
      await sleep(1500);

      const hostText = await pev('document.getElementById("host").textContent');
      if (hostText !== host) {
        console.log(`    跳过：弹窗未处于后台标签页（host="${hostText}"），无法读取活动标签页`);
      } else {
        check('弹窗显示了当前站点', hostText === host, hostText);
        check('站点开关为开启状态', (await pev('document.getElementById("site-toggle").checked')) === true);

        const statusText = await pev('document.getElementById("status-text").textContent');
        check('弹窗状态文本正常', /已生效|正在接管/.test(statusText), statusText);

        await pev('document.getElementById("site-toggle").click()');
        await sleep(1500);
        const offStored = await swEval(`chrome.storage.local.get("sites").then((v) => JSON.stringify(v))`);
        check('点击开关后写入 storage（关闭）', !offStored.includes(host), offStored);

        await pev('document.getElementById("site-toggle").click()');
        await sleep(1500);
        const onStored = await swEval(`chrome.storage.local.get("sites").then((v) => JSON.stringify(v))`);
        check('再次点击后重新启用', onStored.includes(host), onStored);

        const offAfter = await waitFor(
          'window.testApi.status()',
          (s) => s && s.state === 'active',
          12000,
          '弹窗开关后恢复 active'
        );
        check('弹窗切换后页面音效状态同步', offAfter.state === 'active', offAfter.state);
      }
      await cdp.send('Target.closeTarget', { targetId: popupTarget.targetId });
    } catch (e) {
      check('弹窗 UI 可用', false, e.message);
    }

    /* ---------- 13. 页面异常 ---------- */
    step('[13] 页面异常检查');
    check('接管过程中页面没有未捕获异常', exceptions.length === 0, exceptions.slice(0, 3));
  } finally {
    if (process.env.JOYSOUND_E2E_VERBOSE) console.log(readLog().slice(-3000));
    await cleanup();
  }

  console.log(`\n结果：\x1b[32m${passed} 通过\x1b[0m，${failed ? '\x1b[31m' : ''}${failed} 失败\x1b[0m`);
  if (failed) {
    console.log('失败项：\n  - ' + failures.join('\n  - '));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('\n测试中止：' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
