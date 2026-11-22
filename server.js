/**
 * 造梦空间站 v3 - 轻量后端代理
 * 源光工坊 · 明码标价 · 规则透明 · 密钥不出后端
 */
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

/* ================= ★ 安全配置区 ★ =================
 * ★★★ 主理人管理口令在这里修改 ★★★
 * 推荐：启动前设置环境变量  export ADMIN_TOKEN=你的口令
 * =================================================== */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "yuanguang-2024";

// 服务端密钥：只从环境变量读取，前端永远拿不到、也改不了
const API_KEY = process.env.AI_API_KEY || "";
const DEFAULT_BASE_URL = process.env.AI_BASE_URL || "https://api.deepseek.com";
const DEFAULT_MODEL = process.env.AI_MODEL || "deepseek-chat";

/* ===== 可用模型白名单（前端档位 → 真实上游模型名）=====
 * 普通用户只能从这 5 个档位里选，后端映射到环境变量配置的真实模型。
 * 想换真实模型名：改环境变量即可，如 export MODEL_BASIC=gemini-2.0-flash
 */
const MODEL_MAP = {
  basic:  process.env.MODEL_BASIC  || DEFAULT_MODEL,   // 平民版 · Gemini 快速（5积分）
  gpt4:   process.env.MODEL_GPT4   || DEFAULT_MODEL,   // ChatGPT 4（10积分）
  opus45: process.env.MODEL_OPUS45 || DEFAULT_MODEL,   // Opus 4.5（13积分）
  pro:    process.env.MODEL_PRO    || DEFAULT_MODEL,   // 高级版 · ChatGPT 5（15积分）
  ultra:  process.env.MODEL_ULTRA  || DEFAULT_MODEL    // 终极版 · Opus 5.5（20积分）
};
// 各档位代码规模约束（注入系统提示词）
const TIER_LIMIT = {
  basic:  { lines: "严格限制在40行以内的精简代码，只实现最基础玩法逻辑", maxTokens: 2500 },
  gpt4:   { lines: "代码规模适中，功能完整可玩", maxTokens: 5000 },
  opus45: { lines: "代码规模适中偏大，逻辑完整、手感细腻", maxTokens: 6000 },
  pro:    { lines: "限制在150行左右，包含完整UI界面与流畅动画", maxTokens: 6000 },
  ultra:  { lines: "可写200-300行，允许实现复杂物理引擎与高级效果", maxTokens: 8000 }
};

app.use(express.json({ limit: "4mb" }));
app.use(express.static(__dirname));

const SYSTEM_PROMPT = `你是【造梦空间站】的造梦AI，与用户以对话方式协作创作 HTML5 小游戏或互动网页。

【铁律】当用户要求生成/修改作品时，你只输出一个完整的、零外部依赖的单文件 HTML5 代码：
1. 所有 CSS 写在 <style> 内，所有 JS 写在 <script> 内，禁止引用任何 CDN/外部图片/外部字体。
2. 使用 <canvas> 或 DOM 实现，必须支持触屏（touchstart/touchmove）与鼠标操作。
3. 禁止输出任何解释文字、禁止 Markdown 代码块标记，第一行就是 <!DOCTYPE html>，最后一行就是 </html>。
4. 始终在作品左下角内置手机端虚拟摇杆触控适配（半透明圆形摇杆，拖动控制方向）。
5. 用户只是聊天/提问/描述想法而未要求出码时，用简短中文正常回复即可。`;

function isAdmin(req) {
  return ADMIN_TOKEN && req.headers["x-admin-token"] === ADMIN_TOKEN;
}

app.post("/api/admin/verify", (req, res) => {
  res.json({ admin: isAdmin(req) });
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    keyConfigured: Boolean(API_KEY),
    defaultModel: DEFAULT_MODEL,
    defaultBaseUrl: DEFAULT_BASE_URL,
    models: Object.keys(MODEL_MAP) // 只暴露档位id，不暴露真实模型名
  });
});

// 核心生成接口（对话式）
app.post("/api/generate", async (req, res) => {
  const { prompt, modelId, baseUrl, model } = req.body || {};

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "消息不能为空" });
  }
  if (!API_KEY) {
    return res.status(500).json({ error: "服务端未配置 AI_API_KEY 环境变量，请先设置后重启。" });
  }

  const admin = isAdmin(req);
  // 通道：普通用户走默认通道+白名单档位；主理人可覆写
  const useBase = (admin && baseUrl ? baseUrl : DEFAULT_BASE_URL).replace(/\/+$/, "");
  let useModel, tier;
  if (admin && model) {
    useModel = model; tier = TIER_LIMIT.pro;
  } else {
    const id = MODEL_MAP[modelId] ? modelId : "basic";
    useModel = MODEL_MAP[id];
    tier = TIER_LIMIT[id];
  }

  const sysPrompt = SYSTEM_PROMPT + `\n6. 本档位要求：${tier.lines}。`;

  try {
    const upstream = await fetch(`${useBase}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: useModel,
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: prompt.trim() }
        ],
        temperature: 0.7,
        max_tokens: tier.maxTokens
      })
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: `上游接口错误 ${upstream.status}: ${(data && data.error && data.error.message) || JSON.stringify(data).slice(0, 300)}`
      });
    }

    const content = data.choices?.[0]?.message?.content || "";

    // 尝试提取 HTML；提取不到则当普通对话文本返回
    let html = "";
    const fence = content.match(/```(?:html)?\s*([\s\S]*?)```/i);
    let cand = fence ? fence[1] : content;
    const docStart = cand.search(/<!DOCTYPE html|<html/i);
    if (docStart !== -1) {
      let h = cand.slice(docStart);
      const docEnd = h.lastIndexOf("</html>");
      if (docEnd !== -1) h = h.slice(0, docEnd + 7);
      if (h.length > 200) html = h.trim();
    }

    res.json({ html, text: html ? "" : content, model: useModel, usage: data.usage || null });
  } catch (err) {
    res.status(502).json({ error: `连接上游失败: ${err.message}` });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`🛰️  造梦空间站已点火 → http://localhost:${PORT}`);
  console.log(`🔑  API Key: ${API_KEY ? "已配置 ✅" : "未配置 ⚠️ (请设置 AI_API_KEY)"}`);
  console.log(`🛡️  主理人口令: ${process.env.ADMIN_TOKEN ? "环境变量 ✅" : "默认值 ⚠️ 请修改 ADMIN_TOKEN"}`);
});
