import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';

const F = '/home/ssh/apps/douyin-share-resolver/src';
process.env.DY_ASR_DATA = '/home/ssh/apps/douyin-share-resolver/.test-data';

const { titleToName } = await import(F + '/worker.js');
const store = await import(F + '/store.js');

console.log('=== 标题 → 文件名 ===');
const cases = [
  ['100段录音，炼出以假乱真的专属音色！', '7686352463934278975'],
  ['如何评价 GPT-4 / Claude 的表现? <2024>', '7686352463934278976'],
  ['  奇怪的/标题:有*很多?非法"字符<>|  ', '7686352463934278977'],
  ['纯表情标题', '7686352463934278978'],
  ['', '7686352463934278979'],
  ['这是一个非常非常非常非常非常非常非常非常非常非常长的标题需要被截断处理掉不然会超出文件系统的字节上限限制', '7686352463934278980'],
];
for (const [t, id] of cases) {
  const n = titleToName(t, id);
  console.log('  ' + n + '   [' + Buffer.byteLength(n, 'utf8') + ' 字节]');
}

console.log('');
console.log('=== 删除任务是否连带删文件 ===');
const out = store.outDir();
const pick = (r) => r.added[0];

const job = pick(store.addJobs(['https://v.douyin.com/x/']));
const txt = path.join(out, '测试-000111.txt');
const meta = path.join(out, '测试-000111.json');
const outside = '/home/ssh/apps/douyin-share-resolver/.重要不能删.txt';
fs.writeFileSync(txt, 'x');
fs.writeFileSync(meta, '{}');
fs.writeFileSync(outside, '重要');

store.updateJob(job.id, { status: 'done', outFile: txt, metaFile: meta });
console.log('  删除前存在:', fs.existsSync(txt), fs.existsSync(meta), ' 外界文件:', fs.existsSync(outside));

const r1 = store.removeJob(job.id);
console.log('  removeJob ->', JSON.stringify(r1));
console.log('  删除后 txt 还在?', fs.existsSync(txt), ' json 还在?', fs.existsSync(meta));

console.log('');
console.log('=== 越界保护：指向 out 目录外的文件必须保留 ===');
const job2 = pick(store.addJobs(['https://y/222']));
store.updateJob(job2.id, { status: 'done', outFile: outside });
const r2 = store.removeJob(job2.id);
console.log('  removeJob ->', JSON.stringify(r2), ' 外界文件仍在?', fs.existsSync(outside));

console.log('');
console.log('=== clearJobs 批量清理 ===');
const arr3 = store.addJobs(['https://a/333', 'https://b/444']).added;
const f1 = path.join(out, 'c-000333.txt');
const f2 = path.join(out, 'c-000444.txt');
fs.writeFileSync(f1, 'x');
fs.writeFileSync(f2, 'x');
store.updateJob(arr3[0].id, { status: 'done', outFile: f1 });
store.updateJob(arr3[1].id, { status: 'done', outFile: f2 });
const r3 = store.clearJobs(true);
console.log('  clearJobs ->', JSON.stringify(r3));
console.log('  两个文件都已删?', !fs.existsSync(f1) && !fs.existsSync(f2));
