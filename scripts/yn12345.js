#!/usr/bin/env node
/**
 * 云南 12345 一键诉求助手 · 统一入口
 *
 * 一条命令跑完「定地点 → 写内容 → 填表」，把预览单和确认卡交给用户；
 * 用户明确确认后才提交（闸门硬性，不可跳过）。
 *
 * 用法：
 *   # ① 一键：路由+起草+预填（默认不提交）
 *   node scripts/yn12345.js run --text "昆明市五华区人民中路128号工地夜里施工" \
 *        --facts facts.json --phone 13800138000 --district 五华区
 *
 *   # ② 用户确认后提交（--submit 表示确认并立即提交）
 *   node scripts/yn12345.js confirm --id Y-xxxx --by 王大爷 --submit
 *
 *   # ③ 或者：run 时挂起等确认（单进程、单浏览器会话，真正的「一键」）
 *   node scripts/yn12345.js run ... --wait-confirm
 *   #    Agent 侧只需把 "CONFIRM:王大爷" 写入 state/pending/Y-xxxx.confirm
 *
 *   # ④ 已确认但未提交的预览单，补提交
 *   node scripts/yn12345.js submit --id Y-xxxx
 *
 *   node scripts/yn12345.js query  --code 受理编号 --phone 13800138000
 *   node scripts/yn12345.js pending [--all]
 *   node scripts/yn12345.js doctor
 */
const fs = require("fs");
const readline = require("readline");

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || "help";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function help() {
  console.log(`
云南 12345 一键诉求助手

  run       一键：定地点 → 写正文 → 填表 → 出确认卡（默认不提交）
            --text "描述" | --facts facts.json
            --phone 138... [--name 张三] [--district 五华区|"昆明市/五华区/护国街道"]
            [--address 详细地址] [--compact] [--no-headless]
            [--wait-confirm] 挂起等确认后再提交（真一键）
            [--sms-code 123456 | --sms-code-file <文件>] [--slider-vision-dir <目录>]
            [--wait-sec 900]  --fill-anyway 要素不全也先填表看效果

  confirm   用户确认：--id Y-xxxx --by 王大爷 [--submit] [--note "..."]
  submit    提交已确认的预览单：--id Y-xxxx [--no-headless] [--prefill-only]
  query     查询进度：--code 受理编号 --phone 手机号 [--sms-code ...]
  pending   查看预览单 [--all]
  doctor    环境自检

通用：
  --headless / --no-headless   默认无头；滑块需人工拖动时用 --no-headless
  环境变量 PW_CHROME_PATH      指向本机 Chrome（未下载 Playwright 浏览器时必填）
`);
}

function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += /[\u1100-\u115f\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return w;
}
const padR = (s, n) => String(s) + " ".repeat(Math.max(0, n - displayWidth(s)));

function loadFacts() {
  if (args.facts) {
    if (!fs.existsSync(args.facts)) throw new Error("--facts 文件不存在: " + args.facts);
    return JSON.parse(fs.readFileSync(args.facts, "utf8"));
  }
  if (args.json) {
    if (args.json === true) throw new Error("--json 需要 JSON 字符串，或改用 --facts 文件");
    return JSON.parse(args.json);
  }
  return {};
}

/** 预填：开向导 + 填留言页 + 截图，返回会话（浏览器不关，供后续提交复用） */
async function prefill(payload, { headless }) {
  const pf = require("./lib/platform");
  const { browser, page } = await pf.openWizard({
    name: payload.name,
    gender: payload.gender,
    phone: payload.phone,
    headless,
  });
  try {
    const r = await pf.fillMessage(page, payload);
    const shotFile = await shotOf(page, "prefilled");
    return { browser, page, shot: shotFile, districtValue: r.districtValue, districtComplete: r.complete };
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}

async function shotOf(page, name) {
  return require("./lib/browser").shot(page, name);
}

function printPreview(rec) {
  const ap = require("./lib/approval");
  const rows = ap.previewTable(rec);
  const w = Math.max(...rows.map((r) => displayWidth(r[0])), 8) + 2;
  console.log("\n[预览] 以下内容已填入表单，但【尚未提交】：");
  for (const [k, v] of rows) console.log("  " + padR(k, w) + v);
  const body = rec.payload.content || "";
  console.log("\n  ---- 正文全文（平台收到的原文）----");
  body.split("\n").forEach((l) => console.log("  " + l));
  console.log(`  ---- 正文结束，共 ${[...body].length} 字 ----`);
  if (rec.screenshot) console.log(`\n[截图] ${rec.screenshot}`);
}

/** 等待确认：state/pending/<id>.confirm 内容为 CONFIRM 或 CONFIRM:<确认人>；TTY 下也接受终端输入 */
function waitForConfirm(id, timeoutSec) {
  const ap = require("./lib/approval");
  const file = ap.confirmPath(id);
  let stdinLine = null;
  let rl = null;
  if (process.stdin.isTTY) {
    rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (l) => (stdinLine = l.trim()));
  }
  console.log(
    `\n[等待确认] 需要用户明确同意后才能提交。\n` +
      `  ▶ Agent 场景：把 "CONFIRM:<确认人>" 写入 ${file}\n` +
      `  ▶ 终端场景：直接输入 CONFIRM 回车\n` +
      `  ▶ 最长等待 ${timeoutSec >= 60 ? Math.round(timeoutSec / 60) + " 分钟" : timeoutSec + " 秒"}，超时将保留预览单并退出（不提交）`
  );
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutSec * 1000;
    const timer = setInterval(() => {
      let matched = null;
      if (fs.existsSync(file)) {
        const sig = ap.parseConfirmSignal(fs.readFileSync(file, "utf8"));
        if (sig.ok) matched = sig.by;
      }
      if (matched === null && stdinLine !== null) {
        const sig = ap.parseConfirmSignal(stdinLine);
        if (sig.ok) matched = sig.by;
      }
      if (matched !== null) {
        clearInterval(timer);
        if (rl) rl.close();
        resolve(matched || "用户（终端/文件确认）");
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        if (rl) rl.close();
        resolve(null);
      }
    }, 1000);
  });
}

/** 提交已确认的预览单：新开浏览器重新填表（内容取自预览单，哈希一致才放行） */
async function submitPending(rec, { headless, smsCode, smsCodeFile, sliderVisionDir, smsWaitSec, prefillOnly }) {
  const ap = require("./lib/approval");
  const pf = require("./lib/platform");
  ap.verifyApproval({ payload: rec.payload, approval: rec.id });
  console.log(`[审批] 已核验确认记录 ${rec.id}（${rec.approval.by} 于 ${rec.approval.at} 确认）`);

  const { browser, page } = await pf.openWizard({
    name: rec.payload.name,
    gender: rec.payload.gender,
    phone: rec.payload.phone,
    headless,
  });
  try {
    const f = await pf.fillMessage(page, rec.payload);
    if (!f.complete) {
      console.log("[警告] 区划未自动选到叶子，提交环节将提示人工点选（建议下次给出完整路径）");
    }
    if (prefillOnly) {
      const s = await shotOf(page, "refilled");
      console.log(`[仅预填] 已重新填表并截图（未点提交、未请求短信）: ${s}`);
      return { prefillOnly: true, shot: s };
    }
    const r = await pf.submitCurrent(page, { smsCode, smsCodeFile, sliderVisionDir, headless, smsWaitSec });
    ap.consume(rec.id);
    return r;
  } finally {
    await browser.close().catch(() => {});
  }
}

(async () => {
  try {
    if (cmd === "help" || cmd === "--help") return help();

    if (cmd === "doctor") {
      console.log("node:", process.version);
      try {
        require("playwright");
        console.log("playwright: OK");
      } catch (e) {
        console.log("playwright: 未安装（run/submit/query 需要，先 npm install playwright）");
      }
      const chrome = process.env.PW_CHROME_PATH;
      console.log("PW_CHROME_PATH:", chrome ? (fs.existsSync(chrome) ? chrome : chrome + "（不存在！）") : "(未设置，走 Playwright 自带浏览器)");
      const d = require("./lib/route").DATA;
      console.log(`区划数据: ${d.cities.length} 个州市`);
      const ap = require("./lib/approval");
      console.log(`待处理预览单: ${ap.listPending().length} 个`);
      return;
    }

    if (cmd === "pending") {
      const ap = require("./lib/approval");
      const list = ap.listPending({ all: !!args.all });
      if (!list.length) return console.log("[预览单] 无（先跑 run）");
      list.forEach((r) =>
        console.log(`${r.id}  ${String(r.status).padEnd(9)} ${r.createdAt}  ${r.approval ? "已确认 by " + r.approval.by : "待确认"}  ${r.payload.district || ""}`)
      );
      return;
    }

    if (cmd === "confirm") {
      const ap = require("./lib/approval");
      if (!args.id) throw new Error("缺少 --id Y-xxxx（run 输出的预览单号）");
      const rec = ap.approvePending(args.id, { by: args.by, note: args.note });
      console.log(`[已确认] ${rec.id}  by ${rec.approval.by}  at ${rec.approval.at}`);
      console.log(`[内容哈希] ${rec.hash.slice(0, 16)}…（提交时逐字比对，内容一改即失效）`);
      if (!args.submit) {
        console.log(`[下一步] 提交：node scripts/yn12345.js submit --id ${rec.id}`);
        return;
      }
      const r = await submitPending(rec, {
        headless: !(args.noHeadless || args.headed),
        smsCode: args.smsCode,
        smsCodeFile: args.smsCodeFile,
        sliderVisionDir: args.sliderVisionDir,
        smsWaitSec: args.smsWaitSec ? Number(args.smsWaitSec) : undefined,
        prefillOnly: !!args.prefillOnly,
      });
      if (r.prefillOnly) return;
      console.log("[完成] 已提交" + (r.code ? "，受理编号=" + r.code : "（以页面/短信回执为准）"));
      if (r.code) console.log("[提醒] 保存受理编号，查询凭「受理编号 + 提交手机号」");
      return;
    }

    if (cmd === "submit") {
      const ap = require("./lib/approval");
      if (!args.id) throw new Error("缺少 --id Y-xxxx");
      const rec = ap.loadPending(args.id);
      if (!rec) throw new Error(`未找到预览单 ${args.id}`);
      const r = await submitPending(rec, {
        headless: !(args.noHeadless || args.headed),
        smsCode: args.smsCode,
        smsCodeFile: args.smsCodeFile,
        sliderVisionDir: args.sliderVisionDir,
        smsWaitSec: args.smsWaitSec ? Number(args.smsWaitSec) : undefined,
        prefillOnly: !!args.prefillOnly,
      });
      if (r.prefillOnly) return;
      console.log("[完成] 已提交" + (r.code ? "，受理编号=" + r.code : "（以页面/短信回执为准）"));
      return;
    }

    if (cmd === "query") {
      if (!args.code) throw new Error("查询需要 --code 受理编号");
      if (!args.phone) throw new Error("查询需要 --phone（与提交时一致的手机号）");
      const r = await require("./lib/platform").queryAppeal({
        code: args.code,
        phone: args.phone,
        smsCode: args.smsCode,
        smsCodeFile: args.smsCodeFile,
        sliderVisionDir: args.sliderVisionDir,
        headless: !(args.noHeadless || args.headed),
      });
      console.log("[完成] 查询结果截图: " + r.shot);
      if (r.text) {
        console.log("---- 页面文本 ----");
        console.log(r.text.trim().slice(0, 1200));
      }
      return;
    }

    if (cmd === "run") {
      const routeMod = require("./lib/route");
      const composeMod = require("./lib/compose");
      const ap = require("./lib/approval");
      const headless = !(args.noHeadless || args.headed);

      // ---- 1) 定地点（地点线索同时来自 --text 与 facts 文件）----
      const factsInput = loadFacts();
      const placeHints = [
        factsInput.facts && factsInput.facts.place,
        factsInput.place,
        factsInput.address,
        factsInput.district,
      ].filter(Boolean);
      const routeText = [args.text, ...placeHints].filter(Boolean).join(" ");
      const rt = routeMod.route({ text: routeText, city: args.city, district: args.district || factsInput.district });
      console.log(routeMod.format(rt));
      if (rt.status !== "ok") {
        console.log("\n[ASK] 先向用户确认地点，拿到答复后用 --city/--district（或更详细的 --text/--facts）重跑 run。");
        process.exitCode = 2;
        return;
      }

      // ---- 2) 写正文 ----
      factsInput.district = args.district || factsInput.district || rt.leafPath;
      factsInput.phone = args.phone || factsInput.phone;
      factsInput.name = args.name || factsInput.name;
      factsInput.address = args.address || factsInput.address;
      factsInput.compact = !!args.compact;
      if (args.limit) factsInput.limit = Number(args.limit);
      if (!factsInput.facts && args.text) {
        factsInput.facts = { process: args.text };
      }

      const draft = composeMod.compose(factsInput);
      console.log("\n" + composeMod.format(draft));
      if (!factsInput.facts || !(factsInput.facts.place || factsInput.place)) {
        console.log(
          `[提示] 行政区划已确定为 ${rt.leafPath}，但正文还缺「发生地点」。\n` +
            `        请让用户补充具体路段/门牌/小区（这一项同时用于「详细地址」字段，越具体越不容易被退单）。`
        );
      }

      if (!draft.ready && !args.fillAnyway) {
        console.log("\n[ASK] 正文要素不全，先按上面的问题补齐用户信息（或用 --fill-anyway 先填表看效果）。");
        process.exitCode = 2;
        return;
      }
      if (!draft.form.phone) {
        console.log("\n[ASK] 缺少手机号（平台必填，用于接收短信与回执）。请补 --phone。");
        process.exitCode = 2;
        return;
      }

      // ---- 3) 预填 ----
      // 匿名通道：平台姓名栏禁用，姓名固定「匿名」。用户给了真名也如实告知，不静默改写。
      if (draft.form.name && draft.form.name !== "匿名") {
        console.log(`[提示] 云南匿名通道不采集姓名（姓名栏禁用），本次按「匿名」提交；如需实名请走实名认证通道（本技能未覆盖）。`);
      }
      const payload = {
        name: "匿名",
        phone: draft.form.phone,
        district: draft.form.district || rt.leafPath,
        address: draft.form.address,
        content: draft.text,
        isPublic: args.isPublic !== "false",
      };

      console.log("\n[预填] 打开云南 12345 并填写表单（不会提交）…");
      const s = await prefill(payload, { headless });
      if (!s.districtComplete) {
        console.log(
          `[警告] 区划「${payload.district}」未自动选到叶子节点（平台要求末级街道/社区）。\n` +
            `        建议用 --district "昆明市/五华区/护国街道" 形式给出完整路径，或加 --no-headless 人工点选。`
        );
      }

      const rec = ap.createPending({ payload, screenshot: s.shot, meta: { route: rt, draftLen: draft.length } });
      printPreview(rec);
      console.log(
        `\n[待确认] ${rec.id}\n` +
          `  ▶ 把上面的字段、正文全文、截图交给用户，问「确认无误并按此提交吗？」\n` +
          `  ▶ 用户明确同意后：node scripts/yn12345.js confirm --id ${rec.id} --by <用户称呼> --submit\n` +
          `  ▶ 或直接让本进程等确认：run ... --wait-confirm`
      );

      if (!args.waitConfirm) {
        await s.browser.close().catch(() => {});
        console.log("\n[完成] 预填完毕，未提交。");
        return;
      }

      // ---- 4) 挂起等确认 → 同一会话内提交 ----
      const by = await waitForConfirm(rec.id, args.waitSec ? Number(args.waitSec) : 900);
      if (!by) {
        await s.browser.close().catch(() => {});
        console.log(`\n[超时] 未收到确认，已保留预览单 ${rec.id} 且未提交。需要时再 confirm/submit。`);
        process.exitCode = 3;
        return;
      }
      ap.approvePending(rec.id, { by, channel: "wait-confirm" });
      console.log(`[已确认] by ${by}，继续提交…`);
      const r = await require("./lib/platform").submitCurrent(s.page, {
        smsCode: args.smsCode,
        smsCodeFile: args.smsCodeFile,
        sliderVisionDir: args.sliderVisionDir,
        headless,
        smsWaitSec: args.smsWaitSec ? Number(args.smsWaitSec) : undefined,
      });
      await s.browser.close().catch(() => {});
      ap.consume(rec.id);
      console.log("[完成] 已提交" + (r.code ? "，受理编号=" + r.code : "（以页面/短信回执为准）"));
      if (r.code) console.log("[提醒] 保存受理编号；查询凭「受理编号 + 提交手机号」");
      return;
    }

    help();
  } catch (e) {
    console.error("\n[错误] " + e.message);
    if (process.env.DEBUG) console.error(e);
    process.exitCode = 1;
  }
})();
