/**
 * 任务队列存储 —— 用单文件 JSON，零第三方依赖。
 *
 * 为什么不直接用 node:sqlite：本项目承诺 Node 18+，而内置 sqlite 要 22.5 起。
 * 为了在任意 Node 版本上都能跑，这里走「内存对象 + 原子落盘」，
 * 量级在几千条任务以内完全够用，且人可以直接打开 json 看/改。
 *
 * 落盘策略：变更先更新内存，再合并写入临时文件后 rename（原子替换），
 * 避免进程被 kill 时写出半个 JSON。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 项目根目录（本文件在 src/ 下，往上一级）
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 一切产出放在项目内的 data/ 里，方便查找、备份、整个目录拷走。
// 想换位置就设 DY_ASR_DATA 环境变量。
const DATA_DIR = process.env.DY_ASR_DATA || path.join(ROOT_DIR, 'data');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const OUT_DIR = path.join(DATA_DIR, 'out');

fs.mkdirSync(OUT_DIR, { recursive: true });

/* ------------------------------------------------------------ 默认配置 */

export const DEFAULT_CONFIG = {
  // —— 并发：同时处理几条任务。这是最直接的「CPU 占用」旋钮 ——
  concurrency: 2,
  // —— 每条任务分给 ASR 的线程数。并发数 × 线程数 ≈ 占用核数 ——
  threads: 8,
  batch: 8,
  mergeLengthS: 15,
  emoji: 'strip',      // strip | keep
  itn: true,           // 逆文本正则化：二零二五 -> 2025
  termsFile: '',       // 术语表路径，用于纠英文缩写
  termThreshold: 0.86,
  source: 'auto',      // auto | video | music  音频来源
  keepAudio: false,    // 转写完是否保留下载的音视频文件
  nice: 0,             // 进程谦让度 0-19
  // —— 外部命令 ——
  pythonBin: process.env.ASR_PYTHON
    || '/home/ssh/miniconda3/envs/asr/bin/python',
  script: process.env.ASR_SCRIPT || '/home/ssh/apps/asr-cpu/asr_cpu.py',
};

/* -------------------------------------------------------------- 读写 */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);          // rename 在同一分区内是原子的
}

/* -------------------------------------------------------------- 队列 */

let jobs = readJson(QUEUE_FILE, []);
let config = { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) };

// 进程退出前补一次落盘，别丢最后一批状态
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      writeJson(QUEUE_FILE, jobs);
      writeJson(CONFIG_FILE, config);
    } catch { /* 关不掉就算了，别再抛 */ }
  });
}

const save = () => writeJson(QUEUE_FILE, jobs);
const saveConfig = () => writeJson(CONFIG_FILE, config);

export const dataDir = () => DATA_DIR;
export const outDir = () => OUT_DIR;

export const getConfig = () => ({ ...config });

export function setConfig(patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (k in DEFAULT_CONFIG) config[k] = v;
  }
  saveConfig();
  return { ...config };
}

let seq = Date.now();
const newId = () => `${seq++}-${crypto.randomBytes(3).toString('hex')}`;

/** 新增任务。已存在相同 aweme_id 且已完成的任务会被跳过（去重）。 */
export function addJobs(inputs) {
  const added = [];
  const skipped = [];
  for (const raw of inputs) {
    const input = String(raw || '').trim();
    if (!input) continue;
    const exists = jobs.find((j) => j.input === input && j.status !== 'failed');
    if (exists) {
      skipped.push({ input, id: exists.id, status: exists.status });
      continue;
    }
    const job = {
      id: newId(),
      input,
      awemeId: null,
      title: null,
      author: null,
      tags: [],
      cover: null,
      durationSec: null,
      sourceKind: null,      // video | music
      playUrl: null,
      mediaPath: null,
      text: null,
      chars: 0,
      costMs: null,
      rtfx: null,
      status: 'queued',      // queued|running|done|failed|cancelled
      stage: 'queued',       // resolve|download|asr|save
      progress: 0,           // 0-100，仅下载阶段有真实百分比
      error: null,
      retries: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    jobs.push(job);
    added.push(job);
  }
  save();
  return { added, skipped };
}

export const listJobs = () => jobs;
export const getJob = (id) => jobs.find((j) => j.id === id) || null;

export function updateJob(id, patch) {
  const job = getJob(id);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: Date.now() });
  save();
  return job;
}

/**
 * 删除任务时把它产出的文件一起删掉。
 *
 * 只认位于 OUT_DIR 之内的路径：万一 job.outFile 被人手工改过、
 * 或者换了 DY_ASR_DATA 后指向了别处，也不会误删目录下的其它东西。
 */
function unlinkJobFiles(job) {
  const targets = new Set([job.outFile, job.metaFile]);
  // 兼容历史任务：只记了 txt 路径时，推出同名的 json
  if (job.outFile && job.outFile.endsWith('.txt')) {
    targets.add(job.outFile.replace(/\.txt$/, '.json'));
  }

  let removed = 0;
  for (const f of targets) {
    if (!f) continue;
    const abs = path.resolve(f);
    if (!abs.startsWith(OUT_DIR + path.sep)) continue;   // 越界文件不碰
    try {
      if (fs.existsSync(abs)) {
        fs.unlinkSync(abs);
        removed += 1;
      }
    } catch { /* 没权限就算了，不能让删除任务本身失败 */ }
  }
  return removed;
}

export function removeJob(id) {
  const job = jobs.find((j) => j.id === id);
  const before = jobs.length;
  jobs = jobs.filter((j) => j.id !== id);
  const files = job ? unlinkJobFiles(job) : 0;
  save();
  return { jobs: before !== jobs.length ? 1 : 0, files };
}

/** 清理终态任务；done=true 时连同已完成的一起清。文件一并删除。 */
export function clearJobs(includeDone = false) {
  const keep = includeDone
    ? []
    : jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  const gone = jobs.filter((j) => !keep.includes(j));
  const files = gone.reduce((acc, j) => acc + unlinkJobFiles(j), 0);
  jobs = keep;
  save();
  return { jobs: gone.length, files };
}

/** 把中断时正在跑的任务放回队列，服务重启后可续跑。 */
export function requeueRunning() {
  let n = 0;
  for (const j of jobs) {
    if (j.status === 'running') {
      j.status = 'queued';
      j.stage = 'queued';
      j.progress = 0;
      n += 1;
    }
  }
  if (n) save();
  return n;
}

export function stats() {
  const s = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
  for (const j of jobs) s[j.status] = (s[j.status] || 0) + 1;
  return s;
}
