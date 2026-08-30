// 给任务打作业标记：
// - 学而思计算练习: needs_photo=1, needs_ai_grading=1（拍照 + AI 批改）
// - OD学习及子任务: needs_photo=1（仅拍照提交）
const { loadData, saveData } = require('../database.js');
const data = loadData();

let changed = 0;
data.task_templates.forEach(t => {
  const isCalc = t.name && t.name.includes('计算练习');
  const isOD = t.name === 'OD学习' || (t.parent_id === 4) || (t.parent_id && t.name && t.name.includes('ORD'));
  // OD子任务通过 parent 判断：OD学习 id 固定为 4
  const isODSub = t.parent_id === 4;

  if (isCalc) {
    t.needs_photo = 1;
    t.needs_ai_grading = 1;
    changed++;
    console.log(`✅ 计算练习: ${t.name} (id=${t.id}) → 拍照+AI批改`);
  } else if (t.name === 'OD学习' || isODSub) {
    t.needs_photo = 1;
    t.needs_ai_grading = t.needs_ai_grading || 0;
    changed++;
    console.log(`✅ OD: ${t.name} (id=${t.id}) → 拍照提交`);
  }
});

if (changed > 0) saveData();
console.log(`\n完成！共标记 ${changed} 个任务`);
console.log('\n=== 当前任务标记 ===');
data.task_templates.forEach(t => {
  console.log(`  ${t.name} (id=${t.id}) photo=${t.needs_photo || 0} ai=${t.needs_ai_grading || 0}`);
});
