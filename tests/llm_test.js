'use strict';
/**
 * 真实 LLM 调用路径专项测试（用本地 mock 端点，无需真实 API Key）。
 *
 * 前置：先启动服务 `node server.js`
 * 运行：npm run test:llm
 *
 * 覆盖：请求构造、JSON 解析（标准 / 围栏 / 纯文本 / 空）、advance-done 映射、
 *       HTTP 错误降级、连通性自检、以及「不传 apiKey 不覆盖真实密钥」。
 */
const http = require('http');
const coach = require('../lib/coach');   // 直接调用以测试不依赖服务端状态的分支
const BASE = process.env.BASE_URL || 'http://localhost:3000';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  });
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
  return r.json();
}
async function get(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
  return r.json();
}

// ---------- mock OpenAI 兼容端点 ----------
let mode = 'json';
let lastReq = null;
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (e) { /* ignore */ }
    lastReq = { url: req.url, headers: req.headers, body };

    if (mode === 'http500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'internal error' }));
    }
    if (mode === 'hang') return;   // 不响应，用于验证超时（默认不启用，耗时长）

    const payloads = {
      json: JSON.stringify({ reply: '这是教练追问', tags: ['客户', '交付'], actionItems: [], advance: false, done: false }),
      fenced: '我来追问：\n```json\n' + JSON.stringify({ reply: '围栏内的追问', tags: ['预算'], actionItems: [], advance: true, done: false }) + '\n```\n以上',
      plaintext: '这是一段没有 JSON 的纯文本回复',
      empty: '',
      done: JSON.stringify({ reply: '已记录行动项', tags: ['执行'], actionItems: ['明天与交付负责人对齐周期'], advance: false, done: true })
    };
    const content = payloads[mode] != null ? payloads[mode] : payloads.json;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'mock-1', model: 'mock-model', choices: [{ message: { role: 'assistant', content } }] }));
  });
});

async function chat(stage, stageUserTurns) {
  return post('/api/chat', {
    messages: [{ role: 'user', content: '今天和客户谈崩了。' }],
    stage: stage || 1, stageUserTurns: stageUserTurns == null ? 1 : stageUserTurns,
    tone: 'warm', challengeMode: false
  });
}

(async () => {
  console.log('LLM 调用路径专项测试 -> ' + BASE);
  let original = null;
  try {
    original = await get('/api/settings');
    // 安全保护：已配置真实密钥时，写测试配置会覆盖用户 Key（掩码无法还原）。
    // 默认跳过；开发时可设 LLM_TEST_ALLOW_OVERWRITE=1 强制运行（事后需自行恢复密钥）。
    if (original.llm && original.llm.apiKey && !process.env.LLM_TEST_ALLOW_OVERWRITE) {
      console.log('  SKIP  检测到已配置真实 LLM 密钥，跳过 mock 测试以免覆盖用户配置。');
      console.log('  （如需强制运行：LLM_TEST_ALLOW_OVERWRITE=1）');
      console.log(`结果：0 passed, 0 failed (skipped)`);
      return;
    }

    await new Promise(r => mock.listen(0, '127.0.0.1', r));
    const port = mock.address().port;
    const mockURL = `http://127.0.0.1:${port}/v1`;
    console.log(`  mock 端点: ${mockURL}`);

    // 切到真实 LLM 模式（指向 mock）
    await post('/api/settings', {
      llm: { baseURL: mockURL, apiKey: 'test-key', model: 'mock-model', demoMode: false }
    });

    console.log('\n[1] 请求构造');
    mode = 'json';
    await chat();
    check('请求路径为 /v1/chat/completions', lastReq.url === '/v1/chat/completions', lastReq.url);
    check('Authorization 头正确', lastReq.headers.authorization === 'Bearer test-key', lastReq.headers.authorization);
    check('请求体带 model', lastReq.body.model === 'mock-model', String(lastReq.body.model));
    check('请求体带 system 提示词（含四段式目标）',
      JSON.stringify(lastReq.body.messages).includes('教练'), JSON.stringify(lastReq.body.messages).slice(0, 120));

    console.log('\n[2] 响应解析与状态机');
    mode = 'json';
    let r = await chat();
    check('标准 JSON：reply 正确', r.reply === '这是教练追问', r.reply);
    check('标准 JSON：tags 正确', JSON.stringify(r.tags) === JSON.stringify(['客户', '交付']), JSON.stringify(r.tags));
    check('满2轮时代码强制 advance（即使模型返回 false）', r.advance === true, String(r.advance));

    mode = 'json';
    r = await chat(1, 0);
    check('不足2轮时尊重模型判断 advance=false', r.advance === false, String(r.advance));

    mode = 'fenced';
    r = await chat();
    check('围栏 JSON：能剥掉 ```json 解析', r.reply === '围栏内的追问', r.reply);
    check('围栏 JSON：advance=true 生效', r.advance === true, String(r.advance));

    mode = 'plaintext';
    r = await chat(1, 0);
    check('纯文本：原文兜底为 reply', r.reply === '这是一段没有 JSON 的纯文本回复', r.reply);
    check('纯文本：tags 为空数组', Array.isArray(r.tags) && r.tags.length === 0, JSON.stringify(r.tags));

    mode = 'empty';
    r = await chat(1, 0);
    check('空内容：reply 有兜底文案不为空', !!r.reply && r.reply.length > 0, JSON.stringify(r));

    mode = 'done';
    r = await chat(4, 1);
    check('第4段满2轮：模型 done=true 透传', r.done === true, String(r.done));
    check('行动项正确提取',
      JSON.stringify(r.actionItems) === JSON.stringify(['明天与交付负责人对齐周期']), JSON.stringify(r.actionItems));

    mode = 'json';
    r = await chat(4, 1);
    check('第4段满2轮：模型未给 done 也强制结束', r.done === true, String(r.done));
    check('强制结束时行动项兜底取用户末条消息', r.actionItems.length === 1 && r.actionItems[0].includes('客户'), JSON.stringify(r.actionItems));

    console.log('\n[3] 失败降级');
    mode = 'http500';
    r = await chat();
    check('HTTP 500 时降级且仍有回复', !!r.reply && r.reply.length > 0, JSON.stringify(r));
    check('HTTP 500 时带降级提示 note', !!r.note && r.note.includes('降级'), r.note);

    console.log('\n[4] 连通性自检 /api/llm/test');
    mode = 'json';
    const ok = await post('/api/llm/test', {});
    check('自检成功返回 ok', ok.ok === true, JSON.stringify(ok));
    check('自检返回耗时', typeof ok.latencyMs === 'number', String(ok.latencyMs));

    mode = 'http500';
    const bad = await post('/api/llm/test', {});
    check('自检失败返回错误原因', bad.ok === false && /HTTP 500/.test(bad.error || ''), JSON.stringify(bad));

    // 直接测 testConnection 的守卫：不经 HTTP 接口，避免污染服务端已保存的密钥
    // 注意：接口层对空 apiKey 会回落使用服务端已保存值（有意为之，前端清空输入框=沿用原值），故不能直接打接口验证
    let noKey = await coach.testConnection({ baseURL: mockURL, apiKey: '', model: 'mock-model' });
    check('缺少 API Key 时明确报错', noKey.ok === false && /API Key/.test(noKey.error || ''), JSON.stringify(noKey));
    noKey = await coach.testConnection({ baseURL: '', apiKey: 'k', model: 'm' });
    check('缺少服务地址时明确报错', noKey.ok === false && /服务地址/.test(noKey.error || ''), JSON.stringify(noKey));

    console.log('\n[5] 密钥保护：不传 apiKey 不覆盖真实值');
    const hadRealKey = !!original.llm.apiKey;   // 服务端返回的是掩码；非空说明用户已配置过
    if (hadRealKey) {
      console.log('  SKIP  检测到已配置真实密钥，跳过写 Key 的用例以免覆盖用户配置');
    } else {
      await post('/api/settings', { llm: { baseURL: mockURL, apiKey: 'real-secret-key-123', model: 'mock-model', demoMode: false } });
      await post('/api/settings', { llm: { model: 'mock-model' } });   // 只改模型，不传 Key
      const s = await get('/api/settings');
      check('未传 apiKey 时真实密钥保持不变（掩码仍为 rea***23）',
        s.llm.apiKey === 'rea***23', `apiKey=${s.llm.apiKey}`);
      await post('/api/settings', { llm: { apiKey: '' } });   // 复原为未配置
    }

    // 复原：同样不传 apiKey，避免把掩码写回覆盖用户原本的密钥
    await post('/api/settings', {
      llm: { baseURL: original.llm.baseURL, model: original.llm.model, demoMode: original.llm.demoMode }
    });
    console.log('  （已复原设置，未改动 apiKey）');
  } catch (e) {
    fail++;
    console.log('\n  ERROR  ' + e.message);
    console.log('  -> 请确认服务已启动：node server.js');
  } finally {
    mock.close();
  }
  console.log(`\n结果：${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
