/**
 * 真实 LLM 端到端联调测试（需要已在设置页配置可用的 LLM Key）
 *
 * 与 tests/llm_test.js（本地 mock 端点）不同，本脚本走真实厂商端点，
 * 验证：四段式对话推进、标签/行动项提取、会话结束、周报 AI 总结。
 * 未配置真实 Key 时自动跳过（exit 0），不影响 CI。
 *
 * 运行：npm run test:live
 */
const BASE = process.env.BASE_URL || 'http://localhost:3000';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}  -> ${detail}`); }
}

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}
async function get(path) {
  const r = await fetch(BASE + path);
  return r.json();
}

/** 模拟前端的四段式状态机：维护 messages / stage / stageUserTurns */
async function runConversation() {
  console.log('\n[1] 四段式真实对话');
  const stages = [
    ['今天主要做了三件事：上午和交付部门对齐了A项目的工程师排期，下午面试了两位售前候选人，晚上接到客户下周要方案的建议需求。总体顺利，就是排期协调花了些时间。',
     '最大的变数是交付资源——原计划的两名工程师被B项目抽走，我协调了一个小时才要回来，差点影响下周的部署节点。'],
    ['说实话有点焦虑，售前人手一直不够，方案质量时好时坏，客户那边已经开始有微词了。',
     '焦虑的根源是我总在救火，没有提前储备人；另外我对售前同事的能力边界了解不够，分派任务时心里没底。'],
    ['做得好的是把面试流程坚持下来了，没有因为忙就砍掉；若重来，我会把B项目抽人的风险提前写进排期，而不是等出了问题再协调。',
     '学到了资源协调要前置，明天开始把关键资源的占用情况做成每周固定同步。'],
    ['明天最该做的一件事：把客户方案框架定下来，并和售前负责人把两名工程师的时间彻底锁定。',
     '配套动作：给交付总监发资源确认邮件，把方案大纲发给售前负责人评审，面试反馈同步给HR——邮件今天下班前发出。']
  ];
  let messages = [];
  let done = false;
  const allTags = new Set();
  const allActions = [];
  const replies = [];

  for (let stage = 1; stage <= 4 && !done; stage++) {
    let stageUserTurns = 0;
    for (const userMsg of stages[stage - 1]) {
      if (done) break;
      const t0 = Date.now();
      const r = await post('/api/chat', { messages, stage, stageUserTurns, tone: 'warm', challengeMode: false });
      const dt = Date.now() - t0;
      messages.push({ role: 'user', content: userMsg });
      check(`stage=${stage} turn=${stageUserTurns + 1} reply 非空（${dt}ms）`, r && r.reply && r.reply.length > 0, JSON.stringify(r).slice(0, 200));
      if (!r || !r.reply) return { done: false };
      check(`stage=${stage} turn=${stageUserTurns + 1} 未发生静默降级`, !r.note, r.note || '');
      console.log(`        AI: ${String(r.reply).slice(0, 60)}${r.reply.length > 60 ? '…' : ''}`);
      replies.push(r.reply);
      if (Array.isArray(r.tags)) r.tags.forEach(t => allTags.add(t));
      if (Array.isArray(r.actionItems)) allActions.push(...r.actionItems);
      messages.push({ role: 'assistant', content: r.reply });
      stageUserTurns++;
      if (r.done) { done = true; }
      else if (r.advance) { break; }
    }
  }
  check('四段对话全部推进完成（done=true）', done, '遍历完四段仍未 done');
  check('回复均为中文且非演示模板', replies.length >= 4 && replies.every(t => !/这一段我们聊聊|听起来「/.test(t)), replies[0]);
  check('标签为真实主题词（非段落名）', allTags.size > 0 && ![...allTags].every(t => ['关键事', '想法感受', '行动'].includes(t)), [...allTags].join(','));
  check('提取出行动项', allActions.length > 0, `actions=${allActions.length}`);
  return { done };
}

async function main() {
  console.log('真实 LLM 端到端联调测试\n======================');
  const s = await get('/api/settings');
  const llm = s.llm || {};
  if (llm.demoMode || !llm.apiKey || !llm.baseURL) {
    console.log('未配置真实 LLM（demoMode 或缺少 Key），跳过本测试。');
    console.log('结果：0 passed, 0 failed (skipped)');
    return;
  }
  console.log(`端点：${llm.baseURL}  模型：${llm.model}`);

  console.log('\n[0] 连通性自检');
  const t = await post('/api/llm/test', {});
  check('连通性自检 ok', t.ok === true, JSON.stringify(t));
  check('连通性回复非空', t.reply && t.reply.length > 0, JSON.stringify(t));

  const conv = await runConversation();

  console.log('\n[2] 结束复盘');
  const fin = await post('/api/sessions', {});
  const list = await get('/api/sessions');
  const today = new Date();
  const local = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const sess = list.find(x => x.status === 'active' && x.date.slice(0, 10) === local) || fin;
  const finished = await post(`/api/sessions/${sess.id}/finish`, { energyScore: 4, overallMood: '平稳', segments: [] });
  check('会话状态置为 done', finished && finished.status === 'done', JSON.stringify(finished).slice(0, 150));

  console.log('\n[3] 周报 AI 总结');
  const report = await get('/api/report/weekly');
  check('周报包含会话', report.sessionCount >= 1, `count=${report.sessionCount}`);
  check('周报有主题词', Array.isArray(report.themes) && report.themes.length > 0, JSON.stringify(report.themes || []).slice(0, 150));
  check('AI 总结非空且非模板', report.summary && !/坚持就是复利/.test(report.summary), report.summary);

  console.log(`\n结果：${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('脚本异常：', e.message); process.exit(1); });
