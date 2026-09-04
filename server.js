'use strict';
/**
 * 高管日复盘 App · Web 壳 MVP 原型服务端
 * 零外部依赖：仅用 Node 内置 http / fs / path。
 * 运行：node server.js  （默认端口 3000，可用 PORT 环境变量覆盖）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const coach = require('./lib/coach');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function maskSettings(s) {
  const out = JSON.parse(JSON.stringify(s));
  if (out.llm && out.llm.apiKey) out.llm.apiKey = out.llm.apiKey.slice(0, 3) + '***' + out.llm.apiKey.slice(-2);
  return out;
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PUBLIC, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // SPA 兜底：未知路径返回 index.html
      fs.readFile(path.join(PUBLIC, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); res.end('Not found'); }
        else { res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(idx); }
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const method = req.method;

  try {
    // ---------- API ----------
    if (p.startsWith('/api/')) {
      // 设置
      if (p === '/api/settings' && method === 'GET') {
        return sendJSON(res, 200, maskSettings(store.getSettings()));
      }
      if (p === '/api/settings' && method === 'POST') {
        const body = await readBody(req);
        const saved = store.saveSettings(body);
        return sendJSON(res, 200, maskSettings(saved));
      }

      // 教练对话
      if (p === '/api/chat' && method === 'POST') {
        const body = await readBody(req);
        const settings = store.getSettings();
        const user = store.ensureUser(settings.user.id);
        if (body.userId) user.industry = user.industry || '';
        const result = await coach.coach({
          settings,
          messages: Array.isArray(body.messages) ? body.messages : [],
          stage: Number(body.stage) || 1,
          stageUserTurns: Number(body.stageUserTurns) || 0,
          tone: body.tone || settings.user.prefs.tone,
          challengeMode: body.challengeMode != null ? !!body.challengeMode : settings.user.prefs.challengeMode,
          user
        });
        return sendJSON(res, 200, result);
      }

      // 会话
      if (p === '/api/sessions' && method === 'POST') {
        const body = await readBody(req);
        const s = store.createSession(body);
        return sendJSON(res, 200, s);
      }
      if (p === '/api/sessions' && method === 'GET') {
        const userId = url.searchParams.get('userId') || store.getSettings().user.id;
        return sendJSON(res, 200, store.listSessions(userId));
      }
      // 对话进度快照（刷新后恢复用）
      const stateMatch = p.match(/^\/api\/sessions\/([^/]+)\/state$/);
      if (stateMatch && method === 'POST') {
        const body = await readBody(req);
        const s = store.saveSessionState(stateMatch[1], body);
        if (!s) return sendJSON(res, 404, { error: 'session not found or already finished' });
        return sendJSON(res, 200, { ok: true, stage: s.state.stage });
      }

      const segMatch = p.match(/^\/api\/sessions\/([^/]+)\/segments$/);
      if (segMatch && method === 'POST') {
        const body = await readBody(req);
        const s = store.addSegment(segMatch[1], body);
        if (!s) return sendJSON(res, 404, { error: 'session not found' });
        return sendJSON(res, 200, s);
      }
      const finMatch = p.match(/^\/api\/sessions\/([^/]+)\/finish$/);
      if (finMatch && method === 'POST') {
        const body = await readBody(req);
        const s = store.finishSession(finMatch[1], body);
        if (!s) return sendJSON(res, 404, { error: 'session not found' });
        return sendJSON(res, 200, s);
      }
      const idMatch = p.match(/^\/api\/sessions\/([^/]+)$/);
      if (idMatch && method === 'GET') {
        const s = store.getSession(idMatch[1]);
        if (!s) return sendJSON(res, 404, { error: 'session not found' });
        return sendJSON(res, 200, s);
      }

      // 周报聚合
      if (p === '/api/report/weekly' && method === 'GET') {
        const userId = url.searchParams.get('userId') || store.getSettings().user.id;
        const week = url.searchParams.get('week');
        const report = store.getWeeklyReport(userId, week);
        report.summary = await coach.summarizeReport(store.getSettings(), report);
        return sendJSON(res, 200, report);
      }

      return sendJSON(res, 404, { error: 'unknown api' });
    }

    // ---------- 静态资源 ----------
    return serveStatic(req, res, p);
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log('高管日复盘 MVP 原型已启动: http://localhost:' + PORT);
  console.log('默认演示模式（无需密钥即可体验）。配置 LLM 见「设置」页。');
});
