/* ============================================================
 * 造梦空间站 · 商业级后端  server.js
 * 数据文件：users_db.json / db.json / cards_db.json
 *          works_db.json / products_db.json / orders_db.json / videos_db.json
 * 机制：Express + JSON持久化 + 全局互斥锁 + token登录
 * ============================================================ */
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "3mb" }));
app.use(express.static(__dirname));

/* ---------- 环境配置 ---------- */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "yuanguang-2024"; // ⚠️上线必改
const AI_API_KEY  = process.env.AI_API_KEY  || "";
const AI_BASE     = process.env.AI_BASE_URL || "https://api.openai.com/v1";
const AI_MODEL    = process.env.AI_MODEL    || "gpt-4o-mini";

const TIERS = {
  basic:  { cost: 5,  env: "MODEL_BASIC",  maxTokens: 1200, sys: "代码必须控制在40行以内，仅核心逻辑。" },
  gpt4:   { cost: 10, env: "MODEL_GPT4",   maxTokens: 2500, sys: "" },
  opus45: { cost: 13, env: "MODEL_OPUS45", maxTokens: 3000, sys: "" },
  pro:    { cost: 15, env: "MODEL_PRO",    maxTokens: 4000, sys: "代码控制在150行左右，含完整UI与动画。" },
  ultra:  { cost: 20, env: "MODEL_ULTRA",  maxTokens: 8000, sys: "可写200-300行，含复杂物理引擎。" },
};
const tierModel = id => process.env[TIERS[id].env] || AI_MODEL;
const EXTRA_CHARS = 500, EXTRA_COST = 5;
const WELCOME_POINTS = 100, WELCOME_COINS = 50;

/* ============================================================
 * 一、通用持久化层
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

/* ---------- 用户库 ---------- */
const USERS_FILE = path.join(__dirname, "users_db.json");
let users = loadJSON(USERS_FILE, { byUid: {}, byName: {} });
const saveUsers = () => makeSaver(USERS_FILE)(users);

/* ---------- 流水库 ---------- */
const DB_FILE = path.join(__dirname, "db.json");
let db = loadJSON(DB_FILE, { transactions: [], platform: { dreamCoins: 0 } });
const saveDB = () => makeSaver(DB_FILE)(db);
const log = (uid, kind, delta, cur, note) =>
  db.transactions.unshift({ uid, kind, delta, cur, note, time: Date.now() });

/* ---------- 卡密库 ---------- */
const CARDS_FILE = path.join(__dirname, "cards_db.json");
let cards = loadJSON(CARDS_FILE, {});
const saveCards = () => makeSaver(CARDS_FILE)(cards);

/* ---------- 作品库（游戏） ---------- */
const WORKS_FILE = path.join(__dirname, "works_db.json");
let worksDB = loadJSON(WORKS_FILE, { list: [] });
const saveWorks = () => makeSaver(WORKS_FILE)(worksDB);

/* ---------- 商品库 / 订单库 ---------- */
const PROD_FILE = path.join(__dirname, "products_db.json");
const ORDER_FILE = path.join(__dirname, "orders_db.json");
let productsDB = loadJSON(PROD_FILE, { list: [] });
let ordersDB = loadJSON(ORDER_FILE, { list: [] });
const saveProducts = () => makeSaver(PROD_FILE)(productsDB);
const saveOrders = () => makeSaver(ORDER_FILE)(ordersDB);

/* ---------- 视频库 ---------- */
const VIDEO_FILE = path.join(__dirname, "videos_db.json");
let videosDB = loadJSON(VIDEO_FILE, { list: [] });
const saveVideos = () => makeSaver(VIDEO_FILE)(videosDB);

/* ---------- 旧版游客数据迁移 ---------- */
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
  console.log("🔄 已迁移旧版游客数据");
}

/* ---------- 125 预置卡密 ---------- */
const SEED_CODES = {
  JF100: `ZMKJZ-JF100-8K9M-2P4X ZMKJZ-JF100-7H3N-9W6L ZMKJZ-JF100-4R8V-5Q2T ZMKJZ-JF100-9D2B-6Y7J ZMKJZ-JF100-3F6C-8M1Z ZMKJZ-JF100-5G9H-4K8P ZMKJZ-JF100-2L7W-3N5R ZMKJZ-JF100-6T4Q-9X2V ZMKJZ-JF100-8Y1J-7B4D ZMKJZ-JF100-1M5Z-2C8F ZMKJZ-JF100-9P3K-5H7G ZMKJZ-JF100-4W8N-6R2L ZMKJZ-JF100-7Q2X-8V9T ZMKJZ-JF100-3B6D-4J1Y ZMKJZ-JF100-5C9F-2Z7M ZMKJZ-JF100-2H4G-9K3P ZMKJZ-JF100-8N7L-1R6W ZMKJZ-JF100-6X2T-4Q8V ZMKJZ-JF100-9J5Y-7D3B ZMKJZ-JF100-1Z8M-5F2C ZMKJZ-JF100-4K3P-8G6H ZMKJZ-JF100-7R9W-2L4N ZMKJZ-JF100-3V2Q-6T9X ZMKJZ-JF100-5D7B-1Y8J ZMKJZ-JF100-8F4C-9M2Z`,
  JF500: `ZMKJZ-JF500-3P9K-7M2X ZMKJZ-JF500-8W4L-2H6N ZMKJZ-JF500-5Q2T-9R8V ZMKJZ-JF500-2Y7J-4D3B ZMKJZ-JF500-9M1Z-6F8C ZMKJZ-JF500-4K8P-1G5H ZMKJZ-JF500-7N5R-8L2W ZMKJZ-JF500-1X2V-3T6Q ZMKJZ-JF500-6B4D-9Y7J ZMKJZ-JF500-3C8F-2M5Z ZMKJZ-JF500-8H7G-4P9K ZMKJZ-JF500-5R2L-7W3N ZMKJZ-JF500-2V9T-6Q1X ZMKJZ-JF500-9J1Y-8B4D ZMKJZ-JF500-4Z7M-3C2F ZMKJZ-JF500-7G3P-5H8K ZMKJZ-JF500-1L6W-9N2R ZMKJZ-JF500-6Q8V-4X5T ZMKJZ-JF500-3D3B-7J9Y ZMKJZ-JF500-8F2C-1Z6M ZMKJZ-JF500-5P6H-2K4G ZMKJZ-JF500-2W4N-8R7L ZMKJZ-JF500-9T9X-3V1Q ZMKJZ-JF500-4Y8J-6D5B ZMKJZ-JF500-7M2Z-9F3C`,
  VIPJF: `ZMKJZ-VIPJF-6K2M-9P8X ZMKJZ-VIPJF-2H7N-4W3L ZMKJZ-VIPJF-9R4V-1Q6T ZMKJZ-VIPJF-4D8B-7Y2J ZMKJZ-VIPJF-7F1Z-3M9C ZMKJZ-VIPJF-1G5H-8K4P ZMKJZ-VIPJF-8L9W-2N7R ZMKJZ-VIPJF-3T2Q-6X5V ZMKJZ-VIPJF-6Y6J-9B1D ZMKJZ-VIPJF-2M3Z-5C8F ZMKJZ-VIPJF-9P7K-4H2G ZMKJZ-VIPJF-4W1N-8R6L ZMKJZ-VIPJF-7Q5X-3V9T ZMKJZ-VIPJF-1B9D-6J4Y ZMKJZ-VIPJF-8C2F-2Z7M ZMKJZ-VIPJF-3H6G-7K1P ZMKJZ-VIPJF-6N8L-9R4W ZMKJZ-VIPJF-2X4T-5Q2V ZMKJZ-VIPJF-9J7Y-1D8B ZMKJZ-VIPJF-4Z3M-8F5C ZMKJZ-VIPJF-7K9P-3G2H ZMKJZ-VIPJF-1R2W-6L7N ZMKJZ-VIPJF-8V5Q-4T9X ZMKJZ-VIPJF-3D1B-9Y6J ZMKJZ-VIPJF-6F8C-2M4Z`,
  VIPZM: `ZMKJZ-VIPZM-4M8K-3P2X ZMKJZ-VIPZM-9N3H-7W5L ZMKJZ-VIPZM-2V6R-4Q9T ZMKJZ-VIPZM-7B1D-8Y4J ZMKJZ-VIPZM-5Z9F-2M6C ZMKJZ-VIPZM-8H2G-6K1P ZMKJZ-VIPZM-3W4N-9L8R ZMKJZ-VIPZM-6Q7X-1T3V ZMKJZ-VIPZM-1J5Y-4B9D ZMKJZ-VIPZM-4F2C-7Z6M ZMKJZ-VIPZM-9K8P-2H4G ZMKJZ-VIPZM-2L3W-5R1N ZMKJZ-VIPZM-7T6Q-8V2X ZMKJZ-VIPZM-5Y9J-3D7B ZMKJZ-VIPZM-8M4Z-1F8C ZMKJZ-VIPZM-3G1H-6P9K ZMKJZ-VIPZM-6R7L-4W2N ZMKJZ-VIPZM-1X2V-9Q5T ZMKJZ-VIPZM-4D8B-2J3Y ZMKJZ-VIPZM-9C5F-7M1Z ZMKJZ-VIPZM-2P6K-3G8H ZMKJZ-VIPZM-7N9W-8L4R ZMKJZ-VIPZM-5Q3T-1X6V ZMKJZ-VIPZM-8B7D-6Y2J ZMKJZ-VIPZM-3Z4M-9F5C`,
  ZM1K: `ZMKJZ-ZM1K-7P4K-2M9X ZMKJZ-ZM1K-3L8W-6H1N ZMKJZ-ZM1K-8T2Q-5R7V ZMKJZ-ZM1K-4J9Y-1D6B ZMKJZ-ZM1K-9C5F-8Z3M ZMKJZ-ZM1K-2K1P-4G7H ZMKJZ-ZM1K-6R7N-9L2W ZMKJZ-ZM1K-1V3X-3Q8T ZMKJZ-ZM1K-5D6B-7J4Y ZMKJZ-ZM1K-8Z2M-2F9C ZMKJZ-ZM1K-3H8G-5P1K ZMKJZ-ZM1K-7W4L-1R6N ZMKJZ-ZM1K-2Q9V-8T3X ZMKJZ-ZM1K-6Y1J-4B5D ZMKJZ-ZM1K-9M7Z-6C2F ZMKJZ-ZM1K-4G3P-9H8K ZMKJZ-ZM1K-8N5R-2W4L ZMKJZ-ZM1K-3X6T-7V1Q ZMKJZ-ZM1K-7B2D-3Y9J ZMKJZ-ZM1K-1F8C-5M6Z ZMKJZ-ZM1K-5K4H-8G2P ZMKJZ-ZM1K-9L9W-4N7R ZMKJZ-ZM1K-4T1Q-6X3V ZMKJZ-ZM1K-8J5Y-2D8B ZMKJZ-ZM1K-2C7M-9F4C`,
};
const CARD_RULES = {
  JF100: u => { u.points += 100; return "到账 +100 积分"; },
  JF500: u => { u.points += 500; return "到账 +500 积分"; },
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
let seeded = 0;
for (const [tier, list] of Object.entries(SEED_CODES))
  for (const code of list.trim().split(/\s+/))
    if (!cards[code]) { cards[code] = { code, tier, used: false, usedBy: null, usedAt: null }; seeded++; }
saveCards();
if (seeded) console.log(`🎫 卡密库：补入 ${seeded} 个，共 ${Object.keys(cards).length} 个`);

/* ============================================================
 * 二、锁 / 用户工具 / 认证
 * ============================================================ */
let lock = Promise.resolve();
const withLock = fn => { const r = lock.then(fn); lock = r.catch(() => {}); return r; };

const vipSweep = u => { if (u.vipType && u.vipType !== "none" && (u.vipExpireAt || 0) < Date.now()) u.vipType = "none"; };

const hashPwd = (pwd, salt) => {
  salt = salt || crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(pwd, salt, 64).toString("hex");
};
const verifyPwd = (pwd, stored) => {
  const [salt, h] = String(stored || "").split(":");
  if (!salt || !h) return false;
  const chk = crypto.scryptSync(pwd, salt, 64);
  const ref = Buffer.from(h, "hex");
  return chk.length === ref.length && crypto.timingSafeEqual(chk, ref);
};

const tokens = {};
const newToken = uid => { const t = "tk_" + crypto.randomBytes(24).toString("hex"); tokens[t] = uid; return t; };
const authUser = req => {
  const tk = String(req.headers["x-token"] || "");
  const uid = tokens[tk] || String(req.headers["x-uid"] || req.body?.uid || "").slice(0, 40);
  return uid ? (users.byUid[uid] || null) : null;
};
const pubUser = u => ({ uid: u.uid, username: u.username, nickname: u.nickname,
  points: u.points, dreamCoins: u.dreamCoins, vipType: u.vipType, vipExpireAt: u.vipExpireAt,
  strikeCount: u.strikeCount, banned: !!u.banned, lastCheckin: u.lastCheckin });

const failMap = {};
const banLeft = (key, ms) => { const f = failMap[key]; return f && f.banUntil > Date.now() ? Math.ceil((f.banUntil - Date.now()) / ms) : 0; };
const markFail = (key, max, banMs) => { const f = failMap[key] || { n: 0, banUntil: 0 }; f.n++; if (f.n >= max) { f.banUntil = Date.now() + banMs; f.n = 0; } failMap[key] = f; };
const clearFail = key => { delete failMap[key]; };
const rand6 = () => crypto.randomBytes(3).toString("hex").toUpperCase();
const nid = () => Date.now().toString(36) + crypto.randomBytes(3).toString("hex");

/* ============================================================
 * 三、账号接口
 * ============================================================ */
app.post("/api/register", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const pwd = String(req.body.password || ""), pwd2 = String(req.body.password2 || "");
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5]{3,16}$/.test(username))
    return res.status(400).json({ error: "账号需为3-16位（字母/数字/中文/下划线）" });
  if (pwd.length < 6) return res.status(400).json({ error: "密码不少于6位" });
  if (pwd !== pwd2) return res.status(400).json({ error: "两次密码输入不一致" });
  const result = await withLock(() => {
    const key = username.toLowerCase();
    if (users.byName[key]) return { err: "该账号已被注册，请直接登录" };
    const uid = "u_" + crypto.randomBytes(5).toString("hex");
    const u = { uid, username, passwordHash: hashPwd(pwd), nickname: username,
      points: WELCOME_POINTS, dreamCoins: WELCOME_COINS, vipType: "none", vipExpireAt: 0,
      strikeCount: 0, banned: false, lastCheckin: "", createdAt: Date.now() };
    users.byUid[uid] = u; users.byName[key] = uid;
    log(uid, "system", WELCOME_POINTS, "points", "新用户注册赠送积分");
    saveUsers(); saveDB();
    return { ok: true, token: newToken(uid), user: pubUser(u) };
  });
  if (result.err) return res.status(400).json({ error: result.err });
  res.json(result);
});

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
  clearFail(key); res.json(result);
});

app.get("/api/user/profile", (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: "未登录" });
  if (u.banned) return res.status(403).json({ error: "账号已封禁" });
  vipSweep(u); saveUsers();
  res.json({ user: pubUser(u), txs: db.transactions.filter(t => t.uid === u.uid).slice(0, 50) });
});

app.post("/api/user/nickname", async (req, res) => {
  const u = authUser(req); if (!u) return res.status(401).json({ error: "未登录" });
  const n = String(req.body.nickname || "").trim().slice(0, 20);
  if (!n) return res.status(400).json({ error: "昵称不能为空" });
  await withLock(() => { u.nickname = n; saveUsers(); });
  res.json({ ok: true, nickname: n });
});

app.post("/api/logout", (req, res) => {
  delete tokens[String(req.headers["x-token"] || "")];
  res.json({ ok: true });
});

/* ============================================================
 * 四、搜索接口（游戏 / 用户 / 商品）
 * ============================================================ */
app.get("/api/search", (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (!q) return res.json({ q: "", games: [], users: [], products: [], counts: { games: 0, users: 0, products: 0 } });
  const hit = (...arr) => arr.some(x => String(x || "").toLowerCase().includes(q));

  // 游戏 = 作品 + 视频
  const games = [];
  for (const w of worksDB.list)
    if (hit(w.title, w.desc, w.authorName)) games.push({ id: w.id, type: "游戏", title: w.title, desc: w.desc, authorName: w.authorName, price: w.price });
  for (const v of videosDB.list)
    if (hit(v.title, v.desc, v.authorName, (v.tags || []).join(" ")))
      games.push({ id: v.id, type: "视频", title: v.title, desc: v.desc, authorName: v.authorName, url: v.url, tags: v.tags });

  // 用户（仅公开字段）
  const userList = [];
  for (const uid of Object.keys(users.byUid)) {
    const u = users.byUid[uid];
    if (!u.username) continue;
    if (hit(u.username, u.nickname, u.uid))
      userList.push({ uid: u.uid, username: u.username, nickname: u.nickname, vipType: u.vipType });
  }

  // 商品
  const productList = productsDB.list
    .filter(p => hit(p.name, p.desc, p.sellerName))
    .map(p => ({ id: p.id, name: p.name, desc: p.desc, price: p.price, sales: p.sales, sellerName: p.sellerName }));

  res.json({ q, games: games.slice(0, 60), users: userList.slice(0, 60), products: productList.slice(0, 60),
    counts: { games: games.length, users: userList.length, products: productList.length } });
});

/* ============================================================
 * 五、作品（游戏）接口
 * ============================================================ */
app.get("/api/works", (req, res) => res.json({ list: worksDB.list }));

app.post("/api/works", async (req, res) => {
  const u = authUser(req); if (!u) return res.status(401).json({ error: "请先登录" });
  const { title = "", desc = "", html = "", price = "免费试玩" } = req.body;
  if (!html) return res.status(400).json({ error: "作品内容为空" });
  const w = { id: nid(), uid: u.uid, authorName: u.nickname, title: String(title).slice(0, 40) || "未命名梦境",
    desc: String(desc).slice(0, 200), price: String(price).slice(0, 20), html, createdAt: Date.now() };
  await withLock(() => { worksDB.list.unshift(w); saveWorks(); });
  res.json({ ok: true, work: w });
});

app.delete("/api/works/:id", async (req, res) => {
  const u = authUser(req); if (!u) return res.status(401).json({ error: "请先登录" });
  const w = worksDB.list.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: "作品不存在" });
  if (w.uid !== u.uid) return res.status(403).json({ error: "只能删除自己的作品" });
  await withLock(() => { worksDB.list = worksDB.list.filter(x => x.id !== w.id); saveWorks(); });
  res.json({ ok: true });
});

/* ============================================================
 * 六、商品 / 订单 / 结算
 * ============================================================ */
app.get("/api/products", (req, res) => res.json({ list: productsDB.list }));

app.post("/api/products", async (req, res) => {
  const u = authUser(req); if (!u) return res.status(401).json({ error: "请先登录" });
  const name = String(req.body.name || "").trim().slice(0, 40);
  const desc = String(req.body.desc || "").trim().slice(0, 200);
  const price = Math.floor(parseInt(req.body.price) || 0);
  if (!name) return res.status(400).json({ error: "商品名称不能为空" });
  if (price <= 0 || price > 1000000) return res.status(400).json({ error: "价格需为正整数造梦币" });
  const p = { id: nid(), uid: u.uid, sellerName: u.nickname, name, desc, price, sales: 0, createdAt: Date.now() };
  await withLock(() => { productsDB.list.unshift(p); saveProducts(); });
  res.json({ ok: true, product: p });
});

app.post("/api/products/:id/buy", async (req, res) => {
  const buyer0 = authUser(req); if (!buyer0) return res.status(401).json({ error: "请先登录后再购买" });
  const result = await withLock(() => {
    const p = productsDB.list.find(x => x.id === req.params.id);
    if (!p) return { err: "商品不存在或已下架" };
    if (p.uid === buyer0.uid) return { err: "不能购买自己的商品" };
    const buyer = users.byUid[buyer0.uid];
    const seller = users.byUid[p.uid];
    if (!seller) return { err: "卖家账号不存在" };
    if (buyer.dreamCoins < p.price) return { err: `造梦币不足：需 ${p.price}，当前 ${buyer.dreamCoins}` };
    buyer.dreamCoins -= p.price;
    seller.dreamCoins += p.price;
    p.sales = (p.sales || 0) + 1;
    const order = { id: nid(), productId: p.id, productName: p.name, buyerUid: buyer.uid, buyerName: buyer.nickname,
      sellerUid: seller.uid, sellerName: seller.nickname, price: p.price, time: Date.now() };
    ordersDB.list.unshift(order);
    log(buyer.uid, "buy_out", -p.price, "coins", `购买商品「${p.name}」（卖家 ${seller.nickname}）`);
    log(seller.uid, "sell_in", +p.price, "coins", `售出商品「${p.name}」（买家 ${buyer.nickname}）`);
    saveUsers(); saveDB(); saveProducts(); saveOrders();
    return { ok: true, msg: `购买成功！已支付 ${p.price} 造梦币`, product: { id: p.id, name: p.name, desc: p.desc, sales: p.sales } };
  });
  if (result.err) return res.status(400).json({ error: result.err });
  res.json(result);
});

app.get("/api/orders", (req, res) => {
  const u = authUser(req); if (!u) return res.status(401).json({ error: "未登录" });
  res.json({ list: ordersDB.list.filter(o => o.buyerUid === u.uid || o.sellerUid === u.uid).slice(0, 50) });
});

/* ============================================================
 * 七、视频专区：发布 / 投币 / 收藏 / 点赞(+1造梦币) / 留言
 * ============================================================ */
app.get("/api/videos", (req, res) => {
  const u = authUser(req);
  const list = videosDB.list.map(v => ({ ...v, coins: v.coins || 0,
    favedBy: v.favedBy || [], likedBy: v.likedBy || [], comments: v.comments || [] }));
  res.json({ list, myUid: u ? u.uid : "" });
});

app.post("/api/videos", async (req, res) => {
  const u = authUser(req); if (!u) return res.status(401).json({ error: "请先登录后再发布视频" });
  const title = String(req.body.title || "").trim().slice(0, 60);
  const desc = String(req.body.desc || "").trim().slice(0, 300);
  const url = String(req.body.url || "").trim().slice(0, 500);
  const tags = String(req.body.tags || "").split(/[,，\s]+/).filter(Boolean).slice(0, 8);
  if (!title) return res.status(400).json({ error: "视频标题不能为空" });
  const v = { id: nid(), uid: u.uid, authorName: u.nickname, title, desc, url, tags,
    coins: 0, favedBy: [], likedBy: [], comments: [], bonusPaid: [], createdAt: Date.now() };
  await withLock(() => { videosDB.list.unshift(v); saveVideos(); });
  res.json({ ok: true, video: v });
});

/* 投币 */
app.post("/api/videos/:id/coin", async (req, res) => {
  const u0 = authUser(req); if (!u0) return res.status(401).json({ error: "请先登录后再投币" });
  const amount = Math.floor(parseInt(req.body.amount) || 0);
  if (amount <= 0 || amount > 10000) return res.status(400).json({ error: "投币数量需为 1 ~ 10000" });
  const result = await withLock(() => {
    const v = videosDB.list.find(x => x.id === req.params.id);
    if (!v) return { err: "视频不存在" };
    if (v.uid === u0.uid) return { err: "不能给视频投自己的币" };
    const a = users.byUid[u0.uid], author = users.byUid[v.uid];
    if (!author) return { err: "作者账号不存在" };
    if (a.dreamCoins < amount) return { err: `造梦币不足：需 ${amount}，当前 ${a.dreamCoins}` };
    a.dreamCoins -= amount; author.dreamCoins += amount; v.coins = (v.coins || 0) + amount;
    log(a.uid, "vcoin_out", -amount, "coins", `给视频「${v.title}」投币`);
    log(author.uid, "vcoin_in", +amount, "coins", `视频「${v.title}」收到 ${a.nickname} 投币`);
    saveUsers(); saveDB(); saveVideos();
    return { ok: true, msg: `投币成功！已投 ${amount} 造梦币`, coins: v.coins };
  });
  if (result.err) return res.status(400).json({ error: result.err });
  res.json(result);
});

/* 收藏 / 取消收藏 */
app.post("/api/videos/:id/fav", async (req, res) => {
  const u0 = authUser(req); if (!u0) return res.status(401).json({ error: "请先登录" });
  const result = await withLock(() => {
    const v = videosDB.list.find(x => x.id === req.params.id);
    if (!v) return { err: "视频不存在" };
    v.favedBy = v.favedBy || [];
    const i = v.favedBy.indexOf(u0.uid);
    let faved;
    if (i >= 0) { v.favedBy.splice(i, 1); faved = false; } else { v.favedBy.push(u0.uid); faved = true; }
    saveVideos();
    return { ok: true, faved, count: v.favedBy.length, msg: faved ? "已收藏" : "已取消收藏" };
  });
  if (result.err) return res.status(400).json({ error: result.err });
  res.json(result);
});

/* 点赞：首次点赞 +1 造梦币（防刷：同一用户对同一视频只奖励一次） */
app.post("/api/videos/:id/like", async (req, res) => {
  const u0 = authUser(req); if (!u0) return res.status(401).json({ error: "请先登录" });
  const result = await withLock(() => {
    const v = videosDB.list.find(x => x.id === req.params.id);
    if (!v) return { err: "视频不存在" };
    v.likedBy = v.likedBy || []; v.bonusPaid = v.bonusPaid || [];
    const i = v.likedBy.indexOf(u0.uid);
    let liked, bonus = 0;
    if (i >= 0) { v.likedBy.splice(i, 1); liked = false; }
    else {
      v.likedBy.push(u0.uid); liked = true;
      if (!v.bonusPaid.includes(u0.uid)) {   // 去重：只奖励一次
        v.bonusPaid.push(u0.uid);
        const u = users.byUid[u0.uid];
        u.dreamCoins += 1; bonus = 1;
        log(u.uid, "like_bonus", +1, "coins", `点赞视频「${v.title}」奖励 +1 造梦币`);
      }
    }
    saveUsers(); saveDB(); saveVideos();
    return { ok: true, liked, count: v.likedBy.length, bonus,
      msg: liked ? (bonus ? "点赞成功！+1 造梦币" : "已点赞（该视频点赞奖励已领取过）") : "已取消点赞" };
  });
  if (result.err) return res.status(400).json({ error: result.err });
  res.json(result);
});

/* 留言 */
app.post("/api/videos/:id/comment", async (req, res) => {
  const u0 = authUser(req); if (!u0) return res.status(401).json({ error: "请先登录后再留言" });
  const text = String(req.body.text || "").trim().slice(0, 200);
  if (!text) return res.status(400).json({ error: "留言内容不能为空" });
  const result = await withLock(() => {
    const v = videosDB.list.find(x => x.id === req.params.id);
    if (!v) return { err: "视频不存在" };
    v.comments = v.comments || [];
    v.comments.push({ uid: u0.uid, name: u0.nickname, text, time: Date.now() });
    if (v.comments.length > 200) v.comments = v.comments.slice(-200);
    saveVideos();
    return { ok: true, comments: v.comments };
  });
  if (result.err) return res.status(400).json({ error: result.err });
  res.json(result);
});

/* ============================================================
 * 八、钱包 / AI / 兑换 / 签到 / 打赏
 * ============================================================ */
app.get("/api/status", (req, res) => res.json({ keyConfigured: !!AI_API_KEY }));

app.get("/api/wallet", (req, res) => {
  const u = authUser(req); if (!u) return res.status(401).json({ error: "未登录" });
  vipSweep(u); saveUsers();
  res.json({ points: u.points, dreamCoins: u.dreamCoins,
    vipType: u.vipType === "VIPZM" ? 1 : u.vipType === "VIPJF" ? 2 : 0,
    vipExpireTime: u.vipExpireAt, lastCheckin: u.lastCheckin,
    txs: db.transactions.filter(t => t.uid === u.uid).slice(0, 50) });
});

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

app.post("/api/admin/verify", (req, res) => res.json({ admin: req.headers["x-admin-token"] === ADMIN_TOKEN }));

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
  clearFail(key); res.json(result);
});

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
