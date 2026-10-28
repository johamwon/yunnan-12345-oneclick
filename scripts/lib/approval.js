/**
 * 提交前用户确认闸门（云南版）
 *
 * 两阶段：
 *   ① 预填 → 生成预览单 state/pending/P-xxxx.json（字段快照 + 内容哈希 + 截图）
 *   ② 用户确认 → confirm（记录确认人）→ 才允许提交；提交时逐字比对内容哈希
 *
 * 保护点：
 *   - 没有确认记录 → 拒绝提交
 *   - 确认人留痕（--by），写审计日志 state/audit.log
 *   - 确认有效期默认 24h（APPROVAL_TTL_HOURS）
 *   - 内容改动 → 哈希不一致 → 必须重新预填并再确认
 *   - 提交成功即 CONSUMED，同一确认不能二次提交
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STATE_DIR = path.join(__dirname, "..", "..", "state");
const PENDING_DIR = path.join(STATE_DIR, "pending");
const AUDIT_FILE = path.join(STATE_DIR, "audit.log");
const TTL_HOURS = Number(process.env.APPROVAL_TTL_HOURS || 24);

function ensureDirs() {
  for (const d of [STATE_DIR, PENDING_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

/** 规范化序列化：key 排序、剔除空值 → 同一内容得到同一哈希 */
function canonical(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const keys = Object.keys(v)
    .filter((k) => v[k] !== undefined && v[k] !== null && String(v[k]).trim() !== "")
    .sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}

function hashPayload(payload) {
  return crypto.createHash("sha256").update(canonical(payload)).digest("hex");
}

function pendingPath(id) {
  return path.join(PENDING_DIR, `${id}.json`);
}

/** 挂起等待确认用的信号文件（Agent 写入 "CONFIRM:<确认人>" 即放行） */
function confirmPath(id) {
  return path.join(PENDING_DIR, `${id}.confirm`);
}

function newId() {
  return "Y" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex");
}

function audit(entry) {
  try {
    ensureDirs();
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch (e) {
    console.log("[警告] 审计日志写入失败: " + e.message);
  }
}

function createPending({ payload, screenshot, meta }) {
  ensureDirs();
  const id = newId();
  const rec = {
    id,
    createdAt: new Date().toISOString(),
    status: "PENDING",
    hash: hashPayload(payload),
    payload,
    screenshot: screenshot || null,
    meta: meta || {},
    approval: null,
  };
  fs.writeFileSync(pendingPath(id), JSON.stringify(rec, null, 2), "utf8");
  audit({ action: "pending-created", id, hash: rec.hash });
  return rec;
}

function loadPending(ref) {
  if (!ref) return null;
  const cands = [];
  if (/[\\/]/.test(ref) || ref.endsWith(".json")) cands.push(ref);
  cands.push(pendingPath(ref));
  for (const c of cands) {
    if (fs.existsSync(c)) {
      try {
        return JSON.parse(fs.readFileSync(c, "utf8"));
      } catch (e) {
        throw new Error(`预览单损坏，无法解析：${c}`);
      }
    }
  }
  return null;
}

function savePending(rec) {
  fs.writeFileSync(pendingPath(rec.id), JSON.stringify(rec, null, 2), "utf8");
}

function approvePending(id, { by, note, channel } = {}) {
  const name = String(by || "").trim();
  if (!name) throw new Error("必须用 --by 记录确认人（如 --by 王大爷）。这是「用户本人确认」的凭据，不能省略。");
  const rec = loadPending(id);
  if (!rec) throw new Error(`未找到预览单 ${id}。先执行 run 预填，输出里的 [待确认] 即单号。`);
  if (rec.status === "CONSUMED") throw new Error(`预览单 ${rec.id} 已提交过，不能重复确认；如需再次提交请重新预填。`);

  rec.status = "APPROVED";
  rec.approval = { by: name, at: new Date().toISOString(), channel: channel || "agent-chat", note: note || "" };
  savePending(rec);
  audit({ action: "approved", id: rec.id, by: name, hash: rec.hash, note: note || "" });
  return rec;
}

/** 提交前核验；任何一项不满足即抛出可执行说明 */
function verifyApproval({ payload, approval }) {
  if (!approval || approval === true) {
    throw new Error(
      "提交需要用户确认记录。正确顺序：\n" +
        "  1) run 预填（默认只填不提交），得到 [待确认] Y-xxxx 与截图；\n" +
        "  2) 把字段、正文全文、截图交给用户，取得明确的『确认提交』答复；\n" +
        "  3) confirm --id Y-xxxx --by <用户称呼>；\n" +
        "  4) submit --id Y-xxxx（或 confirm 时加 --submit）。\n" +
        "（跳过用户确认直接提交在本技能中被硬性禁止）"
    );
  }
  const rec = loadPending(String(approval));
  if (!rec) throw new Error(`未找到预览单 ${approval}，请确认单号或重新预填。`);
  if (rec.status === "CONSUMED") throw new Error(`预览单 ${rec.id} 已提交过（${rec.consumedAt}），同一确认不能二次提交。`);
  if (!rec.approval || !rec.approval.by) {
    throw new Error(`预览单 ${rec.id} 尚未确认。先向用户出示内容并取得同意，再 confirm --id ${rec.id} --by <用户称呼>。`);
  }
  const ageH = (Date.now() - new Date(rec.approval.at).getTime()) / 3600000;
  if (ageH > TTL_HOURS) {
    throw new Error(`预览单 ${rec.id} 的确认已过期（${ageH.toFixed(1)}h > ${TTL_HOURS}h），请重新预填并再确认。`);
  }
  const h = hashPayload(payload);
  if (h !== rec.hash) {
    throw new Error(
      `提交参数与已确认内容不一致（正文/区划/地址/手机号任一改动都会触发）。\n` +
        `  已确认: ${rec.hash.slice(0, 16)}…\n  本次提交: ${h.slice(0, 16)}…\n` +
        `  请重新 run 预填，把新内容再给用户看一遍并再确认。`
    );
  }
  return rec;
}

function consume(id) {
  const rec = loadPending(id);
  if (!rec) return null;
  rec.status = "CONSUMED";
  rec.consumedAt = new Date().toISOString();
  savePending(rec);
  audit({ action: "consumed", id: rec.id, hash: rec.hash });
  return rec;
}

function listPending({ all = false } = {}) {
  ensureDirs();
  return fs
    .readdirSync(PENDING_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(PENDING_DIR, f), "utf8"));
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean)
    .filter((r) => all || r.status === "PENDING" || r.status === "APPROVED")
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** 确认卡字段（顺序即展示顺序） */
function previewTable(rec) {
  const p = rec.payload || {};
  const rows = [];
  const push = (label, v) => {
    if (v !== undefined && v !== null && String(v).trim() !== "") rows.push([label, String(v)]);
  };
  push("平台", "云南 12345（匿名提交）");
  push("行政区划", p.district);
  push("详细地址", p.address);
  push("姓名", p.name);
  push("手机号", p.phone);
  push("是否公开", p.isPublic === false ? "不公开" : "公开");
  return rows;
}

/** 确认信号解析：文件/终端内容必须是 CONFIRM 或 CONFIRM:<确认人>
 *  @returns {{ok:boolean, by:string}} ok=false 表示内容不是有效确认 */
function parseConfirmSignal(text) {
  const m = String(text == null ? "" : text).trim().match(/^CONFIRM(?::(.*))?$/i);
  if (!m) return { ok: false, by: "" };
  return { ok: true, by: (m[1] || "").trim() };
}

module.exports = {
  createPending,
  approvePending,
  verifyApproval,
  consume,
  listPending,
  loadPending,
  hashPayload,
  previewTable,
  parseConfirmSignal,
  pendingPath,
  confirmPath,
  PENDING_DIR,
  TTL_HOURS,
};
