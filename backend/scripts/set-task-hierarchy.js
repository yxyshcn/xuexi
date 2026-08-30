const { loadData, saveData } = require('../database.js');
const data = loadData();

// 给所有任务添加 parent_id 字段（0=顶级任务）
data.task_templates.forEach(t => {
  if (t.parent_id === undefined) t.parent_id = 0;
});

// 把OD相关子任务（ID 5-11）挂到 OD学习（ID 4）下
const odSubTasks = [5, 6, 7, 8, 9, 10, 11];
odSubTasks.forEach(id => {
  const task = data.task_templates.find(t => t.id === id);
  if (task) {
    task.parent_id = 4;
  }
});

// OD学习本身是顶级任务
const odMain = data.task_templates.find(t => t.id === 4);
if (odMain) odMain.parent_id = 0;

saveData();

console.log('✅ 任务层级结构已更新');
console.log('');
console.log('=== 更新后的任务结构 ===');
data.task_templates.forEach(t => {
  const indent = t.parent_id > 0 ? '  └─ ' : '• ';
  console.log(indent + 'ID:' + t.id + ' | ' + t.name + ' | parent=' + t.parent_id);
});
