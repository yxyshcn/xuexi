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
  exams: [],
  exam_questions: [],
  avatars: [],
  student_avatars: [],
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
      redemptions: 1,
      exams: 1,
      exam_questions: 1,
      avatars: 1,
      student_avatars: 1
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
  if (!Array.isArray(d.exams)) { d.exams = []; changed = true; }
  if (!Array.isArray(d.exam_questions)) { d.exam_questions = []; changed = true; }
  if (!Array.isArray(d.avatars)) { d.avatars = []; changed = true; }
  if (!Array.isArray(d.student_avatars)) { d.student_avatars = []; changed = true; }
  if (!d._meta) { d._meta = { nextId: {} }; changed = true; }
  if (!d._meta.nextId) { d._meta.nextId = {}; changed = true; }
  if (!d._meta.nextId.submissions) { d._meta.nextId.submissions = 1; changed = true; }
  if (!d._meta.nextId.points_ledger) { d._meta.nextId.points_ledger = 1; changed = true; }
  if (!d._meta.nextId.rewards) { d._meta.nextId.rewards = 1; changed = true; }
  if (!d._meta.nextId.redemptions) { d._meta.nextId.redemptions = 1; changed = true; }
  if (!d._meta.nextId.exams) { d._meta.nextId.exams = 1; changed = true; }
  if (!d._meta.nextId.exam_questions) { d._meta.nextId.exam_questions = 1; changed = true; }
  if (!d._meta.nextId.avatars) { d._meta.nextId.avatars = 1; changed = true; }
  if (!d._meta.nextId.student_avatars) { d._meta.nextId.student_avatars = 1; changed = true; }
  // 确保 users 有 avatar_id 字段
  d.users.forEach(u => {
    if (u.avatar_id === undefined) { u.avatar_id = null; changed = true; }
  });
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
  deleteMistake: (id) => {
    const d = loadData();
    const before = d.mistakes.length;
    d.mistakes = d.mistakes.filter(m => m.id !== id);
    if (d.mistakes.length < before) saveData();
    return d.mistakes.length < before;
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

  // ============ 试卷分析 ============
  createExam: (exam) => {
    const d = loadData();
    const newExam = { id: getNextId('exams'), ...exam, created_at: new Date().toISOString() };
    d.exams.push(newExam);
    saveData();
    return newExam;
  },
  getExams: (studentId, filters = {}) => {
    let results = loadData().exams.filter(e => e.student_id === studentId);
    if (filters.subject) results = results.filter(e => e.subject === filters.subject);
    if (filters.exam_type) results = results.filter(e => e.exam_type === filters.exam_type);
    return results.sort((a, b) => b.exam_date.localeCompare(a.exam_date));
  },
  getExamById: (id) => {
    return loadData().exams.find(e => e.id === id);
  },
  updateExam: (id, updates) => {
    const d = loadData();
    const idx = d.exams.findIndex(e => e.id === id);
    if (idx >= 0) {
      d.exams[idx] = { ...d.exams[idx], ...updates };
      saveData();
      return d.exams[idx];
    }
    return null;
  },
  deleteExam: (id) => {
    const d = loadData();
    d.exams = d.exams.filter(e => e.id !== id);
    d.exam_questions = d.exam_questions.filter(q => q.exam_id !== id);
    saveData();
    return true;
  },
  // 题目
  createExamQuestion: (q) => {
    const d = loadData();
    const newQ = { id: getNextId('exam_questions'), ...q };
    d.exam_questions.push(newQ);
    saveData();
    return newQ;
  },
  getExamQuestions: (examId) => {
    return loadData().exam_questions.filter(q => q.exam_id === examId).sort((a, b) => a.question_num - b.question_num);
  },
  // 统计：某学生某科目的所有考试趋势
  getExamTrend: (studentId, subject) => {
    const exams = loadData().exams.filter(e => e.student_id === studentId && e.subject === subject);
    return exams.sort((a, b) => a.exam_date.localeCompare(b.exam_date)).map(e => ({
      id: e.id,
      exam_date: e.exam_date,
      exam_type: e.exam_type,
      title: e.title,
      accuracy: e.accuracy,
      total_questions: e.total_questions,
      correct_count: e.correct_count
    }));
  },
  // 月度报告数据
  getMonthlyExamStats: (studentId, month) => {
    const exams = loadData().exams.filter(e => e.student_id === studentId && e.exam_date.startsWith(month));
    const bySubject = {};
    exams.forEach(e => {
      if (!bySubject[e.subject]) bySubject[e.subject] = { subject: e.subject, exams: 0, total_q: 0, correct_q: 0, accuracies: [] };
      bySubject[e.subject].exams++;
      bySubject[e.subject].total_q += (e.total_questions || 0);
      bySubject[e.subject].correct_q += (e.correct_count || 0);
      if (e.accuracy !== undefined && e.accuracy !== null) bySubject[e.subject].accuracies.push(e.accuracy);
    });
    Object.values(bySubject).forEach(s => {
      s.avg_accuracy = s.accuracies.length ? s.accuracies.reduce((a, b) => a + b, 0) / s.accuracies.length : null;
    });
    // 汇总所有错题知识点
    const allQs = loadData().exam_questions.filter(q => exams.some(e => e.id === q.exam_id));
    const wrongQs = allQs.filter(q => !q.is_correct);
    const knowledgePoints = {};
    wrongQs.forEach(q => {
      const kp = q.knowledge_point || '未分类';
      if (!knowledgePoints[kp]) knowledgePoints[kp] = { point: kp, subject: q.subject, count: 0, error_types: {} };
      knowledgePoints[kp].count++;
      const et = q.error_type || '未知';
      knowledgePoints[kp].error_types[et] = (knowledgePoints[kp].error_types[et] || 0) + 1;
    });
    return { month, exams: exams.length, by_subject: Object.values(bySubject), weak_points: Object.values(knowledgePoints) };
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
    
    // 检查今天是否打卡，如果没打卡就从昨天开始算
    const todayStr = today.toISOString().split('T')[0];
    const startOffset = checkins.includes(todayStr) ? 0 : 1;
    
    for (let i = startOffset; i < 365 + startOffset; i++) {
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
  },

  // ============ 头像管理 ============
  getAllAvatars: () => {
    return loadData().avatars.sort((a, b) => a.price - b.price);
  },
  getAvatarById: (id) => {
    return loadData().avatars.find(a => a.id === id);
  },
  createAvatar: (avatar) => {
    const d = loadData();
    const newAvatar = {
      id: getNextId('avatars'),
      ...avatar,
      created_at: new Date().toISOString()
    };
    d.avatars.push(newAvatar);
    saveData();
    return newAvatar;
  },
  updateAvatar: (id, updates) => {
    const d = loadData();
    const idx = d.avatars.findIndex(a => a.id === id);
    if (idx >= 0) {
      d.avatars[idx] = { ...d.avatars[idx], ...updates };
      saveData();
      return true;
    }
    return false;
  },
  deleteAvatar: (id) => {
    const d = loadData();
    d.avatars = d.avatars.filter(a => a.id !== id);
    // 同时删除学生已购买记录
    d.student_avatars = d.student_avatars.filter(sa => sa.avatar_id !== id);
    // 清除使用该头像的用户
    d.users.forEach(u => {
      if (u.avatar_id === id) u.avatar_id = null;
    });
    saveData();
    return true;
  },

  // 学生已购买头像
  getStudentAvatars: (studentId) => {
    const d = loadData();
    return d.student_avatars
      .filter(sa => sa.student_id === studentId)
      .map(sa => {
        const avatar = d.avatars.find(a => a.id === sa.avatar_id);
        return avatar ? { ...avatar, purchased_at: sa.purchased_at } : null;
      })
      .filter(a => a !== null);
  },
  purchaseAvatar: (studentId, avatarId) => {
    const d = loadData();
    // 检查是否已购买
    const existing = d.student_avatars.find(sa => 
      sa.student_id === studentId && sa.avatar_id === avatarId
    );
    if (existing) return { success: false, error: '已购买过该头像' };

    const avatar = d.avatars.find(a => a.id === avatarId);
    if (!avatar) return { success: false, error: '头像不存在' };

    // 检查积分
    const balance = db.getPointsBalance(studentId);
    if (balance < avatar.price) {
      return { success: false, error: '积分不足' };
    }

    // 扣除积分
    db.addPoints({ student_id: studentId, points: -avatar.price, source: "avatar_purchase", description: "购买头像: " + avatar.name, date: new Date().toISOString().split("T")[0] });

    // 添加购买记录
    d.student_avatars.push({
      id: getNextId('student_avatars'),
      student_id: studentId,
      avatar_id: avatarId,
      purchased_at: new Date().toISOString()
    });
    saveData();
    return { success: true, new_balance: balance - avatar.price };
  },
  setStudentAvatar: (studentId, avatarId) => {
    const d = loadData();
    const user = d.users.find(u => u.id === studentId);
    if (!user) return false;
    user.avatar_id = avatarId;
    saveData();
    return true;
  }
};

module.exports = { loadData, saveData, db };
