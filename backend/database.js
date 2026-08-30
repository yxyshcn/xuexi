const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'xuexi.json');

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 默认数据结构
const defaultData = {
  users: [],
  task_templates: [],
  checkins: [],
  mistakes: [],
  goals: [],
  books: [],
  reports: [],
  messages: [],
  submissions: [],
  points_ledger: [],
  rewards: [],
  redemptions: [],
  _meta: {
    nextId: {
      users: 1,
      task_templates: 1,
      checkins: 1,
      mistakes: 1,
      goals: 1,
      books: 1,
      reports: 1,
      messages: 1,
      submissions: 1,
      points_ledger: 1,
      rewards: 1,
      redemptions: 1
    }
  }
};

let data = null;

function loadData() {
  if (data) return data;

  if (fs.existsSync(DB_FILE)) {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    data = JSON.parse(raw);
  } else {
    data = JSON.parse(JSON.stringify(defaultData));
    initData();
    saveData();
  }
  ensureDefaults(data);
  return data;
}

// 兼容旧数据文件：补齐新增字段
function ensureDefaults(d) {
  let changed = false;
  if (!Array.isArray(d.submissions)) { d.submissions = []; changed = true; }
  if (!Array.isArray(d.points_ledger)) { d.points_ledger = []; changed = true; }
  if (!Array.isArray(d.rewards)) { d.rewards = []; changed = true; }
  if (!Array.isArray(d.redemptions)) { d.redemptions = []; changed = true; }
  if (!d._meta) { d._meta = { nextId: {} }; changed = true; }
  if (!d._meta.nextId) { d._meta.nextId = {}; changed = true; }
  if (!d._meta.nextId.submissions) { d._meta.nextId.submissions = 1; changed = true; }
  if (!d._meta.nextId.points_ledger) { d._meta.nextId.points_ledger = 1; changed = true; }
  if (!d._meta.nextId.rewards) { d._meta.nextId.rewards = 1; changed = true; }
  if (!d._meta.nextId.redemptions) { d._meta.nextId.redemptions = 1; changed = true; }
  // 确保 checkins 有 quality 字段
  d.checkins.forEach(c => {
    if (c.quality === undefined) { c.quality = null; changed = true; }
  });
  if (changed) saveData();
}

function saveData() {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function getNextId(table) {
  const id = data._meta.nextId[table];
  data._meta.nextId[table]++;
  return id;
}

function initData() {
  // 默认用户
  const hash = bcrypt.hashSync('xiaoliu2026', 10);
  data.users.push(
    { id: getNextId('users'), username: 'papa', password_hash: hash, role: 'parent', display_name: '爸爸', created_at: new Date().toISOString() },
    { id: getNextId('users'), username: 'xiaoliu', password_hash: hash, role: 'student', display_name: '小石榴', created_at: new Date().toISOString() }
  );

  // 默认打卡任务
  data.task_templates.push(
    { id: getNextId('task_templates'), name: '语文学习', subject: '语文', icon: '📖', sort_order: 1, is_active: 1, created_at: new Date().toISOString() },
    { id: getNextId('task_templates'), name: '数学练习', subject: '数学', icon: '🔢', sort_order: 2, is_active: 1, created_at: new Date().toISOString() },
    { id: getNextId('task_templates'), name: '英语单词', subject: '英语', icon: '🔤', sort_order: 3, is_active: 1, created_at: new Date().toISOString() },
    { id: getNextId('task_templates'), name: 'OD学习', subject: 'OD', icon: '📗', sort_order: 4, is_active: 1, created_at: new Date().toISOString() }
  );

  console.log('✅ 数据库初始化完成');
}

// 查询辅助函数
const db = {
  // 用户
  getUserByUsername: (username) => {
    return loadData().users.find(u => u.username === username);
  },
  getUserById: (id) => {
    return loadData().users.find(u => u.id === id);
  },

  // 任务模板
  getAllTasks: () => {
    return loadData().task_templates.filter(t => t.is_active === 1 && t.parent_id === 0).sort((a, b) => a.sort_order - b.sort_order);
  },
  getAllSubTasks: (parentId) => {
    return loadData().task_templates.filter(t => t.is_active === 1 && t.parent_id === parentId).sort((a, b) => a.sort_order - b.sort_order);
  },
  getAllTasksIncludeInactive: () => {
    return loadData().task_templates.sort((a, b) => a.sort_order - b.sort_order);
  },
  getTaskById: (id) => {
    return loadData().task_templates.find(t => t.id === id);
  },
  createTask: (task) => {
    const d = loadData();
    const newTask = { id: getNextId('task_templates'), ...task, created_at: new Date().toISOString() };
    d.task_templates.push(newTask);
    saveData();
    return newTask;
  },
  updateTask: (id, updates) => {
    const d = loadData();
    const idx = d.task_templates.findIndex(t => t.id === id);
    if (idx >= 0) {
      d.task_templates[idx] = { ...d.task_templates[idx], ...updates };
      saveData();
      return true;
    }
    return false;
  },
  deleteTask: (id) => {
    const d = loadData();
    d.task_templates = d.task_templates.filter(t => t.id !== id);
    saveData();
    return true;
  },

  // 打卡
  getCheckins: (studentId, date) => {
    return loadData().checkins.filter(c => c.student_id === studentId && c.date === date);
  },
  getCheckinsByDateRange: (studentId, startDate, endDate) => {
    return loadData().checkins.filter(c =>
      c.student_id === studentId && c.date >= startDate && c.date <= endDate
    );
  },
  createOrUpdateCheckin: (checkin) => {
    const d = loadData();
    const existing = d.checkins.findIndex(c =>
      c.student_id === checkin.student_id && c.task_id === checkin.task_id && c.date === checkin.date
    );
    if (existing >= 0) {
      d.checkins[existing] = { ...d.checkins[existing], ...checkin };
    } else {
      d.checkins.push({ id: getNextId('checkins'), ...checkin, created_at: new Date().toISOString() });
    }
    saveData();
    return true;
  },
  removeCheckin: (studentId, taskId, date) => {
    const d = loadData();
    const before = d.checkins.length;
    d.checkins = d.checkins.filter(c =>
      !(c.student_id === studentId && c.task_id === taskId && c.date === date)
    );
    const removed = before - d.checkins.length;
    if (removed > 0) saveData();
    return removed > 0;
  },
  getCheckinsGroupedByDate: (studentId, startDate, endDate) => {
    const checkins = loadData().checkins.filter(c =>
      c.student_id === studentId && c.date >= startDate && c.date <= endDate
    );
    const grouped = {};
    checkins.forEach(c => {
      if (!grouped[c.date]) grouped[c.date] = { date: c.date, total: 0, completed: 0 };
      grouped[c.date].total++;
      if (c.is_completed) grouped[c.date].completed++;
    });
    return Object.values(grouped).sort((a, b) => a.date.localeCompare(b.date));
  },

  // 错题
  getMistakes: (studentId, filters = {}) => {
    let results = loadData().mistakes.filter(m => m.student_id === studentId);
    if (filters.subject) results = results.filter(m => m.subject === filters.subject);
    if (filters.is_corrected !== undefined) results = results.filter(m => m.is_corrected === filters.is_corrected);
    return results.sort((a, b) => b.created_at.localeCompare(a.created_at));
  },
  hasMistake: (studentId, topic, description) => {
    const norm = (s) => (s || '').replace(/\s+/g, '');
    const n = norm(description);
    return loadData().mistakes.some(m =>
      m.student_id === studentId && m.topic === topic && norm(m.description) === n && m.is_corrected === 0
    );
  },
  createMistake: (mistake) => {
    const d = loadData();
    const newMistake = { id: getNextId('mistakes'), ...mistake, created_at: new Date().toISOString() };
    d.mistakes.push(newMistake);
    saveData();
    return newMistake;
  },
  updateMistake: (id, updates) => {
    const d = loadData();
    const idx = d.mistakes.findIndex(m => m.id === id);
    if (idx >= 0) {
      d.mistakes[idx] = { ...d.mistakes[idx], ...updates };
      saveData();
      return true;
    }
    return false;
  },
  getMistakesStats: (studentId) => {
    const mistakes = loadData().mistakes.filter(m => m.student_id === studentId);
    const stats = {};
    mistakes.forEach(m => {
      if (!stats[m.subject]) stats[m.subject] = { subject: m.subject, total: 0, corrected: 0 };
      stats[m.subject].total++;
      if (m.is_corrected) stats[m.subject].corrected++;
    });
    return Object.values(stats);
  },
  getMistakesSince: (studentId, dateStr) => {
    return loadData().mistakes.filter(m =>
      m.student_id === studentId && m.created_at >= dateStr
    );
  },

  // 目标
  getAllGoals: () => {
    return loadData().goals.sort((a, b) => a.subject.localeCompare(b.subject));
  },
  createGoal: (goal) => {
    const d = loadData();
    const newGoal = { id: getNextId('goals'), ...goal, updated_at: new Date().toISOString() };
    d.goals.push(newGoal);
    saveData();
    return newGoal;
  },
  updateGoal: (id, updates) => {
    const d = loadData();
    const idx = d.goals.findIndex(g => g.id === id);
    if (idx >= 0) {
      d.goals[idx] = { ...d.goals[idx], ...updates, updated_at: new Date().toISOString() };
      saveData();
      return true;
    }
    return false;
  },

  // 阅读
  getBooks: (studentId) => {
    return loadData().books.filter(b => b.student_id === studentId).sort((a, b) => a.status.localeCompare(b.status));
  },
  createBook: (book) => {
    const d = loadData();
    const newBook = { id: getNextId('books'), ...book, created_at: new Date().toISOString() };
    d.books.push(newBook);
    saveData();
    return newBook;
  },
  updateBook: (id, updates) => {
    const d = loadData();
    const idx = d.books.findIndex(b => b.id === id);
    if (idx >= 0) {
      d.books[idx] = { ...d.books[idx], ...updates };
      saveData();
      return true;
    }
    return false;
  },

  // 留言
  getMessages: (limit = 50) => {
    return loadData().messages.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
  },
  createMessage: (msg) => {
    const d = loadData();
    const newMsg = { id: getNextId('messages'), ...msg, is_read: 0, created_at: new Date().toISOString() };
    d.messages.push(newMsg);
    saveData();
    return newMsg;
  },
  markMessageRead: (id) => {
    const d = loadData();
    const idx = d.messages.findIndex(m => m.id === id);
    if (idx >= 0) {
      d.messages[idx].is_read = 1;
      saveData();
      return true;
    }
    return false;
  },
  getUnreadMessageCount: () => {
    return loadData().messages.filter(m => m.is_read === 0).length;
  },

  // 作业提交
  createSubmission: (sub) => {
    const d = loadData();
    const newSub = { id: getNextId('submissions'), ...sub, created_at: new Date().toISOString() };
    d.submissions.push(newSub);
    saveData();
    return newSub;
  },
  updateSubmission: (id, updates) => {
    const d = loadData();
    const idx = d.submissions.findIndex(s => s.id === id);
    if (idx >= 0) {
      d.submissions[idx] = { ...d.submissions[idx], ...updates };
      saveData();
      return d.submissions[idx];
    }
    return null;
  },
  getSubmissions: (studentId, filters = {}) => {
    let results = loadData().submissions.filter(s => s.student_id === studentId);
    if (filters.task_id) results = results.filter(s => s.task_id === filters.task_id);
    if (filters.date) results = results.filter(s => s.date === filters.date);
    return results.sort((a, b) => b.created_at.localeCompare(a.created_at));
  },
  getSubmissionById: (id) => {
    return loadData().submissions.find(s => s.id === id);
  },

  // 周报
  getReports: () => {
    return loadData().reports.sort((a, b) => b.generated_at.localeCompare(a.generated_at));
  },
  createReport: (report) => {
    const d = loadData();
    const newReport = { id: getNextId('reports'), ...report, generated_at: new Date().toISOString() };
    d.reports.push(newReport);
    saveData();
    return newReport;
  },

  // 积分
  addPoints: (entry) => {
    const d = loadData();
    const newEntry = { id: getNextId('points_ledger'), ...entry, created_at: new Date().toISOString() };
    d.points_ledger.push(newEntry);
    saveData();
    return newEntry;
  },
  getPointsBalance: (studentId) => {
    const entries = loadData().points_ledger.filter(e => e.student_id === studentId);
    return entries.reduce((sum, e) => sum + e.points, 0);
  },
  getPointsLedger: (studentId, limit = 50) => {
    return loadData().points_ledger
      .filter(e => e.student_id === studentId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  },
  getDailyPoints: (studentId, date) => {
    return loadData().points_ledger.filter(e =>
      e.student_id === studentId && e.date === date && e.source === 'daily'
    );
  },
  getWeeklyBonus: (studentId, weekStart) => {
    return loadData().points_ledger.find(e =>
      e.student_id === studentId && e.source === 'weekly_bonus' && e.week_start === weekStart
    );
  },

  // 奖励
  getRewards: () => {
    return loadData().rewards.filter(r => r.is_active !== 0).sort((a, b) => a.cost - b.cost);
  },
  getAllRewards: () => {
    return loadData().rewards.sort((a, b) => a.sort_order - b.sort_order);
  },
  createReward: (reward) => {
    const d = loadData();
    const newReward = { id: getNextId('rewards'), ...reward, is_active: reward.is_active !== undefined ? reward.is_active : 1, created_at: new Date().toISOString() };
    d.rewards.push(newReward);
    saveData();
    return newReward;
  },
  updateReward: (id, updates) => {
    const d = loadData();
    const idx = d.rewards.findIndex(r => r.id === id);
    if (idx >= 0) {
      d.rewards[idx] = { ...d.rewards[idx], ...updates };
      saveData();
      return true;
    }
    return false;
  },
  deleteReward: (id) => {
    const d = loadData();
    d.rewards = d.rewards.filter(r => r.id !== id);
    saveData();
    return true;
  },

  // 兑换
  createRedemption: (redemption) => {
    const d = loadData();
    const newRed = { id: getNextId('redemptions'), ...redemption, redeemed_at: new Date().toISOString() };
    d.redemptions.push(newRed);
    // 扣减积分（记一笔负数流水）
    d.points_ledger.push({
      id: getNextId('points_ledger'),
      student_id: redemption.student_id,
      points: -redemption.cost,
      source: 'redemption',
      description: `兑换：${redemption.reward_name}`,
      date: new Date().toISOString().split('T')[0],
      created_at: new Date().toISOString()
    });
    saveData();
    return newRed;
  },
  getRedemptions: (studentId) => {
    return loadData().redemptions
      .filter(r => r.student_id === studentId)
      .sort((a, b) => b.redeemed_at.localeCompare(a.redeemed_at));
  },

  // 统计
  getTodayStats: (studentId, today) => {
    const checkins = loadData().checkins.filter(c => c.student_id === studentId && c.date === today);
    const total = checkins.length;
    const completed = checkins.filter(c => c.is_completed).length;
    return { total, completed };
  },
  getStreak: (studentId) => {
    const checkins = loadData().checkins
      .filter(c => c.student_id === studentId && c.is_completed)
      .map(c => c.date)
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort((a, b) => b.localeCompare(a));

    if (checkins.length === 0) return 0;

    let streak = 0;
    const today = new Date();
    for (let i = 0; i < 365; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      if (checkins.includes(dateStr)) {
        streak++;
      } else {
        break;
      }
    }
    return streak;
  }
};

module.exports = { loadData, saveData, db };
