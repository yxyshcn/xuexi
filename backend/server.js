const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { loadData, saveData, db } = require('./database');

// 辅助函数：获取本地日期（Asia/Shanghai UTC+8）
function getLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

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
  if (!authHeader) return res.status(401).json({ error: '未登录' });

  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: '未登录' });

  // 先尝试 JWT token
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (!err) {
      req.user = user;
      return next();
    }
    
    // JWT 失败，尝试 API Key
    const data = loadData();
    const apiKey = data.api_keys?.find(k => k.key === token && k.is_active === 1);
    if (apiKey) {
      req.user = { id: apiKey.student_id, role: 'student', display_name: 'ESP32设备' };
      return next();
    }
    
    return res.status(403).json({ error: '认证失败' });
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

// 批量更新任务排序
app.post('/api/tasks/batch-sort', authenticateToken, requireParent, (req, res) => {
  const { sort_orders } = req.body;
  if (!Array.isArray(sort_orders)) {
    return res.status(400).json({ error: 'sort_orders must be an array' });
  }
  let allSuccess = true;
  sort_orders.forEach(item => {
    const ok = db.updateTask(item.task_id, { sort_order: item.sort_order });
    if (!ok) allSuccess = false;
  });
  res.json({ success: allSuccess });
});

app.delete('/api/tasks/:id', authenticateToken, requireParent, (req, res) => {
  const success = db.deleteTask(parseInt(req.params.id));
  res.json({ success });
});

// ============ 打卡 API ============

app.get('/api/checkins/today', authenticateToken, (req, res) => {
  const today = getLocalDate();
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
      quality: checkinMap[sub.id]?.quality ?? null,
      has_schedule: checkinMap[sub.id] ? true : false
    }));
    // 子任务只显示当天有安排的
    const visibleSubTasks = subWithStatus.filter(s => s.has_schedule);
    return {
      ...task,
      is_completed: checkinMap[task.id]?.is_completed || 0,
      note: checkinMap[task.id]?.note || null,
      quality: checkinMap[task.id]?.quality ?? null,
      has_schedule: checkinMap[task.id] ? true : false,
      sub_tasks: visibleSubTasks
    };
  }).filter(task => {
    // 只返回当天有排期的任务：自身有排期 或 有子任务排期
    return task.has_schedule || task.sub_tasks.length > 0;
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

  const startDate = getLocalDate(monday);
  const endDate = getLocalDate(sunday);

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
      quality: checkinMap[sub.id]?.quality ?? null,
      has_schedule: checkinMap[sub.id] ? true : false
    }));
    // 子任务只显示当天有安排的
    const visibleSubTasks = subWithStatus.filter(s => s.has_schedule);
    return {
      ...task,
      is_completed: checkinMap[task.id]?.is_completed || 0,
      note: checkinMap[task.id]?.note || null,
      quality: checkinMap[task.id]?.quality ?? null,
      has_schedule: checkinMap[task.id] ? true : false,
      sub_tasks: visibleSubTasks
    };
  }).filter(task => {
    // 只返回当天有排期的任务：自身有排期 或 有子任务排期
    return task.has_schedule || task.sub_tasks.length > 0;
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

app.delete('/api/mistakes/:id', authenticateToken, (req, res) => {
  const success = db.deleteMistake(parseInt(req.params.id));
  res.json({ success });
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
  const today = getLocalDate();

  // 今日完成率
  const todayStats = db.getTodayStats(studentId, today);

  // 连续打卡天数
  const streak = db.getStreak(studentId);

  // 本周错题
  const now = new Date();
  const dayOfWeek = now.getDay() || 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - dayOfWeek + 1);
  const weekStart = getLocalDate(monday);

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

  const startDate = getLocalDate(monday);
  const endDate = getLocalDate(sunday);

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

// ============ 初始化默认奖励 ============
function initDefaultRewards() {
  const d = loadData();
  if (d.rewards.length > 0) return; // 已有奖励则不初始化
  const defaults = [
    { name: '多看一集动画', description: '可以多看一集喜欢的动画片', icon: '📺', cost: 30, sort_order: 1 },
    { name: '挑选晚餐菜品', description: '今晚吃什么由你来决定！', icon: '🍽️', cost: 30, sort_order: 2 },
    { name: '睡前多讲2个故事', description: '今晚可以多听两个睡前故事', icon: '📖', cost: 30, sort_order: 3 },
    { name: '贴纸套装', description: '精美贴纸一套', icon: '⭐', cost: 30, sort_order: 4 },
    { name: '小文具', description: '挑选一件喜欢的小文具', icon: '✏️', cost: 60, sort_order: 5 },
    { name: '小型拼装玩具', description: '小型拼装积木一套', icon: '🧩', cost: 60, sort_order: 6 },
    { name: '周末户外多玩1小时', description: '周末出去玩可以多玩一小时', icon: '🏃', cost: 60, sort_order: 7 },
    { name: '课外书一本', description: '挑选一本喜欢的课外书', icon: '📚', cost: 60, sort_order: 8 },
    { name: '家庭观影', description: '全家一起看电影（你来选）', icon: '🎬', cost: 100, sort_order: 9 },
    { name: '公园游玩', description: '去公园玩一整天', icon: '🎡', cost: 100, sort_order: 10 },
    { name: '中等玩具', description: '中等价位的玩具一个', icon: '🎁', cost: 100, sort_order: 11 },
    { name: '终极大奖', description: '神秘超级大奖！', icon: '👑', cost: 160, sort_order: 12 },
  ];
  defaults.forEach(r => db.createReward(r));
  console.log('✅ 默认奖励初始化完成（12项）');
}

// ============ 积分 API ============

// 批量评分（家长给某天作业打质量分，同时计算每日积分）
app.post('/api/checkins/quality', authenticateToken, requireParent, (req, res) => {
  const { date, scores, student_id } = req.body;
  // scores: [{ task_id, quality }]  quality: 0/1/2
  if (!date || !Array.isArray(scores) || !student_id) {
    return res.status(400).json({ error: '缺少日期、评分或学生ID' });
  }

  const d = loadData();
  let dailyTotal = 0;
  const results = [];

  scores.forEach(s => {
    const q = parseInt(s.quality);
    if (q < 0 || q > 2) return;
    // 更新 checkin 的 quality
    const checkin = d.checkins.find(c =>
      c.student_id === parseInt(student_id) && c.task_id === parseInt(s.task_id) && c.date === date
    );
    if (checkin) {
      checkin.quality = q;
      dailyTotal += q;
      results.push({ task_id: s.task_id, quality: q });
    }
  });
  saveData();

  // 检查当天是否已有 daily 积分记录，有则更新，没有则新增
  const existingDaily = d.points_ledger.filter(e =>
    e.student_id === parseInt(student_id) && e.date === date && e.source === 'daily'
  );
  // 删除旧的 daily 记录
  d.points_ledger = d.points_ledger.filter(e =>
    !(e.student_id === parseInt(student_id) && e.date === date && e.source === 'daily')
  );
  // 写入新的
  d.points_ledger.push({
    id: d._meta.nextId.points_ledger++,
    student_id: parseInt(student_id),
    points: dailyTotal,
    source: 'daily',
    description: `${date} 作业积分（${scores.length}项）`,
    date,
    details: results,
    created_at: new Date().toISOString()
  });
  saveData();

  res.json({ success: true, daily_total: dailyTotal, scores: results });
});

// 查询积分余额
app.get('/api/points/balance', authenticateToken, (req, res) => {
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.query.student_id);
  const balance = db.getPointsBalance(studentId);
  res.json({ balance });
});

// 查询积分流水
app.get('/api/points/ledger', authenticateToken, (req, res) => {
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.query.student_id);
  const limit = parseInt(req.query.limit) || 50;
  const ledger = db.getPointsLedger(studentId, limit);
  res.json(ledger);
});

// 查询兑换记录
app.get('/api/points/redemptions', authenticateToken, (req, res) => {
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.query.student_id);
  const redemptions = db.getRedemptions(studentId);
  res.json(redemptions);
});

// 兑换奖励
app.post('/api/points/redeem', authenticateToken, (req, res) => {
  const { reward_id } = req.body;
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.body.student_id);

  const reward = loadData().rewards.find(r => r.id === parseInt(reward_id));
  if (!reward || reward.is_active === 0) {
    return res.status(404).json({ error: '奖励不存在或已下架' });
  }

  const balance = db.getPointsBalance(studentId);
  if (balance < reward.cost) {
    return res.status(400).json({ error: `积分不足，还差 ${reward.cost - balance} 分`, balance, cost: reward.cost });
  }

  const redemption = db.createRedemption({
    student_id: studentId,
    reward_id: reward.id,
    reward_name: reward.name,
    cost: reward.cost
  });

  const newBalance = db.getPointsBalance(studentId);
  res.json({ success: true, redemption, balance: newBalance });
});

// 周全勤检查 & 自动发放
app.get('/api/points/weekly-check', authenticateToken, requireParent, (req, res) => {
  const studentId = parseInt(req.query.student_id);
  const d = loadData();

  // 计算本周范围（周一~周日）
  const now = new Date();
  const dayOfWeek = now.getDay() || 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - dayOfWeek + 1);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const weekStart = getLocalDate(monday);
  const weekEnd = getLocalDate(sunday);

  // 检查是否已发过本周全勤奖
  const already = db.getWeeklyBonus(studentId, weekStart);
  if (already) {
    return res.json({ eligible: false, reason: '本周全勤奖已发放', week_start: weekStart });
  }

  // 获取本周每天的 checkins
  const weekCheckins = db.getCheckinsByDateRange(studentId, weekStart, weekEnd);
  // 按日期分组
  const byDate = {};
  weekCheckins.forEach(c => {
    if (!byDate[c.date]) byDate[c.date] = [];
    byDate[c.date].push(c);
  });

  const dates = Object.keys(byDate).sort();
  if (dates.length === 0) {
    return res.json({ eligible: false, reason: '本周暂无打卡记录', week_start: weekStart });
  }

  // 判定：每天是否"每项作业拿到基础得分"（quality >= 1）
  // 允许1天豁免（那天可以没记录或quality不达标）
  let qualifiedDays = 0;
  let exemptUsed = false;
  const dailyDetails = [];

  dates.forEach(date => {
    const dayCheckins = byDate[date];
    const allQualified = dayCheckins.every(c => c.quality !== null && c.quality >= 1);
    if (allQualified) {
      qualifiedDays++;
      dailyDetails.push({ date, status: 'qualified', count: dayCheckins.length });
    } else {
      if (!exemptUsed) {
        exemptUsed = true;
        dailyDetails.push({ date, status: 'exempt', count: dayCheckins.length });
      } else {
        dailyDetails.push({ date, status: 'failed', count: dayCheckins.length });
      }
    }
  });

  // 没有打卡记录的天不算
  const eligible = qualifiedDays >= 6;

  if (eligible) {
    // 自动发放10分
    db.addPoints({
      student_id: studentId,
      points: 10,
      source: 'weekly_bonus',
      description: `周全勤奖励（${weekStart} ~ ${weekEnd}）`,
      date: weekEnd,
      week_start: weekStart,
      details: dailyDetails
    });
    const balance = db.getPointsBalance(studentId);
    res.json({ eligible: true, bonus: 10, balance, week_start: weekStart, daily_details: dailyDetails });
  } else {
    res.json({ eligible: false, reason: `全勤天数不足（${qualifiedDays}/6）`, week_start: weekStart, daily_details: dailyDetails });
  }
});

// 获取某天的质量评分详情
app.get('/api/checkins/quality/:date', authenticateToken, (req, res) => {
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.query.student_id);
  const date = req.params.date;
  const checkins = db.getCheckins(studentId, date);
  const scored = checkins.filter(c => c.quality !== null && c.quality !== undefined);
  const unscored = checkins.filter(c => c.quality === null || c.quality === undefined);
  res.json({ date, scored, unscored, total: checkins.length });
});

// ============ 奖励管理 API ============

app.get('/api/rewards', authenticateToken, (req, res) => {
  const rewards = db.getAllRewards();
  res.json(rewards);
});

app.post('/api/rewards', authenticateToken, requireParent, (req, res) => {
  const { name, description, icon, cost, sort_order } = req.body;
  if (!name || !cost) return res.status(400).json({ error: '奖励名称和积分不能为空' });
  const reward = db.createReward({ name, description: description || '', icon: icon || '🎁', cost: parseInt(cost), sort_order: sort_order || 0 });
  res.json(reward);
});

app.put('/api/rewards/:id', authenticateToken, requireParent, (req, res) => {
  const { name, description, icon, cost, sort_order, is_active } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (icon !== undefined) updates.icon = icon;
  if (cost !== undefined) updates.cost = parseInt(cost);
  if (sort_order !== undefined) updates.sort_order = sort_order;
  if (is_active !== undefined) updates.is_active = is_active;
  const success = db.updateReward(parseInt(req.params.id), updates);
  res.json({ success });
});

app.delete('/api/rewards/:id', authenticateToken, requireParent, (req, res) => {
  const success = db.deleteReward(parseInt(req.params.id));
  res.json({ success });
});

// ============ 试卷分析 API ============

// 试卷AI分析函数（支持语文/数学/英语，考试卷+练习册）
async function analyzeExamWithMiniMax(imagePath, subject, examType) {
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

    const subjectDesc = {
      '语文': '语文（包括字词、阅读理解、作文等）',
      '数学': '数学（包括计算题、应用题、几何题等）',
      '英语': '英语（包括单词、语法、阅读理解等）'
    }[subject] || subject;

    const typeDesc = examType === '练习册' ? '练习册作业' : '考试试卷';

    const prompt = `你是一位经验丰富的小学${subjectDesc}老师，负责批改学生的${typeDesc}。
请仔细识别图片中的每一道题目，并判断学生的答案是否正确。
要求：
1. 逐题列出：题号、题目内容（简短概括）、学生答案、正确答案、是否正确
2. 对每道错题，分析错误类型：
   - "计算错误"：计算过程出错
   - "概念不清"：对知识点理解有误
   - "粗心"：审题不清或抄写错误
   - "不会"：完全不会做，空白或乱写
3. 对每道题标注涉及的知识点（如"两位数加法"、"分数比较"、"一般过去时"等）
4. 如果题目或答案模糊看不清，correct 标记为 false，并在 note 里写"看不清"
5. 严格只输出一个 JSON 对象，不要 markdown 代码块标记，不要任何解释、注释或多余文字。

输出格式：
{
  "questions": [
    {
      "question_num": 1,
      "question_content": "题目内容简短概括",
      "question_type": "选择题/填空题/计算题/应用题/阅读理解/作文",
      "student_answer": "学生写的答案",
      "correct_answer": "正确答案",
      "is_correct": true,
      "error_type": "",
      "knowledge_point": "涉及的知识点",
      "note": ""
    }
  ],
  "total_questions": 10,
  "correct_count": 8,
  "accuracy": 0.8,
  "summary": "整体评价，指出主要薄弱环节"
}`;

    const callApi = async (promptText) => {
      const resp = await fetch('https://api.minimaxi.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'MiniMax-M3',
          thinking: { type: 'disabled' },
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: promptText },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }
            ]
          }],
          max_tokens: 6000
        })
      });
      const data = await resp.json();
      return data?.choices?.[0]?.message?.content || '';
    };

    let text = await callApi(prompt);
    let result = extractJsonFromText(text);

    // 解析失败时重试一次
    if (!result) {
      console.error('试卷AI首次解析失败，重试。raw:', text.slice(0, 300));
      const retryPrompt = `识别图片中的${typeDesc}题目并批改。只输出 JSON，格式：{"questions":[{"question_num":1,"question_content":"题目","question_type":"类型","student_answer":"学生答案","correct_answer":"正确答案","is_correct":true,"error_type":"","knowledge_point":"知识点","note":""}],"total_questions":题目数,"correct_count":答对数,"accuracy":正确率,"summary":"评价"}。不要输出 JSON 以外的任何内容。`;
      text = await callApi(retryPrompt);
      result = extractJsonFromText(text);
    }

    if (!result) {
      return { status: 'failed', error: 'AI 返回格式无法解析', raw: text.slice(0, 500) };
    }
    return { status: 'analyzed', ...result };
  } catch (e) {
    console.error('试卷AI分析失败', e);
    return { status: 'failed', error: e.message };
  }
}

// 上传并分析试卷
app.post('/api/exams', authenticateToken, upload.single('image'), async (req, res) => {
  const { student_id, subject, exam_type, exam_date, title } = req.body;
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(student_id);

  if (!req.file) return res.status(400).json({ error: '请上传试卷照片' });
  if (!subject || !exam_type || !exam_date) {
    return res.status(400).json({ error: '缺少科目、类型或日期' });
  }

  const imagePath = `/uploads/${req.file.filename}`;
  const fullPath = req.file.path;

  // AI分析
  const aiResult = await analyzeExamWithMiniMax(fullPath, subject, exam_type);

  // 创建考试记录
  const exam = db.createExam({
    student_id: studentId,
    subject,
    exam_type, // 考试/练习册
    exam_date,
    title: title || `${subject}${exam_type} - ${exam_date}`,
    total_questions: aiResult.status === 'analyzed' ? aiResult.total_questions : 0,
    correct_count: aiResult.status === 'analyzed' ? aiResult.correct_count : 0,
    accuracy: aiResult.status === 'analyzed' ? aiResult.accuracy : null,
    summary: aiResult.status === 'analyzed' ? aiResult.summary : null,
    ai_status: aiResult.status
  });

  // 保存每道题的详情
  if (aiResult.status === 'analyzed' && Array.isArray(aiResult.questions)) {
    aiResult.questions.forEach(q => {
      db.createExamQuestion({
        exam_id: exam.id,
        subject,
        question_num: q.question_num,
        question_content: q.question_content || '',
        question_type: q.question_type || '',
        student_answer: q.student_answer || '',
        correct_answer: q.correct_answer || '',
        is_correct: q.is_correct ? 1 : 0,
        error_type: q.error_type || '',
        knowledge_point: q.knowledge_point || '',
        note: q.note || ''
      });
    });
  }

  // 删除原图（分析完不保留）
  try { fs.unlinkSync(fullPath); } catch (e) { console.log('删除图片失败:', e.message); }

  res.json({ ...exam, ai_result: aiResult });
});

// 查询试卷列表
app.get('/api/exams', authenticateToken, (req, res) => {
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.query.student_id);
  const filters = {};
  if (req.query.subject) filters.subject = req.query.subject;
  if (req.query.exam_type) filters.exam_type = req.query.exam_type;
  const exams = db.getExams(studentId, filters);
  res.json(exams);
});

// 查询试卷详情（含题目）
app.get('/api/exams/:id', authenticateToken, (req, res) => {
  const exam = db.getExamById(parseInt(req.params.id));
  if (!exam) return res.status(404).json({ error: '试卷不存在' });
  const questions = db.getExamQuestions(exam.id);
  res.json({ ...exam, questions });
});

// 删除试卷
app.delete('/api/exams/:id', authenticateToken, requireParent, (req, res) => {
  const success = db.deleteExam(parseInt(req.params.id));
  res.json({ success });
});

// 查询趋势数据
app.get('/api/exams/trend/:subject', authenticateToken, (req, res) => {
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.query.student_id);
  const trend = db.getExamTrend(studentId, req.params.subject);
  res.json(trend);
});

// 月度报告
app.get('/api/exams/monthly/:month', authenticateToken, (req, res) => {
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.query.student_id);
  const stats = db.getMonthlyExamStats(studentId, req.params.month);
  res.json(stats);
});

// ============ 头像管理 ============

// 获取所有头像（公开）
app.get('/api/avatars', (req, res) => {
  const avatars = db.getAllAvatars();
  res.json(avatars);
});

// 获取学生已购买的头像
app.get('/api/avatars/mine', authenticateToken, (req, res) => {
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.query.student_id);
  const avatars = db.getStudentAvatars(studentId);
  res.json(avatars);
});

// 上传新头像（家长）
app.post('/api/avatars', authenticateToken, requireParent, upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '请上传头像图片' });
  }
  const { name, price } = req.body;
  if (!name || price === undefined) {
    return res.status(400).json({ error: '请填写头像名称和价格' });
  }
  const avatar = db.createAvatar({
    name,
    price: parseInt(price),
    image_url: `/xuexi/uploads/${req.file.filename}`
  });
  res.json(avatar);
});

// 修改头像（家长）
app.put('/api/avatars/:id', authenticateToken, requireParent, (req, res) => {
  const { name, price } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (price !== undefined) updates.price = parseInt(price);
  const success = db.updateAvatar(parseInt(req.params.id), updates);
  res.json({ success });
});

// 删除头像（家长）
app.delete('/api/avatars/:id', authenticateToken, requireParent, (req, res) => {
  const success = db.deleteAvatar(parseInt(req.params.id));
  res.json({ success });
});

// 购买头像（学生）
app.post('/api/avatars/:id/purchase', authenticateToken, (req, res) => {
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.body.student_id);
  const avatarId = parseInt(req.params.id);
  const result = db.purchaseAvatar(studentId, avatarId);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});

// 设置当前头像（学生）
app.put('/api/students/avatar', authenticateToken, (req, res) => {
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.body.student_id);
  const { avatar_id } = req.body;
  
  // 验证学生是否拥有该头像
  if (avatar_id) {
    const owned = db.getStudentAvatars(studentId);
    if (!owned.find(a => a.id === avatar_id)) {
      return res.status(400).json({ error: '未拥有该头像' });
    }
  }
  
  const success = db.setStudentAvatar(studentId, avatar_id);
  res.json({ success });
});

// 获取当前头像信息
app.get('/api/students/avatar', authenticateToken, (req, res) => {
  const studentId = req.user.role === 'student' ? req.user.id : parseInt(req.query.student_id);
  const user = db.getUserById(studentId);
  if (!user || !user.avatar_id) {
    return res.json(null);
  }
  const avatar = db.getAvatarById(user.avatar_id);
  res.json(avatar);
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
initDefaultRewards(); // 初始化默认奖励

app.listen(PORT, () => {
  console.log(`🚀 小石榴学习管理系统后端运行在 http://localhost:${PORT}`);
});

// 自定义积分修改（加分/减分）
app.post('/api/points/custom', authenticateToken, requireParent, (req, res) => {
  const { student_id, points, reason } = req.body;
  if (!student_id || points === undefined || !reason) {
    return res.status(400).json({ error: '缺少学生ID、积分数量或原因' });
  }
  
  const d = loadData();
  const studentId = parseInt(student_id);
  const pointsNum = parseInt(points);
  const date = new Date().toISOString().split('T')[0];
  
  // 添加积分流水记录
  d.points_ledger.push({
    id: d._meta.nextId.points_ledger++,
    student_id: studentId,
    points: pointsNum,
    source: 'custom',
    description: reason,
    date,
    created_at: new Date().toISOString()
  });
  saveData();
  
  res.json({ success: true, message: '积分修改成功' });
});

// 自定义积分修改（加分/减分）
app.post('/api/points/custom', authenticateToken, requireParent, (req, res) => {
  const { student_id, points, reason } = req.body;
  if (!student_id || points === undefined || !reason) {
    return res.status(400).json({ error: '缺少学生ID、积分数量或原因' });
  }
  
  const d = loadData();
  const studentId = parseInt(student_id);
  const pointsNum = parseInt(points);
  const date = new Date().toISOString().split('T')[0];
  
  // 添加积分流水记录
  d.points_ledger.push({
    id: d._meta.nextId.points_ledger++,
    student_id: studentId,
    points: pointsNum,
    source: 'custom',
    description: reason,
    date,
    created_at: new Date().toISOString()
  });
  saveData();
  
  res.json({ success: true, message: '积分修改成功' });
});

// 获取所有历史任务模板（去重，用于添加任务功能）
app.get('/api/tasks/history', authenticateToken, requireParent, (req, res) => {
  const tasks = db.getAllTasks();
  // 只返回顶级任务（parent_id=0），子任务会在展开时显示
  const topLevelTasks = tasks.filter(t => !t.parent_id || t.parent_id === 0);
  res.json(topLevelTasks);
});

// 添加已有任务到指定日期的打卡清单
app.post('/api/checkins/add-task', authenticateToken, requireParent, (req, res) => {
  const { student_id, task_id, date } = req.body;
  if (!student_id || !task_id || !date) {
    return res.status(400).json({ error: '缺少学生ID、任务ID或日期' });
  }
  
  const d = loadData();
  const studentId = parseInt(student_id);
  const taskId = parseInt(task_id);
  
  // 检查是否已存在
  const existing = d.checkins.find(c => 
    c.student_id === studentId && 
    c.task_id === taskId && 
    c.date === date
  );
  
  if (existing) {
    return res.status(400).json({ error: '该任务已在当天打卡清单中' });
  }
  
  // 添加打卡记录
  d.checkins.push({
    id: d._meta.nextId.checkins++,
    student_id: studentId,
    task_id: taskId,
    date: date,
    is_completed: 0,
    quality: null,
    note: '',
    created_at: new Date().toISOString()
  });
  saveData();
  
  res.json({ success: true, message: '任务已添加到打卡清单' });
});
