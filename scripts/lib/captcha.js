/**
 * 12345-assist-skill · HITL 验证码协议（Human-In-The-Loop）
 *
 * 三种工作模式：
 *  A. 交互模式（默认）：截图 -> 终端提示 -> 等待用户在 stdin 输入验证码 -> 回填页面
 *  B. 参数模式：调用方通过 opts.prefilled 直接传入（Agent 集成场景：Agent 先把截图发给
 *     用户，用户在对话里回复，Agent 再带 --captcha 参数重入或通过 stdin 管道喂入）
 *  C. 管道模式：echo "384726" | node 12345.js ... （stdin 非交互时自动读取一行）
 */
const readline = require("readline");

/** 从 stdin 读一行（同时支持 TTY 交互与管道输入） */
function ask(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve((answer || "").trim());
    });
  });
}

/**
 * HITL 验证码获取流程
 * @param {object} p
 * @param {import('playwright').Page} p.page      - 页面对象
 * @param {string} p.label                        - 验证码说明（图形验证码 / 短信验证码）
 * @param {string|null} p.shotFile                - 已有截图路径；传 null 则现场截图
 * @param {string|null} p.prefilled               - 外部已提供答案（跳过人工）
 * @param {number} p.timeoutSec                   - 等待输入超时（默认300秒）
 * @param {Function} p.onAsk                      - Agent集成回调：fn(promptText, shotFile)，可用于推送通知
 * @returns {Promise<string>} 验证码内容
 */
async function humanCaptcha({ page, label = "验证码", shotFile = null, prefilled = null, timeoutSec = 300, onAsk = null }) {
  if (prefilled) {
    console.log(`[HITL] ${label} 已由调用方提供: ${prefilled}`);
    return prefilled;
  }
  if (!shotFile) shotFile = await require("./browser").shot(page, `captcha_${label}`);
  const prompt = `\n[HITL] 需要人工输入「${label}」\n  截图已保存: ${shotFile}\n  请查看图片/手机短信后输入 (超时 ${timeoutSec}s，直接回车=放弃): `;

  if (onAsk) await onAsk(prompt, shotFile); // Agent 集成点：先推送提醒
  console.log(prompt);

  const answer = await Promise.race([
    ask("> "),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`等待 ${label} 输入超时`)), timeoutSec * 1000)),
  ]);
  if (!answer) throw new Error(`用户放弃了 ${label} 输入`);
  return answer;
}

module.exports = { humanCaptcha, ask };
