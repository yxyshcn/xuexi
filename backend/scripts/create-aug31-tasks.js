const { loadData, saveData } = require('../database.js');

const data = loadData();

// 8月31日的OD任务（根据PDF内容）
const aug31Tasks = [
  {
    name: '口语表述 Workbook P22',
    subject: 'OD',
    icon: '🗣️',
    description: '参考口语句型进行表达：When you heat..., it... / When...gets cold, it... / ...can change into... / ...is a solid/liquid/gas. / ...can..., but...cannot.... 录制视频发班级群',
    task_type: 'speaking'
  },
  {
    name: 'ORD Art Ch08 朗读',
    subject: 'OD',
    icon: '📖',
    description: '跟着音频大声朗读，并用手指准确指读，录制视频发班级群',
    task_type: 'reading'
  },
  {
    name: '短语+句子抄写',
    subject: 'OD',
    icon: '✍️',
    description: '短语抄写 05-09（4英1中）+ 句子抄写 01-05（2英1中），建议写大字，边写边拼读，录制视频展示书写过程',
    task_type: 'writing'
  },
  {
    name: '复习 Workbook P20-P21',
    subject: 'OD',
    icon: '📚',
    description: '边指边说，录视频发群，自查订正',
    task_type: 'review'
  }
];

console.log('📝 创建8月31日OD打卡任务...\n');

// 创建任务模板
const createdTaskIds = [];
aug31Tasks.forEach(task => {
  const newTask = {
    id: data._meta.nextId.task_templates++,
    name: task.name,
    subject: task.subject,
    icon: task.icon,
    description: task.description,
    task_type: task.task_type,
    is_daily: 0,  // 不是每日重复任务
    is_active: 1,
    created_at: new Date().toISOString()
  };
  data.task_templates.push(newTask);
  createdTaskIds.push(newTask.id);
  console.log(`✅ 创建任务: ${task.icon} ${task.name} (ID: ${newTask.id})`);
});

// 为小石榴（student_id=2）创建8月31日的打卡记录
const date = '2026-08-31';
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

console.log('\n✨ 完成！8月31日共有4个打卡任务已创建');
console.log('\n任务清单：');
aug31Tasks.forEach((task, idx) => {
  console.log(`  ${idx + 1}. ${task.icon} ${task.name}`);
  console.log(`     ${task.description}`);
});
