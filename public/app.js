'use strict';

const STAGES = [
  { id: 1, name: '关键事' },
  { id: 2, name: '想法/感受' },
  { id: 3, name: '洞察/遗憾' },
  { id: 4, name: '下一步' }
];

const state = {
  settings: null,
  sessionId: null,
  stage: 1,
  stageUserTurns: 0,
  messages: [],            // {role, content}
  stageTranscripts: {},    // stage -> 用户文本拼接
  stageTags: {},           // stage -> Set
  stageActions: {},        // stage -> []
  finished: false,
  busy: false
};

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

// ---------- 初始化 ----------
async function init() {
  bindTabs();
  bindComposer();
  bindSettings();
  bindFinish();
  bindReport();
  await loadSettings();
  await ensureSession();
  renderStepper();
}

function bindTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      btn.classList.add('active');
      $('#view-' + btn.dataset.view).classList.add('active');
      if (btn.dataset.view === 'report') loadReport();
    });
  });
}

// ---------- 设置 ----------
async function loadSettings() {
  const r = await fetch('/api/settings').then(r => r.json());
  state.settings = r;
  // 填充表单
  $('#llmBaseURL').value = r.llm.baseURL || '';
  $('#llmApiKey').value = r.llm.apiKey || '';
  $('#llmModel').value = r.llm.model || '';
  $('#demoMode').checked = !!r.llm.demoMode;
  $('#tone').value = (r.user.prefs && r.user.prefs.tone) || 'warm';
  $('#challengeMode').checked = !!(r.user.prefs && r.user.prefs.challengeMode);
  $('#industry').value = r.user.industry || '';
  $('#role').value = r.user.role || '';
  $('#profileTags').value = (r.user.profileTags || []).join('、');
  updateModeBadge();
}

function updateModeBadge() {
  const live = state.settings && state.settings.llm && state.settings.llm.apiKey && !state.settings.llm.demoMode;
  const badge = $('#modeBadge');
  if (live) { badge.textContent = '已接入 LLM'; badge.className = 'badge live'; }
  else { badge.textContent = '演示模式'; badge.className = 'badge demo'; }
}

async function saveSettings() {
  const payload = {
    llm: {
      baseURL: $('#llmBaseURL').value.trim(),
      apiKey: $('#llmApiKey').value.trim(),
      model: $('#llmModel').value.trim(),
      demoMode: $('#demoMode').checked
    },
    user: {
      industry: $('#industry').value.trim(),
      role: $('#role').value.trim(),
      profileTags: $('#profileTags').value.split(/[，,、]/).map(s => s.trim()).filter(Boolean),
      prefs: { tone: $('#tone').value, challengeMode: $('#challengeMode').checked }
    }
  };
  const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(r => r.json());
  state.settings = r;
  updateModeBadge();
  $('#settingsMsg').textContent = '已保存 ✓';
  setTimeout(() => { $('#settingsMsg').textContent = ''; }, 2000);
}
function bindSettings() { $('#saveSettingsBtn').addEventListener('click', saveSettings); }

// ---------- 会话 ----------
async function ensureSession() {
  const list = await fetch('/api/sessions').then(r => r.json());
  const today = localDate(new Date());
  const active = list.find(s => s.status === 'active' && s.date.slice(0, 10) === today);
  if (active) {
    state.sessionId = active.id;
    // 简单恢复：直接进入第4段结束态之前，这里仅继续新对话
  } else {
    const s = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json());
    state.sessionId = s.id;
  }
  await getOpener();
}

function addMsg(role, content, meta) {
  state.messages.push({ role, content });
  const wrap = el('div', 'msg ' + role);
  const who = role === 'ai' ? 'AI 教练' : '我';
  wrap.appendChild(el('div', null, `<div class="who">${who}</div><div class="bubble">${escapeHtml(content)}</div>`));
  if (meta) {
    const m = el('div', 'meta');
    if (meta.tags && meta.tags.length) m.appendChild(el('div', null, meta.tags.map(t => `<span class="chip">${escapeHtml(t)}</span>`).join('')));
    if (meta.actions && meta.actions.length) m.appendChild(el('div', null, meta.actions.map(t => `<span class="chip act">行动：${escapeHtml(t)}</span>`).join('')));
    wrap.appendChild(m);
  }
  $('#chatLog').appendChild(wrap);
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
}

async function getOpener() {
  const r = await callCoach();
  if (r && r.reply) addMsg('ai', r.reply);
}

async function callCoach() {
  const body = {
    messages: state.messages,
    stage: state.stage,
    stageUserTurns: state.stageUserTurns,
    tone: (state.settings.user.prefs && state.settings.user.prefs.tone) || 'warm',
    challengeMode: !!(state.settings.user.prefs && state.settings.user.prefs.challengeMode)
  };
  const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  return r;
}

function bindComposer() {
  $('#sendBtn').addEventListener('click', sendUser);
  $('#userInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendUser(); }
  });
  $('#energy').addEventListener('input', () => { $('#energyVal').textContent = $('#energy').value; });
}

async function sendUser() {
  if (state.busy || state.finished) return;
  const input = $('#userInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  // 记录本段用户文本（addMsg 内部已入栈 state.messages，此处不重复 push）
  addMsg('user', text);
  state.stageUserTurns += 1;
  (state.stageTranscripts[state.stage] = state.stageTranscripts[state.stage] || []).push(text);

  state.busy = true;
  $('#sendBtn').disabled = true;
  try {
    const r = await callCoach();
    if (r && r.reply) {
      addMsg('ai', r.reply, { tags: r.tags, actions: r.actionItems });
      // 收集标签/行动项
      (state.stageTags[state.stage] = state.stageTags[state.stage] || new Set());
      (r.tags || []).forEach(t => state.stageTags[state.stage].add(t));
      (state.stageActions[state.stage] = state.stageActions[state.stage] || []).push(...(r.actionItems || []));

      if (r.done) {
        // 第4段完成 -> 显示结束面板
        $('#finishPanel').classList.remove('hidden');
        $('#finishBtn').disabled = false;
        state.finished = true;
      } else if (r.advance && state.stage < 4) {
        state.stage += 1;
        state.stageUserTurns = 0;
        renderStepper();
        // 拉取下一段开场
        const op = await callCoach();
        if (op && op.reply) addMsg('ai', op.reply);
      }
    }
  } catch (e) {
    addMsg('ai', '（连接异常：' + e.message + '）');
  } finally {
    state.busy = false;
    $('#sendBtn').disabled = false;
  }
}

function renderStepper() {
  const wrap = $('#stepper');
  wrap.innerHTML = '';
  STAGES.forEach(s => {
    const div = el('div', 'step' + (s.id === state.stage ? ' active' : '') + (s.id < state.stage ? ' done' : ''));
    div.appendChild(el('div', 'num', '第 ' + s.id + ' 段'));
    div.appendChild(el('div', 'name', s.name + (s.id < state.stage ? ' ✓' : '')));
    wrap.appendChild(div);
  });
}

// ---------- 结束复盘 ----------
function bindFinish() {
  $('#finishBtn').addEventListener('click', () => { $('#finishPanel').classList.remove('hidden'); });
  $('#saveFinishBtn').addEventListener('click', finishSession);
}
async function finishSession() {
  // 保存各段为 segment
  for (const s of STAGES) {
    const transcript = (state.stageTranscripts[s.id] || []).join('\n');
    if (!transcript) continue;
    const tags = Array.from(state.stageTags[s.id] || []);
    const actions = state.stageActions[s.id] || [];
    await fetch('/api/sessions/' + state.sessionId + '/segments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: s.id, transcript, tags, actionItems: actions })
    });
  }
  const energy = Number($('#energy').value);
  const mood = $('#mood').value.trim();
  await fetch('/api/sessions/' + state.sessionId + '/finish', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ energyScore: energy, overallMood: mood })
  });
  addMsg('ai', '✅ 今日复盘已沉淀。可在「周报」查看本周聚合。');
  $('#finishPanel').classList.add('hidden');
  // 进入新会话
  state.sessionId = null; state.stage = 1; state.stageUserTurns = 0; state.messages = [];
  state.stageTranscripts = {}; state.stageTags = {}; state.stageActions = {}; state.finished = false;
  renderStepper();
  $('#chatLog').innerHTML = '';
  await ensureSession();
}

// ---------- 周报 ----------
function bindReport() { $('#refreshReport').addEventListener('click', loadReport); }
async function loadReport() {
  const body = $('#reportBody');
  body.innerHTML = '<div class="empty">加载中…</div>';
  const r = await fetch('/api/report/weekly').then(r => r.json());
  $('#weekRange').textContent = r.weekStart + ' ~ ' + r.weekEnd;

  let html = '';
  html += `<div class="summary-card">${escapeHtml(r.summary || '—')}</div>`;
  html += `<div class="kpi-row">
    <div class="kpi"><div class="v">${r.sessionCount}</div><div class="l">本周复盘次数</div></div>
    <div class="kpi"><div class="v">${r.themes.length}</div><div class="l">高频主题</div></div>
    <div class="kpi"><div class="v">${r.actionItems.length}</div><div class="l">行动项</div></div>
  </div>`;

  if (r.themes.length) {
    html += `<div class="card"><h3>高频主题</h3><div class="themes">` +
      r.themes.map(t => `<span class="chip">${escapeHtml(t.tag)} · ${t.count}</span>`).join('') + `</div></div>`;
  }
  if (r.energySeries.length) {
    const max = Math.max(...r.energySeries.map(e => e.score), 1);
    html += `<div class="card"><h3>能量走势</h3>` +
      r.energySeries.map(e => `<div class="bar-row"><span style="width:64px">${e.date.slice(5)}</span><span class="bar" style="width:${e.score / max * 120}px"></span><span class="muted">${e.score}</span></div>`).join('') + `</div>`;
  }
  if (r.actionItems.length) {
    html += `<div class="card"><h3>行动项</h3><ul class="clean">` +
      r.actionItems.map(a => `<li>${escapeHtml(a.content)} <span class="muted">(${a.date})</span></li>`).join('') + `</ul></div>`;
  }
  if (!r.sessionCount) html += `<div class="empty">本周还没有复盘记录，今晚开始第一次吧。</div>`;
  body.innerHTML = html;
}

// ---------- utils ----------
/** 按本地时区取 YYYY-MM-DD（避免 toISOString 的 UTC 日期偏移） */
function localDate(d) {
  const dt = new Date(d);
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return dt.getFullYear() + '-' + m + '-' + day;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init();
