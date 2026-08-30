const { loadData, saveData } = require('../database.js');

const data = loadData();

// 8月30日的OD任务（根据PDF内容，Day 4，周日休息日）
const aug30Tasks = [
  {
    name: 'ORD Art Ch07 朗读',
    subject: 'OD',
    icon: '📖',
    description: '跟着音频大声朗读，并用手指准确指读，录制视频发班级群',
    task_type: 'reading'
  },
  {
    name: '短语抄写 01-04',
    subject: 'OD',
    icon: '✍️',
    description: 'solid, liquid and gas 固体、液体和气体 / see and feel 看见和触摸 / hard and soft 坚硬和柔软 / thick and thin 浓稠和稀薄。4英1中，建议写大字，边写边拼读，录制视频展示书写过程',
    task_type: 'writing'
  },
  {
    name: 'Workbook P23',
    subject: 'OD',
    icon: '📚',
    description: 'Workbook Unit 3 P23（Understand），边指边说，录视频发群；可观看练习讲解视频并对照参考答案自查',
    task_type: 'workbook'
  }
];

console.log('📝 创建8月30日OD打卡任务...\n');

// 创建任务模板
const createdTaskIds = [];
aug30Tasks.forEach(task => {
  const newTask = {
    id: data._meta.nextId.task_templates++,
    name: task.name,
    subject: task.subject,
    icon: task.icon,
    description: task.description,
    task_type: task.task_type,
    is_daily: 0,
    is_active: 1,
    created_at: new Date().toISOString()
  };
  data.task_templates.push(newTask);
  createdTaskIds.push(newTask.id);
  console.log(`✅ 创建任务: ${task.icon} ${task.name} (ID: ${newTask.id})`);
});

// 为小石榴（student_id=2）创建8月30日的打卡记录
const date = '2026-08-30';
const studentId = 2;

console.log(`\n📅 为小石榴创建 ${date} 的打卡记录...\n`);

createdTaskIds.forEach(taskId => {
  const checkin = {
    id: data._meta.nextId.checkins++,
    student_id: studentId,
    task_id: taskId,
    date: date,
    is_completed: 0,
    note: '',
    created_at: new Date().toISOString()
  };
  data.checkins.push(checkin);
  console.log(`✅ 创建打卡记录: 任务ID ${taskId}, 日期 ${date}`);
});

saveData();

console.log('\n✨ 完成！8月30日共有3个打卡任务已创建');
console.log('\n任务清单：');
aug30Tasks.forEach((task, idx) => {
  console.log(`  ${idx + 1}. ${task.icon} ${task.name}`);
  console.log(`     ${task.description}`);
});
