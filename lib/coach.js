'use strict';
/**
 * 教练引擎：四段式复盘引导。
 * - 真实模式：调用用户在设置中配置的 OpenAI 兼容 LLM（baseURL + apiKey + model）。
 * - 演示模式：规则式兜底教练，无需密钥即可跑通主链路，方便评审。
 */

const STAGES = [
  { id: 1, key: 'keyEvents',   label: '关键事',   goal: '聚焦当天最关键的 1–3 件事，避免流水账。' },
  { id: 2, key: 'thoughts',    label: '想法/感受', goal: '还原决策情境、判断依据与当时的情绪/能量状态。' },
  { id: 3, key: 'insights',    label: '洞察/遗憾', goal: '提炼做得好的、可改进的、学到的模式与洞察。' },
  { id: 4, key: 'nextSteps',   label: '下一步',   goal: '形成 1 个具体、可行动、有明确时间的下一步。' }
];

const TONES = {
  serious:     { label: '严肃', style: '简洁、专业、点到即止，不寒暄、不绕弯。' },
  warm:        { label: '温暖', style: '共情、温和，先认可再引导，像一位值得信任的伙伴。' },
  sharp:       { label: '锐利', style: '一针见血、直指要害，直接点出矛盾与盲区，不客套。' },
  encouraging: { label: '鼓励', style: '积极赋能、强调成长与可能性，给予信心与方向。' }
};

function getStage(id) { return STAGES.find(s => s.id === Number(id)) || STAGES[0]; }
function getTone(key) { return TONES[key] || TONES.warm; }

function buildProfileText(user) {
  if (!user) return '（暂无用户画像）';
  const parts = [];
  if (user.industry) parts.push('行业：' + user.industry);
  if (user.role) parts.push('角色：' + user.role);
  if (user.profileTags && user.profileTags.length) parts.push('高频主题：' + user.profileTags.join('、'));
  return parts.length ? parts.join('；') + '。' : '（暂无用户画像）';
}

function buildSystemPrompt({ stage, tone, challengeMode, user, stageUserTurns = 0 }) {
  const st = getStage(stage);
  const t = getTone(tone);
  const challengeNote = challengeMode
    ? '已开启「挑战式」追问：适度质疑用户的判断，追问"你确定吗 / 依据是什么 / 有没有另一种可能"，但保持尊重、不挑衅。'
    : '保持建设性，不做对抗式质疑。';
  return [
    '你是「高管日复盘」AI 教练，正在引导一次日复盘。',
    `当前处于第 ${st.id} 段「${st.label}」（共 4 段），本段目标：${st.goal}。本段内用户已输入 ${stageUserTurns + 1} 次（含本次消息）。`,
    `语气风格（${t.label}）：${t.style}`,
    challengeNote,
    '用户画像：' + buildProfileText(user),
    '',
    '请基于对话历史，生成你作为教练的【下一句】引导或追问。规则：',
    '1. 只聚焦当前段落目标，不要提前跳到后续段落。',
    '2. 段内推进：用户已输入不足 2 次时，追问深挖（advance=false）；已满 2 次时，必须给一句过渡总结并设 advance=true 进入下一段，不要再追问。',
    '3. 结束条件：仅第 4 段且用户已输入满 2 次时，必须设 done=true，并把用户提到的具体行动提取进 actionItems（至少 1 条）；其余情况 done 恒为 false。',
    '4. 仅在第 4 段「下一步」提取 actionItems（具体行动项）；其余段落 actionItems 为空数组。',
    '5. 不要重复你之前说过的话；用户已回答过的问题换角度深挖。',
    '6. 输出严格 JSON，不要任何多余说明：',
    '{"reply":"教练下一句","tags":["主题/情绪/卡点标签"],"actionItems":["具体行动项"],"advance":false,"done":false}'
  ].join('\n');
}

/** 从模型返回中稳健提取 JSON 对象 */
function extractJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { /* fallthrough */ }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(body.slice(start, end + 1)); } catch (e) { /* ignore */ }
  }
  return null;
}

/**
 * 统一 chat 调用：默认附加 thinking:disabled（智谱语法，避免思考型模型
 * 把 token 预算耗在 reasoning_content 上导致 content 为空）；
 * 端点返回 400（不支持该参数，或"始终思考"型模型）时自动去参重试一次。
 * 对 DeepSeek / 通义等 OpenAI 兼容端点同样安全。
 */
async function postChat(baseURL, apiKey, payload, timeoutMs) {
  const doFetch = (body) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(baseURL + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(body),
      signal: controller.signal
    }).finally(() => clearTimeout(timer));
  };
  let resp = await doFetch({ ...payload, thinking: { type: 'disabled' } });
  if (resp.status === 400) resp = await doFetch(payload);
  return resp;
}

/**
 * 状态机确定性保障：每段满 2 轮用户输入必须推进，第 4 段满 2 轮必须结束。
 * LLM 可以提前建议推进（其 advance/done 为 true 时生效），但不能阻止推进——
 * 避免"模型迟迟不输出 done 导致对话无法结束"的不可控情况。
 */
function applyStateMachine(result, stage, turnCount, messages) {
  if (Number(stage) >= 4) {
    if (turnCount >= 2) {
      result.done = true;
      result.advance = false;
      if (!result.actionItems || !result.actionItems.length) {
        const lastUser = [...(messages || [])].reverse().find(m => m.role === 'user');
        result.actionItems = lastUser ? [String(lastUser.content).slice(0, 100)] : [];
      }
    } else {
      result.done = false;
    }
  } else {
    result.done = false;
    if (turnCount >= 2) result.advance = true;
  }
  return result;
}

async function callLLM(settings, { messages, stage, stageUserTurns, tone, challengeMode, user }) {
  const llm = settings.llm || {};
  const baseURL = (llm.baseURL || '').replace(/\/+$/, '');
  const apiKey = llm.apiKey || '';
  const model = llm.model || 'deepseek-chat';

  const sys = { role: 'system', content: buildSystemPrompt({ stage, tone, challengeMode, user, stageUserTurns }) };
  const payload = {
    model,
    messages: [sys, ...messages.map(m => ({ role: m.role, content: m.content }))],
    temperature: 0.8,
    max_tokens: 2000
  };
  // 部分兼容端点支持 json_object；不支持时由 prompt 兜底
  try { payload.response_format = { type: 'json_object' }; } catch (e) { /* noop */ }

  try {
    const resp = await postChat(baseURL, apiKey, payload, 40000);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error('LLM HTTP ' + resp.status + ' ' + errText.slice(0, 200));
    }
    const json = await resp.json();
    const content = json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content : '';
    const parsed = extractJSON(content);
    const turnCount = (Number(stageUserTurns) || 0) + 1;
    if (parsed && parsed.reply) {
      return applyStateMachine({
        reply: parsed.reply,
        tags: Array.isArray(parsed.tags) ? parsed.tags : [],
        actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
        advance: !!parsed.advance,
        done: !!parsed.done
      }, stage, turnCount, messages);
    }
    // 解析失败：把原文当作回复（状态推进仍由代码保证）
    return applyStateMachine({
      reply: content || '（模型未返回有效内容）', tags: [], actionItems: [], advance: false, done: false
    }, stage, turnCount, messages);
  } catch (e) {
    throw new Error(e && e.name === 'AbortError' ? 'LLM 请求超时（40s）' : String((e && e.message) || e));
  }
}

/** 各段开场问句（turnInStage=0 时给出） */
const OPENERS = {
  1: '今天最关键的 1–3 件事是什么？',
  2: '先回到其中一件——当时你是怎么判断的？情绪和能量状态如何？',
  3: '哪些做得好？若重来会不同吗？你学到了什么？',
  4: '明天（或近期）最该做的 1 件事是什么？'
};

/** 演示模式标签提取：高管常见主题词典匹配（真实 LLM 模式由模型直接产出 tags） */
const TOPIC_DICT = [
  '授权', '决策', '团队', '客户', '交付', '预算', '沟通', '战略', '人才', '激励',
  '冲突', '谈判', '风险', '成本', '创新', '执行', '协同', '目标', '绩效', '招聘',
  '组织', '流程', '增长', '竞争', '产品', '技术', '数据', '复盘', '压力', '跨部门',
  '资源', '汇报', '人事', '财务', '供应链', '渠道', '定价', '合规', '现金流', '排期'
];
function extractTags(text) {
  if (!text) return [];
  const hit = TOPIC_DICT.filter(t => text.includes(t));
  return hit.length ? hit.slice(0, 3) : [];
}

/**
 * 演示模式：规则式教练，保证无密钥也能跑通四段式。
 * 标签优先取主题词典命中项，未命中时回落到段落名（保证周报始终有主题可聚）。
 */
function demoCoach({ stage, turnInStage, lastUserMsg, tone, challengeMode, userText }) {
  const st = getStage(stage);
  const t = getTone(tone);
  const last = (lastUserMsg || '').trim();
  const kw = last ? last.replace(/[，。；;,.!！?？\s].*$/, '').slice(0, 12) : '';

  const followups = {
    1: challengeMode
      ? `你说的是「${kw || '这件事'}」。你确定它真的最关键，而不是只是最紧急吗？`
      : `听起来「${kw || '这件事'}」分量不轻。其中哪一件最消耗你的精力？当时你是主导还是被动？`,
    2: challengeMode
      ? `那个判断你后来动摇过吗？有没有被情绪带着走？`
      : `那个判断当时有没有一丝不确定？情绪和能量处于什么状态？`,
    3: challengeMode
      ? `这和你反复提到的卡点是不是同一个根因？`
      : `这和你近期关注的主题有关联吗？若重来会不同吗？`,
    4: challengeMode
      ? `最晚什么时候做？不做的代价是什么？`
      : `最晚什么时候做？需要谁配合？`
  };

  // 开场
  if (turnInStage === 0) {
    return { reply: OPENERS[st.id], tags: [], actionItems: [], advance: false, done: false };
  }

  const isLast = turnInStage >= 2; // 每段两轮用户输入后推进
  let reply, advance = false, done = false, actionItems = [];

  if (st.id < 4) {
    if (!isLast) {
      reply = followups[st.id];
    } else {
      const bridges = { 1: '好，关键事清晰了，我们进入下一段——', 2: '情绪和判断都还原了，接着看洞察——', 3: '洞察很有价值，最后落到行动——' };
      reply = bridges[st.id];
      advance = true;
    }
  } else {
    if (!isLast) {
      reply = followups[4];
    } else {
      reply = '已记录你的下一步。今天复盘到这里，辛苦了。';
      done = true;
      if (last) actionItems = [last];
    }
  }

  // 标签：优先主题词典（覆盖本段全部用户表述），未命中回落到段落名
  const tagPool = extractTags(userText || last);
  const tags = tagPool.length ? tagPool : (last ? [st.label] : []);
  return { reply, tags, actionItems, advance, done };
}

/**
 * 主入口。优先真实 LLM（有 apiKey 且非演示模式），否则演示兜底。
 */
async function coach({ settings, messages, stage, stageUserTurns = 0, tone, challengeMode, user }) {
  const llm = settings.llm || {};
  const useLLM = llm.apiKey && llm.baseURL && !llm.demoMode;
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const lastUserMsg = lastUser ? lastUser.content : '';
  // 本段累计的用户表述（用于演示模式的主题识别，覆盖多轮输入）
  const userText = (messages || []).filter(m => m.role === 'user').map(m => m.content).join(' ');
  const demoArgs = { stage, turnInStage: stageUserTurns, lastUserMsg, tone, challengeMode, userText };

  if (useLLM) {
    // 防御：无用户消息时不打 LLM（部分端点对空 messages 直接 400），直接给本段开场白
    if (!lastUserMsg) {
      return { reply: OPENERS[getStage(stage).id], tags: [], actionItems: [], advance: false, done: false };
    }
    try {
      return await callLLM(settings, { messages, stage, stageUserTurns, tone, challengeMode, user });
    } catch (e) {
      // LLM 失败则降级到演示，保证主链路可用
      const d = demoCoach(demoArgs);
      d.note = 'LLM 调用失败，已降级演示模式：' + e.message;
      return d;
    }
  }
  return demoCoach(demoArgs);
}

/**
 * LLM 连通性自检：发一个最小请求，验证 baseURL / apiKey / model 是否可用。
 * 返回 { ok, latencyMs, model, reply } 或 { ok:false, latencyMs, error }
 */
async function testConnection({ baseURL, apiKey, model }) {
  const t0 = Date.now();
  const url = String(baseURL || '').replace(/\/+$/, '');
  if (!url || !apiKey) return { ok: false, latencyMs: 0, error: '缺少服务地址或 API Key' };

  try {
    const resp = await postChat(url, apiKey, {
      model: model || 'deepseek-chat',
      messages: [{ role: 'user', content: '回复两个字：正常' }],
      max_tokens: 500
    }, 20000);
    const latencyMs = Date.now() - t0;
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return { ok: false, latencyMs, error: `HTTP ${resp.status} ${txt.slice(0, 200)}` };
    }
    const json = await resp.json();
    const content = json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content : '';
    return { ok: true, latencyMs, model: json.model || model || '', reply: String(content || '').trim().slice(0, 50) };
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: e && e.name === 'AbortError' ? '请求超时（20s）' : String((e && e.message) || e)
    };
  }
}

/** 周报 AI 一句总结（可选，真实 LLM 可用时调用，否则返回模板） */
async function summarizeReport(settings, report) {
  const llm = settings.llm || {};
  if (!(llm.apiKey && llm.baseURL && !llm.demoMode)) {
    if (report.sessionCount === 0) return '本周还没有复盘记录，今晚花 5 分钟开始第一次吧。';
    const top = report.themes.slice(0, 3).map(t => t.tag).join('、');
    const acts = report.actionItems.length;
    return `本周复盘 ${report.sessionCount} 次，高频主题：${top || '—'}；待办行动项 ${acts} 项。坚持就是复利。`;
  }
  try {
    const prompt = '你是高管复盘教练。基于以下本周复盘聚合数据，用一句中文（不超过 60 字）给出洞察式总结：'
      + JSON.stringify({
          sessionCount: report.sessionCount,
          themes: report.themes,
          moods: report.moods,
          actionItems: report.actionItems.map(a => a.content)
        });
    const resp = await postChat(llm.baseURL.replace(/\/+$/, ''), llm.apiKey, {
      model: llm.model || 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500
    }, 30000);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const json = await resp.json();
    return json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content.trim() : '';
  } catch (e) {
    return '（AI 总结不可用，已用模板）本周复盘 ' + report.sessionCount + ' 次。';
  }
}

module.exports = { STAGES, TONES, getStage, getTone, coach, summarizeReport, buildSystemPrompt, testConnection };
