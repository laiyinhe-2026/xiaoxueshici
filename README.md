# 古诗词教学 AI 智能体

面向小学第一学段古诗词课堂的 AI 智能体工作台，支持朗读指导、课堂描绘生成图片/视频、围绕当前诗词实时问答。

## 功能

- 朗读指导：上传或录制学生朗读音频，调用讯飞 ISE 语音评测，并用 DeepSeek 整理为课堂可读的朗读评价。
- 描绘生成：输入学生描述，调用 PPIO Qwen-Image Edit 创建图片任务，或调用 Minimax Hailuo 2.3 T2V 创建视频任务，并轮询异步任务结果。
- 实时问答：围绕当前诗词文本调用 PPIO DeepSeek V4 Flash，返回适合小学低年级表达的互动回答。
- 课堂内容：支持编辑诗词题目、诗词全文，并保存在浏览器本地历史记录中。

## 本地运行

```bash
npm run dev
```

打开 `http://localhost:3000`。

也可以双击 `start-agent.bat`。

## 接口配置

复制 `.env.example` 为 `.env.local`，填入对应密钥和网关：

```bash
PORT=3000
XFYUN_APPID=
XFYUN_API_KEY=
XFYUN_API_SECRET=
PPIO_API_KEY=
PPIO_CHAT_MODEL=deepseek/deepseek-v4-flash
```

注意：`.env.local` 保存真实密钥，已经被 `.gitignore` 排除，不要上传到 GitHub。

## 部署说明

这个项目不是纯静态网页，前端需要通过 `server.js` 调用语音评测、图片/视频生成和问答接口，所以不能直接用 GitHub Pages 打开。

推荐流程：

1. 上传代码到 GitHub 仓库。
2. 在 Render、Railway 或同类 Node 托管平台导入该 GitHub 仓库。
3. 设置启动命令为 `npm start`。
4. 在托管平台的环境变量里填写 `.env.example` 中列出的密钥。
5. 部署完成后，把平台生成的网址发给其他人访问。

## 项目结构

```text
server.js          # Node 服务，代理 AI API 并保护密钥
public/index.html  # 课堂端界面
public/app.js      # 录音、生成、问答交互
public/styles.css  # 响应式界面样式
.env.example       # 接口配置模板
render.yaml        # Render 部署参考配置
```
