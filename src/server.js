#!/usr/bin/env node
/**
 * HTTP 服务（零第三方依赖）
 *
 *   node src/server.js            默认监听 8848
 *   PORT=9000 node src/server.js
 *
 * 单条解析接口（原有能力）：
 *   POST /api/resolve   body: { "text": "分享文案", "raw": false }
 *   GET  /api/resolve?text=...&raw=1
 *
 * 批量 / 队列接口：
 *   GET    /api/queue                任务列表 + 统计 + 配置 + worker 状态
 *   POST   /api/queue                body: { "texts": ["文案1","文案2",...] }
 *   POST   /api/queue/start|pause    启停 worker
 *   POST   /api/queue/clear          body: { "includeDone": false }
 *   GET    /api/queue/<id>           单条详情
 *   POST   /api/queue/<id>/retry     失败后重试
 *   POST   /api/queue/<id>/cancel    取消（运行中会 kill 子进程）
 *   DELETE /api/queue/<id>           删除
 *   GET    /api/queue/<id>/download  下载 txt 结果
 *   GET    /api/export?format=txt|json  导出全部已完成
 *   GET    /api/config  POST /api/config   读写运行参数
 *   GET    /api/probe                检查 python / ffmpeg / 模型是否就位
 *
 *   GET  /health
 *   GET  /      单条解析页
 *   GET  /batch 批量转写页
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveShare } from './resolver.js';
import * as store from './store.js';
import { worker } from './worker.js';
import { probe } from './asr.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8848);
// 监听地址：本地默认只绑 127.0.0.1（外部访问不到，更安全）；
// 需要局域网内其他设备访问时，设 HOST=0.0.0.0。
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const sendJson = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
};

const readBody = (req) =>
  new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 5_000_000) req.destroy();
    });
    req.on('end', () => resolve(buf));
  });

const cors = (res) => {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  });
  res.end();
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const seg = url.pathname.split('/').filter(Boolean);   // ['api','queue',id,...]

  if (req.method === 'OPTIONS') return cors(res);

  /* ------------------------------------------------------ 健康检查 */
  if (url.pathname === '/health') {
    const cfg = store.getConfig();
    return sendJson(res, 200, {
      status: 'ok',
      service: 'douyin-share-resolver',
      asr: {
        python: fs.existsSync(cfg.pythonBin),
        script: fs.existsSync(cfg.script),
        ffmpeg: (() => {
          try {
            const p = `${process.env.HOME}/.cache/imageio_ffmpeg`;
            return fs.existsSync(p) || true;   // 具体路径由 /api/probe 给出
          } catch { return false; }
        })(),
      },
      worker: { active: worker.active, paused: worker.paused, running: !!worker.timer },
    });
  }

  /* ---------------------------------------------------- 关闭服务 */
  // 给 stop.sh 用的优雅退出通道。容器/受限环境里常常查不到进程号
  // （lsof、ss -p、pgrep 都可能失联），但 HTTP 永远连得上。
  // 所以反过来让服务自己关自己最可靠。注意：容器里若 HOST=0.0.0.0，
  // 这个接口也会对外暴露，生产环境请配合防火墙或改为仅本地访问。
  if (url.pathname === '/api/shutdown' && req.method === 'POST') {
    sendJson(res, 200, { ok: true, message: '正在关闭' });
    setTimeout(() => {
      try { worker.pause(); } catch { /* 已经停了，忽略 */ }
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();   // close 挂住时的兜底
    }, 100);
    return;
  }

  /* ------------------------------------------------ 运行环境探活 */
  if (url.pathname === '/api/probe') {
    const cfg = store.getConfig();
    const r = await probe(cfg);
    return sendJson(res, r.ok ? 200 : 503, {
      ...r,
      pythonBin: cfg.pythonBin,
      script: cfg.script,
      dataDir: store.dataDir(),
    });
  }

  /* ---------------------------------------------------- 配置读写 */
  if (url.pathname === '/api/config') {
    if (req.method === 'POST') {
      let patch = {};
      try { patch = JSON.parse(await readBody(req)); } catch { /* 空 body */ }
      return sendJson(res, 200, { ok: true, config: store.setConfig(patch) });
    }
    return sendJson(res, 200, { ok: true, config: store.getConfig() });
  }

  /* ------------------------------------------------------ 队列 API */
  if (seg[0] === 'api' && seg[1] === 'queue') {
    const id = seg[2];
    const action = seg[3];

    // 列表
    if (!id) {
      if (req.method === 'POST') {
        let payload = {};
        try { payload = JSON.parse(await readBody(req)); } catch { /* noop */ }
        const texts = payload.texts || [payload.text];
        if (!Array.isArray(texts) || !texts.length) {
          return sendJson(res, 400, { ok: false, error: '缺少 texts' });
        }
        const { added, skipped } = store.addJobs(texts);
        return sendJson(res, 200, {
          ok: true, added: added.map((j) => j.id), skipped,
          stats: store.stats(),
        });
      }
      return sendJson(res, 200, {
        ok: true,
        jobs: store.listJobs(),
        stats: store.stats(),
        config: store.getConfig(),
        worker: { active: worker.active, paused: worker.paused, running: !!worker.timer },
      });
    }

    if (id === 'start') { worker.start(); worker.setPaused(false); return sendJson(res, 200, { ok: true, running: true }); }
    if (id === 'pause') { worker.setPaused(true); return sendJson(res, 200, { ok: true, paused: true }); }
    if (id === 'resume') { worker.setPaused(false); return sendJson(res, 200, { ok: true, paused: false }); }
    if (id === 'clear') {
      let includeDone = false;
      try { includeDone = JSON.parse(await readBody(req) || '{}').includeDone; } catch { /* noop */ }
      const r = store.clearJobs(includeDone);
      return sendJson(res, 200, { ok: true, removed: r.jobs, files: r.files });
    }

    const job = store.getJob(id);
    if (!job) return sendJson(res, 404, { ok: false, error: 'job_not_found' });

    if (action === 'retry') {
      store.updateJob(id, {
        status: 'queued', stage: 'queued', progress: 0, error: null,
        retries: (job.retries || 0) + 1,
      });
      return sendJson(res, 200, { ok: true });
    }
    if (action === 'cancel') {
      const killed = worker.cancel(id);
      store.updateJob(id, { status: 'cancelled', stage: 'cancelled', progress: 0 });
      return sendJson(res, 200, { ok: true, killed });
    }
    if (action === 'download') {
      if (job.status !== 'done') return sendJson(res, 409, { ok: false, error: '任务未完成' });
      const file = job.outFile;
      if (!file || !fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: '结果文件不存在' });
      // 直接沿用磁盘上的文件名，标题改名的好处能在「下载」这一步延续
      const name = path.basename(file);
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      return res.end(fs.readFileSync(file));
    }

    if (req.method === 'DELETE') {
      worker.cancel(id);
      const r = store.removeJob(id);
      return sendJson(res, 200, { ok: true, removed: r.jobs, files: r.files });
    }

    return sendJson(res, 200, { ok: true, job });
  }

  /* ------------------------------------------------------- 导出 */
  if (url.pathname === '/api/export') {
    const fmt = url.searchParams.get('format') === 'json' ? 'json' : 'txt';
    const done = store.listJobs().filter((j) => j.status === 'done');
    if (!done.length) return sendJson(res, 404, { ok: false, error: '还没有已完成的任务' });

    if (fmt === 'json') {
      const body = JSON.stringify(
        done.map((j) => ({
          awemeId: j.awemeId, title: j.title, author: j.author,
          durationSec: j.durationSec, chars: j.chars, text: j.text,
        })), null, 2);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="douyin-asr.json"',
      });
      return res.end(body);
    }
    const body = done.map((j) => [
      `【${j.title || '无标题'}】`,
      `作者：${j.author || '-'}    时长：${j.durationSec ?? '-'} 秒`,
      `https://www.douyin.com/video/${j.awemeId}`,
      '',
      j.text || '',
      '',
      '='.repeat(60),
      '',
    ].join('\n')).join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="douyin-asr.txt"',
    });
    return res.end(body);
  }

  /* ------------------------------------------------ 单条解析（原有） */
  if (url.pathname === '/api/resolve') {
    let text = url.searchParams.get('text') || '';
    let raw = url.searchParams.get('raw') === '1';

    if (req.method === 'POST') {
      try {
        const parsed = JSON.parse((await readBody(req)) || '{}');
        text = parsed.text ?? parsed.url ?? text;
        raw = parsed.raw === true || raw;
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid_json_body' });
      }
    }

    if (!text.trim()) return sendJson(res, 400, { ok: false, error: 'missing_text' });

    try {
      const result = await resolveShare(text, { includeRaw: raw });
      return sendJson(res, result.ok ? 200 : 422, result);
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: String(err?.message || err) });
    }
  }

  /* -------------------------------------------------------- 静态页 */
  const rel = url.pathname === '/' ? '/index.html'
    : url.pathname === '/batch' ? '/batch.html'
      : url.pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (file.startsWith(PUBLIC_DIR) && fs.existsSync(file)) {
    const ext = path.extname(file);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    return res.end(fs.readFileSync(file));
  }

  return sendJson(res, 404, { ok: false, error: 'not_found' });
});

server.listen(PORT, HOST, async () => {
  console.log(`某音分享解析器已启动: http://127.0.0.1:${PORT}`);
  console.log(`  单条解析: http://127.0.0.1:${PORT}/`);
  console.log(`  批量转写: http://127.0.0.1:${PORT}/batch`);

  const cfg = store.getConfig();
  const r = await probe(cfg);
  if (!r.ok) {
    console.log(`  ⚠ ASR 环境未就绪: ${r.error}`);
  } else {
    console.log(`  ✓ ASR 就绪  ffmpeg: ${r.ffmpeg ? '有' : '无'}`
      + `  模型: ${r.svExists ? '有' : '缺'}`);
    worker.start();
  }
});
