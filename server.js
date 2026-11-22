/* ============================================================
 * 造梦空间站 · 商业级后端  server.js
 * 架构：Express + JSON文件数据库 + 全局互斥锁（行锁等价物）
 * 卡密：独立文件 cards_db.json，启动时只增补、绝不覆盖已核销记录
 * ============================================================ */
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));

/* ---------- 基础配置（环境变量） ---------- */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "yuanguang-2024"; // ⚠️ 上线必改
const AI_API_KEY  = process.env.AI_API_KEY  || "";
const AI_BASE     = process.env.AI_BASE_URL || "https://api.openai.com/v1";
const AI_MODEL    = process.env.AI_MODEL    || "gpt-4o-mini";

/* ---------- 档位表 ---------- */
const TIERS = {
  basic:  { cost: 5,  env: "MODEL_BASIC",  maxTokens: 1200, sys: "代码必须控制在40行以内，仅核心逻辑。" },
  gpt4:   { cost: 10, env: "MODEL_GPT4",   maxTokens: 2500, sys: "" },
  opus45: { cost: 13, env: "MODEL_OPUS45", maxTokens: 3000, sys: "" },
  pro:    { cost: 15, env: "MODEL_PRO",    maxTokens: 4000, sys: "代码控制在150行左右，含完整UI与动画。" },
  ultra:  { cost: 20, env: "MODEL_ULTRA",  maxTokens: 8000, sys: "可写200-300行，含复杂物理引擎。" },
};
const tierModel = id => process.env[TIERS[id].env] || AI_MODEL;
const EXTRA_CHARS = 500, EXTRA_COST = 5;

/* ============================================================
 * 一、主数据库层（db.json + Mutex）
 * ============================================================ */
const DB_FILE = path.join(__dirname, "db.json");
let db = { users: {}, transactions: [], platform: { dreamCoins: 0 } };
if (fs.existsSync(DB_FILE)) { try { db = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch (e) {} }
// 兼容旧版 db.json 中的 coupons 字段（迁移到 cards_db，见下）
if (db.coupons) { db._legacyCoupons = db.coupons; delete db.coupons; }
let saving = false;
const saveDB = () => {
  if (saving) return; saving = true;
  setTimeout(() => fs.writeFile(DB_FILE, JSON.stringify(db), () => { saving = false; }), 200);
};

let lock = Promise.resolve();
const withLock = fn => { const r = lock.then(fn); lock = r.catch(() => {}); return r; };

const getUser = uid => db.users[uid] || (db.users[uid] = {
  uid, points: 100, dreamCoins: 50, vipType: 0, vipExpireTime: 0,
  lastCheckin: "", name: "Play 1", createdAt: Date.now()
});
const vipSweep = u => { if (u.vipType && u.vipExpireTime < Date.now()) u.vipType = 0; };
const log = (uid, kind, delta, cur, note) =>
  db.transactions.unshift({ uid, kind, delta, cur, note, time: Date.now() });

/* ============================================================
 * 二、卡密数据库层（cards_db.json 独立持久化）
 * 规则：启动时读取现有文件 → 把预置序列号中"尚不存在"的补进去
 *       → 已存在/已核销记录原样保留，绝不覆盖
 * ============================================================ */
const CARDS_FILE = path.join(__dirname, "cards_db.json");

/* ---- 125 个预置序列号（5档 × 25个）---- */
const SEED_CODES = {
  JF100: `ZMKJZ-JF100-8K9M-2P4X ZMKJZ-JF100-7H3N-9W6L ZMKJZ-JF100-4R8V-5Q2T ZMKJZ-JF100-9D2B-6Y7J ZMKJZ-JF100-3F6C-8M1Z ZMKJZ-JF100-5G9H-4K8P ZMKJZ-JF100-2L7W-3N5R ZMKJZ-JF100-6T4Q-9X2V ZMKJZ-JF100-8Y1J-7B4D ZMKJZ-JF100-1M5Z-2C8F ZMKJZ-JF100-9P3K-5H7G ZMKJZ-JF100-4W8N-6R2L ZMKJZ-JF100-7Q2X-8V9T ZMKJZ-JF100-3B6D-4J1Y ZMKJZ-JF100-5C9F-2Z7M ZMKJZ-JF100-2H4G-9K3P ZMKJZ-JF100-8N7L-1R6W ZMKJZ-JF100-6X2T-4Q8V ZMKJZ-JF100-9J5Y-7D3B ZMKJZ-JF100-1Z8M-5F2C ZMKJZ-JF100-4K3P-8G6H ZMKJZ-JF100-7R9W-2L4N ZMKJZ-JF100-3V2Q-6T9X ZMKJZ-JF100-5D7B-1Y8J ZMKJZ-JF100-8F4C-9M2Z`,
  JF500: `ZMKJZ-JF500-3P9K-7M2X ZMKJZ-JF500-8W4L-2H6N ZMKJZ-JF500-5Q2T-9R8V ZMKJZ-JF500-2Y7J-4D3B ZMKJZ-JF500-9M1Z-6F8C ZMKJZ-JF500-4K8P-1G5H ZMKJZ-JF500-7N5R-8L2W ZMKJZ-JF500-1X2V-3T6Q ZMKJZ-JF500-6B4D-9Y7J ZMKJZ-JF500-3C8F-2M5Z ZMKJZ-JF500-8H7G-4P9K ZMKJZ-JF500-5R2L-7W3N ZMKJZ-JF500-2V9T-6Q1X ZMKJZ-JF500-9J1Y-8B4D ZMKJZ-JF500-4Z7M-3C2F ZMKJZ-JF500-7G3P-5H8K ZMKJZ-JF500-1L6W-9N2R ZMKJZ-JF500-6Q8V-4X5T ZMKJZ-JF500-3D3B-7J9Y ZMKJZ-JF500-8F2C-1Z6M ZMKJZ-JF500-5P6H-2K4G ZMKJZ-JF500-2W4N-8R7L ZMKJZ-JF500-9T9X-3V1Q ZMKJZ-JF500-4Y8J-6D5B ZMKJZ-JF500-7M2Z-9F3C`,
  VIPJF: `ZMKJZ-VIPJF-6K2M-9P8X ZMKJZ-VIPJF-2H7N-4W3L ZMKJZ-VIPJF-9R4V-1Q6T ZMKJZ-VIPJF-4D8B-7Y2J ZMKJZ-VIPJF-7F1Z-3M9C ZMKJZ-VIPJF-1G5H-8K4P ZMKJZ-VIPJF-8L9W-2N7R ZMKJZ-VIPJF-3T2Q-6X5V ZMKJZ-VIPJF-6Y6J-9B1D ZMKJZ-VIPJF-2M3Z-5C8F ZMKJZ-VIPJF-9P7K-4H2G ZMKJZ-VIPJF-4W1N-8R6L ZMKJZ-VIPJF-7Q5X-3V9T ZMKJZ-VIPJF-1B9D-6J4Y ZMKJZ-VIPJF-8C2F-2Z7M ZMKJZ-VIPJF-3H6G-7K1P ZMKJZ-VIPJF-6N8L-9R4W ZMKJZ-VIPJF-2X4T-5Q2V ZMKJZ-VIPJF-9J7Y-1D8B ZMKJZ-VIPJF-4Z3M-8F5C ZMKJZ-VIPJF-7K9P-3G2H ZMKJZ-VIPJF-1R2W-6L7N ZMKJZ-VIPJF-8V5Q-4T9X ZMKJZ-VIPJF-3D1B-9Y6J ZMKJZ-VIPJF-6F8C-2M4Z`,
  VIPZM: `ZMKJZ-VIPZM-4M8K-3P2X ZMKJZ-VIPZM-9N3H-7W5L ZMKJZ-VIPZM-2V6R-4Q9T ZMKJZ-VIPZM-7B1D-8Y4J ZMKJZ-VIPZM-5Z9F-2M6C ZMKJZ-VIPZM-8H2G-6K1P ZMKJZ-VIPZM-3W4N-9L8R ZMKJZ-VIPZM-6Q7X-1T3V ZMKJZ-VIPZM-1J5Y-4B9D ZMKJZ-VIPZM-4F2C-7Z6M ZMKJZ-VIPZM-9K8P-2H4G ZMKJZ-VIPZM-2L3W-5R1N ZMKJZ-VIPZM-7T6Q-8V2X ZMKJZ-VIPZM-5Y9J-3D7B ZMKJZ-VIPZM-8M4Z-1F8C ZMKJZ-VIPZM-3G1H-6P9K ZMKJZ-VIPZM-6R7L-4W2N ZMKJZ-VIPZM-1X2V-9Q5T ZMKJZ-VIPZM-4D8B-2J3Y ZMKJZ-VIPZM-9C5F-7M1Z ZMKJZ-VIPZM-2P6K-3G8H ZMKJZ-VIPZM-7N9W-8L4R ZMKJZ-VIPZM-5Q3T-1X6V ZMKJZ-VIPZM-8B7D-6Y2J ZMKJZ-VIPZM-3Z4M-9F5C`,
  ZM1K: `ZMKJZ-ZM1K-7P4K-2M9X ZMKJZ-ZM1K-3L8W-6H1N ZMKJZ-ZM1K-8T2Q-5R7V ZMKJZ-ZM1K-4J9Y-1D6B ZMKJZ-ZM1K-9C5F-8Z3M ZMKJZ-ZM1K-2K1P-4G7H ZMKJZ-ZM1K-6R7N-9L2W ZMKJZ-ZM1K-1V3X-3Q8T ZMKJZ-ZM1K-5D6B-7J4Y ZMKJZ-ZM1K-8Z2M-2F9C ZMKJZ-ZM1K-3H8G-5P1K ZMKJZ-ZM1K-7W4L-1R6N ZMKJZ-ZM1K-2Q9V-8T3X ZMKJZ-ZM1K-6Y1J-4B5D ZMKJZ-ZM1K-9M7Z-6C2F ZMKJZ-ZM1K-4G3P-9H8K ZMKJZ-ZM1K-8N5R-2W4L ZMKJZ-ZM1K-3X6T-7V1Q ZMKJZ-ZM1K-7B2D-3Y9J ZMKJZ-ZM1K-1F8C-5M6Z ZMKJZ-ZM1K-5K4H-8G2P ZMKJZ-ZM1K-9L9W-4N7R ZMKJZ-ZM1K-4T1Q-6X3V ZMKJZ-ZM1K-8J5Y-2D8B ZMKJZ-ZM1K-2C7M-9F4C`,
};

/* ---- 5 档位核销规则：返回发放文案 ---- */
const CARD_RULES = {
  JF100: u => { u.points += 100;                    return "到账 +100 积分"; },
  JF500: u => { u.points += 500;                    return "到账 +500 积分"; },
  ZM1K:  u => { u.dreamCoins += 1000;               return "到账 +1,000 造梦币"; },
  VIPJF: u => { u.vipType = 2;                       // 积分大会员30天 +6000分
                u.vipExpireTime = Math.max(Date.now(), u.vipExpireTime) + 30 * 864e5;
                u.points += 6000;                   return "积分大会员30天激活 +6,000 积分"; },
  VIPZM: u => { u.vipType = 1;                       // 站点大会员30天 +10000币
                u.vipExpireTime = Math.max(Date.now(), u.vipExpireTime) + 30 * 864e5;
                u.dreamCoins += 10000;              return "站点大会员30天激活 +10,000 造梦币"; },
};

/* ---- 卡密库加载：读取现存文件，仅"补种"缺失卡，不动已核销记录 ---- */
let cards = {};
if (fs.existsSync(CARDS_FILE)) {
  try { cards = JSON.parse(fs.readFileSync(CARDS_FILE, "utf8")); } catch (e) { cards = {}; }
}
// 迁移旧版 coupons（若存在）为卡密记录
if (db._legacyCoupons) {
  for (const [code, c] of Object.entries(db._legacyCoupons)) {
    if (!cards[code]) cards[code] = { code, tier: "LEGACY", type: c.type, amount: c.amount,
      used: !!c.isUsed, usedBy: c.usedBy || null, usedAt: null };
  }
  delete db._legacyCoupons;
}
let seeded = 0;
for (const [tier, list] of Object.entries(SEED_CODES)) {
  for (const code of list.trim().split(/\s+/)) {
    if (!cards[code]) { cards[code] = { code, tier, used: false, usedBy: null, usedAt: null }; seeded++; }
  }
}
let cardsSaving = false;
const saveCards = () => {
  if (cardsSaving) return; cardsSaving = true;
  setTimeout(() => fs.writeFile(CARDS_FILE, JSON.stringify(cards), () => { cardsSaving = false; }), 200);
};
saveCards();
if (seeded) console.log(`🎫 卡密库：补入 ${seeded} 个预置序列号，当前共 ${Object.keys(cards).length} 个`);

/* 管理员批量生成的动态卡密同样落入卡密库 */
const GEN_TYPES = { // 与旧版一致：动态生成的额外卡密（预置之外可继续加库存）
  points: { tier: "GENPT", apply: (u, a) => { u.points += a; return `到账 +${a} 积分`; } },
  coins:  { tier: "GENCN", apply: (u, a) => { u.dreamCoins += a; return `到账 +${a} 造梦币`; } },
  vip_site_month: { tier: "VIPZM", apply: CARD_RULES.VIPZM },
  vip_pts_month:  { tier: "VIPJF", apply: CARD_RULES.VIPJF },
  vip_pts_year:   { tier: "GENPY", apply: u => { u.vipType = 2;
                u.vipExpireTime = Math.max(Date.now(), u.vipExpireTime) + 365 * 864e5;
                u.points += 12000; return "积分大会员365天激活 +12,000 积分"; } },
};
const rand6 = () => crypto.randomBytes(3).toString("hex").toUpperCase();

/* 兑换防爆破：连续错5次封禁1小时 */
const failMap = {};
const checkBan = uid => { const f = failMap[uid]; return f && f.banUntil > Date.now() ? Math.ceil((f.banUntil - Date.now()) / 6e4) : 0; };
const markFail = uid => { const f = failMap[uid] || { n: 0, banUntil: 0 }; f.n++; if (f.n >= 5) { f.banUntil = Date.now() + 36e5; f.n = 0; } failMap[uid] = f; };
const clearFail = uid => { delete failMap[uid]; };

const uidOf = req => String(req.headers["x-uid"] || req.body?.uid || "").slice(0, 40) || null;

/* ============================================================
 * 三、API 路由
 * ============================================================ */
app.get("/api/status", (req, res) => res.json({ keyConfigured: !!AI_API_KEY }));

/* 钱包信息 */
app.get("/api/wallet", (req, res) => {
  const uid = uidOf(req); if (!uid) return res.status(400).json({ error: "缺少UID" });
  const u = getUser(uid); vipSweep(u); saveDB();
  res.json({ points: u.points, dreamCoins: u.dreamCoins, vipType: u.vipType,
    vipExpireTime: u.vipExpireTime, lastCheckin: u.lastCheckin,
    txs: db.transactions.filter(t => t.uid === uid).slice(0, 50) });
});

/* AI 生成 + 原子扣费 + 失败退款 */
app.post("/api/generate", async (req, res) => {
  const { prompt = "", modelId = "basic", baseUrl, model } = req.body;
  const uid = uidOf(req); if (!uid) return res.status(400).json({ error: "缺少UID" });
  const isAdmin = req.headers["x-admin-token"] === ADMIN_TOKEN;
  const tier = TIERS[modelId] || TIERS.basic;
  const cost = tier.cost + (prompt.length > EXTRA_CHARS ? EXTRA_COST : 0);
  if (!AI_API_KEY) return res.status(503).json({ error: "服务端未配置 AI_API_KEY" });

  let deducted = false;
  await withLock(() => {
    const u = getUser(uid); vipSweep(u);
    if (u.points < cost) return;
    u.points -= cost; deducted = true;
    log(uid, "ai", -cost, "points", `AI生成(${modelId})${prompt.length > EXTRA_CHARS ? " 含超字数+5" : ""}`);
    saveDB();
  });
  if (!deducted) {
    const u = getUser(uid);
    return res.status(402).json({ error: `积分不足：本档需 ${cost}，当前余额 ${u.points}，可去钱包兑换卡密充值`, points: u.points });
  }

  const sys = `你是「造梦AI」，根据用户需求输出一个零外部依赖的单文件HTML5网页/小游戏。` +
    `移动端必须内置虚拟摇杆或触控支持。只输出完整HTML代码，不要解释。` + tier.sys;
  const useBase = (isAdmin && baseUrl) ? baseUrl : AI_BASE;
  const useModel = (isAdmin && model) ? model : tierModel(modelId);
  try {
    const r = await fetch(useBase.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${AI_API_KEY}` },
      body: JSON.stringify({ model: useModel, max_tokens: tier.maxTokens,
        messages: [{ role: "system", content: sys }, { role: "user", content: prompt }] }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || "上游错误");
    const text = d.choices?.[0]?.message?.content || "";
    const m = text.match(/<!DOCTYPE html[\s\S]*<\/html>/i) || text.match(/<html[\s\S]*<\/html>/i);
    res.json({ model: useModel, cost, html: m ? m[0] : null, text: m ? null : text });
  } catch (e) {
    await withLock(() => { const u = getUser(uid); u.points += cost; log(uid, "refund", +cost, "points", "AI失败退款"); saveDB(); });
    res.status(502).json({ error: "生成失败已退款：" + e.message });
  }
});

/* 管理员验证 */
app.post("/api/admin/verify", (req, res) => res.json({ admin: req.headers["x-admin-token"] === ADMIN_TOKEN }));

/* 批量生成动态卡密（管理员，最少20） */
app.post("/api/admin/gencodes", (req, res) => {
  if (req.headers["x-admin-token"] !== ADMIN_TOKEN) return res.status(403).json({ error: "无权" });
  const { type, amount = 0, count = 20 } = req.body;
  if (!GEN_TYPES[type]) return res.status(400).json({ error: "未知类型" });
  const n = Math.max(20, Math.min(500, parseInt(count) || 20));
  const out = [];
  for (let i = 0; i < n; i++) {
    const code = `DS-${GEN_TYPES[type].tier}-${amount}-${rand6()}`;
    cards[code] = { code, tier: GEN_TYPES[type].tier, genType: type, amount, used: false, usedBy: null, usedAt: null };
    out.push(code);
  }
  saveCards();
  res.json({ count: out.length, codes: out });
});

/* ★ 卡密库存看板（管理员）：各档位总量/剩余/已核销明细 ★ */
app.get("/api/admin/cards", (req, res) => {
  if (req.headers["x-admin-token"] !== ADMIN_TOKEN) return res.status(403).json({ error: "无权" });
  const stats = {};   // tier → {total, left, used}
  const usedList = []; // 已核销明细
  for (const c of Object.values(cards)) {
    const s = stats[c.tier] || (stats[c.tier] = { total: 0, left: 0, used: 0 });
    s.total++;
    if (c.used) { s.used++; usedList.push({ code: c.code, tier: c.tier, usedBy: c.usedBy, usedAt: c.usedAt }); }
    else s.left++;
  }
  usedList.sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0));
  res.json({ stats, usedList: usedList.slice(0, 100), totalCards: Object.keys(cards).length });
});

/* ★ 统一核销接口：预置卡密 + 动态生成卡密，锁内原子 ★ */
app.post("/api/redeem", async (req, res) => {
  const uid = uidOf(req); if (!uid) return res.status(400).json({ error: "缺少UID" });
  const code = String(req.body.code || "").trim().toUpperCase(); // 转大写去空格
  const ban = checkBan(uid);
  if (ban) return res.status(429).json({ error: `输错次数过多，兑换已冻结 ${ban} 分钟` });
  const result = await withLock(() => {
    const c = cards[code];
    if (!c) return { err: "序列号无效" };
    if (c.used) return { err: "该序列号已被核销" };
    const u = getUser(uid); vipSweep(u);
    c.used = true; c.usedBy = uid; c.usedAt = Date.now();        // 锁内标记，防并发
    let msg;
    if (CARD_RULES[c.tier]) msg = CARD_RULES[c.tier](u);          // 5档预置规则
    else if (c.genType && GEN_TYPES[c.genType]) msg = GEN_TYPES[c.genType].apply(u, c.amount); // 动态卡
    else return { err: "序列号配置异常" };
    const cur = c.tier === "ZM1K" || c.tier === "VIPZM" || c.genType === "coins" ? "coins"
              : c.tier.startsWith("VIP") || (c.genType || "").startsWith("vip") ? "vip" : "points";
    log(uid, "redeem", c.amount || 0, cur, `兑换 ${code} → ${msg}`);
    saveDB(); saveCards();                                       // 立即持久化
    return { ok: true, msg };
  });
  if (result.err) { markFail(uid); return res.status(400).json({ error: result.err }); }
  clearFail(uid);
  res.json(result);
});

/* 每日签到 */
app.post("/api/checkin", async (req, res) => {
  const uid = uidOf(req); if (!uid) return res.status(400).json({ error: "缺少UID" });
  const today = new Date().toISOString().slice(0, 10);
  const result = await withLock(() => {
    const u = getUser(uid); vipSweep(u);
    if (u.lastCheckin === today) return { err: "今日已签到，明天再来吧" };
    u.lastCheckin = today;
    let msg;
    if (u.vipType === 1) { u.dreamCoins += 100; msg = "站点大会员签到 +100 造梦币"; log(uid, "checkin", 100, "coins", msg); }
    else if (u.vipType === 2) { u.points += 100; msg = "积分大会员签到 +100 积分"; log(uid, "checkin", 100, "points", msg); }
    else { u.dreamCoins += 10; msg = "签到成功 +10 造梦币"; log(uid, "checkin", 10, "coins", msg); }
    saveDB();
    return { ok: true, msg };
  });
  if (result.err) return res.status(400).json({ error: result.err });
  res.json(result);
});

/* 打赏（A→B，平台抽成10%，锁内事务） */
app.post("/api/tip", async (req, res) => {
  const uid = uidOf(req); if (!uid) return res.status(400).json({ error: "缺少UID" });
  const amt = Math.floor(parseInt(req.body.amount) || 0);
  const toUid = String(req.body.toUid || "").slice(0, 40);
  if (amt <= 0 || amt > 100000) return res.status(400).json({ error: "金额无效" });
  if (!toUid || toUid === uid) return res.status(400).json({ error: "不能打赏自己" });
  const result = await withLock(() => {
    const a = getUser(uid); vipSweep(a);
    if (a.dreamCoins < amt) return { err: `造梦币不足：需 ${amt}，当前 ${a.dreamCoins}` };
    const fee = Math.floor(amt * 0.1);
    const b = getUser(toUid);
    a.dreamCoins -= amt; b.dreamCoins += amt - fee; db.platform.dreamCoins += fee;
    log(uid, "tip_out", -amt, "coins", `打赏 ${toUid}（对方实收${amt - fee}，平台抽成${fee}）`);
    log(b.uid, "tip_in", +(amt - fee), "coins", `收到 ${uid} 打赏`);
    saveDB();
    return { ok: true, msg: `打赏成功！对方实收 ${amt - fee} 造梦币` };
  });
  if (result.err) return res.status(400).json({ error: result.err });
  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`造梦空间站 → http://localhost:${PORT}`));
