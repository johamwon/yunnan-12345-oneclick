/**
 * 云南地域路由：把用户描述落到「州市 / 区县 /（可选）街道」三级，
 * 供一键流程决定区划级联路径；不确定时返回追问问题，绝不猜。
 *
 * 状态机：
 *   ok           州市 + 区县都已确定 → 可直接填表
 *   need_district 州市已知、区县未知 → 追问区县（附候选）
 *   need_city     区县跨州市同名 / 什么都没识别到 → 追问州市
 *   out_of_scope  描述指向云南省外 → 本技能不适用，交给用户决定手工或其他方式
 */
const fs = require("fs");
const path = require("path");

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "config", "districts.json"), "utf8"));

/** 外省信号：命中即提示「本技能只覆盖云南」，避免把外省工单投到云南平台 */
const OUT_OF_SCOPE = [
  "北京", "天津", "上海", "重庆", "河北", "山西", "辽宁", "吉林", "黑龙江", "江苏", "浙江", "安徽",
  "福建", "江西", "山东", "河南", "湖北", "湖南", "广东", "广西", "海南", "四川", "贵州", "西藏",
  "陕西", "甘肃", "青海", "宁夏", "新疆", "内蒙古", "成都", "贵阳", "广州", "深圳", "杭州", "南京",
  "武汉", "长沙", "西安", "郑州", "济南", "福州", "厦门", "南宁", "海口", "兰州", "西宁", "银川",
  "乌鲁木齐", "拉萨", "呼和浩特", "沈阳", "长春", "哈尔滨", "石家庄", "太原", "合肥", "南昌",
];

const CITY_INDEX = new Map(); // alias -> cityName
const DISTRICT_INDEX = new Map(); // name|alias -> [{city, district}]

for (const c of DATA.cities) {
  CITY_INDEX.set(normalize(c.name), c.name);
  CITY_INDEX.set(normalize(c.name.replace(/[市州]$/, "")), c.name);
  (c.aliases || []).forEach((a) => CITY_INDEX.set(normalize(a), c.name));
  (c.districts || []).forEach((d) => addDistrict(c.name, d, d));
  Object.entries(c.districtAlias || {}).forEach(([alias, full]) => addDistrict(c.name, alias, full));
}

function addDistrict(city, alias, fullName) {
  const k = normalize(alias);
  const arr = DISTRICT_INDEX.get(k) || [];
  if (!arr.some((x) => x.city === city && x.district === fullName)) arr.push({ city, district: fullName });
  DISTRICT_INDEX.set(k, arr);
}

function normalize(s) {
  return String(s || "").replace(/[\s，。！？；：、“”‘’（）()《》【】\[\]…·,.!?;:"']/g, "");
}

function scoreAlias(alias, base, cap = 15) {
  return base + Math.min(cap, Math.max(0, (alias.length - 2) * 6));
}

function cityOf(name) {
  return CITY_INDEX.get(normalize(name)) || null;
}

function districtsOf(cityName) {
  const c = DATA.cities.find((x) => x.name === cityName);
  return c ? c.districts || [] : [];
}

/** 解析「昆明市/五华区/护国街道」这类完整级联路径 */
function parsePath(str) {
  const parts = String(str || "").split(/[/／>]+|\s{2,}/).map((s) => s.trim()).filter(Boolean);
  return parts;
}

/** 从自由文本里找区县（返回所有候选，供消歧） */
function findDistricts(text) {
  const t = normalize(text);
  const hits = [];
  for (const [alias, list] of DISTRICT_INDEX.entries()) {
    if (!alias) continue;
    if (!t.includes(alias)) continue;
    for (const item of list) {
      const s = scoreAlias(alias, 35, 12);
      const exist = hits.find((h) => h.city === item.city && h.district === item.district);
      if (exist) exist.score = Math.max(exist.score, s);
      else hits.push({ ...item, score: s, alias });
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

function findCity(text) {
  const t = normalize(text);
  let best = null;
  for (const [alias, city] of CITY_INDEX.entries()) {
    if (!alias || !t.includes(alias)) continue;
    const s = scoreAlias(alias, 45);
    if (!best || s > best.score) best = { city, score: s, alias };
  }
  return best;
}

function outOfScope(text) {
  const t = normalize(text);
  return OUT_OF_SCOPE.find((w) => t.includes(w)) || null;
}

/**
 * 路由主入口
 * @param {{text?:string, city?:string, district?:string}} input
 * @returns {{status:string, city?:string, district?:string, leafPath?:string, question?:string, candidates?:Array, score?:number, evidence?:Array}}
 */
function route(input = {}) {
  const text = String(input.text || "");
  const explicitCity = String(input.city || "").trim();
  const explicitDistrict = String(input.district || "").trim();

  // ---- 1. 用户直接给了区划（可能是完整级联路径）----
  if (explicitDistrict) {
    const parts = parsePath(explicitDistrict);
    let city = explicitCity ? cityOf(explicitCity) : null;
    let district = null;
    let leaf = [];

    if (parts.length >= 2) {
      city = cityOf(parts[0]) || city;
      if (city) {
        district = resolveDistrictName(city, parts[1]);
        leaf = parts.slice(2);
      } else {
        // 首段可能是县级市/区（如「大理市」「安宁市」）而非州市 → 按区县解析并反推州市
        const cands = DISTRICT_INDEX.get(normalize(parts[0])) || [];
        if (cands.length === 1) {
          city = cands[0].city;
          district = cands[0].district;
          leaf = parts.slice(1);
        } else if (cands.length > 1) {
          return {
            status: "need_city",
            question: `「${parts[0]}」在云南有多个同名区县，属于：${cands.map((c) => c.city).join("、")}。请确认是哪一个州市？`,
            candidates: cands.map((c) => ({ city: c.city, district: c.district })),
          };
        }
      }
    } else if (parts.length === 1) {
      const cands = DISTRICT_INDEX.get(normalize(parts[0])) || [];
      if (city) {
        district = resolveDistrictName(city, parts[0]);
      } else if (cands.length === 1) {
        city = cands[0].city;
        district = cands[0].district;
      } else if (cands.length > 1) {
        return {
          status: "need_city",
          question: `「${parts[0]}」在云南有多个同名区县，属于：${cands.map((c) => c.city).join("、")}。请确认是哪一个州市？`,
          candidates: cands.map((c) => ({ city: c.city, district: c.district })),
        };
      } else {
        district = parts[0]; // 交给平台级联自行匹配，Agent 会在填表时看到结果
      }
    }

    if (city && district) {
      return {
        status: "ok",
        city,
        district,
        leafPath: [city, district, ...leaf].join("/"),
        score: 90,
        evidence: ["用户显式指定区划"],
        needLeaf: leaf.length === 0,
      };
    }
    if (city && !district) {
      return needDistrict(city, `已指定${city}，还需要具体区县/街道`);
    }
  }

  // ---- 2. 只有城市 ----
  if (explicitCity) {
    const city = cityOf(explicitCity);
    if (!city) {
      return { status: "need_city", question: `「${explicitCity}」不在云南省 16 个州市内。请确认州市名（如昆明市、大理白族自治州）。` };
    }
    const d = findDistricts(text).find((x) => x.city === city);
    if (d) {
      return { status: "ok", city, district: d.district, leafPath: `${city}/${d.district}`, score: 88, evidence: [d.alias], needLeaf: true };
    }
    return needDistrict(city, `已确定${city}，还需要具体区县`);
  }

  // ---- 3. 从自由文本推断 ----
  const scope = outOfScope(text);
  const cityHit = findCity(text);
  const distHits = findDistricts(text);

  if (!cityHit && !distHits.length && scope) {
    return {
      status: "out_of_scope",
      question: `描述里出现「${scope}」，看起来不在云南省内。本技能只对接云南 12345，请确认事发地是否在云南；如在外省，需要改用对应省份的 12345 渠道。`,
    };
  }

  // 区县命中且唯一 → 可反推州市
  if (!cityHit && distHits.length) {
    const uniqueCities = [...new Set(distHits.map((d) => d.city))];
    if (uniqueCities.length === 1) {
      const d = distHits[0];
      return {
        status: "ok",
        city: d.city,
        district: d.district,
        leafPath: `${d.city}/${d.district}`,
        score: Math.min(98, d.score + 15),
        evidence: [d.alias, "区县名在云南唯一，已反推州市"],
        needLeaf: true,
      };
    }
    return {
      status: "need_city",
      question: `这个名字在云南有多个对应区县，请确认州市：`,
      candidates: uniqueCities.slice(0, DATA.maxCandidates || 3).map((c) => ({ city: c, district: distHits.find((d) => d.city === c).district })),
    };
  }

  if (cityHit && distHits.length) {
    const same = distHits.find((d) => d.city === cityHit.city);
    if (same) {
      return {
        status: "ok",
        city: same.city,
        district: same.district,
        leafPath: `${same.city}/${same.district}`,
        score: Math.min(98, Math.max(cityHit.score, same.score) + 20),
        evidence: [cityHit.alias, same.alias],
        needLeaf: true,
      };
    }
    // 州市与区县指向不同地区 → 以区县为准并提示核对
    const d = distHits[0];
    return {
      status: "ok",
      city: d.city,
      district: d.district,
      leafPath: `${d.city}/${d.district}`,
      score: Math.min(90, d.score + 20),
      evidence: [d.alias],
      warning: `描述中同时出现「${cityHit.city}」与「${d.city}${d.district}」，已按区县归属选择后者，请核对。`,
      needLeaf: true,
    };
  }

  if (cityHit) {
    if (cityHit.score < (DATA.minConfidence || 50)) {
      return needDistrict(cityHit.city, `可能是${cityHit.city}（置信度 ${cityHit.score}），请确认并补充区县`);
    }
    return needDistrict(cityHit.city, `已识别${cityHit.city}，还需要具体区县/街道`);
  }

  if (/\b(云南|滇)\b|云南/.test(text)) {
    return {
      status: "need_city",
      question: "确认在云南，但还需要城市。事情发生在哪个州市？（如昆明市、曲靖市、大理白族自治州）",
      candidates: DATA.cities.slice(0, 4).map((c) => ({ city: c.name })),
    };
  }

  return {
    status: "need_city",
    question:
      "描述里没有识别到地点。为了把诉求提交到正确的辖区，需要确认：① 哪个州市？② 哪个区县/街道？③ 具体路段或小区名？（例如「昆明市五华区护国街道 人民中路128号」）",
  };
}

function resolveDistrictName(city, raw) {
  if (!city) return raw;
  const list = districtsOf(city);
  const key = normalize(raw);
  const exact = list.find((d) => normalize(d) === key);
  if (exact) return exact;
  const c = DATA.cities.find((x) => x.name === city);
  const alias = (c && c.districtAlias) || {};
  for (const [a, full] of Object.entries(alias)) {
    if (normalize(a) === key) return full;
  }
  const fuzzy = list.find((d) => normalize(d).includes(key) || key.includes(normalize(d)));
  return fuzzy || raw;
}

function needDistrict(city, reason) {
  const list = districtsOf(city);
  return {
    status: "need_district",
    city,
    question: `${reason}。请确认区县（例：${list.slice(0, 3).join("、")}…），最好连街道一起给出，例如「${city}/${list[0] || "XX区"}/XX街道」。`,
    candidates: list.slice(0, 6).map((d) => ({ city, district: d })),
  };
}

/** 人类可读输出 */
function format(r) {
  const L = [];
  if (r.status === "ok") {
    L.push(`[路由] 云南省 / ${r.city} / ${r.district}  置信度=${r.score}`);
    L.push(`[区划路径] ${r.leafPath}${r.needLeaf ? "（浏览器内需继续点到街道/社区叶子）" : ""}`);
    if (r.warning) L.push(`[注意] ${r.warning}`);
    const c = DATA.cities.find((x) => x.name === r.city);
    if (c && c.leafHint) L.push(`[提示] ${c.leafHint}`);
  } else if (r.status === "need_district" || r.status === "need_city") {
    L.push(`[ASK] 地点需用户确认（${r.status}）`);
    if (r.candidates && r.candidates.length) {
      L.push("[候选] " + r.candidates.map((c) => (c.district ? `${c.city}/${c.district}` : c.city)).join("  |  "));
    }
    L.push(`[问题] ${r.question}`);
  } else {
    L.push(`[路由-不适用] ${r.status}`);
    L.push(`[问题] ${r.question}`);
  }
  return L.join("\n");
}

module.exports = { route, format, DATA, parsePath, districtsOf, cityOf };

if (require.main === module) {
  console.log(format(route({ text: process.argv.slice(2).join(" ") })));
}
