# Multi Model Chat Lab

本机运行的多模型对话调试工作台。一次向最多 5 个模型发送同一条消息，并排查看回复、耗时、Token 用量和估算费用。适合比较模型表现、调试系统 Prompt，以及观察上下文压缩效果。

## 功能

- 支持 OpenAI 兼容、Anthropic 兼容、Gemini 原生协议和自定义完整接口 URL 四种接入方式；模型可单独选择流式或非流式响应，并测试连接。
- 支持批量添加模型，在 1–5 个面板中并发对话。单个模型请求失败不会中断其他面板。
- 每个对话窗口独立保存历史；各模型只接收共同的用户消息和自己的历史回复。切换面板模型后从新上下文开始。
- 每轮可编辑系统 Prompt 和最近 0–100 轮上下文；支持 `${userInputPrevious}`、`${aiOutputPrevious}`、`${userInputlatest}`、`${memory}`、`${summary}`、`${currentTime}` 变量，并可预览替换值。
- 支持按模型分别手动或定期压缩上下文，生成 `memory` 和 `summary` 供后续 Prompt 使用。
- 显示回复总耗时、首字耗时、接口返回的 Token 用量，以及基于自填价格计算的费用。接口未返回用量时标记统计不完整。
- 支持复制回复、失败重试和欢迎语生成。模型配置与对话保存在当前浏览器。

## 环境要求

- Node.js 22 或更新版本
- npm
- 至少一个可用的模型接口、API Key 和模型 ID

## 快速开始

```bash
git clone https://github.com/ryohgicc/multi-model-chat-lab.git
cd multi-model-chat-lab
npm install
npm run dev
```

打开终端显示的 Vite 地址，默认是 <http://127.0.0.1:5173>。开发命令会同时启动网页和本机接口服务。

在「模型与设置」中添加模型：选择接入方式，填写 API Key、接口地址和模型 ID，测试连接并保存。回到工作台，在面板顶部选择模型即可开始对话。

生产构建及本机运行：

```bash
npm run build
npm start
```

打开 <http://127.0.0.1:3001>。服务仅监听 `127.0.0.1`。

## 接口地址

| 接入方式 | 地址示例 | 实际请求 |
| --- | --- | --- |
| OpenAI 兼容 | `https://api.openai.com/v1` | 自动追加 `/chat/completions` |
| Anthropic 兼容 | `https://api.anthropic.com/v1` | 自动追加 `/messages` |
| Gemini 原生协议 | `https://generativelanguage.googleapis.com/v1beta` | 自动追加模型路径与生成接口 |
| 自定义直接请求 | `https://example.com/v1/chat/completions` | 直接向填写的完整 URL 发送 POST |

自定义模式使用 OpenAI 兼容的请求与响应格式，适合已有完整聊天接口 URL 的网关。它不支持任意 HTTP 请求模板。默认启用流式响应；如果接口不支持，可在模型设置中关闭。

## Prompt 与上下文

每轮系统 Prompt 可独立编辑，新一轮默认沿用上一轮。上下文轮数默认 10，设为 0 时只发送本轮用户消息。变量在每个模型发出请求前按该模型自己的上下文替换：

| 变量 | 含义 |
| --- | --- |
| `${userInputPrevious}` | 上一轮用户消息 |
| `${aiOutputPrevious}` | 该模型上一轮回复 |
| `${userInputlatest}` | 本轮用户消息 |
| `${memory}` | 该模型最近一次压缩得到的长期记忆 |
| `${summary}` | 该模型最近一次压缩得到的近期摘要 |
| `${currentTime}` | 请求发送时的 UTC ISO 时间 |

压缩可手动触发，也可设置每隔若干轮自动触发。每个模型使用自己的对话记录独立生成结果；压缩失败不会覆盖已有记忆。手动「压缩全部对话」会处理已保存窗口中符合条件的模型对话。

## 数据与安全

模型配置、API Key 和聊天记录存储在当前浏览器的 `localStorage`。清除浏览器数据会删除这些内容；项目没有账号或云同步。本机服务负责转发请求，不持久保存 API Key 或聊天正文。请勿分享包含浏览器数据的备份，并仅在自己的设备上运行服务。

## 开发与验证

前端使用 React、TypeScript 和 Vite；本机接口服务使用 Express。

```bash
npm test       # 单元测试
npm run lint   # ESLint
npm run build  # TypeScript 检查和生产构建
```

## 版本记录

- 2026-10-10：增加独立模型上下文压缩、Prompt 变量与预览、欢迎语和新对话配置继承。
- 2026-10-09：首版支持多模型并发对话、三种接口模式、独立对话窗口、流式响应和回复指标。
