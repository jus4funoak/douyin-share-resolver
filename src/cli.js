#!/usr/bin/env node
/**
 * 命令行入口
 *
 *   node src/cli.js "2.05 复制打开某音... https://v.douyin.com/xxxx/"
 *   node src/cli.js "https://v.douyin.com/xxxx/" --compact      # 单行 JSON
 *   node src/cli.js "..." --raw                                 # 附带未裁剪的原始 aweme 对象
 *   node src/cli.js "..." --text                                # 只打印人类可读摘要
 */
import { resolveShare } from './resolver.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));

const HELP = `
某音分享链接解析 - CLI

用法:
  douyin-resolve <分享文案或链接> [选项]

选项:
  --compact   输出压缩的单行 JSON
  --raw       附带接口返回的原始字段（很长）
  --text      输出人类可读摘要，而不是 JSON
  --help      显示本帮助

示例:
  douyin-resolve "2.05 复制打开某音... https://v.douyin.com/vLitGS7xL2A/ :0pm u@s.RX yGI:/"
  douyin-resolve "https://v.douyin.com/vLitGS7xL2A/" --text
`;

if (flags.has('--help') || positional.length === 0) {
  console.log(HELP);
  process.exit(positional.length === 0 ? 1 : 0);
}

const input = positional.join(' ');
const result = await resolveShare(input, {
  includeRaw: flags.has('--raw')
});

if (flags.has('--text')) {
  printHuman(result);
} else {
  const json = flags.has('--compact')
    ? JSON.stringify(result)
    : JSON.stringify(result, null, 2);
  console.log(json);
}

if (!result.ok) process.exitCode = 1;

function printHuman(r) {
  const line = '─'.repeat(60);
  if (!r.ok) {
    console.log(`${line}\n解析失败：${r.error}\n${line}`);
    if (r.input?.shareUrl) console.log('提取到的链接 :', r.input.shareUrl);
    if (r.input?.resolvedUrl) console.log('重定向后     :', r.input.resolvedUrl);
    if (r.returnedIds?.length) console.log('接口返回 ID  :', r.returnedIds.join(', '));
    return;
  }

  console.log(line);
  console.log('视频标题 :', r.desc);
  console.log('aweme_id :', r.input.awemeId);
  console.log('作者     :', r.author.nickname, `(${r.author.uid})`);
  console.log('发布     :', r.createTimeText || '-');
  console.log('时长     :', `${r.video.durationSec} 秒  (${r.video.width}x${r.video.height}, ${r.video.ratio})`);
  console.log('数据     :', `播放 ${r.stats.playCount} / 点赞 ${r.stats.diggCount} / 评论 ${r.stats.commentCount} / 收藏 ${r.stats.collectCount}`);
  console.log('话题     :', r.tags.map((t) => t.name).join(' ') || '-');
  console.log(line);
  console.log('视频地址 :', r.video.playUrl || '(无)');
  console.log('清晰度档 :', r.video.qualities.length ? r.video.qualities.map(q => `${q.width}x${q.height}`).join(' / ') : '(接口未返回 bit_rate)');
  console.log('封面     :', r.video.cover || '-');
  console.log(line);
  console.log('音频来源 :', r.music.isOriginalSound ? '作者创作的原声（即人声本身）' : '背景音乐 BGM');
  console.log('音乐名   :', `${r.music.title} - ${r.music.author}`);
  console.log('音乐地址 :', r.music.playUrl || '(无)');
  console.log(line);
  console.log('短链重定向:');
  r.input.redirectChain.forEach((h, i) => console.log(`  ${i}. HTTP ${h.status}  ${h.url}`));
  console.log(line);
  console.log(`接口: HTTP ${r.input.feedApi.httpStatus}, ${r.input.feedApi.bytes} 字节, aweme_list ${r.input.feedApi.listSize} 条`);
  console.log(`耗时: ${r.elapsedMs} ms`);
  console.log(line);
}
