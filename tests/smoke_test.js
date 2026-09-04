'use strict';
/**
 * 高管日复盘 MVP · 端到端冒烟测试
 *
 * 前置：先在另一个终端启动服务 `node server.js`（默认 http://localhost:3000）
 * 运行：npm test   或   node tests/smoke_test.js
 * 说明：测试会写入 data/db.json（运行时数据，已 gitignore）。断言使用 >= 以兼容历史数据。
 */
const BASE = process.env.BASE_URL || 'http://localhost:3000';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
  return r.json();
}
async function get(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
  return r.json();
}

/** 本段用户表述（模拟真实高管口吻，覆盖主题词：客户/预算/交付/授权） */
const INPUTS = {
  1: ['今天最关键是和客户谈崩了，还有定了 Q4 预算。', '谈崩那件最消耗我，我是被动接招的。'],
  2: ['我当时以为价格不是问题。', '其实有点焦虑，怕交付跟不上。'],
  3: ['授权还是不够，下次要先对齐交付周期。', '学到了要前置确认交付承诺。'],
  4: ['明天和交付负责人对齐周期。', '最晚上午 10 点，需要交付主管配合。']
};

/** 四段式对话：每段 2 轮用户输入，验证 advance / done 状态机 */
async function runConversation() {
  console.log('\n[1] 四段式教练对话');
  let stage = 1, turn = 0;
  const messages = [];
  const stageTags = { 1: [], 2: [], 3: [], 4: [] };
  let actionItems = [];
  const guard = 40;

  for (let i = 0; i < guard && stage <= 4; i++) {
    const r = await post('/api/chat', {
      messages, stage, stageUserTurns: turn, tone: 'warm', challengeMode: false
    });
    if (!r.reply) { check(`第${stage}段返回非空回复`, false, JSON.stringify(r)); break; }

    if (r.tags && r.tags.length) stageTags[stage] = [...new Set([...stageTags[stage], ...r.tags])];
    if (r.actionItems && r.actionItems.length) actionItems = actionItems.concat(r.actionItems);

    if (r.done) {
      check('第4段结束标记 done', true);
      break;
    }
    if (r.advance) {
      check(`第${stage}段推进到下一段(advance)`, stage < 4);
      stage++; turn = 0;
      continue;
    }
    // 注入本轮用户输入
    const input = INPUTS[stage][turn];
    if (input == null) { check(`第${stage}段按预期推进`, false, '用户输入已耗尽仍未 advance'); break; }
    messages.push({ role: 'user', content: input });
    turn++;
  }
  check('四段全部走完（到达第4段）', stage === 4, `实际停在第 ${stage} 段`);
  check('第4段提取到行动项', actionItems.length > 0, JSON.stringify(actionItems));
  check('演示模式主题识别生效（非段落名兜底）',
    stageTags[1].some(t => ['客户', '预算'].includes(t)), JSON.stringify(stageTags[1]));
  return { stageTags, actionItems };
}

/** 会话沉淀：创建 -> 写四段 segment -> 结束 */
async function runSession(stageTags, actionItems) {
  console.log('\n[2] 会话沉淀');
  const s = await post('/api/sessions', {});
  check('创建会话返回 id', !!s.id, JSON.stringify(s));

  for (let st = 1; st <= 4; st++) {
    const seg = await post(`/api/sessions/${s.id}/segments`, {
      stage: st,
      transcript: INPUTS[st].join(' | '),
      tags: stageTags[st] || [],
      actionItems: st === 4 ? actionItems : []
    });
    if (st === 4) check('四段 segment 均写入', (seg.segments || []).length === 4, `segments=${(seg.segments || []).length}`);
  }
  const fin = await post(`/api/sessions/${s.id}/finish`, { energyScore: 4, overallMood: '平稳' });
  check('会话状态置为 done', fin.status === 'done', fin.status);
  check('能量值已保存', fin.energyScore === 4, String(fin.energyScore));
  return s.id;
}

/** 周报聚合：区间/次数/主题/能量/行动项/总结 */
async function runReport() {
  console.log('\n[3] 周报聚合');
  const r = await get('/api/report/weekly');

  // 周区间应为 周一~周日，且与本地时区一致
  const start = new Date(r.weekStart + 'T00:00:00');
  const end = new Date(r.weekEnd + 'T00:00:00');
  check('周起始为周一', start.getDay() === 1, `${r.weekStart} day=${start.getDay()}`);
  check('周结束为周日', end.getDay() === 0, `${r.weekEnd} day=${end.getDay()}`);
  check('周区间跨度为 6 天', Math.round((end - start) / 86400000) === 6, `${r.weekStart}~${r.weekEnd}`);

  // 今天必须落在本周区间内（时区偏移回归测试）
  const today = new Date(); const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  const todayStr = `${y}-${m}-${d}`;
  check('今天落在本周区间内', todayStr >= r.weekStart && todayStr <= r.weekEnd,
    `today=${todayStr} range=${r.weekStart}~${r.weekEnd}`);

  check('本周复盘次数 >= 1', r.sessionCount >= 1, String(r.sessionCount));
  check('聚合出高频主题', r.themes.length > 0, JSON.stringify(r.themes));
  check('能量走势有数据', r.energySeries.length > 0, JSON.stringify(r.energySeries));
  check('行动项已聚合', r.actionItems.length > 0, JSON.stringify(r.actionItems));
  check('AI 总结非空', !!r.summary && r.summary.length > 0, r.summary);
}

(async () => {
  console.log('高管日复盘 MVP 冒烟测试 -> ' + BASE);
  try {
    const settings = await get('/api/settings');
    check('设置接口可用', !!settings.llm, JSON.stringify(settings).slice(0, 120));
    check('API Key 前端掩码', !settings.llm.apiKey || settings.llm.apiKey.includes('***'), settings.llm.apiKey);

    const { stageTags, actionItems } = await runConversation();
    await runSession(stageTags, actionItems);
    await runReport();
  } catch (e) {
    fail++;
    console.log('\n  ERROR  ' + e.message);
    console.log('  -> 请确认服务已启动：node server.js');
  }
  console.log(`\n结果：${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
