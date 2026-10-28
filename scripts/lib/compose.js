/**
 * 云南 12345 诉求内容增强：把口述变成「八要素齐全、可核查、诉求明确」的工单正文。
 * 只排版与检查，不编造事实；缺哪项就生成一句该问用户的话。
 *
 * 云南平台特点：无独立标题栏（正文首行写【诉求事项】即可）、正文上限 2000 字、必填区划与详细地址。
 */
const SECTIONS = [
  { key: "time", label: "发生时间", required: true, question: "事情发生的具体时间？（精确到日期，最好带时段，如「10月20日上午8点左右」；持续性问题说清起止时间）" },
  { key: "place", label: "发生地点", required: true, question: "具体地点？（州市 + 区县 + 道路/门牌/小区/单位全称，例如「昆明市五华区人民中路128号XX小区东门」）" },
  { key: "subject", label: "涉及单位", required: false, question: "涉及哪个单位/企业/部门？（如物业全称、施工方、商家、监管单位；不确定写「不详，请核实」）" },
  { key: "process", label: "事项经过", required: true, question: "事情经过按时间顺序补 3–5 句？（起因 → 经过 → 目前状态，只写事实不写评价）" },
  { key: "impact", label: "造成影响", required: false, question: "造成了哪些具体影响？（安全隐患 / 经济损失金额 / 生活不便 / 持续多久）" },
  { key: "evidence", label: "证据材料", required: false, question: "有哪些可佐证的材料？（照片、视频、录音、票据、聊天记录、此前的工单编号）" },
  { key: "contacted", label: "前期反映", required: false, question: "此前是否已向相关单位或 12345 反映过？（时间、渠道、对方答复；没有可跳过）" },
];

const TONE_RULES = [
  { re: /垃圾|狗屁|混蛋|王八|无耻|欺负人|欺压/g, tip: "情绪化用语", to: "长期无人处理" },
  { re: /不作为|乱作为|失职|渎职/g, tip: "定性用语（宜由部门认定）", to: "多次反映后仍未处理" },
  { re: /曝光|叫记者|发抖音|上网曝光|闹到|上访|告到底/g, tip: "外溢威胁性表述", to: "请依法依规处理并书面答复" },
  { re: /肯定|绝对是|百分之百|100%|从来不|全是|根本没/g, tip: "绝对化表述", to: "我了解到的情况是" },
];

const VAGUE_TIME = /前几天|最近|前段时间|这两天|一直以来|很久了|好久了|有段时间/;
const VAGUE_DEMAND = /^(请)?[^，。]{0,4}(处理|解决|整改|重视|关注|管一管|管管|核实)$/;
const LIMIT = 2000;

function charLen(s) {
  return [...String(s || "")].length;
}

function pick(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  return "";
}

function normalizeDemands(d) {
  let arr = [];
  if (Array.isArray(d)) arr = d;
  else if (typeof d === "string") arr = d.split(/[\n；;]+|(?<=[。！？])\s*/);
  return arr
    .map((x) => String(x || "").replace(/^\s*(\d+[.、)）]|[-*•])\s*/, "").trim())
    .filter(Boolean);
}

/**
 * 生成草稿
 * @param {object} input {title?, facts{...}, demands, compact?, limit?, name?, phone?, district?, address?}
 */
function compose(input = {}) {
  const f = input.facts || input;
  const facts = {};
  for (const s of SECTIONS) facts[s.key] = pick(f[s.key], input[s.key]);

  const title = pick(input.title, f.title);
  const demands = normalizeDemands(input.demands || f.demands || f.demand);
  const limit = Number(input.limit || LIMIT);
  const compact = !!input.compact;

  const missing = [];
  SECTIONS.forEach((s) => {
    if (!facts[s.key]) missing.push({ key: s.key, label: s.label, required: s.required, question: s.question });
  });
  if (!demands.length) {
    missing.push({
      key: "demands",
      label: "具体诉求",
      required: true,
      question: "希望怎么解决？（写成可执行、可核查的要求，如「3个工作日内修复并书面告知处理结果」「退还多收费用120元」；避免只写「尽快处理」）",
    });
  }

  let text;
  if (compact) {
    const parts = [];
    parts.push([facts.time, facts.place, facts.subject ? `涉及${facts.subject}` : ""].filter(Boolean).join("，"));
    if (facts.process) parts.push(facts.process);
    if (facts.impact) parts.push(`影响：${facts.impact}`);
    if (facts.evidence) parts.push(`证据：${facts.evidence}`);
    if (facts.contacted) parts.push(`前期反映：${facts.contacted}`);
    let body = parts.filter(Boolean).join("。");
    if (!/[。！？]$/.test(body)) body += "。";
    const dm = demands.length ? "诉求：" + demands.map((d, i) => `${i + 1}.${d}`).join(" ") : "";
    text = [title ? `关于${title}的诉求` : "", body, dm].filter(Boolean).join("");
  } else {
    const L = [];
    if (title) L.push(`【诉求事项】${title}`);
    for (const s of SECTIONS) if (facts[s.key]) L.push(`【${s.label}】${facts[s.key]}`);
    if (demands.length) {
      L.push("【具体诉求】");
      demands.forEach((d, i) => L.push(`${i + 1}. ${d}`));
    }
    text = L.join("\n");
  }

  const len = charLen(text);
  const over = len > limit;

  const tips = [];
  for (const r of TONE_RULES) {
    const hits = text.match(r.re);
    if (hits) tips.push(`${r.tip}「${[...new Set(hits)].join("、")}」→ 建议改为事实描述，如「${r.to}」`);
  }
  if (VAGUE_TIME.test(facts.time || "")) tips.push(`时间表述偏模糊「${facts.time}」→ 补到具体日期（部门按时间线核查）`);
  if (facts.process && !/[0-9]|[一二三四五六七八九十百千万两半]\s*[点时分天月年次元块米人户个层]/u.test(facts.process)) {
    tips.push("经过里没有任何数量信息 → 建议补充次数/时长/面积/金额等可核查量");
  }
  if (demands.some((d) => VAGUE_DEMAND.test(d))) tips.push("诉求偏笼统（如「尽快处理」）→ 补时间要求与可核查结果");
  if (title && charLen(title) > 30) tips.push(`标题 ${charLen(title)} 字偏长 → 压到 30 字内（地点/对象 + 问题）`);
  if (facts.place && !/(州|市|区|县)/.test(facts.place)) tips.push(`地点「${facts.place}」缺行政区划层级 → 补州市与区县，否则会派错辖区`);
  if (over) {
    tips.push(
      `正文 ${len} 字超出平台上限 ${limit} 字 → ` +
        (compact ? "段落版仍超限，建议拆成「主诉求 + 补充说明」两条" : "用 --compact 输出段落版，或拆成两条")
    );
  }

  const district = pick(input.district, f.district);
  const address = pick(facts.address, input.address, input.addressDetail);
  const form = {
    name: pick(input.name, f.name) || "匿名",
    phone: pick(input.phone, f.phone),
    district,
    address: address || facts.place,
    content: text,
  };

  return {
    ok: true,
    title,
    text,
    length: len,
    limit,
    over,
    missing,
    requiredMissing: missing.filter((m) => m.required),
    tips,
    demands,
    form,
    ready: missing.filter((m) => m.required).length === 0 && !over,
  };
}

function format(r) {
  const L = [];
  L.push("[草稿-开始]");
  L.push(r.text || "（空）");
  L.push("[草稿-结束]");
  L.push(`[字数] ${r.length}/${r.limit}${r.over ? "  ⚠ 超限" : ""}`);
  L.push(`[要素] 已具备 ${SECTIONS.length + 1 - r.missing.length}/${SECTIONS.length + 1}，必填缺 ${r.requiredMissing.length} 项`);
  if (r.missing.length) {
    L.push("[缺要素] 逐条向用户提问（必填未补齐不要提交）：");
    r.missing.forEach((m) => L.push(`  - ${m.label}${m.required ? "（必填）" : "（建议）"}：${m.question}`));
  }
  if (r.tips.length) {
    L.push("[润色建议]");
    r.tips.forEach((t) => L.push(`  - ${t}`));
  }
  L.push(r.ready ? "[校验] 通过：可进入预填与确认" : "[校验] 未通过：先补齐必填要素并处理超限");
  L.push(`[表单映射] 正文→反映内容 姓名→${r.form.name} 手机→${r.form.phone || "（缺）"} 区划→${r.form.district || "（缺）"} 地址→${r.form.address || "（缺）"}`);
  return L.join("\n");
}

module.exports = { compose, format, charLen, SECTIONS, LIMIT };
