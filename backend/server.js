const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { loadData, saveData, db } = require('./database');

const app = express();
const PORT = 3003;
const JWT_SECRET = 'xuexi-xiaoliu-2026-secret';

// 中间件
app.use(cors());
app.use(express.json());
// 兼容 /xuexi/api 前缀：本地直连 3003 时前端请求带 /xuexi/api；ECS 由 Nginx 剥前缀，此处不干扰
app.use((req, res, next) => {
  if (req.url.startsWith('/xuexi/api/')) {
    req.url = req.url.slice('/xuexi'.length);
  }
  next();
});
app.use('/xuexi/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/xuexi', express.static(path.join(__dirname, '..', 'frontend')));

// 图片上传配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).substr(2, 9)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });

// ============ AI 批改（MiniMax-M3 视觉） ============
// 从模型输出中提取 JSON：去掉 think 标签 / markdown 代码块，再匹配 { }
function extractJsonFromText(text) {
  if (!text) return null;
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  t = t.replace(/<\|thinking\|>[\s\S]*?<\/\|thinking\|>/g, '');
  t = t.replace(/<\|Thinking\|>[\s\S]*?<\/\|Thinking\|>/g, '');
  t = t.replace(/```json|```/g, '');
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch (e) {
    return null;
  }
}

async function gradeWithMiniMax(imagePath) {
  const apiKey = process.env.MINIMAX_CN_API_KEY;
  if (!apiKey) {
    return { status: 'failed', error: 'MINIMAX_CN_API_KEY 未配置' };
  }
  try {
    const b64 = fs.readFileSync(imagePath).toString('base64');
    const lower = imagePath.toLowerCase();
    const mime = lower.endsWith('.png') ? 'image/png'
      : lower.endsWith('.webp') ? 'image/webp'
      : lower.endsWith('.gif') ? 'image/gif'
      : 'image/jpeg';

    const prompt = `你是一位小学数学老师，负责批改学生的计算练习作业照片。
请识别照片中的每一道计算题，并判断学生写的答案是否正确。
要求：
1. 逐题列出：题目、学生答案、正确答案、是否正确
2. 如果题目或答案模糊看不清，correct 标记为 false，并在 note 里写"看不清"
3. 严格只输出一个 JSON 对象，不要 markdown 代码块标记，不要任何解释、注释或多余文字。输出格式：
{"questions": [{"q":"12+34","student_answer":"46","correct_answer":"46","correct":true,"note":""}], "total":10, "correct":8, "accuracy":0.8}
其中 total 为题目总数，correct 为答对数量，accuracy 为正确率(0-1)。`;

    const callApi = async (promptText) => {
      const resp = await fetch('https://api.minimaxi.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'MiniMax-M3',
          // 关闭思考推理，确保 token 全部用于 JSON 输出（否则长推理会截断 JSON）
          thinking: { type: 'disabled' },
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: promptText },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }
            ]
          }],
          max_tokens: 4000
        })
      });
      const data = await resp.json();
      return data?.choices?.[0]?.message?.content || '';
    };

    let text = await callApi(prompt);
    let result = extractJsonFromText(text);

    // 解析失败时重试一次（更简短的提示词）
    if (!result) {
      console.error('AI 首次解析失败，重试。raw:', text.slice(0, 300));
      const retryPrompt = `识别图片中的计算题并批改。只输出 JSON，格式：{"questions":[{"q":"题目","student_answer":"学生答案","correct_answer":"正确答案","correct":true,"note":""}],"total":题目数,"correct":答对数,"accuracy":正确率}。看不清就在 note 写"看不清"。不要输出 JSON 以外的任何内容。`;
      text = await callApi(retryPrompt);
      result = extractJsonFromText(text);
    }

    if (!result) {
      return { status: 'failed', error: 'AI 返回格式无法解析', raw: text.slice(0, 500) };
    }
    return { status: 'graded', ...result };
  } catch (e) {
    console.error('AI 批改失败', e);
    return { status: 'failed', error: e.message };
  }
}

// JWT 认证中间件
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: '未登录' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: '登录已过期' });
    req.user = user;
    next();
  });
}

function requireParent(req, res, next) {
  if (req.user.role !== 'parent') {
    return res.status(403).json({ error: '需要家长权限' });
  }
  next();
}

// ============ 认证 API ============

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.getUserByUsername(username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, display_name: user.display_name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      display_name: user.display_name
    }
  });
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// ============ 任务模板 API ============

app.get('/api/tasks', authenticateToken, (req, res) => {
  const db2 = loadData();
  const allTasks = db2.task_templates.filter(t => t.is_active === 1).sort((a, b) => a.sort_order - b.sort_order);
  // 构建层级结构：顶层任务带 sub_tasks
  const topTasks = allTasks.filter(t => t.parent_id === 0);
  const result = topTasks.map(task => ({
    ...task,
    sub_tasks: allTasks.filter(s => s.parent_id === task.id)
  }));
  res.json(result);
});

// 按日期返回任务层级（仅当天有排期的子任务）
app.get('/api/tasks/by-date/:date', authenticateToken, (req, res) => {
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.query.student_id);
  const date = req.params.date;

  const tasks = db.getAllTasks();
  const checkins = db.getCheckins(studentId, date);

  const checkinMap = {};
  checkins.forEach(c => { checkinMap[c.task_id] = c; });

  const result = tasks.map(task => {
    const subTasks = db.getAllSubTasks(task.id);
    const subWithStatus = subTasks.map(sub => ({
      ...sub,
      is_completed: checkinMap[sub.id]?.is_completed || 0,
      has_schedule: checkinMap[sub.id] ? true : false
    }));
    // 只保留当天有排期的子任务
    const visibleSubTasks = subWithStatus.filter(s => s.has_schedule);
    return {
      ...task,
      is_completed: checkinMap[task.id]?.is_completed || 0,
      has_schedule: checkinMap[task.id] ? true : false,
      sub_tasks: visibleSubTasks
    };
  });

  res.json({ date, tasks: result });
});

app.post('/api/tasks', authenticateToken, requireParent, (req, res) => {
  const { name, subject, icon, sort_order, parent_id, description, task_type } = req.body;
  const newTask = db.createTask({
    name,
    subject,
    icon: icon || '📝',
    sort_order: sort_order || 0,
    parent_id: parent_id || 0,
    description: description || '',
    task_type: task_type || 'general',
    is_active: 1
  });
  res.json(newTask);
});

app.put('/api/tasks/:id', authenticateToken, requireParent, (req, res) => {
  const { name, subject, icon, sort_order, parent_id, description, task_type, is_active } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (subject !== undefined) updates.subject = subject;
  if (icon !== undefined) updates.icon = icon;
  if (sort_order !== undefined) updates.sort_order = sort_order;
  if (parent_id !== undefined) updates.parent_id = parent_id;
  if (description !== undefined) updates.description = description;
  if (task_type !== undefined) updates.task_type = task_type;
  if (is_active !== undefined) updates.is_active = is_active;
  const success = db.updateTask(parseInt(req.params.id), updates);
  res.json({ success });
});

app.delete('/api/tasks/:id', authenticateToken, requireParent, (req, res) => {
  const success = db.deleteTask(parseInt(req.params.id));
  res.json({ success });
});

// ============ 打卡 API ============

app.get('/api/checkins/today', authenticateToken, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.query.student_id);

  const tasks = db.getAllTasks();
  const checkins = db.getCheckins(studentId, today);

  const checkinMap = {};
  checkins.forEach(c => { checkinMap[c.task_id] = c; });

  const result = tasks.map(task => {
    const subTasks = db.getAllSubTasks(task.id);
    const subWithStatus = subTasks.map(sub => ({
      ...sub,
      is_completed: checkinMap[sub.id]?.is_completed || 0,
      note: checkinMap[sub.id]?.note || null,
      has_schedule: checkinMap[sub.id] ? true : false
    }));
    // 子任务只显示当天有安排的
    const visibleSubTasks = subWithStatus.filter(s => s.has_schedule);
    return {
      ...task,
      is_completed: checkinMap[task.id]?.is_completed || 0,
      note: checkinMap[task.id]?.note || null,
      sub_tasks: visibleSubTasks
    };
  });

  res.json({ date: today, tasks: result });
});

// 周统计与月历接口（必须定义在 /api/checkins/:date 之前，否则会被日期路由拦截）
app.get('/api/checkins/week', authenticateToken, (req, res) => {
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.query.student_id);

  // 获取本周日期范围
  const now = new Date();
  const dayOfWeek = now.getDay() || 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - dayOfWeek + 1);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const startDate = monday.toISOString().split('T')[0];
  const endDate = sunday.toISOString().split('T')[0];

  const stats = db.getCheckinsGroupedByDate(studentId, startDate, endDate);

  res.json({ week_start: startDate, week_end: endDate, stats });
});

app.get('/api/checkins/calendar', authenticateToken, (req, res) => {
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.query.student_id);
  const { month } = req.query; // YYYY-MM

  const startDate = `${month}-01`;
  const endDate = `${month}-31`;

  const stats = db.getCheckinsGroupedByDate(studentId, startDate, endDate);

  res.json(stats);
});

app.get('/api/checkins/:date', authenticateToken, (req, res) => {
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.query.student_id);

  const tasks = db.getAllTasks();
  const checkins = db.getCheckins(studentId, req.params.date);

  const checkinMap = {};
  checkins.forEach(c => { checkinMap[c.task_id] = c; });

  const result = tasks.map(task => {
    const subTasks = db.getAllSubTasks(task.id);
    const subWithStatus = subTasks.map(sub => ({
      ...sub,
      is_completed: checkinMap[sub.id]?.is_completed || 0,
      note: checkinMap[sub.id]?.note || null,
      has_schedule: checkinMap[sub.id] ? true : false
    }));
    // 子任务只显示当天有安排的
    const visibleSubTasks = subWithStatus.filter(s => s.has_schedule);
    return {
      ...task,
      is_completed: checkinMap[task.id]?.is_completed || 0,
      note: checkinMap[task.id]?.note || null,
      sub_tasks: visibleSubTasks
    };
  });

  res.json({ date: req.params.date, tasks: result });
});

app.post('/api/checkins', authenticateToken, (req, res) => {
  const { task_id, date, is_completed, note } = req.body;
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.body.student_id);

  db.createOrUpdateCheckin({
    student_id: studentId,
    task_id: parseInt(task_id),
    date,
    is_completed: is_completed ? 1 : 0,
    note
  });

  res.json({ success: true });
});

// 移除某天某任务的排期（打卡记录），任务模板保留
app.delete('/api/checkins/:date/:taskId', authenticateToken, requireParent, (req, res) => {
  const studentId = parseInt(req.query.student_id);
  const success = db.removeCheckin(studentId, parseInt(req.params.taskId), req.params.date);
  res.json({ success });
});

// ============ 作业提交 API ============

// AI 批改后把错题自动加入错题本（同学生同题且未订正的不重复添加）
function addMistakesFromGrading(studentId, task, submission) {
  const ai = submission.ai_result;
  if (!ai || ai.status !== 'graded' || !Array.isArray(ai.questions)) return 0;
  let added = 0;
  ai.questions.forEach(q => {
    if (q.correct) return;
    const description = (q.q || '').trim();
    if (!description) return;
    if (db.hasMistake(studentId, task.name, description)) return;
    db.createMistake({
      student_id: studentId,
      subject: task.subject || '其他',
      topic: task.name,
      description,
      error_reason: `学生答案：${q.student_answer || '未作答'}`,
      image_path: submission.image_path,
      is_corrected: 0
    });
    added++;
  });
  return added;
}

// 提交作业（拍照上传；若任务标记 needs_ai_grading，自动 AI 批改）
app.post('/api/submissions', authenticateToken, upload.single('image'), async (req, res) => {
  const { task_id, date } = req.body;
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.body.student_id);

  if (!req.file) return res.status(400).json({ error: '请上传作业照片' });
  if (!task_id || !date) return res.status(400).json({ error: '缺少任务或日期' });

  const imagePath = `/uploads/${req.file.filename}`;
  const fullPath = req.file.path;

  // 查任务是否标记 AI 批改
  const task = db.getTaskById(parseInt(task_id));
  const needsAi = task && task.needs_ai_grading === 1;

  let aiResult = null;
  if (needsAi) {
    aiResult = await gradeWithMiniMax(fullPath);
  }

  const submission = db.createSubmission({
    student_id: studentId,
    task_id: parseInt(task_id),
    date,
    image_path: imagePath,
    needs_ai_grading: needsAi ? 1 : 0,
    ai_result: aiResult,
    is_read: 0
  });

  // AI 批改后自动把错题加入错题本
  const mistakeAdded = needsAi ? addMistakesFromGrading(studentId, task, submission) : 0;

  res.json({ ...submission, mistake_added: mistakeAdded });
});

// 查询作业提交记录（按学生，可过滤任务/日期）
app.get('/api/submissions', authenticateToken, (req, res) => {
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.query.student_id);
  const filters = {};
  if (req.query.task_id) filters.task_id = parseInt(req.query.task_id);
  if (req.query.date) filters.date = req.query.date;
  const submissions = db.getSubmissions(studentId, filters);
  res.json(submissions);
});

// ============ 错题 API ============

app.get('/api/mistakes', authenticateToken, (req, res) => {
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.query.student_id);
  const { subject, is_corrected } = req.query;

  const filters = {};
  if (subject) filters.subject = subject;
  if (is_corrected !== undefined) filters.is_corrected = parseInt(is_corrected);

  const mistakes = db.getMistakes(studentId, filters);
  res.json(mistakes);
});

app.post('/api/mistakes', authenticateToken, upload.single('image'), (req, res) => {
  const { subject, topic, description, error_reason } = req.body;
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.body.student_id);
  const imagePath = req.file ? `/uploads/${req.file.filename}` : null;

  const newMistake = db.createMistake({
    student_id: studentId,
    subject,
    topic,
    description,
    error_reason,
    image_path: imagePath,
    is_corrected: 0
  });

  res.json({ id: newMistake.id, image_path: newMistake.image_path });
});

app.patch('/api/mistakes/:id', authenticateToken, (req, res) => {
  const { is_corrected } = req.body;

  if (is_corrected) {
    db.updateMistake(parseInt(req.params.id), { is_corrected: 1, corrected_at: new Date().toISOString() });
  } else {
    db.updateMistake(parseInt(req.params.id), { is_corrected: 0, corrected_at: null });
  }

  res.json({ success: true });
});

app.get('/api/mistakes/stats', authenticateToken, (req, res) => {
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.query.student_id);
  const stats = db.getMistakesStats(studentId);
  res.json(stats);
});

// ============ 目标 API ============

app.get('/api/goals', authenticateToken, (req, res) => {
  const goals = db.getAllGoals();
  res.json(goals);
});

app.put('/api/goals/:id', authenticateToken, requireParent, (req, res) => {
  const { target_score, current_score, weekly_task, milestone, weak_point } = req.body;
  const success = db.updateGoal(parseInt(req.params.id), { target_score, current_score, weekly_task, milestone, weak_point });
  res.json({ success });
});

app.post('/api/goals', authenticateToken, requireParent, (req, res) => {
  const { subject, target_score, current_score, weekly_task, milestone, weak_point } = req.body;
  const newGoal = db.createGoal({ subject, target_score, current_score, weekly_task, milestone, weak_point });
  res.json({ id: newGoal.id });
});

// ============ 阅读 API ============

app.get('/api/books', authenticateToken, (req, res) => {
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.query.student_id);
  const books = db.getBooks(studentId);
  res.json(books);
});

app.post('/api/books', authenticateToken, (req, res) => {
  const { title, author, status, total_pages, current_page } = req.body;
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.body.student_id);

  const newBook = db.createBook({
    title,
    author,
    status: status || 'want_to_read',
    total_pages: total_pages || 0,
    current_page: current_page || total_pages || 0,
    student_id: studentId,
    started_at: new Date().toISOString()
  });

  res.json({ id: newBook.id });
});

app.patch('/api/books/:id', authenticateToken, (req, res) => {
  const { status, current_page, finished_at } = req.body;
  const success = db.updateBook(parseInt(req.params.id), { status, current_page, finished_at });
  res.json({ success });
});

// ============ 留言 API ============

app.get('/api/messages', authenticateToken, (req, res) => {
  const messages = db.getMessages(50);
  res.json(messages);
});

app.post('/api/messages', authenticateToken, requireParent, (req, res) => {
  const { content } = req.body;
  const newMsg = db.createMessage({ parent_id: req.user.id, content });
  res.json({ id: newMsg.id });
});

app.patch('/api/messages/:id/read', authenticateToken, (req, res) => {
  const success = db.markMessageRead(parseInt(req.params.id));
  res.json({ success });
});

// ============ 统计 API ============

app.get('/api/stats/dashboard', authenticateToken, (req, res) => {
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.query.student_id);
  const today = new Date().toISOString().split('T')[0];

  // 今日完成率
  const todayStats = db.getTodayStats(studentId, today);

  // 连续打卡天数
  const streak = db.getStreak(studentId);

  // 本周错题
  const now = new Date();
  const dayOfWeek = now.getDay() || 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - dayOfWeek + 1);
  const weekStart = monday.toISOString().split('T')[0];

  const weekMistakes = db.getMistakesSince(studentId, weekStart);

  // 未读留言
  const unreadMessages = db.getUnreadMessageCount();

  res.json({
    today_total: todayStats.total || 0,
    today_completed: todayStats.completed || 0,
    today_rate: todayStats.total ? Math.round((todayStats.completed / todayStats.total) * 100) : 0,
    streak,
    week_mistakes: weekMistakes.length,
    unread_messages: unreadMessages
  });
});

app.get('/api/stats/subjects', authenticateToken, (req, res) => {
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.query.student_id);

  const tasks = db.getAllTasks();
  const stats = {};

  tasks.forEach(task => {
    if (!stats[task.subject]) {
      stats[task.subject] = { subject: task.subject, total_checkins: 0, completed: 0 };
    }
  });

  const data = loadData();
  data.checkins.filter(c => c.student_id === studentId).forEach(c => {
    const task = tasks.find(t => t.id === c.task_id);
    if (task && stats[task.subject]) {
      stats[task.subject].total_checkins++;
      if (c.is_completed) stats[task.subject].completed++;
    }
  });

  res.json(Object.values(stats));
});

// ============ 周报 API ============

app.get('/api/reports/week', authenticateToken, (req, res) => {
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.query.student_id);

  const now = new Date();
  const dayOfWeek = now.getDay() || 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - dayOfWeek + 1);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const startDate = monday.toISOString().split('T')[0];
  const endDate = sunday.toISOString().split('T')[0];

  // 本周打卡统计
  const dailyStats = db.getCheckinsGroupedByDate(studentId, startDate, endDate);

  // 本周错题
  const mistakes = db.getMistakesSince(studentId, startDate);

  // 计算总完成率
  const totalTasks = dailyStats.reduce((sum, d) => sum + d.total, 0);
  const totalCompleted = dailyStats.reduce((sum, d) => sum + d.completed, 0);
  const completionRate = totalTasks ? Math.round((totalCompleted / totalTasks) * 100) : 0;

  res.json({
    week_start: startDate,
    week_end: endDate,
    daily_stats: dailyStats,
    completion_rate: completionRate,
    mistakes_count: mistakes.length,
    mistakes
  });
});

app.get('/api/reports', authenticateToken, (req, res) => {
  const reports = db.getReports();
  res.json(reports);
});

// ============ 上传/通用错误处理（返回 JSON 而不是 HTML） ============
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: '图片太大，请压缩后重试（限制 15MB）' });
    }
    return res.status(400).json({ error: `上传失败：${err.message}` });
  }
  console.error('服务错误:', err);
  res.status(500).json({ error: '服务器内部错误' });
});

// ============ 启动 ============

loadData(); // 初始化数据库

app.listen(PORT, () => {
  console.log(`🚀 小石榴学习管理系统后端运行在 http://localhost:${PORT}`);
});
