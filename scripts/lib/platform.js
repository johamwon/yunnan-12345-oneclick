/**
 * 云南 12345 平台操作层（Vue SPA / Element Plus，省门户 iframe 内嵌，双重防盗链）
 *
 * 拆成可分离的三段，供「预填 → 用户确认 → 提交」在同一次浏览器会话里连续执行：
 *   openWizard()    两跳导航 + 关弹窗 + 匿名通道 + 个人信息 → 停在留言页
 *   fillMessage()   区划级联（选到叶子）+ 详细地址 + 反映内容 + 是否公开
 *   submitCurrent() 短信验证码（前置滑块）→ 隐私勾选 → 提交 → 取受理编号
 *
 * 两根必须保留的硬约束（2026-10-27 实测教训）：
 *  1) 【禁止】全局 extraHTTPHeaders 注入 Referer：页面 HTML 需要外层门户 Referer 放行，
 *     但滑块静态资源反而拒绝它（403 → 滑块永远加载不出来 → 短信发不出去）。
 *     正确做法是 gotoEntry() 两跳导航，让浏览器自然携带级联 Referer。
 *  2) 行政区划必须选到【叶子节点】才产生值：Element Plus cascader 默认 checkStrictly=false，
 *     点非叶子只展开不选中；末级可能是街道/社区（滇池度假区下有 27 个小区级叶子）。
 */
const fs = require("fs");
const { launch, gotoEntry, shot } = require("./browser");
const { humanCaptcha } = require("./captcha");
const { solveSlider, solveSliderVision } = require("./slider");

const ENTRY = "https://12345lm.www.yn.gov.cn:9001/pcwebprotal/";
const REF = "https://www.yn.gov.cn/12345/";

const SEL = {
  dialogBtn: ".el-dialog__footer button, .el-overlay button",
  anonymousCard: "text=直接提交",
  pName: 'input[placeholder="请输入您的姓名"]',
  pFemale: 'label:has-text("女")',
  pPhone: 'input[placeholder="请输入您的手机号码"]',
  nextBtn: 'button:has-text("下一步")',
  mDistrict: 'input[placeholder="请选择事件发生地点所属行政区划"]',
  mContent: 'textarea[placeholder*="时间、地点"]',
  mPublicNo: 'label:has-text("不公开")',
  mSms: 'input[placeholder="请输入短信验证码"]',
  mSmsBtn: 'button:has-text("获取短信验证码")',
  mPrivacy: ".el-checkbox__original",
  submitBtn: 'button:has-text("提 交"), button:has-text("提交")',
  // 查询页
  qCode: 'input[placeholder="请输入受理编号"]',
  qPhone: 'input[placeholder="请输入接收验证码的手机号码"]',
  qSms: 'input[placeholder="请输入短信验证码"]',
  qSmsBtn: 'button:has-text("获取短信验证码")',
  qBtn: 'button:has-text("查 询"), button:has-text("查询")',
};

/** 滑块通过判定：短信按钮进入倒计时（"xx秒后重新获取"）或滑块弹窗消失 */
async function smsPassed(page) {
  return page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) => /重新获取|秒后/.test(b.innerText));
    if (btn) return true;
    return !document.querySelector(".verify-dialog");
  });
}

/** 读区划值：选中叶子后 placeholder 被清空，值落在 .el-cascader input.el-input__inner */
async function readDistrictValue(page) {
  return page
    .evaluate(() => {
      const els = Array.from(document.querySelectorAll(".el-cascader input.el-input__inner"));
      for (const el of els) if (el.value && el.value.trim()) return el.value.trim();
      return "";
    })
    .catch(() => "");
}

/** 在最后一个可见菜单列里点节点：先精确匹配再包含匹配，最后退回全局 label */
async function clickCascaderNode(page, text) {
  const menus = page.locator(".el-cascader-menu:visible");
  const cnt = await menus.count().catch(() => 0);
  const scope = cnt > 0 ? menus.nth(cnt - 1) : page.locator(".el-cascader-panel");
  const esc = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exact = scope
    .locator(".el-cascader-node", { has: page.locator(".el-cascader-node__label", { hasText: new RegExp("^" + esc + "$") }) })
    .first();
  let ok = await exact.scrollIntoViewIfNeeded({ timeout: 4000 }).then(() => true).catch(() => false);
  if (ok) {
    ok = await exact.click({ timeout: 6000 }).then(() => true).catch(() => false);
    if (ok) return true;
  }
  const node = scope.locator(".el-cascader-node", { hasText: text }).first();
  ok = await node.scrollIntoViewIfNeeded({ timeout: 4000 }).then(() => true).catch(() => false);
  if (ok) {
    ok = await node.click({ timeout: 6000 }).then(() => true).catch(() => false);
    if (ok) return true;
  }
  const lbl = page.locator(".el-cascader-node__label", { hasText: text }).first();
  await lbl.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
  return lbl.click({ timeout: 6000 }).then(() => true).catch(() => false);
}

/** 逐级点选行政区划，返回是否选到叶子（产生值） */
async function selectDistrict(page, districtPath) {
  const parts = String(districtPath).split(/[/／>\s]+/).filter(Boolean);
  const waitVal = async (timeout) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const v = (await readDistrictValue(page)).trim();
      if (v) return v;
      await page.waitForTimeout(400);
    }
    return "";
  };

  await page.click(SEL.mDistrict);
  await page.waitForSelector(".el-cascader__dropdown, .el-cascader-panel", { state: "visible", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;
    await page.waitForSelector(".el-cascader-node", { state: "visible", timeout: 10000 }).catch(() => {});
    const ok = await clickCascaderNode(page, part);
    const val = await waitVal(isLast ? 9000 : 1500);
    console.log(`[区划] 第${i + 1}级「${part}」点击=${ok} 值=${JSON.stringify(val)}`);
    if (val) {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(500);
      return { value: val, complete: true };
    }
    if (!ok) console.log(`[区划] 未找到节点：${part}`);
    await page.waitForTimeout(400);
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);
  return { value: await waitVal(3000), complete: false };
}

/**
 * 打开向导并走到留言页
 * @returns {{browser, page}}
 */
async function openWizard({ name, gender, phone, headless = true }) {
  const { browser, page } = await launch({ headless });
  try {
    await gotoEntry(page, ENTRY + "submit/certification", REF);
    await page.waitForTimeout(5000);

    const dlg = await page.$(SEL.dialogBtn);
    if (dlg) {
      console.log("[弹窗] 关闭注意事项");
      await dlg.click();
      await page.waitForTimeout(1500);
    }

    console.log("[步骤1] 匿名直接提交");
    await page.click(SEL.anonymousCard, { timeout: 10000 });
    await page.waitForTimeout(3000);

    console.log("[步骤2] 个人信息");
    // 匿名通道下姓名栏是 disabled 的（平台固定为「匿名」），填真名会直接超时
    if (name && name !== "匿名") {
      const disabled = await page.$eval(SEL.pName, (el) => el.disabled).catch(() => true);
      if (disabled) {
        console.log("[个人信息] 匿名通道姓名栏已禁用，按「匿名」提交（如需实名请走实名认证通道，本技能不覆盖）");
      } else {
        await page.fill(SEL.pName, name);
      }
    }
    if (gender === "女") await page.click(SEL.pFemale);
    if (!phone) throw new Error("手机号为必填项（接收短信提醒与验证码）");
    await page.fill(SEL.pPhone, phone);
    await page.click(SEL.nextBtn);
    await page.waitForTimeout(3000);
    return { browser, page };
  } catch (e) {
    await shot(page, "open_error").catch(() => {});
    await browser.close().catch(() => {});
    throw e;
  }
}

/**
 * 填写留言页
 * @returns {{districtValue:string, complete:boolean}}
 */
async function fillMessage(page, { district, address, content, isPublic = true }) {
  let districtValue = "";
  let complete = false;

  if (district) {
    const r = await selectDistrict(page, district);
    districtValue = r.value || "";
    complete = r.complete;
  }
  if (address) {
    const strategies = [
      'input[placeholder*="详细地址"]',
      'input[placeholder*="地址"]',
      '.el-form-item:has-text("详细地址") input.el-input__inner',
      'xpath=//textarea[contains(@placeholder,"时间、地点")]/preceding::input[not(@type="radio") and not(@type="checkbox")][1]',
    ];
    let filled = false;
    for (const sel of strategies) {
      const el = page.locator(sel).first();
      const ok = await el.waitFor({ state: "visible", timeout: 4000 }).then(() => true).catch(() => false);
      if (ok) {
        await el.fill(address);
        filled = true;
        break;
      }
    }
    if (!filled) console.log("[警告] 详细地址框未定位到，需人工补填");
  }
  if (!content) throw new Error("反映内容必填（<=2000字）");
  await page.fill(SEL.mContent, content);
  if (isPublic === false) await page.click(SEL.mPublicNo).catch(() => {});
  return { districtValue, complete };
}

/** 隐私指引勾选：原生 input 被隐藏且移出视口，点可见包裹层 + JS 兜底 */
async function checkPrivacy(page) {
  for (const sel of ['.el-checkbox:has-text("隐私")', '.el-checkbox__label:has-text("隐私")', ".el-checkbox"]) {
    try {
      const el = page.locator(sel).first();
      await el.scrollIntoViewIfNeeded({ timeout: 6000 });
      await el.click({ timeout: 6000 });
      const ok = await page.evaluate(() => {
        const c = document.querySelector(".el-checkbox__original");
        return !!(c && c.checked);
      });
      if (ok) return true;
    } catch (e) {
      // 换下一种策略
    }
  }
  return page.evaluate(() => {
    const c = document.querySelector(".el-checkbox__original");
    if (!c) return false;
    c.click();
    return true;
  });
}

/**
 * 在已停好的留言页上完成：滑块 → 短信码 → 勾选 → 提交 → 读受理编号
 * @param {object} opts {smsCode, smsCodeFile, sliderVisionDir, headless, smsWaitSec, manualDistrictWaitSec}
 */
async function submitCurrent(page, opts = {}) {
  const headless = opts.headless !== false;
  const districtValue = await readDistrictValue(page);

  // 区划没选上：平台会拦「事件地点不可为空」，先给人工补救窗口
  if (!districtValue.trim() && opts.manualDistrictWaitSec !== 0) {
    const s = await shot(page, "district_manual");
    console.log(
      `\n[HITL] 行政区划未选中，需人工点选到最末一级（街道/社区）。\n` +
        `  截图: ${s}\n  脚本等待区划框出现内容（最长 ${Math.round((opts.manualDistrictWaitSec || 180) / 60)} 分钟）…`
    );
    const deadline = Date.now() + (opts.manualDistrictWaitSec || 180) * 1000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(3000);
      if ((await readDistrictValue(page)).trim()) break;
    }
    if (!(await readDistrictValue(page)).trim()) {
      throw new Error("行政区划仍为空——平台会校验失败。已中止，未请求短信，可修好区划路径后重跑。");
    }
  }

  // 滑块（短信验证码前置）
  console.log("[提交] 点击获取短信验证码（先弹滑块）");
  await page.click(SEL.mSmsBtn);
  let slider;
  if (opts.sliderVisionDir) {
    slider = await solveSliderVision({ page, label: "提交-获取短信验证码-滑块", isPassed: () => smsPassed(page), visionDir: opts.sliderVisionDir, waitSec: 600 });
    if (!slider.ok) {
      console.log("[滑块] 视觉模式未通过（" + (slider.error || slider.mode) + "），降级人工");
      slider = await solveSlider({ page, label: "提交-获取短信验证码-滑块", isPassed: () => smsPassed(page), autoTries: 0, manualOperable: !headless });
    }
  } else {
    slider = await solveSlider({ page, label: "提交-获取短信验证码-滑块", isPassed: () => smsPassed(page), autoTries: 3, manualOperable: !headless });
  }
  if (!slider.ok) {
    if (slider.mode === "headless-blocked") throw new Error("滑块未通过且无头模式无法人工拖动——请加 --no-headless 重跑");
    throw new Error(slider.error || "滑块验证未完成");
  }

  // 短信验证码：参数 / 文件监听 / 终端交互
  let sms = opts.smsCode;
  if (!sms && opts.smsCodeFile) {
    const f = opts.smsCodeFile;
    try {
      fs.unlinkSync(f);
    } catch (e) {}
    console.log(`[短信] 已发送至手机，请把 6 位验证码写入文件: ${f}`);
    const deadline = Date.now() + (opts.smsWaitSec || 300) * 1000;
    while (Date.now() < deadline) {
      if (fs.existsSync(f)) {
        const v = fs.readFileSync(f, "utf8").trim();
        if (/^\d{4,8}$/.test(v)) {
          sms = v;
          break;
        }
      }
      await page.waitForTimeout(1000);
    }
    if (!sms) throw new Error(`等待短信码超时（请将验证码写入 ${f}）`);
  }
  if (!sms) {
    console.log("[短信] 已发送，请查收");
    await page.waitForTimeout(2000);
    sms = await humanCaptcha({ page, label: "短信验证码", prefilled: null, timeoutSec: 300 });
  }
  await page.fill(SEL.mSms, sms);

  if (!(await checkPrivacy(page))) console.log("[警告] 隐私指引勾选未确认生效");
  await page.waitForTimeout(500);
  try {
    await page.locator(SEL.submitBtn).first().scrollIntoViewIfNeeded({ timeout: 6000 });
    await page.locator(SEL.submitBtn).first().click({ timeout: 8000 });
  } catch (e) {
    console.log("[警告] 提交按钮首选方案失败，降级重试: " + e.message);
    await page.locator('button:has-text("提交")').first().click({ timeout: 8000 });
  }
  await page.waitForTimeout(6000);

  const finishShot = await shot(page, "submit_finish");
  const body = await page.evaluate(() => document.body.innerText).catch(() => "");
  const m = body.match(/受[理]?编号[：:\s]*([A-Za-z0-9-]{6,})/);
  return { code: m ? m[1] : null, shot: finishShot, text: body.slice(0, 800) };
}

/** 受理进度查询（免登录，受理编号 + 手机号 + 短信码，前置滑块） */
async function queryAppeal({ code, phone, smsCode, smsCodeFile, sliderVisionDir, headless = true }) {
  const { browser, page } = await launch({ headless });
  try {
    await gotoEntry(page, ENTRY, REF);
    await page.waitForTimeout(6000);
    await page.fill(SEL.qCode, code);
    await page.fill(SEL.qPhone, phone);
    console.log("[表单] 受理编号与手机号已填");

    await page.click(SEL.qSmsBtn);
    let slider;
    if (sliderVisionDir) {
      slider = await solveSliderVision({ page, label: "查询-滑块", isPassed: () => smsPassed(page), visionDir: sliderVisionDir, waitSec: 600 });
      if (!slider.ok) slider = await solveSlider({ page, label: "查询-滑块", isPassed: () => smsPassed(page), autoTries: 0, manualOperable: !headless });
    } else {
      slider = await solveSlider({ page, label: "查询-滑块", isPassed: () => smsPassed(page), autoTries: 3, manualOperable: !headless });
    }
    if (!slider.ok) throw new Error(slider.mode === "headless-blocked" ? "滑块未通过且为无头模式，请加 --no-headless" : slider.error || "滑块未完成");

    let sms = smsCode;
    if (!sms && smsCodeFile) {
      const f = smsCodeFile;
      try {
        fs.unlinkSync(f);
      } catch (e) {}
      console.log(`[短信] 请把验证码写入文件: ${f}`);
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        if (fs.existsSync(f)) {
          const v = fs.readFileSync(f, "utf8").trim();
          if (/^\d{4,8}$/.test(v)) {
            sms = v;
            break;
          }
        }
        await page.waitForTimeout(1000);
      }
      if (!sms) throw new Error("等待短信码超时");
    }
    if (!sms) sms = await humanCaptcha({ page, label: "短信验证码", prefilled: null, timeoutSec: 300 });

    await page.fill(SEL.qSms, sms);
    await page.click(SEL.qBtn);
    await page.waitForTimeout(5000);

    const resultShot = await shot(page, "query_result");
    const text = await page.evaluate(() => document.body.innerText.slice(0, 2000)).catch(() => "");
    return { shot: resultShot, text };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { openWizard, fillMessage, submitCurrent, queryAppeal, readDistrictValue, selectDistrict, ENTRY, REF, SEL };
