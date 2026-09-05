# 高管日复盘 App · Web 壳 MVP 原型

AI 教练式语音日记 —— 高管用「说话」的方式，在 AI 教练的四段式引导下完成当天关键事的回顾、反思、洞察与行动规划；系统自动结构化沉淀，并可聚合为周报。

> 本仓库为 **MVP 原型（Web 壳）**，用于验证主链路：**四段式对话 + 周报聚合**。对应设计文档 `docs/plans/2026-09-04-executive-daily-review-design.md` 第 0/8 节已确认决策。

## 已确认决策（落地点）
| 决策 | 实现 |
| --- | --- |
| MVP 落地端 | Web 壳先行（React Native 移动端为后续） |
| 语音形态 | MVP 阶段用**轮流对话**（文字）验证教练逻辑，全双工语音为路线图项 |
| LLM 选型 | **不锁定厂商**：设置页用户自填服务地址 + API Key（默认预填 DeepSeek 兼容端点） |
| 大模型接入 | 企业级 API（非私有化），密钥仅存服务端，前端掩码 |
| 教练语气 | 下拉选择（温暖/严肃/锐利/鼓励）+ 挑战式追问开关 |
| 多人维度 | 当前仅个人；数据模型预留扩展 |

## 运行
零外部依赖，仅需 Node.js（≥18）：

```bash
node server.js
# 或
npm start
```

打开 http://localhost:3000

- **演示模式**（默认）：无需任何密钥即可跑通四段式对话与周报，使用规则式兜底教练。
- **接入真实 LLM**：进入「设置」页，关闭演示模式，填写 baseURL / API Key / 模型名（OpenAI 兼容协议，如 DeepSeek、通义、智谱、GLM 等）。

**智谱（GLM）接入提示**（已实测验证）：
- 推荐模型 `glm-4.5-air`：支持关闭思考，单轮响应约 0.5–3 秒，JSON 输出稳定。
- `glm-5.x-flash` 等"始终思考"型模型单轮思考可达 25 秒以上，且思考 token 计入 `max_tokens`，会挤占回复空间——服务端已统一提高 max_tokens 并采用 40s 超时兜底。
- 服务端对所有请求默认附加 `thinking: {type:"disabled"}`（智谱语法），端点返回 400 时自动去参重试，对 DeepSeek / 通义等端点同样安全。

### 测试
服务启动后另开一个终端执行：

```bash
npm test              # 全部（冒烟 26 项 + LLM 路径 mock 24 项）
npm run test:smoke    # 主链路：四段式状态机、会话沉淀与恢复、周报聚合（自动临时切演示模式）
npm run test:llm      # 真实 LLM 调用路径（用本地 mock 端点；检测到已配真实密钥时自动跳过）
npm run test:live     # 真实厂商端到端联调（需已配置可用 Key；未配置时自动跳过）
```

`test:llm` 覆盖：请求构造（路径/鉴权头/模型/系统提示词）、响应解析（标准 JSON / ```json 围栏 / 纯文本 / 空内容）、
状态机推进（满 2 轮强制 advance / 第 4 段强制 done + 行动项兜底）、HTTP 错误降级、连通性自检、以及「不传 apiKey 不覆盖已保存密钥」。
`test:live` 覆盖：真实端点连通性、四段式完整对话（含每轮未发生静默降级断言）、标签/行动项真实提取、周报 AI 总结。

## 架构
```
浏览器(public/)  ──HTTP──▶  Node 服务端(server.js, 零依赖)
                               ├─ lib/coach.js  教练引擎（LLM 调用 + 演示兜底 + 主题识别）
                               ├─ lib/store.js  本地 JSON 仓储（生产可换 PostgreSQL）
                               └─ data/db.json  运行时数据（已 gitignore）
tests/smoke_test.js            端到端冒烟测试（npm run test:smoke）
tests/llm_test.js              LLM 调用路径 mock 测试（npm run test:llm）
tests/live_llm_test.js         真实厂商端到端联调（npm run test:live）
```

### 主要接口
- `GET/POST /api/settings` 读写 LLM 与用户设置（读取时 API Key 掩码返回）
- `POST /api/llm/test` **LLM 连通性自检**，返回 ok / 耗时 / 模型名 / 错误原因
- `POST /api/chat` 教练对话（四段式引导，返回 reply/tags/actionItems/advance/done）
- `POST/GET /api/sessions` 创建 / 列出会话
- `POST /api/sessions/:id/state` **进度快照**（每轮对话后保存，页面刷新可恢复上下文与当前段）
- `POST /api/sessions/:id/finish` 结束复盘，**一次提交四段 segment**（整体覆盖，重复提交幂等）
- `POST /api/sessions/:id/segments` 逐段追加（保留兼容，前端已改为一次提交四段）
- `GET /api/report/weekly` 本周聚合（主题词频、能量走势、行动项、AI 一句总结）

## 四段式主线（§2）
1. **关键事**：今天最关键的 1–3 件事
2. **想法/感受**：当时的判断、情绪与能量
3. **洞察/遗憾**：做得好 / 可改进 / 学到的
4. **下一步**：一个具体、可行动、有时间的下一步

## 数据模型（§5）
`User / ReviewSession / Segment(stage 1–4) / Tag / ActionItem / Report`。当前用文件型 JSON 仓储（MVP），字段已按 PostgreSQL 聚合需求设计，后续可直接平移。

## 路线图（§6.2）
1. ✅ MVP：四段式 + 轮流对话 + 周报
2. 语音打磨：全双工打断 / 停顿 / 自然度
3. 聚合深化：月报、季报、主题画像
4. 智能追问：跨日模式识别、个性化教练
5. 多端发布：iOS + Android、团队/教练后台（可选）

## 已知局限（MVP 范围内的有意取舍）
1. **无鉴权**：当前为单用户本地原型，未做登录/鉴权；生产化需补（见文末）。
2. **进度恢复依赖服务端快照**：每轮对话后写入 `session.state`，刷新页面可完整恢复对话与当前段；已结束（done）的会话不再接受快照。清空 `data/db.json` 会丢失历史。
3. **演示模式为规则式教练**：无密钥时按「每段两轮 + 过渡语」推进，主题标签走关键词词典匹配；真实追问深度需接入 LLM 后体现。LLM 调用链路已用本地 mock 端点验证（含降级与解析），但**尚未与真实厂商 API 联调**——填入 Key 后点「测试连接」即可确认。
4. **语音为路线图项**：当前以文字轮流对话验证教练逻辑，全双工 ASR/TTS 与打断检测尚未实现（§3）。
5. **周报仅本周**：未做历史周切换与月/季报（§5.3 路线图第 3 阶段）。

---
*原型为验证用途，生产化需补充鉴权、并发、加密存储与合规审计。*
