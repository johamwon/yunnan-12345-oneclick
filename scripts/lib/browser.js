/**
 * 12345-assist-skill · 浏览器管理模块
 * 负责启动 Playwright Chromium、防盗链两跳导航、会话（storageState）持久化与恢复。
 * 会话文件保存在 skill 目录 state/ 下，登录一次可复用数天。
 *
 * 2026-10-27 重要教训（云南实测）：
 *  - 部分平台（如云南 12345lm.www.yn.gov.cn:9001）页面 HTML 需要外层门户 Referer 才放行，
 *    但其静态资源（滑块图片 /images/verifyBackgroud/*.png）的防盗链规则反而拒绝外层门户 Referer。
 *  - 因此【禁止】用 extraHTTPHeaders 全局注入 Referer（会污染静态资源请求 → 滑块图片 403 →
 *    滑块永远无法加载 → 短信验证码永远发不出去）。
 *  - 正确做法是 gotoEntry() 两跳导航：先正常加载入口页（建立自然 Referer 链）再跳转目标系统，
 *    浏览器自动为后续资源携带系统自身域的 Referer，两类防盗链同时满足。
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const STATE_DIR = path.join(__dirname, "..", "..", "state");
const SHOT_DIR = path.join(STATE_DIR, "shots");
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

// 优先使用环境变量指定的 Chrome；否则走 Playwright 默认解析
const EXECUTABLE = process.env.PW_CHROME_PATH || "";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * 启动浏览器并新建页面
 * @param {object} opts
 * @param {string} opts.sessionName - 会话名（storageState 持久化，如 "shanghai"）；不需要会话管理传 null
 * @param {boolean} opts.headless - 默认 true；需要人工拖滑块时传 false（headed 模式）
 */
async function launch({ sessionName = null, headless = true } = {}) {
  const launchOpts = {
    headless,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--lang=zh-CN",
    ],
  };
  if (EXECUTABLE) launchOpts.executablePath = EXECUTABLE;

  const contextOpts = {
    viewport: { width: 1440, height: 900 },
    userAgent: UA,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    // 注意：不使用 extraHTTPHeaders 全局 Referer（见文件头教训说明）
  };

  // 恢复已有会话
  const sessionFile = sessionName ? sessionPath(sessionName) : null;
  if (sessionFile && fs.existsSync(sessionFile)) {
    try {
      contextOpts.storageState = sessionFile;
      console.log(`[会话] 已加载 ${sessionName} 的既有登录态`);
    } catch {
      console.log(`[会话] ${sessionName} 会话文件损坏，忽略`);
    }
  }

  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext(contextOpts);
  // 注入 navigator.webdriver 隐藏
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();
  return { browser, context, page };
}

/**
 * 防盗链两跳导航：先访问入口页建立自然 Referer 链，再跳转目标系统
 * @param {import('playwright').Page} page
 * @param {string} targetUrl - 目标系统 URL
 * @param {string|null} refererUrl - 外层入口页（无防盗链可传 null 直达）
 */
async function gotoEntry(page, targetUrl, refererUrl = null) {
  if (refererUrl) {
    console.log(`[防盗链] 第一跳入口页: ${refererUrl}`);
    await page.goto(refererUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2000);
    console.log(`[防盗链] 第二跳目标系统: ${targetUrl}`);
  }
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
}

/** 保存会话（cookie + localStorage） */
async function saveSession(context, sessionName) {
  if (!sessionName) return;
  const file = sessionPath(sessionName);
  await context.storageState({ path: file });
  console.log(`[会话] 已保存 ${sessionName} 登录态 -> ${path.basename(file)}`);
}

function sessionPath(name) {
  return path.join(STATE_DIR, `${name}_session.json`);
}

/** 判断会话文件是否存在（快速判断是否需要重新登录） */
function hasSession(sessionName) {
  return !!sessionName && fs.existsSync(sessionPath(sessionName));
}

/** 截图工具：返回绝对路径 */
async function shot(page, name) {
  const file = path.join(SHOT_DIR, `${Date.now()}_${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

module.exports = { launch, gotoEntry, saveSession, hasSession, shot, STATE_DIR, SHOT_DIR };
