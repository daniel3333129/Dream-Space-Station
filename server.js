/* ============================================================
 * 造梦空间站 · 商业级后端  server.js
 * 架构：Express + JSON文件数据库（users_db.json / cards_db.json）
 *      + 全局互斥锁（行锁等价物）+ 登录令牌（token → uid）
 * 安全：密码加盐哈希存储（crypto.scrypt）；严禁明文
 *       所有余额变动在锁内完成，先校验后扣减，不可能负数
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

/* ---------- AI 档位表 ---------- */
const TIERS = {
  basic:  { cost: 5,  env: "MODEL_BASIC",  maxTokens: 1200, sys: "代码必须控制在40行以内，仅核心逻辑。" },
  gpt4:   { cost: 10, env: "MODEL_GPT4",   maxTokens: 2500, sys: "" },
  opus45: { cost: 13, env: "MODEL_OPUS45", maxTokens: 3000, sys: "" },
  pro:    { cost: 15, env: "MODEL_PRO",    maxTokens: 4000, sys: "代码控制在150行左右，含完整UI与动画。" },
  ultra:  { cost: 20, env: "MODEL_ULTRA",  maxTokens: 8000, sys: "可写200-300行，含复杂物理引擎。" },
};
const tierModel = id => process.env[TIERS[id].env] || AI_MODEL;
const EXTRA_CHARS = 500, EXTRA_COST = 5;
const WELCOME_POINTS = 100, WELCOME_COINS = 50;   // 新用户注册赠送

/* ============================================================
 * 一、JSON 文件持久化工具（防抖落盘）
 * ============================================================ */
const loadJSON = (file, def) => {
  if (!fs.existsSync(file)) return def;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return def; }
};
const makeSaver = file => {
  let pending = false;
  return data => {
    if (pending) return; pending = true;
    setTimeout(() => fs.writeFile(file, JSON.stringify(data), () => { pending = false; }), 200);
  };
};

/* ---------- 用户库 users_db.json（重启不丢、不覆盖） ---------- */
const USERS_FILE = path.join(__dirname, "users_db.json");
let users = loadJSON(USERS_FILE, { byUid: {}, byName: {} }); // 双索引：uid → 用户；小写账号 → uid
const saveUsers = () => makeSaver(USERS_FILE)(users);

/* ---------- 流水库 db.json ---------- */
const DB_FILE = path.join(__dirname, "db.json");
let db = loadJSON(DB_FILE, { transactions: [], platform: { dreamCoins: 0 } });
const saveDB = () => makeSaver(DB_FILE)(db);
const log = (uid, kind, delta, cur, note) =>
  db.transactions.unshift({ uid, kind, delta, cur, note, time: Date.now() });

/* ---------- 旧版兼容：把 db.json 里的游客数据迁移为系统用户 ---------- */
if (db.users && !users._migrated) {
  for (const [ouid, ou] of Object.entries(db.users)) {
    if (!users.byUid[ouid]) {
      users.byUid[ouid] = {
        uid: ouid, username: "", passwordHash: "", nickname: "游客_" + ouid.slice(-4),
        points: ou.points ?? 0, dreamCoins: ou.dreamCoins ?? 0,
        vipType: ou.vipType === 1 ? "VIPZM" : ou.vipType === 2 ? "VIPJF" : "none",
        vipExpireAt: ou.vipExpireTime || 0, strikeCount: 0, banned: false,
        lastCheckin: ou.lastCheckin || "", createdAt: ou.createdAt || Date.now(), guest: true,
      };
    }
  }
  users._migrated = true; delete db.users; saveUsers(); saveDB();
  console.log("🔄 已迁移旧版游客数据到新用户库");
}

/* ---------- 卡密库 cards_db.json ---------- */
const CARDS_FILE = path.join(__dirname, "cards_db.json");
let cards = loadJSON(CARDS_FILE, {});
const saveCards = () => makeSaver(CARDS_FILE)(cards);

/* ---- 125 个预置序列号 ---- */
const SEED_CODES = {
  JF100: `ZMKJZ-JF100-8K9M-2P4X ZMKJZ-JF100-7H3N-9W6L ZMKJZ-JF100-4R8V-5Q2T ZMKJZ-JF100-9D2B-6Y7J ZMKJZ-JF100-3F6C-8M1Z ZMKJZ-JF100-5G9H-4K8P ZMKJZ-JF100-2L7W-3N5R ZMKJZ-JF100-6T4Q-9X2V ZMKJZ-JF100-8Y1J-7B4D ZMKJZ-JF100-1M5Z-2C8F ZMKJZ-JF100-9P3K-5H7G ZMKJZ-JF100-4W8N-6R2L ZMKJZ-JF100-7Q2X-8V9T ZMKJZ-JF100-3B6D-4J1Y ZMKJZ-JF100-5C9F-2Z7M ZMKJZ-JF100-2H4G-9K3P ZMKJZ-JF100-8N7L-1R6W ZMKJZ-JF100-6X2T-4Q8V ZMKJZ-JF100-9J5Y-7D3B ZMKJZ-JF100-1Z8M-5F2C ZMKJZ-JF100-4K3P-8G6H ZMKJZ-JF100-7R9W-2L4N ZMKJZ-JF100-3V2Q-6T9X ZMKJZ-JF100-5D7B-1Y8J ZMKJZ-JF100-8F4C-9M2Z`,
  JF500: `ZMKJZ-JF500-3P9K-7M2X ZMKJZ-JF500-8W4L-2H6N ZMKJZ-JF500-5Q2T-9R8V ZMKJZ-JF500-2Y7J-4D3B ZMKJZ-JF500-9M1Z-6F8C ZMKJZ-JF500-4K8P-1G5H ZMKJZ-JF500-7N5R-8L2W ZMKJZ-JF500-1X2V-3T6Q ZMKJZ-JF500-6B4D-9Y7J ZMKJZ-JF500-3C8F-2M5Z ZMKJZ-JF500-8H7G-4P9K ZMKJZ-JF500-5R2L-7W3N ZMKJZ-JF500-2V9T-6Q1X ZMKJZ-JF500-9J1Y-8B4D ZMKJZ-JF500-4Z7M-3C2F ZMKJZ-JF500-7G3P-5H8K ZMKJZ-JF500-1L6W-9N2R ZMKJZ-JF500-6Q8V-4X5T ZMKJZ-JF500-3D3B-7J9Y ZMKJZ-JF500-8F2C-1Z6M ZMKJZ-JF500-5P6H-2K4G ZMKJZ-JF500-2W4N-8R7L ZMKJZ-JF500-9T9X-3V1Q ZMKJZ-JF500-4Y8J-6D5B ZMKJZ-JF500-7M2Z-9F3C`,
  VIPJF: `ZMKJZ-VIPJF-6K2M-9P8X ZMKJZ-VIPJF-2H7N-4W3L ZMKJZ-VIPJF-9R4V-1Q6T ZMKJZ-VIPJF-4D8B-7Y2J ZMKJZ-VIPJF-7F1Z-3M9C ZMKJZ-VIPJF-1G5H-8K4P ZMKJZ-VIPJF-8L9W-2N7R ZMKJZ-VIPJF-3T2Q-6X5V ZMKJZ-VIPJF-6Y6J-9B1D ZMKJZ-VIPJF-2M3Z-5C8F ZMKJZ-VIPJF-9P7K-4H2G ZMKJZ-VIPJF-4W1N-8R6L ZMKJZ-VIPJF-7Q5X-3V9T ZMKJZ-VIPJF-1B9D-6J4Y ZMKJZ-VIPJF-8C2F-2Z7M ZMKJZ-VIPJF-3H6G-7K1P ZMKJZ-VIPJF-6N8L-9R4W ZMKJZ-VIPJF-2X4T-5Q2V ZMKJZ-VIPJF-9J7Y-1D8B ZMKJZ-VIPJF-4Z3M-8F5C ZMKJZ-VIPJF-7K9P-3G2H ZMKJZ-VIPJF-1R2W-6L7N ZMKJZ-VIPJF-8V5Q-4T9X ZMKJZ-VIPJF-3D1B-9Y6J ZMKJZ-VIPJF-6F8C-2M4Z`,
  VIPZM: `ZMKJZ-VIPZM-4M8K-3P2X ZMKJZ-VIPZM-9N3H-7W5L ZMKJZ-VIPZM-2V6R-4Q9T ZMKJZ-VIPZM-7B1D-8Y4J ZMKJZ-VIPZM-5Z9F-2M6C ZMKJZ-VIPZM-8H2G-6K1P ZMKJZ-VIPZM-3W4N-9L8R ZMKJZ-VIPZM-6Q7X-1T3V ZMKJZ-VIPZM-1J5Y-4B9D ZMKJZ-VIPZM-4F2C-7Z6M ZMKJZ-VIPZM-9K8P-2H4G ZMKJZ-VIPZM-2L3W-5R1N ZMKJZ-VIPZM-7T6Q-8V2X ZMKJZ-VIPZM-5Y9J-3D7B ZMKJZ-VIPZM-8M4Z-1F8C ZMKJZ-VIPZM-3G1H-6P9K ZMKJZ-VIPZM-6R7L-4W2N ZMKJZ-VIPZM-1X2V-9Q5T ZMKJZ-VIPZM-4D8B-2J3Y ZMKJZ-VIPZM-9C5F-7M1Z ZMKJZ-VIPZM-2P6K-3G8H ZMKJZ-VIPZM-7N9W-8L4R ZMKJZ-VIPZM-5Q3T-1X6V ZMKJZ-VIPZM-8B7D-6Y2J ZMKJZ-VIPZM-3Z4M-9F5C`,
  ZM1K: `ZMKJZ-ZM1K-7P4K-2M9X ZMKJZ-ZM1K-3L8W-6H1N ZMKJZ-ZM1K-8T2Q-5R7V ZMKJZ-ZM1K-4J9Y-1D6B ZMKJZ-ZM1K-9C5F-8Z3M ZMKJZ-ZM1K-2K1P-4G7H ZMKJZ-ZM1K-6R7N-9L2W ZMKJZ-ZM1K-1V3X-3Q8T ZMKJZ-ZM1K-5D6B-7J4Y ZMKJZ-ZM1K-8Z2M-2F9C ZMKJZ-ZM1K-3H8G-5P1K ZMKJZ-ZM1K-7W4L-1R6N ZMKJZ-ZM1K-2Q9V-8T3X ZMKJZ-ZM1K-6Y1J-4B5D ZMKJZ-ZM1K-9M7Z-6C2F ZMKJZ-ZM1K-4G3P-9H8K ZMKJZ-ZM1K-8N5R-2W4L ZMKJZ-ZM1K-3X6T-7V1Q ZMKJZ-ZM1K-7B2D-3Y9J ZMKJZ-ZM1K-1F8C-5M6Z ZMKJZ-ZM1K-5K4H-8G2P ZMKJZ-ZM1K-9L9W-4N7R ZMKJZ-ZM1K-4T1Q-6X3V ZMKJZ-ZM1K-8J5Y-2D8B ZMKJZ-ZM1K-2C7M-9F4C`,
};

/* ---- 卡密发放规则 ---- */
const CARD_RULES = {
  JF100: u => { u.points += 100;    return "到账 +100 积分"; },
  JF500: u => { u.points += 500;    return "到账 +500 积分"; },
  ZM1K:  u => { u.dreamCoins += 1000; return "到账 +1,000 造梦币"; },
  VIPJF: u => { u.vipType = "VIPJF"; u.vipExpireAt = Math.max(Date.now(), u.vipExpireAt || 0) + 30 * 864e5; u.points += 6000; return "积分大会员30天激活 +6,000 积分"; },
  VIPZM: u => { u.vipType = "VIPZM"; u.vipExpireAt = Math.max(Date.now(), u.vipExpireAt || 0) + 30 * 864e5; u.dreamCoins += 10000; return "站点大会员30天激活 +10,000 造梦币"; },
};
const GEN_TYPES = {
  points: { tier: "GENPT", apply: (u, a) => { u.points += a; return `到账 +${a} 积分`; } },
  coins:  { tier: "GENCN", apply: (u, a) => { u.dreamCoins += a; return `到账 +${a} 造梦币`; } },
  vip_site_month: { tier: "VIPZM", apply: CARD_RULES.VIPZM },
  vip_pts_month:  { tier: "VIPJF", apply: CARD_RULES.VIPJF },
  vip_pts_year:   { tier: "GENPY", apply: u => { u.vipType = "VIPJF"; u.vipExpireAt = Math.max(Date.now(), u.vipExpireAt || 0) + 365 * 864e5; u.points += 12000; return "积分大会员365天激活 +12,000 积分"; } },
};

/* ---- 补种预置卡（不覆盖已核销） ---- */
let seeded = 0;
for (const [tier, list] of Object.entries(SEED_CODES))
  for (const code of list.trim().split(/\s+/))
    if (!cards[code]) { cards[code] = { code, tier, used: false, usedBy: null, usedAt: null }; seeded++; }
saveCards();
if (seeded) console.log(`🎫 卡密库：补入 ${seeded} 个，共 ${Object.keys(cards).length} 个`);

/* ============================================================
 * 二、互斥锁 + 用户工具
 * ============================================================ */
let lock = Promise.resolve();
const withLock = fn => { const r = lock.then(fn); lock = r.catch(() => {}); return r; };

/* 会员过期清扫：vipType → none */
const vipSweep = u => { if (u.vipType && u.vipType !== "none" && (u.vipExpireAt || 0) < Date.now()) u.vipType = "none"; };

/* ---------- 密码：salt + scrypt 哈希 ---------- */
const hashPwd = (pwd, salt) => {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const h = crypto.scryptSync(pwd, salt, 64).toString("hex");
  return salt + ":" + h;
};
const verifyPwd = (pwd, stored) => {
  const [salt, h] = String(stored || "").split(":");
  if (!salt || !h) return false;
  const chk = crypto.scryptSync(pwd, salt, 64);
  const ref = Buffer.from(h, "hex");
  return chk.length === ref.length && crypto.timingSafeEqual(chk, ref); // 防时序攻击
};

/* ---------- 登录令牌（内存态，重启后需重新登录；凭据本身可恢复） ---------- */
const tokens = {}; // token → uid
const newToken = uid => { const t = "tk_" + crypto.randomBytes(24).toString("hex"); tokens[t] = uid; return t; };

/* 取登录用户：优先 token，其次 x-uid（游客/旧接口兼容） */
const authUser = req => {
  const tk = String(req.headers["x-token"] || "");
  const uid = tokens[tk] || String(req.headers["x-uid"] || req.body?.uid || "").slice(0, 40);
  if (!uid) return null;
  return users.byUid[uid] || null;
};
const pubUser = u => ({ uid: u.uid, username: u.username, nickname: u.nickname,
  points: u.points, dreamCoins: u.dreamCoins, vipType: u.vipType, vipExpireAt: u.vipExpireAt,
  strikeCount: u.strikeCount, banned: !!u.banned, lastCheckin: u.lastCheckin });

/* 防爆破：登录/兑换共用计数器 */
const failMap = {};
const banLeft = (key, ms) => { const f = failMap[key]; return f && f.banUntil > Date.now() ? Math.ceil((f.banUntil - Date.now()) / ms) : 0; };
const markFail = (key, max, banMs) => { const f = failMap[key] || { n: 0, banUntil: 0 }; f.n++; if (f.n >= max) { f.banUntil = Date.now() + banMs; f.n = 0; } failMap[key] = f; };
const clearFail = key => { delete failMap[key]; };
const rand6 = () => crypto.randomBytes(3).toString("hex").toUpperCase();

/* ============================================================
 * 三、认证接口
 * ============================================================ */

/* 注册 */
app.post("/api/register", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const pwd = String(req.body.password || "");
  const pwd2 = String(req.body.password2 || "");
  /* 校验规则：账号3-16位，密码>=6，两次一致 */
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5]{3,16}$/.test(username))
    return res.status(400).json({ error: "账号需为3-16位（字母/数字/中文/下划线）" });
  if (pwd.length < 6) return res.status(400).json({ error: "密码不少于6位" });
  if (pwd !== pwd2) return res.status(400).json({ error: "两次密码输入不一致" });

  const result = await withLock(() => {
    const key = username.toLowerCase();
    if (users.byName[key]) return { err: "该账号已被注册，请直接登录" };
    const uid = "u_" + crypto.randomBytes(5).toString("hex");
    const u = {
      uid, username, passwordHash: hashPwd(pwd), nickname: username,
      points: WELCOME_POINTS, dreamCoins: WELCOME_COINS,
      vipType: "none", vipExpireAt: 0, strikeCount: 0, banned: false,
      lastCheckin: "", createdAt: Date.now(),
    };
    users.byUid[uid] = u; users.byName[key] = uid;
    log(uid, "system", WELCOME_POINTS, "points", "新用户注册赠送积分");
    saveUsers(); saveDB();
    return { ok: true, token: newToken(uid), user: pubUser(u) };
  });
  if (result.err) return res.status(400).json({ error: result.err });
  res.json(result);
});

/* 登录（账号错误5次 → 冻结10分钟） */
app.post("/api/login", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const pwd = String(req.body.password || "");
  const key = "login_" + username.toLowerCase();
  const ban = banLeft(key, 6e4);
  if (ban) return res.status(429).json({ error: `尝试次数过多，请 ${ban} 分钟后再试` });

  const result = await withLock(() => {
    const uid = users.byName[username.toLowerCase()];
    if (!uid) { markFail(key, 5, 6e5); return { err: "账号未注册，请先点击注册" }; }
    const u = users.byUid[uid];
    if (u.banned) return { err: "该账号已被永久封禁，如有疑问请联系主理人" };
    if (!verifyPwd(pwd, u.passwordHash)) { markFail(key, 5, 6e5); return { err: "账号或密码错误" }; }
    vipSweep(u); saveUsers();
    return { ok: true, token: newToken(uid), user: pubUser(u) };
  });
  if (result.err) return res.status(400).json({ error: result.err });
  clearFail(key);
  res.json(result);
});

/* 当前用户资料（钱包/我的页实时拉取） */
app.get("/api/user/profile", (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: "未登录" });
  if (u.banned) return res.status(403).json({ error: "账号已封禁" });
  vipSweep(u); saveUsers();
  res.json({ user: pubUser(u), txs: db.transactions.filter(t => t.uid === u.uid).slice(0, 50) });
});

/* 改昵称（登录态） */
app.post("/api/user/nickname", async (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: "未登录" });
  const n = String(req.body.nickname || "").trim().slice(0, 20);
  if (!n) return res.status(400).json({ error: "昵称不能为空" });
  await withLock(() => { u.nickname = n; saveUsers(); });
  res.json({ ok: true, nickname: n });
});

/* 退出登录：销毁token */
app.post("/api/logout", (req, res) => {
  delete tokens[String(req.headers["x-token"] || "")];
  res.json({ ok: true });
});

/* ============================================================
 * 四、业务接口（全部走 authUser → 真实用户）
 * ============================================================ */
app.get("/api/status", (req, res) => res.json({ keyConfigured: !!AI_API_KEY }));

/* 旧接口兼容：/api/wallet 转发 profile 的扁平结构 */
app.get("/api/wallet", (req, res) => {
  const u = authUser(req); if (!u) return res.status(401).json({ error: "未登录" });
  vipSweep(u); saveUsers();
  res.json({ points: u.points, dreamCoins: u.dreamCoins,
    vipType: u.vipType === "VIPZM" ? 1 : u.vipType === "VIPJF" ? 2 : 0,
    vipExpireTime: u.vipExpireAt, lastCheckin: u.lastCheckin,
    txs: db.transactions.filter(t => t.uid === u.uid).slice(0, 50) });
});

/* AI 生成 + 原子扣费 + 失败退款 */
app.post("/api/generate", async (req, res) => {
  const u0 = authUser(req); if (!u0) return res.status(401).json({ error: "请先登录后再造梦" });
  if (u0.banned) return res.status(403).json({ error: "账号已封禁" });
  const { prompt = "", modelId = "basic", baseUrl, model } = req.body;
  const isAdmin = req.headers["x-admin-token"] === ADMIN_TOKEN;
  const tier = TIERS[modelId] || TIERS.basic;
  const cost = tier.cost + (prompt.length > EXTRA_CHARS ? EXTRA_COST : 0);
  if (!AI_API_KEY) return res.status(503).json({ error: "服务端未配置 AI_API_KEY" });

  let deducted = false;
  await withLock(() => {
    const u = users.byUid[u0.uid]; vipSweep(u);
    if (u.points < cost) return;
    u.points -= cost; deducted = true;
    log(u.uid, "ai", -cost, "points", `AI生成(${modelId})${prompt.length > EXTRA_CHARS ? " 含超字数+5" : ""}`);
    saveUsers(); saveDB();
  });
  if (!deducted)
    return res.status(402).json({ error: `积分不足：本档需 ${cost}，当前余额 ${u0.points}，可去钱包兑换卡密`, points: u0.points });

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
    await withLock(() => { const u = users.byUid[u0.uid]; u.points += cost; log(u.uid, "refund", +cost, "points", "AI失败退款"); saveUsers(); saveDB(); });
    res.status(502).json({ error: "生成失败已退款：" + e.message });
  }
});

/* 管理员验证 */
app.post("/api/admin/verify", (req, res) => res.json({ admin: req.headers["x-admin-token"] === ADMIN_TOKEN }));

/* 批量生成动态卡密（管理员） */
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

/* 卡密库存看板（管理员） */
app.get("/api/admin/cards", (req, res) => {
  if (req.headers["x-admin-token"] !== ADMIN_TOKEN) return res.status(403).json({ error: "无权" });
  const stats = {}, usedList = [];
  for (const c of Object.values(cards)) {
    const s = stats[c.tier] || (stats[c.tier] = { total: 0, left: 0, used: 0 });
    s.total++;
    if (c.used) { s.used++; usedList.push({ code: c.code, tier: c.tier, usedBy: c.usedBy, usedAt: c.usedAt }); }
    else s.left++;
  }
  usedList.sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0));
  res.json({ stats, usedList: usedList.slice(0, 100), totalCards: Object.keys(cards).length });
});

/* 统一核销（锁内原子 + 防爆破） */
app.post("/api/redeem", async (req, res) => {
  const u0 = authUser(req); if (!u0) return res.status(401).json({ error: "请先登录后再兑换" });
  if (u0.banned) return res.status(403).json({ error: "账号已封禁" });
  const code = String(req.body.code || "").trim().toUpperCase();
  const key = "rd_" + u0.uid;
  const ban = banLeft(key, 6e4);
  if (ban) return res.status(429).json({ error: `输错次数过多，兑换已冻结 ${ban} 分钟` });
  const result = await withLock(() => {
    const c = cards[code];
    if (!c) return { err: "序列号无效" };
    if (c.used) return { err: "该序列号已被核销" };
    const u = users.byUid[u0.uid]; vipSweep(u);
    c.used = true; c.usedBy = u.uid; c.usedAt = Date.now();
    let msg;
    if (CARD_RULES[c.tier]) msg = CARD_RULES[c.tier](u);
    else if (c.genType && GEN_TYPES[c.genType]) msg = GEN_TYPES[c.genType].apply(u, c.amount);
    else return { err: "序列号配置异常" };
    const cur = c.tier === "ZM1K" || c.tier === "VIPZM" || c.genType === "coins" ? "coins"
              : c.tier.startsWith("VIP") || (c.genType || "").startsWith("vip") ? "vip" : "points";
    log(u.uid, "redeem", c.amount || 0, cur, `兑换 ${code} → ${msg}`);
    saveUsers(); saveDB(); saveCards();
    return { ok: true, msg };
  });
  if (result.err) { markFail(key, 5, 36e5); return res.status(400).json({ error: result.err }); }
  clearFail(key);
  res.json(result);
});

/* 每日签到 */
app.post("/api/checkin", async (req, res) => {
  const u0 = authUser(req); if (!u0) return res.status(401).json({ error: "请先登录后再签到" });
  const today = new Date().toISOString().slice(0, 10);
  const result = await withLock(() => {
    const u = users.byUid[u0.uid]; vipSweep(u);
    if (u.lastCheckin === today) return { err: "今日已签到，明天再来吧" };
    u.lastCheckin = today;
    let msg;
    if (u.vipType === "VIPZM") { u.dreamCoins += 100; msg = "站点大会员签到 +100 造梦币"; log(u.uid, "checkin", 100, "coins", msg); }
    else if (u.vipType === "VIPJF") { u.points += 100; msg = "积分大会员签到 +100 积分"; log(u.uid, "checkin", 100, "points", msg); }
    else { u.dreamCoins += 10; msg = "签到成功 +10 造梦币"; log(u.uid, "checkin", 10, "coins", msg); }
    saveUsers(); saveDB();
    return { ok: true, msg };
  });
  if (result.err) return res.status(400).json({ error: result.err });
  res.json(result);
});

/* 打赏（A→B，平台抽成10%，锁内事务） */
app.post("/api/tip", async (req, res) => {
  const u0 = authUser(req); if (!u0) return res.status(401).json({ error: "请先登录后再打赏" });
  const amt = Math.floor(parseInt(req.body.amount) || 0);
  const toUid = String(req.body.toUid || "").slice(0, 40);
  if (amt <= 0 || amt > 100000) return res.status(400).json({ error: "金额无效" });
  if (!toUid || toUid === u0.uid) return res.status(400).json({ error: "不能打赏自己" });
  const result = await withLock(() => {
    const a = users.byUid[u0.uid];
    if (a.dreamCoins < amt) return { err: `造梦币不足：需 ${amt}，当前 ${a.dreamCoins}` };
    const b = users.byUid[toUid];
    if (!b) return { err: "对方用户不存在" };
    const fee = Math.floor(amt * 0.1);
    a.dreamCoins -= amt; b.dreamCoins += amt - fee; db.platform.dreamCoins += fee;
    log(a.uid, "tip_out", -amt, "coins", `打赏 ${toUid}（对方实收${amt - fee}，平台抽成${fee}）`);
    log(b.uid, "tip_in", +(amt - fee), "coins", `收到 ${a.uid} 打赏`);
    saveUsers(); saveDB();
    return { ok: true, msg: `打赏成功！对方实收 ${amt - fee} 造梦币` };
  });
  if (result.err) return res.status(400).json({ error: result.err });
  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`造梦空间站 → http://localhost:${PORT}`));
