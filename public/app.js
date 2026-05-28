const poems = [
  { title: "咏鹅", author: "骆宾王", text: "鹅，鹅，鹅，曲项向天歌。白毛浮绿水，红掌拨清波。" },
  { title: "静夜思", author: "李白", text: "床前明月光，疑是地上霜。举头望明月，低头思故乡。" },
  { title: "春晓", author: "孟浩然", text: "春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。" },
  { title: "登鹳雀楼", author: "王之涣", text: "白日依山尽，黄河入海流。欲穷千里目，更上一层楼。" },
];

const POEM_DRAFT_KEY = "poetry-agent-current-poem";
const POEM_HISTORY_KEY = "poetry-agent-poem-history";
const MAX_POEM_HISTORY = 8;

const state = {
  mediaRecorder: null,
  audioBase64: "",
  audioPreviewUrl: "",
  referenceImage: "",
  mediaType: "image",
  chatHistory: [],
  poemSaveTimer: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const poemTitle = $("#poemTitle");
const poemText = $("#poemText");
const poemHistory = $("#poemHistory");
const audioPreview = $("#audioPreview");
const recordButton = $("#recordButton");
const stopButton = $("#stopButton");
const recordingState = $("#recordingState");
const evaluateButton = $("#evaluateButton");
const readingEvaluation = $("#readingEvaluation");
const chatStream = $("#chatStream");

init();

function init() {
  initializePoemFields();
  bindTabs();
  bindReading();
  bindCreation();
  bindChat();
  refreshServiceStatus();
  renderWelcomeMessage();
}

function initializePoemFields() {
  const saved = readStoredPoem();
  poemTitle.value = saved?.title || poems[0].title;
  poemText.value = saved?.text || poems[0].text;
  bindPoemPersistence();
  renderPoemHistory();
}

function bindPoemPersistence() {
  [poemTitle, poemText].forEach((input) => {
    input.addEventListener("input", schedulePoemSave);
    input.addEventListener("blur", saveCurrentPoemToHistory);
  });
  $("#clearPoemHistory").addEventListener("click", () => {
    localStorage.removeItem(POEM_HISTORY_KEY);
    renderPoemHistory();
  });
}

function bindTabs() {
  $$(".nav-tab").forEach((button) => {
    button.addEventListener("click", () => {
      $$(".nav-tab").forEach((item) => item.classList.remove("active"));
      $$(".view").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      $(`#${button.dataset.view}View`).classList.add("active");
    });
  });
}

function schedulePoemSave() {
  window.clearTimeout(state.poemSaveTimer);
  state.poemSaveTimer = window.setTimeout(saveCurrentPoemToHistory, 400);
}

function saveCurrentPoemToHistory() {
  const poem = currentPoem();
  if (!poem.title && !poem.text) return;
  localStorage.setItem(POEM_DRAFT_KEY, JSON.stringify(poem));
  if (!poem.title || !poem.text) return;
  const history = readPoemHistory();
  const next = [{ ...poem, savedAt: new Date().toISOString() }, ...history.filter((item) => item.title !== poem.title || item.text !== poem.text)].slice(0, MAX_POEM_HISTORY);
  localStorage.setItem(POEM_HISTORY_KEY, JSON.stringify(next));
  renderPoemHistory(next);
}

function renderPoemHistory(history = readPoemHistory()) {
  if (!history.length) {
    poemHistory.innerHTML = '<div class="history-empty">暂无历史记录</div>';
    return;
  }
  poemHistory.innerHTML = history.map((item, index) => `<button class="history-item" type="button" data-history-index="${index}"><strong>${escapeHtml(item.title || "未命名诗词")}</strong><span>${escapeHtml(compactPoemPreview(item.text))}</span></button>`).join("");
  poemHistory.querySelectorAll(".history-item").forEach((button) => {
    button.addEventListener("click", () => {
      const item = history[Number(button.dataset.historyIndex)];
      if (!item) return;
      poemTitle.value = item.title || "";
      poemText.value = item.text || "";
      saveCurrentPoemToHistory();
    });
  });
}

function readStoredPoem() {
  return safeJsonParse(localStorage.getItem(POEM_DRAFT_KEY));
}

function readPoemHistory() {
  const history = safeJsonParse(localStorage.getItem(POEM_HISTORY_KEY));
  return Array.isArray(history) ? history.filter((item) => item?.title || item?.text) : [];
}

function compactPoemPreview(text) {
  const clean = String(text || "").replace(/\s+/g, "");
  return clean.length > 28 ? `${clean.slice(0, 28)}...` : clean || "无正文";
}

function bindReading() {
  $("#loadDemoReading").addEventListener("click", () => {
    poemTitle.value = poems[1].title;
    poemText.value = poems[1].text;
    saveCurrentPoemToHistory();
  });
  recordButton.addEventListener("click", startRecording);
  stopButton.addEventListener("click", stopRecording);
  $("#audioFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    state.audioPreviewUrl = await fileToDataUrl(file);
    audioPreview.src = state.audioPreviewUrl;
    recordingState.textContent = "正在转换音频";
    try {
      state.audioBase64 = await blobToPcm16Base64(file);
      recordingState.textContent = `已选择 ${file.name}`;
    } catch (error) {
      state.audioBase64 = "";
      recordingState.textContent = "音频转换失败";
      showInlineError($("#readingNextStep"), `无法解析 ${file.name}，请换用 wav、mp3 或重新录音。${error.message}`);
    }
  });
  evaluateButton.addEventListener("click", async () => {
    setBusy(evaluateButton, true, "评测中");
    try {
      const result = await postJson("/api/reading/evaluate", {
        refText: poemText.value,
        titleInfo: currentPoem().title,
        audioBase64: state.audioBase64,
        audioFormat: "pcm",
      });
      renderReadingResult(result);
    } catch (error) {
      showInlineError($("#readingNextStep"), error.message);
    } finally {
      setBusy(evaluateButton, false, "提交朗读评测");
    }
  });
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    recordingState.textContent = "当前浏览器不支持录音";
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const chunks = [];
  state.mediaRecorder = new MediaRecorder(stream);
  state.mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) chunks.push(event.data);
  });
  state.mediaRecorder.addEventListener("stop", async () => {
    const blob = new Blob(chunks, { type: "audio/webm" });
    state.audioPreviewUrl = await blobToDataUrl(blob);
    audioPreview.src = state.audioPreviewUrl;
    recordingState.textContent = "正在转换音频";
    state.audioBase64 = await blobToPcm16Base64(blob);
    stream.getTracks().forEach((track) => track.stop());
    recordingState.textContent = "录音已完成";
  });
  state.mediaRecorder.start();
  recordButton.disabled = true;
  stopButton.disabled = false;
  recordingState.textContent = "录音中";
}

function stopRecording() {
  state.mediaRecorder?.stop();
  recordButton.disabled = false;
  stopButton.disabled = true;
}

function renderReadingResult(result) {
  const summary = result.summary || {};
  readingEvaluation.innerHTML = formatEvaluationText(summary.readingEvaluation || summary.nextStep || "暂未生成朗读评价。");
}

function formatEvaluationText(text) {
  return String(text || "").split(/\n{2,}|\r?\n/).map((part) => part.trim()).filter(Boolean).slice(0, 3).map((part) => `<p>${escapeHtml(part)}</p>`).join("");
}

function bindCreation() {
  $$(".segmented button").forEach((button) => {
    button.addEventListener("click", () => {
      $$(".segmented button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.mediaType = button.dataset.mediaType;
    });
  });
  $("#referenceImage").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    state.referenceImage = await fileToDataUrl(file);
    $("#mediaStatus").textContent = `已选择参考图 ${file.name}`;
  });
  $("#generateButton").addEventListener("click", async () => {
    const button = $("#generateButton");
    setBusy(button, true, "生成中");
    $("#mediaStatus").textContent = "正在提交任务";
    try {
      const response = await postJson("/api/media/generate", {
        type: state.mediaType,
        depiction: $("#depictionInput").value,
        poemTitle: currentPoem().title,
        referenceImage: state.referenceImage,
        duration: Number($("#videoDuration").value),
        resolution: $("#videoResolution").value,
        watermark: $("#watermarkToggle").checked,
      });
      renderMediaResponse(response);
      if (response.taskId && response.mode === "api") pollTask(response.taskId, state.mediaType);
    } catch (error) {
      showMediaError(error.message);
    } finally {
      setBusy(button, false, "生成课堂素材");
    }
  });
}

function renderMediaResponse(response) {
  $("#promptPreview").textContent = response.prompt || "";
  if (response.imageUrl) {
    $("#mediaStatus").textContent = response.mode === "demo" ? "演示图片已生成" : "图片已生成";
    $("#mediaFrame").innerHTML = `<img alt="生成的诗意图片" src="${response.imageUrl}">`;
    return;
  }
  if (response.videoUrl) {
    $("#mediaStatus").textContent = "视频已生成";
    $("#mediaFrame").innerHTML = `<video src="${response.videoUrl}" controls autoplay muted loop></video>`;
    return;
  }
  if (response.taskId) {
    $("#mediaStatus").textContent = response.mode === "demo" ? response.message : `任务已提交：${response.taskId}`;
    $("#mediaFrame").innerHTML = `<span>${escapeHtml(response.message || "等待异步任务完成。")}</span>`;
  }
}

async function pollTask(taskId, type) {
  for (let attempt = 0; attempt < 36; attempt += 1) {
    await wait(5000);
    const response = await postJson("/api/media/status", { taskId });
    const task = response.task || response.raw?.task || {};
    const progress = task.progress_percent ?? task.progress ?? 0;
    $("#mediaStatus").textContent = `生成中 ${progress}%`;
    const imageUrl = response.images?.[0]?.image_url || response.raw?.images?.[0]?.image_url;
    const videoUrl = response.videos?.[0]?.video_url || response.raw?.videos?.[0]?.video_url;
    if (imageUrl || videoUrl) {
      renderMediaResponse({ mode: "api", type, prompt: $("#promptPreview").textContent, imageUrl, videoUrl });
      return;
    }
    if (/fail|error|cancel/i.test(task.status || "")) {
      showMediaError(task.reason || "生成任务失败");
      return;
    }
  }
  $("#mediaStatus").textContent = "任务仍在处理中，可稍后查询";
}

function bindChat() {
  $("#clearChat").addEventListener("click", () => {
    state.chatHistory = [];
    chatStream.innerHTML = "";
    renderWelcomeMessage();
  });
  $("#chatForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("#questionInput");
    const question = input.value.trim();
    if (!question) return;
    input.value = "";
    appendMessage("user", question);
    setBusy($("#chatForm button"), true, "发送中");
    try {
      const response = await postJson("/api/chat", {
        question,
        history: state.chatHistory,
        poemTitle: currentPoem().title,
        poemText: poemText.value,
      });
      appendMessage("assistant", response.answer || "没有收到回答");
    } catch (error) {
      appendMessage("assistant", `实时问答暂时不可用：${error.message}`);
    } finally {
      setBusy($("#chatForm button"), false, "发送");
    }
  });
}

function appendMessage(role, content) {
  state.chatHistory.push({ role, content });
  const node = document.createElement("div");
  node.className = `message ${role}`;
  node.textContent = content;
  chatStream.appendChild(node);
  chatStream.scrollTop = chatStream.scrollHeight;
}

function renderWelcomeMessage() {
  appendMessage("assistant", "我是课堂里的古诗词学习伙伴。你可以问诗句意思、朗读停顿，也可以让我帮你把诗里的画面说清楚。");
}

async function refreshServiceStatus() {
  try {
    const { configured } = await fetch("/api/health").then((res) => res.json());
    $("#serviceStatus").innerHTML = [["讯飞评测", configured.reading], ["图片/视频", configured.imageVideo], ["实时问答", configured.realtimeChat]].map(([label, ok]) => `<div class="status-pill"><span>${label}</span><strong>${ok ? "已配置" : "演示"}</strong></div>`).join("");
  } catch {
    $("#serviceStatus").innerHTML = '<span class="status-pill">服务状态读取失败</span>';
  }
}

function currentPoem() {
  return { title: poemTitle.value.trim(), text: poemText.value.trim() };
}

async function postJson(url, data) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail || result.error || "请求失败");
  return result;
}

function setBusy(button, busy, text) {
  button.disabled = busy;
  button.textContent = text;
}

function showInlineError(node, message) {
  if (!node) return;
  node.textContent = `错误：${message}`;
}

function showMediaError(message) {
  $("#mediaStatus").textContent = "生成失败";
  $("#mediaFrame").innerHTML = `<span>错误：${escapeHtml(message)}</span>`;
}

async function blobToPcm16Base64(blob) {
  const pcm = await blobToPcm16(blob);
  return arrayBufferToBase64(pcm.buffer);
}

async function blobToPcm16(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("当前浏览器不支持音频解码");
  const context = new AudioContextClass();
  try {
    const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
    return audioBufferToPcm16(audioBuffer, 16000);
  } finally {
    await context.close?.();
  }
}

function audioBufferToPcm16(audioBuffer, targetRate) {
  const sourceRate = audioBuffer.sampleRate;
  const sampleCount = Math.round(audioBuffer.duration * targetRate);
  const pcm = new Int16Array(sampleCount);
  const channels = [];
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) channels.push(audioBuffer.getChannelData(channel));
  for (let index = 0; index < sampleCount; index += 1) {
    const sourceIndex = index * sourceRate / targetRate;
    const low = Math.floor(sourceIndex);
    const high = Math.min(low + 1, audioBuffer.length - 1);
    const ratio = sourceIndex - low;
    let mixed = 0;
    channels.forEach((channel) => { mixed += channel[low] * (1 - ratio) + channel[high] * ratio; });
    mixed /= channels.length || 1;
    pcm[index] = floatTo16BitPcm(mixed);
  }
  return pcm;
}

function floatTo16BitPcm(value) {
  const sample = Math.max(-1, Math.min(1, value));
  return sample < 0 ? sample * 0x8000 : sample * 0x7fff;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  return btoa(binary);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function blobToDataUrl(blob) {
  return fileToDataUrl(blob);
}

function safeJsonParse(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
