/**
 * 12345-assist-skill · 通用滑块验证模块（vue slide-verify 拼图缺口型）
 *
 * 策略（2026-10-27 云南实测形成）：
 *  1. 自动尝试：canvas 模板匹配定位缺口（block 拼图图案源自背景缺口处截取，
 *     对背景逐位置做零均值 SAD，最小处即缺口） + dispatchEvent 派发带时间间隔的
 *     mousedown/mousemove/mouseup 人类轨迹（真实 mouse API 在此类组件上事件
 *     会被吞，dispatch 到 document 才触发 Vue 监听）。
 *     注意鼠标位移→拼图位移存在 ~0.93 比例映射，已做补偿。
 *  2. 自动失败（定位存在 ±15px 级误差、叠加比例漂移，不保证一次通过）→
 *     降级人工：headless=false 弹出有头浏览器，用户手动拖滑块（几秒），
 *     脚本轮询等待滑块通过（弹窗消失或目标按钮进入倒计时态）。
 *  3. HITL 标记对 Agent 集成友好：输出 [HITL] 前缀 + 截图路径。
 *
 * 通过判定由调用方传入 judge() 函数（各平台“通过”的表现不同）。
 */

const fs = require("fs");
const path = require("path");

/** 页面内执行：模板匹配定位缺口中心与拼图案初始中心 */
async function analyzeSlider(page) {
  return page.evaluate(() => {
    const bgCanvas = document.querySelector(".slide-verify canvas:not(.slide-verify-block)");
    const blockCanvas = document.querySelector("canvas.slide-verify-block");
    if (!bgCanvas || !blockCanvas) return { error: "滑块canvas未找到" };
    const W = bgCanvas.width, H = bgCanvas.height;
    let gdata;
    try {
      gdata = bgCanvas.getContext("2d").getImageData(0, 0, W, H).data;
    } catch (e) {
      return { error: "背景canvas跨域: " + e.message };
    }
    const bw = blockCanvas.width, bh = blockCanvas.height;
    const bdata = blockCanvas.getContext("2d").getImageData(0, 0, bw, bh).data;
    // 拼图案（非透明像素）的边界与中心偏移
    let pxMin = bw, pxMax = 0, pyMin = bh, pyMax = 0;
    for (let y = 0; y < bh; y++)
      for (let x = 0; x < bw; x++)
        if (bdata[(y * bw + x) * 4 + 3] > 40) {
          if (x < pxMin) pxMin = x;
          if (x > pxMax) pxMax = x;
          if (y < pyMin) pyMin = y;
          if (y > pyMax) pyMax = y;
        }
    const patternCenter = Math.round((pxMin + pxMax) / 2);
    // 模板匹配：零均值 SAD（消除缺口遮罩整体变暗的影响），步长2加速
    let best = null;
    for (let gx = 70; gx + (pxMax - pxMin) <= W; gx += 2) {
      const pairs = [];
      let bSum = 0, gSum = 0;
      for (let y = pyMin; y <= pyMax; y += 2)
        for (let x = pxMin; x <= pxMax; x += 2) {
          const bi = (y * bw + x) * 4;
          if (bdata[bi + 3] < 40) continue;
          const gi = (y * W + gx + (x - pxMin)) * 4;
          const b = (bdata[bi] + bdata[bi + 1] + bdata[bi + 2]) / 3;
          const g = (gdata[gi] + gdata[gi + 1] + gdata[gi + 2]) / 3;
          pairs.push([b, g]);
          bSum += b;
          gSum += g;
        }
      const n = pairs.length || 1;
      let sad = 0;
      const bMean = bSum / n, gMean = gSum / n;
      for (const [b, g] of pairs) sad += Math.abs(b - bMean - (g - gMean));
      const score = sad / n;
      if (!best || score < best.score) best = { x: gx, score };
    }
    return {
      canvasW: W,
      blockCanvasW: bw, // 拼图块canvas像素宽（用于 canvas坐标→屏幕坐标 换算，考虑devicePixelRatio）
      gapCenter: best ? best.x + patternCenter : null, // 缺口中心（canvas坐标）
      patternCenter, // 拼图块【图案】在block canvas内的中心x偏移（canvas坐标）
      score: best ? Math.round(best.score * 10) / 10 : null,
    };
  });
}

/**
 * 滑块拖动（纯 Playwright mouse API + 0.93 位移比例补偿 + 人类轨迹）
 * 2026-10-27 实测：
 *  - 真实 mouse 事件有效（早前误判：mouse.down 后未发生 move 时拼图自然不动）
 *  - dispatchEvent 方案会让页面 JS 挂起，弃用
 *  - 鼠标位移→拼图位移映射 ≈0.93（多组实测：72→67, 123→114, 164→152）
 */
async function dragSlider(page, dxBlock) {
  const dxMouse = Math.round(dxBlock / 0.93); // 比例补偿
  console.log(`[滑块-拖动] dxBlock=${dxBlock} dxMouse=${dxMouse} 定位按钮...`);
  const box = await page.locator(".slide-verify-slider-mask-item").boundingBox();
  if (!box) return { error: "滑块按钮未找到" };
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  console.log(`[滑块-拖动] 按钮(${Math.round(startX)},${Math.round(startY)}) 按下...`);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.waitForTimeout(150);
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const eased = t < 0.7 ? (t / 0.7) * 0.84 : 0.84 + ((t - 0.7) / 0.3) * 0.16; // 先快后缓停
    await page.mouse.move(startX + dxMouse * eased, startY + (Math.random() * 2 - 1), { steps: 1 });
    await page.waitForTimeout(45 + Math.random() * 40);
  }
  console.log(`[滑块-拖动] 移动完成，mouseup...`);
  await page.mouse.move(startX + dxMouse, startY);
  await page.waitForTimeout(150);
  await page.mouse.up();
  console.log(`[滑块-拖动] 完成`);
  return { done: true, dxMouse, dxBlock };
}

/**
 * 滑块完整处理：自动尝试N次 → 失败降级人工（需 headed 浏览器）
 * @param {object} p
 * @param {import('playwright').Page} p.page
 * @param {string} p.label - 展示名（如「获取短信验证码-滑块」）
 * @param {Function} p.isPassed - async () => boolean，平台特定的通过判定
 * @param {number} p.autoTries - 自动尝试次数，默认 2
 * @param {Function} p.humanPrompt - async (msg) => void，人工提示回调（可输出HITL标记）
 */
async function solveSlider({ page, label = "滑块验证", isPassed, autoTries = 2, humanPrompt = null, waitSec = 300, manualOperable = false }) {
  // 等滑块弹出
  const appeared = await page
    .waitForSelector(".slide-verify", { state: "visible", timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return { ok: true, mode: "no-slider" }; // 没弹滑块，无需处理

  // ---- 自动尝试 ----
  const GAP_OFFSET = -12; // 2026-10-27 视觉交叉验证：模板匹配结果系统性偏右约1/4缺口宽（≈12px）
  const withTimeout = (fn, ms, fallback) =>
    Promise.race([Promise.resolve().then(fn), new Promise((r) => setTimeout(() => r(fallback), ms))]);
  for (let i = 1; i <= autoTries; i++) {
    const info = await withTimeout(() => analyzeSlider(page), 8000, { error: "分析超时" });
    if (info.error || info.gapCenter == null) {
      console.log(`[滑块] 第${i}次定位失败: ${info.error || "缺口未识别"}`);
      continue;
    }
    console.log(`[滑块] 第${i}次自动尝试: 缺口中心=${info.gapCenter} 拼图初始中心=${info.patternCenter} (匹配分=${info.score})`);
    const dx = info.gapCenter + GAP_OFFSET - info.patternCenter;
    if (dx <= 0) continue;
    await dragSlider(page, dx);
    // 拖动后页面可能因验证失败进入重置动画（JS繁忙，evaluate会排队），判定加超时保护
    await page.waitForTimeout(2500);
    const passed = await withTimeout(() => isPassed(page), 6000, false);
    if (passed) {
      console.log(`[滑块] 自动通过（第${i}次）`);
      return { ok: true, mode: "auto", tries: i };
    }
    // 失败后组件会重置并刷新新滑块，等它稳定
    await page.waitForTimeout(1200);
    console.log(`[滑块] 第${i}次未通过，${i < autoTries ? "重试" : "转入人工"}`);
  }

  // ---- 人工降级 ----
  // headless 模式下用户无法操作浏览器窗口：直接给出明确指引而非傻等
  if (!manualOperable) {
    const shotFile = await require("./browser").shot(page, "slider_blocked");
    console.log(
      `\n[HITL] 需要人工完成「${label}」滑块验证，但当前为无头模式（headless）无法人工操作。\n` +
      `  截图: ${shotFile}\n` +
      `  解决：请加 --no-headless（或 --headed）参数重新运行本命令，浏览器窗口弹出后\n` +
      `  脚本会自动完成到滑块步骤，您只需拖动滑块对准缺口（几秒），之后流程自动继续。`
    );
    return { ok: false, mode: "headless-blocked", error: "滑块需人工操作，请加 --no-headless 重跑" };
  }
  const shotFile = await require("./browser").shot(page, "slider_manual");
  const msg =
    `\n[HITL] 需要人工完成「${label}」滑块验证\n` +
    `  请在浏览器窗口中手动拖动滑块对准缺口（几秒即可）。\n` +
    `  当前状态截图: ${shotFile}\n` +
    `  脚本将自动等待您完成（最长${Math.round(waitSec / 60)}分钟）...`;
  console.log(msg);
  if (humanPrompt) await humanPrompt(msg, shotFile);

  // 轮询等待人工完成
  const pollCount = Math.max(1, Math.round(waitSec / 3));
  for (let i = 0; i < pollCount; i++) {
    await page.waitForTimeout(3000);
    if (await isPassed()) {
      console.log("[滑块] 人工已完成，继续流程");
      return { ok: true, mode: "manual" };
    }
  }
  return { ok: false, mode: "timeout", error: `等待人工完成滑块超时（${waitSec}s）` };
}

/**
 * 闭环拖动（2026-10-28 新增）：
 * 开环（算好dx一次性拖）受「鼠标→拼图比例漂移 + 缺口定位误差」影响成功率低。
 * 闭环在 mouse.down 后反复读取拼图块实时位置，与目标比对、分段逼近，到位再松手，
 * 从而消除比例漂移与一次性定位误差。目标位置由调用方给定（视觉识别或模板匹配）。
 * @param {import('playwright').Page} page
 * @param {number} dxScreenTarget 拼图块需要移动的【屏幕像素】水平距离（缺口中心x - 拼图块初始中心x）
 */
async function dragSliderClosedLoop(page, dxScreenTarget) {
  const block = page.locator("canvas.slide-verify-block");
  const btn = await page.locator(".slide-verify-slider-mask-item").boundingBox();
  const initBox = await block.boundingBox();
  if (!btn || !initBox) return { error: "滑块按钮或拼图块未找到" };
  const startMouseX = btn.x + btn.width / 2;
  const startY = btn.y + btn.height / 2;
  const targetCenterX = initBox.x + initBox.width / 2 + dxScreenTarget;
  let mouseX = startMouseX;
  await page.mouse.move(startMouseX, startY);
  await page.mouse.down();
  await page.waitForTimeout(120);
  let converged = false;
  for (let i = 0; i < 40; i++) {
    const b = await block.boundingBox().catch(() => null);
    if (!b) break;
    const curCenter = b.x + b.width / 2;
    const remaining = targetCenterX - curCenter;
    if (Math.abs(remaining) <= 3) {
      converged = true;
      break;
    }
    // 鼠标与拼图块同向移动，比例不必精确（闭环会收敛）；每步走剩余的55%避免过冲
    mouseX += remaining * 0.55;
    await page.mouse.move(mouseX, startY + (Math.random() * 2 - 1), { steps: 3 });
    await page.waitForTimeout(55 + Math.random() * 45);
  }
  await page.waitForTimeout(120);
  await page.mouse.up();
  console.log(`[滑块-闭环] 拖动结束 converged=${converged}`);
  return { done: true, converged };
}

/**
 * 视觉识别模式（2026-10-28 新增，Agent 集成首选，天然适配移动端）：
 * 脚本截图滑块并写出 meta（拼图块初始中心屏幕x），随后 watch `gap_x.txt`；
 * Agent 用多模态视觉读图，把【缺口中心在截图中的x像素】写入 `gap_x.txt`；
 * 脚本读到后换算 dxScreen 并闭环拖动。全程无需用户操作浏览器。
 * 识别比脚本内模板匹配更准，闭环比开环更稳，两者结合显著提高自动通过率。
 *
 * @param {object} p
 * @param {import('playwright').Page} p.page
 * @param {string} p.label 展示名
 * @param {Function} p.isPassed async ()=>boolean 平台通过判定
 * @param {string} p.visionDir 视觉交互目录（截图/meta/gap_x.txt 均在此）
 * @param {number} p.waitSec 等待 Agent 写坐标超时（默认180s）
 * @param {Function} p.onRequest 可选回调 fn(msg, shotFile, meta)，用于 Agent 推送提醒
 */
async function solveSliderVision({ page, label = "滑块验证", isPassed, visionDir, waitSec = 180, onRequest = null }) {
  const appeared = await page
    .waitForSelector(".slide-verify", { state: "visible", timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return { ok: true, mode: "no-slider" };

  fs.mkdirSync(visionDir, { recursive: true });
  const gapFile = path.join(visionDir, "gap_x.txt");
  const shotFile = path.join(visionDir, "slider_vision.png");
  const metaFile = path.join(visionDir, "slider_meta.json");
  const withTimeout = (fn, ms, fb) => Promise.race([Promise.resolve().then(fn), new Promise((r) => setTimeout(() => r(fb), ms))]);

  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.waitForSelector("canvas.slide-verify-block", { state: "visible", timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(600);
    const block = page.locator("canvas.slide-verify-block");
    const bb = await block.boundingBox().catch(() => null);
    if (!bb) return { ok: false, mode: "error", error: "拼图块未找到" };
    const blockInitCenterX = bb.x + bb.width / 2;
    await page.screenshot({ path: shotFile, fullPage: false });
    // 脚本模板匹配先算出缺口候选屏幕x，供 Agent 视觉参考/微调（Agent 不必凭空目测像素，更准）
    let info = null;
    let tmplGapScreenX = null;
    try {
      info = await withTimeout(() => analyzeSlider(page), 8000, null);
      const bgBox = await page.locator(".slide-verify canvas:not(.slide-verify-block)").boundingBox().catch(() => null);
      if (info && info.gapCenter != null && bgBox && info.canvasW) {
        tmplGapScreenX = Math.round(bgBox.x + info.gapCenter * (bgBox.width / info.canvasW));
      }
    } catch {}
    const meta = { blockInitCenterX, blockW: bb.width, tmplGapScreenX, shotFile, attempt };
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    try { fs.unlinkSync(gapFile); } catch {}
    const msg =
      `\n[HITL-VISION] 请Agent识别「${label}」缺口位置（第${attempt}次）\n` +
      `  截图: ${shotFile}\n` +
      `  拼图块初始中心屏幕x = ${blockInitCenterX}\n` +
      (tmplGapScreenX != null ? `  脚本模板匹配缺口候选x = ${tmplGapScreenX}（供参考/微调）\n` : "") +
      `  请将【缺口中心在截图中的x像素】(纯数字)写入: ${gapFile}\n` +
      `  脚本等待最长${waitSec}s...`;
    console.log(msg);
    if (onRequest) await onRequest(msg, shotFile, meta);

    const deadline = Date.now() + waitSec * 1000;
    let gapX = null;
    while (Date.now() < deadline) {
      if (fs.existsSync(gapFile)) {
        const v = parseFloat(fs.readFileSync(gapFile, "utf8").trim());
        if (isFinite(v)) { gapX = v; break; }
      }
      await page.waitForTimeout(1000);
    }
    if (gapX == null) return { ok: false, mode: "vision-timeout", error: "等待Agent视觉坐标超时" };

    // 关键：对齐应以拼图块【图案】中心为准，而非 block canvas 元素中心（图案在canvas内常不居中）。
    // 闭环目标是把 canvas 中心拖到 gapX + (canvasW/2 - patternCenterScreen)，此处通过 dxScreen 补偿。
    const bcw = info && info.blockCanvasW ? info.blockCanvasW : bb.width;
    const patternCenterScreen = info && info.patternCenter != null ? info.patternCenter * (bb.width / bcw) : bb.width / 2;
    const patternInitScreenX = bb.x + patternCenterScreen; // 拼图块图案初始中心屏幕x
    const dxScreen = gapX - patternInitScreenX;
    console.log(
      `[滑块-视觉] 缺口x=${gapX} 图案初始中心x=${Math.round(patternInitScreenX)} (canvas中心x=${blockInitCenterX}, 图案偏移=${Math.round(patternCenterScreen - bb.width / 2)}) → dxScreen=${Math.round(dxScreen)}`
    );
    if (dxScreen <= 0) return { ok: false, mode: "error", error: "视觉坐标异常(dx<=0)" };
    await dragSliderClosedLoop(page, dxScreen);
    await page.waitForTimeout(2500);
    const passed = await withTimeout(() => isPassed(page), 6000, false);
    if (passed) {
      console.log(`[滑块] 视觉+闭环 自动通过（第${attempt}次）`);
      return { ok: true, mode: "vision", tries: attempt };
    }
    console.log(`[滑块] 第${attempt}次视觉尝试未通过，${attempt < 2 ? "重新识别" : "结束"}`);
    await page.waitForTimeout(1200);
  }
  return { ok: false, mode: "vision-failed", error: "视觉闭环两次未通过" };
}

module.exports = { solveSlider, analyzeSlider, dragSlider, dragSliderClosedLoop, solveSliderVision };
