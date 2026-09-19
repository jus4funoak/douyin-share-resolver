/**
 * 后台任务处理管线
 *
 *   分享文案 -> [解析] -> [选音源] -> [下载] -> [转写] -> [落盘]
 *
 * 设计要点：
 *   1) 一个固定大小的并发池，而不是来一条起一条 —— 线程数是有限的，
 *      并发开太高只会互相抢核，总吞吐反而下降。
 *   2) 每条任务一个独立 python 子进程，取消任务直接 kill。
 *   3) 下载用流式写盘并算百分比，前端才有真实进度条。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';

import { resolveShare } from './resolver.js';
import { transcribe } from './asr.js';
import * as store from './store.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

/**
 * 由视频标题生成文件名。
 *
 * 直接用标题有三个坑，这里逐个处理：
 *   1. 标题里常有 / : * ? " < > | 这类文件系统非法字符，还有换行和 emoji
 *   2. 标题可能很长，中文 UTF-8 一个字 3 字节，很容易撑破 255 字节上限
 *   3. 不同视频可能重名
 *
 * 所以：净化非法字符 → 压空白 → 截断 → 后缀视频 ID 末 6 位。
 * 带 ID 尾号的好处是同一视频重跑会覆盖同一个文件，不会攒出一堆 "-2"、"-3"。
 */
export function titleToName(title, videoId) {
  const cleaned = String(title || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');

  // 40 个字符 × 3 字节 = 120 字节，给后缀和扩展名留足余量
  const name = cleaned.slice(0, 40) || '无标题';
  const tail = String(videoId || '').slice(-6);
  return tail ? `${name}-${tail}` : name;
}

class Worker {
  constructor() {
    this.running = new Map();   // jobId -> { child, controller }
    this.timer = null;
    this.paused = false;
  }

  start() {
    const requeued = store.requeueRunning();
    if (requeued) console.log(`[worker] 找回 ${requeued} 条中断任务`);
    if (!this.timer) this.timer = setInterval(() => this.tick(), 700);
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setPaused(v) {
    this.paused = v;
    return this.paused;
  }

  get active() {
    return this.running.size;
  }

  tick() {
    if (this.paused) return;
    const { concurrency } = store.getConfig();
    const slots = Math.max(1, concurrency) - this.running.size;
    for (let i = 0; i < slots; i += 1) {
      const job = store.listJobs().find((j) => j.status === 'queued');
      if (!job) break;
      this.run(job.id).catch(() => { /* 错误已写进 job */ });
    }
  }

  cancel(id) {
    const ctx = this.running.get(id);
    if (ctx) {
      try { ctx.child?.kill('SIGKILL'); } catch { /* noop */ }
      try { ctx.controller?.abort(); } catch { /* noop */ }
      return true;
    }
    const job = store.getJob(id);
    if (job && job.status === 'queued') {
      store.updateJob(id, { status: 'cancelled', stage: 'cancelled' });
      return true;
    }
    return false;
  }

  async run(id) {
    const cfg = store.getConfig();
    const job = store.getJob(id);
    if (!job) return;

    // 放进 running 是「占座」，必须在任何 await 之前，否则并发会超发
    const ctx = { child: null, controller: new AbortController() };
    this.running.set(id, ctx);

    const step = (stage, progress = null) => {
      const patch = { status: 'running', stage, error: null };
      if (progress !== null) patch.progress = progress;
      store.updateJob(id, patch);
    };

    let mediaPath = null;
    try {
      step('resolve', 0);
      const info = await resolveShare(job.input, { includeRaw: false });
      if (!info.ok) throw new Error(`解析失败: ${info.error}`);

      // —— 选音源：这一步决定了下载体积，也是最容易踩坑的地方 ——
      // video.play_addr  = 画面 + 混合音轨（博主声音 + BGM），一定有人声
      // music.play_url   = 纯配乐；只有「作者创作的原声」时才等于人声
      const useMusic = cfg.source === 'music'
        || (cfg.source === 'auto' && info.music?.isOriginalSound);
      const url = useMusic
        ? (info.music?.playUrl || info.video?.playUrl)
        : (info.video?.playUrl || info.music?.playUrl);

      if (!url) throw new Error('没有拿到可播放的音视频地址');

      store.updateJob(id, {
        awemeId: info.input.awemeId,
        title: info.desc,
        author: info.author?.nickname,
        tags: (info.tags || []).map((t) => t.name),
        cover: info.video?.cover,
        durationSec: info.video?.durationSec,
        playUrl: url,
        sourceKind: url === info.music?.playUrl ? 'music' : 'video',
      });

      step('download', 1);
      const ext = useMusic ? '.mp3' : '.mp4';
      // 文件名带 job.id 而不是纯 awemeId：并发下多条任务可能指向同一个视频，
      // 只按视频 ID 命名会让它们抢写同一个文件。
      mediaPath = path.join(store.dataDir(), `${job.id}${ext}`);
      await this.download(url, mediaPath, ctx, (pct) => {
        step('download', Math.max(1, Math.min(95, pct)));
      });

      step('asr', 96);
      const result = await transcribe(mediaPath, cfg, () => {});

      step('save', 99);
      const files = await this.writeResult(job, result, info);

      store.updateJob(id, {
        status: 'done',
        stage: 'done',
        progress: 100,
        text: result.text,
        chars: result.text.length,
        costMs: Math.round(result.costSec * 1000),
        rtfx: result.rtfx,
        outFile: files.txtPath,
        metaFile: files.metaPath,
        error: null,
      });
    } catch (e) {
      store.updateJob(id, {
        status: 'failed',
        stage: job.stage || 'unknown',
        error: String(e?.message || e),
        progress: 0,
      });
    } finally {
      this.running.delete(id);
      if (mediaPath && !store.getConfig().keepAudio) {
        try { await fsp.unlink(mediaPath); } catch { /* 已经没了 */ }
      }
    }
  }

  async download(url, dest, ctx, onProgress) {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.douyin.com/',
        Accept: '*/*',
      },
      signal: ctx.controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);

    const total = Number(res.headers.get('content-length') || 0);
    let got = 0;
    let lastPct = -1;

    const source = Readable.fromWeb(res.body);
    source.on('data', (chunk) => {
      got += chunk.length;
      if (total) {
        const pct = Math.floor((got / total) * 100);
        if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; onProgress(pct); }
      }
    });

    await streamPipeline(source, fs.createWriteStream(dest));
    if (got === 0) throw new Error('下载到 0 字节，可能是链接过期');
    return got;
  }

  async writeResult(job, result, info) {
    const videoId = info.input.awemeId || job.id;
    const base = path.join(store.outDir(), titleToName(info?.desc, videoId));
    const txtPath = `${base}.txt`;
    const metaPath = `${base}.json`;

    const header = [
      `标题：${info.desc || '-'}`,
      `作者：${info.author?.nickname || '-'}`,
      `链接：https://www.douyin.com/video/${videoId}`,
      `时长：${result.duration || info.video?.durationSec || '-'} 秒`,
      `转写：${result.costSec}s（${result.rtfx}x 实时）`,
      '─'.repeat(40),
      '',
    ].join('\n');

    await fsp.writeFile(txtPath, header + result.text + '\n', 'utf8');
    await fsp.writeFile(metaPath, JSON.stringify({
      awemeId: videoId,
      jobId: job.id,
      input: job.input,
      title: info.desc,
      author: info.author?.nickname,
      tags: (info.tags || []).map((t) => t.name),
      durationSec: result.duration,
      costSec: result.costSec,
      rtfx: result.rtfx,
      chars: result.text.length,
      text: result.text,
      textFile: txtPath,
      metaFile: metaPath,
    }, null, 2), 'utf8');

    return { txtPath, metaPath };
  }
}

export const worker = new Worker();
