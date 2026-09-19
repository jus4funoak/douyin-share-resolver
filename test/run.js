/**
 * 冒烟测试：覆盖正常链接、各种形态、异常输入。
 *   node test/run.js
 */
import { resolveShare, extractAwemeId, extractShareUrl } from '../src/resolver.js';

const SAMPLE =
  '2.05 复制打开某音，看看【01研究所的作品】100段录音，炼出以假乱真的专属音色！ # ind... https://v.douyin.com/vLitGS7xL2A/ :0pm u@s.RX yGI:/ 12/06';

let passed = 0;
let failed = 0;

const check = (name, cond, extra = '') => {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
};

console.log('\n[1] 纯函数');
check('从分享文本提取短链', extractShareUrl(SAMPLE) === 'https://v.douyin.com/vLitGS7xL2A/', extractShareUrl(SAMPLE));
check('从长链提取 aweme_id', extractAwemeId('https://www.douyin.com/video/7686352463934278975') === '7686352463934278975');
check('从 modal_id 提取 aweme_id', extractAwemeId('https://www.douyin.com/?modal_id=7686352463934278975') === '7686352463934278975');
check('无链接返回空', extractShareUrl('今天天气不错') === '');

console.log('\n[2] 完整解析（真实链接）');
const r = await resolveShare(SAMPLE);
check('ok = true', r.ok === true, JSON.stringify(r.error));
check('命中正确的 aweme_id', r.input?.awemeId === '7686352463934278975', r.input?.awemeId);
check('标题非空', !!r.desc, r.desc);
check('有时长', r.video?.durationSec > 0, String(r.video?.durationSec));
check('有视频播放地址', !!r.video?.playUrl);
check('有清晰度列表', Array.isArray(r.video?.qualities));
check('作者信息存在', !!r.author?.nickname, r.author?.nickname);
check('音乐信息存在', !!r.music?.playUrl);
check('互动数据存在', r.stats && typeof r.stats.playCount === 'number');
check('重定向链非空', (r.input?.redirectChain?.length || 0) >= 1);
check('暴露了未解析字段清单', Array.isArray(r.availableFields) && r.availableFields.length > 0);
console.log(`    -> 标题: ${r.desc}`);
console.log(`    -> 时长: ${r.video?.durationSec}s  分辨率: ${r.video?.width}x${r.video?.height}`);
console.log(`    -> 清晰度: ${r.video?.qualities.map((q) => `${q.width}x${q.height}`).join(' / ') || '(无)'}`);
console.log(`    -> 作者: ${r.author?.nickname}`);
console.log(`    -> 配乐: ${r.music?.title} - ${r.music?.author}  (${r.music?.isOriginalSound ? '原声' : 'BGM'})`);

console.log('\n[3] 异常输入');
const cases = [
  ['', 'benchmark_video_empty'],
  ['今天天气不错，没有链接', 'share_url_not_found'],
  ['https://www.bilibili.com/video/BV1xx411c7mD', 'share_url_not_douyin'],
  ['https://v.douyin.com/thisIsFakeId123/', 'aweme_id_not_found']
];
for (const [input, expected] of cases) {
  const res = await resolveShare(input);
  check(`${expected}`, res.ok === false && res.error.includes(expected.split('_')[0]), `实际=${res.error}`);
}

console.log(`\n结果: ${passed} 通过 / ${failed} 失败\n`);
process.exitCode = failed > 0 ? 1 : 0;
