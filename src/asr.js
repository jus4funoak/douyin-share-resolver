/**
 * 调用本地 SenseVoice 引擎做转写。
 *
 * 用子进程跑 python，而不是塞进 Node 里 —— 模型推理是独立重型任务，
 * 进程隔离可以拿到三个好处：崩了不拖垮服务、能被 nice/os 调度限制、
 * 可以随时 kill 来做「取消任务」。
 */
import { spawn } from 'node:child_process';

/**
 * @param {string} file          本地音视频文件路径
 * @param {object} cfg           来自 store.getConfig()
 * @param {(chunk:string)=>void} [onStderr]
 * @returns {Promise<{text:string, duration:number, costSec:number, rtfx:number}>}
 */
export function transcribe(file, cfg, onStderr) {
  const args = [cfg.script, file, '--json'];

  const maybe = (flag, value) => {
    if (value !== undefined && value !== null && value !== '') args.push(flag, String(value));
  };

  maybe('--threads', cfg.threads || 8);
  maybe('--batch', cfg.batch || 8);
  maybe('--merge-length-s', cfg.mergeLengthS);
  maybe('--emoji', cfg.emoji || 'strip');
  maybe('--term-threshold', cfg.termThreshold);
  if (cfg.termsFile) args.push('--terms-file', cfg.termsFile);
  if (cfg.itn === false) args.push('--no-itn');
  if (cfg.nice) maybe('--nice', cfg.nice);

  return new Promise((resolve, reject) => {
    const child = spawn(cfg.pythonBin, args, {
      env: {
        ...process.env,
        // /tmp 常常只有几十 MB，长音频解压会撑爆；统一指到数据盘
        TMPDIR: process.env.ASR_TMP || process.env.TMPDIR || '/tmp',
        ASR_TMP: process.env.ASR_TMP || process.env.TMPDIR || '/tmp',
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        // 别再让 onnxruntime 自己内部多线程套多线程
        OMP_NUM_THREADS: String(cfg.threads || 8),
      },
    });

    let out = '';
    let err = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      reject(new Error('ASR 超时（20 分钟）'));
    }, 20 * 60 * 1000);

    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      err += s;
      if (onStderr) onStderr(s);
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 ${cfg.pythonBin}: ${e.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;

      // stdout 里混了 progress 之类的噪声时，取最后一个完整 JSON 对象
      const start = out.indexOf('{');
      const end = out.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          const data = JSON.parse(out.slice(start, end + 1));
          if (data && data.ok) {
            return resolve({
              text: data.text || '',
              duration: data.duration_s || 0,
              costSec: data.cost_s || 0,
              rtfx: data.rtfx || 0,
            });
          }
          if (data && data.ok === false) {
            return reject(new Error(data.error || 'ASR 返回失败'));
          }
        } catch { /* 落到下面的 stderr 处理 */ }
      }

      reject(new Error(
        `ASR 退出码 ${code}\n${(err || out).trim().split('\n').slice(-8).join('\n')}`
      ));
    });
  });
}

/** 探活：确认 python 和脚本都在，顺手返回 ffmpeg 可用性，避免任务跑到一半才报错。 */
export function probe(cfg) {
  return new Promise((resolve) => {
    const code = [
      'import sys, os',
      `sys.path.insert(0, ${JSON.stringify(cfg.script.replace(/\/[^/]+$/, ''))})`,
      'r = {"ok": False}',
      'try:',
      '    import importlib',
      '    for m in ["funasr_onnx", "onnxruntime", "soundfile"]:',
      '        importlib.import_module(m)',
      '    from asr_cpu import ffmpeg_path, _pick_model, SV_DIRNAME, VAD_DIRNAME',
      '    import os',
      '    sv = _pick_model("SV_MODEL_DIR", SV_DIRNAME)',
      '    vd = _pick_model("SV_VAD_DIR", VAD_DIRNAME)',
      '    r = {"ok": True, "ffmpeg": ffmpeg_path() or None,',
      '         "svModel": sv, "svExists": os.path.isdir(sv),',
      '         "vadDir": vd, "vadExists": os.path.isdir(vd)}',
      'except Exception as e:',
      '    r = {"ok": False, "error": f"{type(e).__name__}: {e}"}',
      'import json; print("__JSON__" + json.dumps(r))',
    ].join('\n');

    const child = spawn(cfg.pythonBin, ['-c', code], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, error: '探活超时' });
    }, 20000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => {
      clearTimeout(timer);
      const i = out.indexOf('__JSON__');
      if (i >= 0) {
        try { return resolve(JSON.parse(out.slice(i + 8))); } catch { /* noop */ }
      }
      resolve({ ok: false, error: (err || out).trim().slice(-300) || '未知错误' });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
  });
}
