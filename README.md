# 云南 12345 一键诉求 · 使用与自测指南

> v1.0 · 2026-10-28 · 从 `yn-12345-assist` v0.4 抽取云南专属链路，去掉多省路由与无关平台

## 零、从压缩包安装（拿到 zip 后从这里开始）

```bash
# 1) 解压到用户级 skills 目录，保持顶层文件夹名为 yunnan-12345-oneclick
unzip yunnan-12345-oneclick-1.0.0.zip -d ~/.workbuddy/skills/

# Windows PowerShell
# Expand-Archive .\yunnan-12345-oneclick-1.0.0.zip -DestinationPath "$env:USERPROFILE\.workbuddy\skills\"

# 2) 装依赖（必需，playwright 不在包内）
cd ~/.workbuddy/skills/yunnan-12345-oneclick
npm install

# 3) 自检（应输出「区划数据: 16 个州市」）
node scripts/yn12345.js doctor
```

装好后在 WorkBuddy 中用 `@skill:yunnan-12345-oneclick` 触发。`state/` 目录（预览单、截图、审计日志）首次运行时自动创建，无需手工建；包内不含任何测试数据与截图。

## 一、它和通用版有什么不同

| | `yn-12345-assist`（通用） | `yunnan-12345-oneclick`（本技能） |
|---|---|---|
| 覆盖 | 云南/新疆/福州/上海 4 地 + 27 省替代说明 | **只有云南**（16 州市 + 129 个区县） |
| 入口 | `12345.js <子命令>` 多命令编排 | `yn12345.js run` **一条命令**跑完路由+起草+填表 |
| 区划 | 需自己拼 `昆明市/五华区/护国街道` | 支持只给「五华区」→ 自动补州市；或完整路径直填 |
| 确认 | `submit` 预填 → `approve` → `submit --approval` | `run` 预填 → `confirm --submit`，或 `run --wait-confirm` 单进程挂起 |
| 代码 | 9 个脚本 + 5 份配置 | 1 个入口 + 7 个 lib，配置只有一份区划表 |

## 二、依赖安装（已按「零」装过可跳过）

```bash
# 在 skill 根目录（有 package.json 的那一层）执行
npm install                 # 等价于 npm install playwright
npx playwright install chromium

# 未下载 Playwright 浏览器时，指向本机 Chrome（Windows 实测可用，省 150MB 下载）
export PW_CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe"

node scripts/yn12345.js doctor
```

## 三、三步走

### ① 一键预填（不会提交）

```bash
node scripts/yn12345.js run --text "昆明市五华区人民中路128号工地夜里施工，已经三晚" \
     --phone 13800138000 --district 五华区
```

脚本会：路由 → 生成/校验正文 → 打开云南 12345 → 匿名通道填表 → 截图 → 输出确认卡与预览单号 `Y-xxxx`。

### ② 用户确认后提交

```bash
node scripts/yn12345.js confirm --id Y-xxxx --by 王大爷 --submit
```

### ③ 或真「一键」（挂起等确认，同一个浏览器会话直接提交）

```bash
node scripts/yn12345.js run --facts facts.json --phone 13800138000 --wait-confirm
# 确认方式：终端输入 CONFIRM，或把 "CONFIRM:王大爷" 写入 state/pending/Y-xxxx.confirm
```

## 四、完整示例（噪音扰民）

```bash
cp examples/facts.example.json my-case.json   # 改成自己的八要素
node scripts/yn12345.js run --facts my-case.json --phone 13800138000
# → [路由] 云南省 / 昆明市 / 五华区
# → [草稿] 8/8 要素齐全，295/2000 字
# → [预览] 字段 + 正文全文 + 截图
# → [待确认] Y-xxxx
node scripts/yn12345.js confirm --id Y-xxxx --by 王大爷 --submit
# → [完成] 已提交，受理编号=XXXXXXX
```

## 五、自测清单

| 用例 | 命令 | 预期 |
|------|------|------|
| 环境 | `yn12345.js doctor` | playwright OK / 16 个州市 / 待处理预览单数 |
| 路由（完整路径） | `run --district "昆明市/五华区/护国街道" ...` | `[路由]` 命中三级 |
| 路由（只说区县） | `run --district 五华区 ...` | 自动补 `昆明市/五华区` |
| 路由（无地点） | `run --text "楼下餐馆油烟大" ...` | `[ASK] need_city`，退出码 2 |
| 路由（外省） | `run --text "成都市武侯区…" ...` | `[路由-不适用] out_of_scope` |
| 内容不全 | `run --text "工地吵" --phone 138…` | `[缺要素]` 逐条追问，退出码 2 |
| 预填 | `run --facts examples/facts.example.json --phone …` | 出 `[预览]`+`[待确认]`，不提交 |
| 闸门：未确认 | `submit --id Y-xxxx` | `[错误] 尚未确认`，不打开浏览器 |
| 闸门：改内容 | 手改预览单 payload 后 `submit` | `[错误] 内容不一致` |
| 闸门：重复提交 | 已提交的单再 `submit` | `[错误] 已提交过` |
| 确认后复填 | `confirm --id Y-xxxx --by 王大爷 --submit --prefill-only` | 重新开浏览器复填并截图，不点提交、不请求短信 |
| 等待超时 | `run ... --wait-confirm --wait-sec 10` | 超时退出码 3，保留预览单、不提交 |

## 六、已知限制

- **只做匿名提交**：云南实名认证通道（需身份证 + 人脸）未覆盖；匿名通道姓名栏禁用，一律按「匿名」提交
- 附件不代传：最多 5 个、单个 ≤10MB，需要在页面手工添加
- 滑块：`--slider-vision-dir` 走视觉模式（headless 可用），自动模板匹配成功率有限，稳妥起见真实提交用 `--no-headless`
- 手机号必须是用户本人的（接收短信码与回执）
- 平台改版会让选择器失效（报「页面结构可能已改版」），需更新 `scripts/lib/platform.js` 的 `SEL`
- 仅供本人提交本人诉求，禁止代投

## 七、变更记录

- **v1.0（2026-10-28）**：从 `yn-12345-assist` v0.4 抽取。新增：单命令 `run` 编排、云南 16 州市/129 区县路由、`--wait-confirm` 单进程确认提交、匿名通道姓名栏 disabled 适配（真实浏览器发现并修复）
