import http from "node:http";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

loadEnvFile(".env");
loadEnvFile(".env.local");

const port = Number(process.env.PORT || 3000);
const config = {
  ppioApiKey: process.env.PPIO_API_KEY || "",
  ppioImageEndpoint: process.env.PPIO_IMAGE_ENDPOINT || "https://api.ppio.com/v3/async/qwen-image-edit",
  ppioVideoEndpoint: process.env.PPIO_VIDEO_ENDPOINT || "https://api.ppio.com/v3/async/minimax-hailuo-2.3-t2v",
  ppioTaskEndpoint: process.env.PPIO_TASK_ENDPOINT || "https://api.ppio.com/v3/async/task-result",
  ppioChatEndpoint: process.env.PPIO_CHAT_ENDPOINT || "https://api.ppio.com/openai/v1/chat/completions",
  ppioChatModel: process.env.PPIO_CHAT_MODEL || "deepseek/deepseek-v4-flash",
  xfyunAppId: process.env.XFYUN_APPID || "",
  xfyunApiKey: process.env.XFYUN_API_KEY || "",
  xfyunApiSecret: process.env.XFYUN_API_SECRET || "",
  xfyunIseEndpoint: process.env.XFYUN_ISE_ENDPOINT || "wss://ise-api.xfyun.cn/v2/open-ise",
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/api/health") return sendJson(res, 200, { ok: true, configured: getConfiguredStatus() });
    if (req.method === "POST" && url.pathname === "/api/reading/evaluate") return handleReadingEvaluation(res, await readJson(req));
    if (req.method === "POST" && url.pathname === "/api/media/generate") return handleMediaGeneration(res, await readJson(req));
    if (req.method === "POST" && url.pathname === "/api/media/status") return handleTaskStatus(res, await readJson(req));
    if (req.method === "POST" && url.pathname === "/api/chat") return handleChat(res, await readJson(req));
    return serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: "服务调用失败", detail: error.message });
  }
});

server.listen(port, () => {
  console.log(`古诗词教学智能体已启动：http://localhost:${port}`);
});

function loadEnvFile(fileName) {
  const file = path.join(__dirname, fileName);
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

function getConfiguredStatus() {
  return {
    reading: Boolean(config.xfyunAppId && config.xfyunApiKey && config.xfyunApiSecret),
    imageVideo: Boolean(config.ppioApiKey),
    realtimeChat: Boolean(config.ppioApiKey),
  };
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 60 * 1024 * 1024) throw new Error("请求体过大，请压缩音频或图片后重试");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function handleReadingEvaluation(res, body) {
  const refText = String(body.refText || "").trim();
  if (!refText) return sendJson(res, 400, { error: "请先输入或选择古诗词文本" });
  if (!String(body.audioBase64 || "").trim()) return sendJson(res, 400, { error: "请先录音或上传音频后再提交评测" });

  if (!config.xfyunAppId || !config.xfyunApiKey || !config.xfyunApiSecret) {
    return sendJson(res, 200, buildDemoReadingResult(refText));
  }

  const raw = await callXfyunIse({
    refText,
    titleInfo: body.titleInfo || "",
    audioBase64: body.audioBase64,
  });
  const summary = normalizeReadingResult(raw);
  const readingEvaluation = await generateReadingFeedback(summary, raw);
  return sendJson(res, 200, { mode: "api", provider: "xfyun-ise", raw, summary: { ...summary, readingEvaluation } });
}

async function handleMediaGeneration(res, body) {
  const type = body.type === "video" ? "video" : "image";
  const depiction = String(body.depiction || "").trim();
  if (!depiction) return sendJson(res, 400, { error: "请先输入学生描绘的画面" });
  const prompt = buildVisualPrompt(depiction, body.poemTitle, type);
  if (!config.ppioApiKey) return sendJson(res, 200, buildDemoMediaResult(type, depiction, prompt));

  if (type === "image") {
    const payload = {
      prompt,
      image: body.referenceImage || process.env.PPIO_DEFAULT_REFERENCE_IMAGE || defaultReferenceImage(),
      seed: -1,
      output_format: "png",
      watermark: Boolean(body.watermark),
    };
    const raw = await postJson(config.ppioImageEndpoint, payload, ppioHeaders());
    return sendJson(res, 200, { mode: "api", type, prompt, raw, taskId: raw.task_id });
  }

  const payload = {
    prompt,
    duration: Number(body.duration || 6) === 10 ? 10 : 6,
    resolution: body.resolution || "768P",
    enable_prompt_expansion: true,
    fast_pretreatment: false,
    aigc_watermark: Boolean(body.watermark),
  };
  const raw = await postJson(config.ppioVideoEndpoint, payload, ppioHeaders());
  return sendJson(res, 200, { mode: "api", type, prompt, raw, taskId: raw.task_id });
}

async function handleTaskStatus(res, body) {
  const taskId = String(body.taskId || "").trim();
  if (!taskId) return sendJson(res, 400, { error: "缺少 taskId" });
  if (!config.ppioApiKey) return sendJson(res, 200, { mode: "demo", task: { task_id: taskId, status: "completed", progress_percent: 100 }, images: [], videos: [] });
  const url = new URL(config.ppioTaskEndpoint);
  url.searchParams.set("task_id", taskId);
  const raw = await getJson(url, ppioHeaders());
  return sendJson(res, 200, { mode: "api", raw, ...raw });
}

async function handleChat(res, body) {
  const question = String(body.question || "").trim();
  if (!question) return sendJson(res, 400, { error: "请输入学生问题" });
  const context = { poemTitle: body.poemTitle || "", poemText: body.poemText || "" };
  if (!config.ppioApiKey) return sendJson(res, 200, { mode: "demo", answer: buildDemoAnswer(question, context) });

  const history = Array.isArray(body.history) ? body.history.slice(-12) : [];
  const messages = [
    {
      role: "system",
      content: [
        "你是小学第一学段古诗词课堂里的AI学习伙伴。",
        "回答要短、具体、温和，适合一二年级学生听懂。",
        "优先围绕当前诗词解释字词、诗句意思、朗读停顿、画面想象。",
        "不用表情符号，不写太长的段落。",
        "不要编造诗文、作者、朝代；不确定时直接说明。",
        `当前诗题：${context.poemTitle || "未填写"}`,
        `诗词全文：${context.poemText || "未填写"}`,
      ].join("\n"),
    },
    ...history.filter((item) => item?.role === "user" || item?.role === "assistant").map((item) => ({ role: item.role, content: String(item.content || "").slice(0, 1000) })).filter((item) => item.content),
    { role: "user", content: question },
  ];
  const raw = await postJson(config.ppioChatEndpoint, { model: config.ppioChatModel, messages, temperature: 0.4, max_tokens: 500, stream: false }, ppioHeaders());
  return sendJson(res, 200, { mode: "api", provider: "ppio", model: config.ppioChatModel, raw, answer: extractChatCompletionAnswer(raw) });
}

async function callXfyunIse({ refText, titleInfo, audioBase64 }) {
  if (typeof WebSocket !== "function") throw new Error("当前 Node 环境缺少 WebSocket，请使用 Node 22 或更高版本部署。");
  const audio = Buffer.from(audioBase64, "base64");
  if (!audio.length) throw new Error("音频数据为空");
  const socketUrl = buildXfyunIseUrl();
  const frames = [];
  const xmlParts = [];

  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(socketUrl);
    const timeout = setTimeout(() => finish(reject, new Error("讯飞 ISE 评测超时")), 90000);
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      fn(value);
    };
    ws.addEventListener("open", () => sendXfyunAudioFrames(ws, { refText, titleInfo, audio }).catch((error) => finish(reject, error)));
    ws.addEventListener("message", async (event) => {
      const text = await webSocketMessageToText(event.data);
      const frame = tryParseJson(text);
      frames.push(frame);
      if (Number(frame.code || 0) !== 0) return finish(reject, new Error(frame.message || frame.desc || "讯飞 ISE 返回错误"));
      if (frame?.data?.data) xmlParts.push(Buffer.from(frame.data.data, "base64").toString("utf8"));
      if (Number(frame?.data?.status) === 2) {
        const xml = xmlParts.join("");
        finish(resolve, { provider: "xfyun-ise", frames, xml, result: normalizeXfyunXml(xml) });
      }
    });
    ws.addEventListener("error", () => finish(reject, new Error("讯飞 ISE WebSocket 连接失败")));
    ws.addEventListener("close", () => {
      if (!settled) finish(reject, new Error("讯飞 ISE 连接提前关闭"));
    });
  });
}

function buildXfyunIseUrl() {
  const endpoint = new URL(config.xfyunIseEndpoint);
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${endpoint.host}\ndate: ${date}\nGET ${endpoint.pathname} HTTP/1.1`;
  const signature = crypto.createHmac("sha256", config.xfyunApiSecret).update(signatureOrigin).digest("base64");
  const authorizationOrigin = `api_key="${config.xfyunApiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  endpoint.searchParams.set("authorization", Buffer.from(authorizationOrigin).toString("base64"));
  endpoint.searchParams.set("date", date);
  endpoint.searchParams.set("host", endpoint.host);
  return endpoint.toString();
}

async function sendXfyunAudioFrames(ws, { refText, titleInfo, audio }) {
  const text = Buffer.from(refText, "utf8").toString("base64");
  ws.send(JSON.stringify({
    common: { app_id: config.xfyunAppId },
    business: { sub: "ise", ent: "cn_vip", category: "read_chapter", cmd: "ssb", auf: "audio/L16;rate=16000", aue: "raw", text, tte: "utf-8", rstcd: "utf8", group: "pupil", title: titleInfo || "" },
    data: { status: 0 },
  }));
  const chunkSize = 1280;
  for (let offset = 0; offset < audio.length; offset += chunkSize) {
    const chunk = audio.subarray(offset, offset + chunkSize);
    const isLast = offset + chunkSize >= audio.length;
    ws.send(JSON.stringify({ business: { cmd: "auw", aus: isLast ? 4 : offset === 0 ? 1 : 2 }, data: { status: isLast ? 2 : 1, data: chunk.toString("base64") } }));
    await wait(40);
  }
}

function normalizeXfyunXml(xml) {
  if (!xml) return { overall: null, pron: null, accuracy: null, fluency: null, details: [] };
  const rootAttrs = firstTagAttrs(xml, "rec_paper") || firstTagAttrs(xml, "read_chapter") || firstTagAttrs(xml, "read_sentence") || {};
  const sentenceBlocks = matchTagBlocks(xml, "sentence").concat(matchTagBlocks(xml, "read_sentence"));
  const details = sentenceBlocks.map(({ attrs, inner }) => {
    const words = matchTagBlocks(inner, "word").map(({ attrs: wordAttrs, inner: wordInner }) => normalizeXfyunWord(wordAttrs, wordInner));
    const score = nullableScoreAttr(attrs, ["total_score", "phone_score", "score"]);
    const fluency = nullableScoreAttr(attrs, ["fluency_score", "fluency"]);
    return { text: attrs.content || attrs.text || "", score, fluency: { overall: fluency, pause: fluency, speed: 1 }, snt_details: words };
  }).filter((item) => item.text || item.snt_details.length);
  return {
    overall: nullableScoreAttr(rootAttrs, ["total_score", "score", "overall_score"]),
    pron: nullableScoreAttr(rootAttrs, ["phone_score", "pron_score", "pron"]),
    accuracy: nullableScoreAttr(rootAttrs, ["accuracy_score", "phone_score", "total_score"]),
    fluency: nullableScoreAttr(rootAttrs, ["fluency_score", "fluency"]),
    details: details.length ? details : [{ text: "", score: nullableScoreAttr(rootAttrs, ["total_score", "phone_score", "score"]), fluency: { overall: nullableScoreAttr(rootAttrs, ["fluency_score", "fluency"]) }, snt_details: matchTagBlocks(xml, "word").map(({ attrs, inner }) => normalizeXfyunWord(attrs, inner)) }],
  };
}

function normalizeXfyunWord(attrs, inner) {
  const syll = firstTagAttrs(inner, "syll") || firstTagAttrs(inner, "phone") || {};
  const score = nullableScoreAttr(attrs, ["total_score", "phone_score", "syll_score", "score"]) ?? nullableScoreAttr(syll, ["syll_score", "phone_score", "total_score", "score"]);
  const toneScore = nullableScoreAttr(attrs, ["tone_score"]) ?? nullableScoreAttr(syll, ["tone_score"]);
  const dpMessage = Number(attrs.dp_message || attrs.dp_type || attrs.perr_msg || syll.dp_message || 0);
  return { chn_char: attrs.content || attrs.text || syll.content || "", char: attrs.symbol || attrs.py || attrs.pinyin || syll.symbol || syll.py || syll.pinyin || "", score, tonescore: toneScore, start: Number(attrs.beg_pos || attrs.beg || syll.beg_pos || syll.beg || 0), end: Number(attrs.end_pos || attrs.end || syll.end_pos || syll.end || 0), isMissing: dpMessage > 0 && (score === null || score === 0), dpMessage };
}

function normalizeReadingResult(raw) {
  const result = raw?.result || raw?.data?.result || raw;
  const details = Array.isArray(result?.details) ? result.details : [];
  const charScores = details.flatMap((item) => Array.isArray(item.snt_details) ? item.snt_details : []).map((item) => ({ char: item.chn_char || "", pinyin: item.char || "", score: toHundredOrNull(item.score), toneScore: toHundredOrNull(item.tonescore), isMissing: Boolean(item.isMissing) })).filter((item) => isChineseChar(item.char));
  const problemChars = uniqueByChar(charScores.filter((item) => !item.isMissing && ((item.score !== null && item.score < 70) || (item.toneScore !== null && item.toneScore < 70))).sort((a, b) => (a.score ?? 101) - (b.score ?? 101))).slice(0, 10);
  const sentenceTips = details.map((item) => ({ text: item.text || "", score: toHundredOrNull(item.score), fluency: toHundredOrNull(item?.fluency?.overall), tip: buildSentenceTip(item), type: "expression" })).filter((item) => (item.score !== null && item.score < 85) || (item.fluency !== null && item.fluency < 82)).slice(0, 6);
  const sentenceAverage = averageNullable(details.map((item) => toHundredOrNull(item.score)));
  const charAverage = averageNullable(charScores.map((item) => item.score));
  const fluencyAverage = averageNullable(details.map((item) => toHundredOrNull(item?.fluency?.overall)));
  const pronunciation = toHundredOrNull(result?.pron) ?? charAverage ?? sentenceAverage;
  const accuracy = toHundredOrNull(result?.accuracy) ?? sentenceAverage ?? pronunciation;
  const fluency = toHundredOrNull(result?.fluency) ?? fluencyAverage;
  const overall = toHundredOrNull(result?.overall) ?? averageNullable([pronunciation, accuracy, fluency]) ?? sentenceAverage ?? charAverage;
  return { pronunciation: pronunciation ?? 0, accuracy: accuracy ?? 0, fluency: fluency ?? 0, overall: overall ?? 0, charScores, problemChars, sentenceTips, nextStep: buildReadingNextStep(problemChars, sentenceTips) };
}

async function generateReadingFeedback(summary, raw) {
  const payload = {
    overall: summary.overall,
    pronunciation: summary.pronunciation,
    accuracy: summary.accuracy,
    fluency: summary.fluency,
    problemChars: (summary.problemChars || []).filter((item) => !item.isMissing).slice(0, 8),
    sentenceTips: (summary.sentenceTips || []).slice(0, 5),
  };
  if (!config.ppioApiKey) return buildFallbackReadingEvaluation(payload);
  try {
    const response = await postJson(config.ppioChatEndpoint, {
      model: config.ppioChatModel,
      messages: [
        { role: "system", content: [
          "你是小学古诗词朗读评价专家，服务对象是一二年级学生和课堂教师。",
          "请根据输入的朗读评测 JSON 生成朗读评价，200字以内，必须分为两段。",
          "第一段以“优点：”开头，只评价学生读得好的地方。",
          "第二段以“修改建议：”开头，只提出1-2条最关键、最可执行的练习建议。",
          "不要体现任何具体分数、百分比、等级或“0分”等表述；分数只能作为你内部判断依据。",
          "分数字段为 null、undefined、空值、0 或明显互相矛盾时，不要提到该项分数，也不要据此下负面结论。",
          "必须忽略 isMissing=true、疑似漏读、未识别等标记，不把它们写进评价，也不要据此批评学生。",
          "problemChars 只挑1-3个最有代表性的字；sentenceTips 只挑1条最关键的句子建议，不要罗列清单。",
          "语言要自然、鼓励、具体，避免模板化套话；不要出现 JSON、字段名、接口、模型、raw、provider 等技术词。",
        ].join("\n") },
        { role: "user", content: JSON.stringify(payload) },
      ],
      temperature: 0.35,
      max_tokens: 360,
      stream: false,
    }, ppioHeaders());
    return extractChatCompletionAnswer(response, { fallback: "" }).trim() || buildFallbackReadingEvaluation(payload);
  } catch {
    return buildFallbackReadingEvaluation(payload);
  }
}

function buildFallbackReadingEvaluation(data) {
  const problems = (data.problemChars || []).map((item) => item.char).filter(Boolean).slice(0, 5);
  const sentence = (data.sentenceTips || [])[0];
  const strengths = "优点：本次朗读整体能够围绕诗句展开，字音和节奏已有一定基础，能看出学生在认真跟读和表达诗意。";
  const suggestions = [];
  if (problems.length) suggestions.push(`可以重点练习“${problems.join("、")}”等字，先单字读准，再放回诗句中连读`);
  if (sentence?.tip) suggestions.push(sentence.tip);
  if (!suggestions.length) suggestions.push("继续保持清晰、平稳的朗读节奏，注意逗号处轻停、句末收稳");
  return `${strengths}\n\n修改建议：${suggestions.slice(0, 2).join("；")}。`;
}

function buildSentenceTip(item) {
  const chars = Array.isArray(item.snt_details) ? item.snt_details : [];
  const lowChars = chars.map((char) => ({ char: char.chn_char || "", score: toHundredOrNull(char.score), toneScore: toHundredOrNull(char.tonescore), isMissing: Boolean(char.isMissing) })).filter((char) => isChineseChar(char.char) && !char.isMissing && ((char.score !== null && char.score < 70) || (char.toneScore !== null && char.toneScore < 70))).slice(0, 3).map((char) => char.char);
  if (lowChars.length) return `先把“${lowChars.join("、")}”读准，再整句朗读。`;
  const fluencyScore = toHundredOrNull(item?.fluency?.overall);
  if (fluencyScore !== null && fluencyScore > 0 && fluencyScore < 70) return "这句中间有卡顿，先慢读一遍，逗号处轻停，句末停稳。";
  return "这一句较稳定，下一遍可以加入更自然的语气。";
}

function buildReadingNextStep(problemChars, sentenceTips) {
  if (problemChars.length) return `先练“${problemChars.map((item) => item.char).filter(Boolean).slice(0, 5).join("、")}”这些字：先单字读准，再放回原句读两遍。`;
  if (sentenceTips.length) return "字音基本稳定，下一步重点练逗号处轻停和句末收音。";
  return "朗读状态不错，可以尝试加入情感和画面感。";
}

function buildDemoReadingResult(refText) {
  const clean = refText.replace(/\s+/g, "");
  const problemChars = Array.from(new Set(clean.replace(/[，。！？；、\s]/g, "").slice(0, 4))).slice(0, 3).map((char, index) => ({ char, pinyin: "", score: 72 - index * 3, toneScore: 70 - index * 2 }));
  return { mode: "demo", raw: null, summary: { pronunciation: 82, accuracy: 80, fluency: 78, overall: 80, problemChars, sentenceTips: [], nextStep: "当前为演示评测。配置讯飞 ISE 语音评测后，可返回真实评测结果。", readingEvaluation: "优点：本次朗读整体较完整，字音和节奏已有基础，能看出朗读者在认真表达诗句。\n\n修改建议：可以先把个别重点字读清楚，再放回诗句中连读；朗读时注意逗号处轻轻停顿，句末收稳。" } };
}

function buildVisualPrompt(depiction, poemTitle, type) {
  const medium = type === "video" ? "小学低年级课堂可展示的国风短视频，镜头稳定，画面明亮，动作轻柔" : "小学低年级课堂可展示的国风插画，画面明亮，主体清晰，适合投屏";
  const title = poemTitle ? `围绕《${poemTitle}》的诗意画面。` : "";
  return `${medium}。${title}学生描述：${depiction}。避免恐怖、暴力、成人化内容，保留儿童想象力和古诗意境。`;
}

function buildDemoMediaResult(type, depiction, prompt) {
  if (type === "video") return { mode: "demo", type, prompt, taskId: `demo-video-${Date.now()}`, message: "演示模式：配置 PPIO_API_KEY 后将创建真实视频任务。" };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#f6fbff"/><circle cx="770" cy="120" r="58" fill="#ffd66b"/><path d="M0 430 C180 350 300 450 480 365 C650 285 760 350 960 270 L960 540 L0 540Z" fill="#9fc4a3"/><text x="80" y="110" font-family="Microsoft YaHei,sans-serif" font-size="38" fill="#263238">学生诗意画面</text><foreignObject x="80" y="145" width="800" height="180"><div xmlns="http://www.w3.org/1999/xhtml" style="font-family:Microsoft YaHei,sans-serif;font-size:28px;line-height:1.5;color:#2f3c48;">${escapeHtml(depiction)}</div></foreignObject></svg>`;
  return { mode: "demo", type, prompt, imageUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, message: "演示模式：配置 PPIO_API_KEY 后将创建真实图片任务。" };
}

function defaultReferenceImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="#f6fbff"/><circle cx="760" cy="180" r="86" fill="#ffd76a"/><path d="M0 760 C180 650 340 760 520 650 C680 560 820 610 1024 510 L1024 1024 L0 1024Z" fill="#b7d7b0"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function buildDemoAnswer(question, context) {
  const title = context.poemTitle ? `《${context.poemTitle}》` : "这首诗";
  if (/意思|讲了什么|为什么/.test(question)) return `${title}是在用很短的句子说一个画面或心情。你可以先找诗里的景物，再想一想诗人看到它时的感受。`;
  if (/怎么读|朗读|停顿/.test(question)) return `读${title}时先慢一点，逗号处轻轻停，句号处停稳。遇到不熟的字，先单独读准，再连成一句。`;
  if (/画|图片|视频/.test(question)) return "可以把诗里的景物画在最显眼的位置，再加上天气、颜色和人物动作，这样画面会更像诗。";
  const firstLine = String(context.poemText || "").split(/[，。！？；\n]/).find(Boolean);
  return firstLine ? `我们可以从“${firstLine}”这一句开始想：谁看到了什么？心里是什么感觉？` : "你可以把问题说得更具体一点，比如问某个字、某一句，或者这首诗的画面。";
}

async function serveStatic(req, res, url) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "Method Not Allowed" });
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) return sendJson(res, 403, { error: "Forbidden" });
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  } catch {
    const fallback = await readFile(path.join(publicDir, "index.html"));
    res.writeHead(200, { "Content-Type": mimeTypes[".html"] });
    res.end(fallback);
  }
}

async function postJson(url, payload, headers = {}) {
  const response = await fetch(url, { method: "POST", headers: compactHeaders({ "Content-Type": "application/json", ...headers }), body: JSON.stringify(payload) });
  return parseApiResponse(response);
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers: compactHeaders(headers) });
  return parseApiResponse(response);
}

async function parseApiResponse(response) {
  const text = await response.text();
  const body = text ? tryParseJson(text) : {};
  if (!response.ok) throw new Error(body?.error?.message || body?.message || body?.error || `接口返回 ${response.status}`);
  return body;
}

function ppioHeaders() {
  return { Authorization: `Bearer ${config.ppioApiKey}`, "Content-Type": "application/json" };
}

function extractChatCompletionAnswer(raw, options = {}) {
  const content = raw?.choices?.[0]?.message?.content || raw?.choices?.[0]?.delta?.content || raw?.choices?.[0]?.text || raw?.data?.choices?.[0]?.message?.content || raw?.data?.output_text || raw?.output_text || raw?.content || raw?.answer;
  if (Array.isArray(content)) return content.map((item) => item?.text || item?.content || item?.value || "").filter(Boolean).join("");
  if (typeof content === "object" && content) return content.text || content.content || content.value || options.fallback || "";
  return content || options.fallback || "已收到回答，但未能识别文本字段。";
}

function firstTagAttrs(xml, tagName) {
  const match = new RegExp(`<${tagName}\\b([^>]*)>`, "i").exec(xml);
  return match ? parseXmlAttrs(match[1]) : null;
}

function matchTagBlocks(xml, tagName) {
  const blocks = [];
  const regex = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  let match;
  while ((match = regex.exec(xml))) blocks.push({ attrs: parseXmlAttrs(match[1]), inner: match[2] });
  return blocks;
}

function parseXmlAttrs(text) {
  const attrs = {};
  const regex = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = regex.exec(text))) attrs[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? "");
  return attrs;
}

function nullableScoreAttr(attrs, names) {
  for (const name of names) if (attrs[name] !== undefined && attrs[name] !== "") return toHundred(attrs[name]);
  return null;
}

function toHundred(value) {
  const number = Number(value || 0);
  if (!number) return 0;
  return Math.round(number <= 10 ? number * 10 : number);
}

function toHundredOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  return toHundred(value);
}

function averageNullable(values) {
  const nums = values.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  if (!nums.length) return null;
  return Math.round(nums.reduce((sum, value) => sum + value, 0) / nums.length);
}

function uniqueByChar(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item.char || seen.has(item.char)) return false;
    seen.add(item.char);
    return true;
  });
}

function isChineseChar(value) {
  return /^[\u3400-\u9fff]$/.test(String(value || ""));
}

function webSocketMessageToText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return String(data || "");
}

function tryParseJson(text) {
  try { return JSON.parse(text); } catch { return { text }; }
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function compactHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([, value]) => Boolean(value)));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeXmlEntities(value) {
  return String(value).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
