'use strict';
/**
 * 轻量 JSON 文件仓储（MVP 原型用，生产可替换为 PostgreSQL）。
 * 实体对齐设计文档 §5：User / ReviewSession / Segment / Tag / ActionItem / Report。
 * 为简化写入与保证原子性，session 内联 segments；tag/actionItem 挂在 segment 上。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_DATA = {
  version: 1,
  users: {},
  settings: {
    llm: {
      // 默认预填一家国内合规企业级 API（OpenAI 兼容协议），用户可在设置中修改
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      demoMode: true
    },
    user: {
      id: 'u_default',
      industry: '',
      role: '',
      profileTags: [],
      prefs: { tone: 'warm', challengeMode: false }
    }
  },
  sessions: []
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }

/** 按本地时区取 YYYY-MM-DD（toISOString 会转 UTC，东八区会整体偏前一天） */
function toLocalDate(d) {
  const dt = new Date(d);
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return dt.getFullYear() + '-' + m + '-' + day;
}

class Store {
  constructor() { this.ensure(); this.data = this.load(); }

  ensure() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DATA, null, 2), 'utf8');
    }
  }

  load() {
    try {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const obj = JSON.parse(raw);
      // 简单迁移保护：缺字段则合并默认
      return Object.assign(clone(DEFAULT_DATA), obj);
    } catch (e) {
      return clone(DEFAULT_DATA);
    }
  }

  save() {
    fs.writeFileSync(DB_FILE, JSON.stringify(this.data, null, 2), 'utf8');
  }

  // ---------- Settings ----------
  getSettings() { return this.data.settings; }

  saveSettings(patch) {
    if (patch && patch.llm) {
      this.data.settings.llm = Object.assign({}, this.data.settings.llm, patch.llm);
    }
    if (patch && patch.user) {
      this.data.settings.user = Object.assign({}, this.data.settings.user, patch.user);
      if (patch.user.profileTags) this.data.settings.user.profileTags = patch.user.profileTags;
      if (patch.user.prefs) this.data.settings.user.prefs = Object.assign({}, this.data.settings.user.prefs, patch.user.prefs);
    }
    this.save();
    return this.getSettings();
  }

  // ---------- Users ----------
  ensureUser(id) {
    if (!this.data.users[id]) {
      this.data.users[id] = { id, industry: '', role: '', profileTags: [], createdAt: new Date().toISOString() };
      this.save();
    }
    return this.data.users[id];
  }

  // ---------- Sessions ----------
  createSession({ userId, date, energyScore, overallMood }) {
    userId = userId || this.data.settings.user.id;
    const session = {
      id: 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      userId,
      date: date || new Date().toISOString(),
      durationSec: 0,
      energyScore: energyScore || null,
      overallMood: overallMood || '',
      status: 'active',
      segments: [],
      createdAt: new Date().toISOString()
    };
    this.data.sessions.push(session);
    this.save();
    return session;
  }

  getSession(id) {
    return this.data.sessions.find(s => s.id === id) || null;
  }

  listSessions(userId) {
    userId = userId || this.data.settings.user.id;
    return this.data.sessions
      .filter(s => s.userId === userId)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  addSegment(sessionId, segment) {
    const s = this.getSession(sessionId);
    if (!s) return null;
    const seg = {
      id: 'seg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      stage: segment.stage,
      transcript: segment.transcript || '',
      tags: segment.tags || [],
      actionItems: segment.actionItems || [],
      createdAt: new Date().toISOString()
    };
    s.segments.push(seg);
    this.save();
    return s;
  }

  finishSession(sessionId, { energyScore, overallMood } = {}) {
    const s = this.getSession(sessionId);
    if (!s) return null;
    if (energyScore != null) s.energyScore = energyScore;
    if (overallMood) s.overallMood = overallMood;
    s.status = 'done';
    s.durationSec = Math.round((Date.now() - new Date(s.createdAt).getTime()) / 1000);
    this.save();
    return s;
  }

  // ---------- Weekly report (§5.3) ----------
  getMonday(d) {
    const dt = new Date(d);
    const day = (dt.getDay() + 6) % 7; // 周一=0
    dt.setDate(dt.getDate() - day);
    dt.setHours(0, 0, 0, 0);
    return dt;
  }

  getWeeklyReport(userId, weekStartISO) {
    userId = userId || this.data.settings.user.id;
    const start = weekStartISO ? new Date(weekStartISO) : this.getMonday(new Date());
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(start.getDate() + 7);

    const sessions = (this.data.sessions || [])
      .filter(s => s.userId === userId && new Date(s.date) >= start && new Date(s.date) < end);

    const tagFreq = {};
    const actionItems = [];
    const energySeries = [];
    const moodSet = new Set();

    for (const s of sessions) {
      if (s.energyScore != null) energySeries.push({ date: toLocalDate(s.date), score: s.energyScore });
      if (s.overallMood) moodSet.add(s.overallMood);
      for (const seg of (s.segments || [])) {
        for (const t of (seg.tags || [])) tagFreq[t] = (tagFreq[t] || 0) + 1;
        for (const a of (seg.actionItems || [])) actionItems.push({ content: a, done: false, date: toLocalDate(s.date) });
      }
    }

    const themes = Object.keys(tagFreq)
      .map(t => ({ tag: t, count: tagFreq[t] }))
      .sort((a, b) => b.count - a.count);

    return {
      weekStart: toLocalDate(start),
      weekEnd: toLocalDate(new Date(end.getTime() - 1)),
      sessionCount: sessions.length,
      themes,
      energySeries,
      moods: Array.from(moodSet),
      actionItems,
      summary: ''
    };
  }
}

module.exports = new Store();
