#!/usr/bin/env python3
"""
纯 CPU 的本地音频转文字工具（无需显卡）

后端:
  sensevoice (默认) -> funasr-onnx SenseVoiceSmall
                       中文最快最准，覆盖 中/粤/英/日/韩，不需要 torch
  whisper            -> faster-whisper (CTranslate2 int8)
                       多语种、可靠时间戳/字幕，英文更强

⚠️ 实测结论：SenseVoice 无论 onnx 还是 torch 版都不支持 hotword，
   英文名词/缩写请靠 --terms-file 做后处理纠偏。

用法示例:
  python asr_cpu.py input.mp3                        # 默认 SenseVoice
  python asr_cpu.py talk.mp3 --terms-file terms.txt  # 纠英文缩写
  python asr_cpu.py video.mp4 --backend whisper --format srt -o out.srt

依赖安装见 README.md
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time

_ROOT = os.path.dirname(os.path.abspath(__file__))

SV_DIRNAME = "iic--SenseVoiceSmall-onnx"
VAD_DIRNAME = "damo--speech_fsmn_vad_zh-cn-16k-common-onnx"


def _pick_model(env_var: str, dirname: str) -> str:
    """
    挑一个真实存在的模型目录。兼容两种摆放方式：
      models/<dirname>/snapshots/master     （部署时用的扁平结构）
      models/models/<dirname>/...           （modelscope snapshot_download 原样产物）
    环境变量优先，方便一台机器共享同一份模型。
    """
    candidates = [
        os.getenv(env_var, ""),
        f"{_ROOT}/models/{dirname}/snapshots/master",
        f"{_ROOT}/models/models/{dirname}/snapshots/master",
        f"{_ROOT}/models/{dirname}",
    ]
    for c in candidates:
        if c and os.path.isdir(c):
            return c
    return candidates[1]


# SenseVoice 主模型 + fsmn-vad（用来按语音切段，提速关键）
DEFAULT_SV_MODEL = _pick_model("SV_MODEL_DIR", SV_DIRNAME)
DEFAULT_VAD_MODEL = _pick_model("SV_VAD_DIR", VAD_DIRNAME)


# ---------------------------------------------------------------- 基础工具

def human_sec(s: float) -> str:
    m, sec = divmod(int(s), 60)
    h, m = divmod(m, 60)
    return f"{h:d}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"


def srt_ts(t: float) -> str:
    ms = int(round((t - int(t)) * 1000))
    h, rem = divmod(int(t), 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def ffmpeg_path() -> str | None:
    """
    定位 ffmpeg 可执行文件。优先级：
      1. 系统 PATH（which ffmpeg）
      2. imageio-ffmpeg 自带的静态二进制（pip install imageio-ffmpeg，免 sudo）
    某音/视频平台拿到的多是 mp4，soundfile 读不了，必须有 ffmpeg。
    """
    from shutil import which
    ff = which("ffmpeg") or which("ffmpeg-static")
    if ff:
        return ff
    try:
        import imageio_ffmpeg
        p = imageio_ffmpeg.get_ffmpeg_exe()
        return p if p and os.path.exists(p) else None
    except Exception:
        return None


def check_ffmpeg() -> bool:
    """找 ffmpeg 可执行文件：系统 PATH 优先，其次 imageio-ffmpeg 静态二进制。"""
    return ffmpeg_path() is not None




# ------------------------------------------------- 术语表 / 后处理纠错

CN_DIGIT = {"零": "0", "一": "1", "二": "2", "两": "2", "三": "3", "四": "4",
            "五": "5", "六": "6", "七": "7", "八": "8", "九": "9", "十": "10"}


def load_terms(path: str) -> list[str]:
    """每行一个术语，支持 `# 注释` 和空行。"""
    if not path or not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            w = line.strip()
            if w and not w.startswith("#"):
                out.append(w)
    return out


def _norm(s: str) -> str:
    """归一化：去空格/标点、全角转半角、中文数字转阿拉伯数字、统一小写。"""
    import re
    import unicodedata
    s = unicodedata.normalize("NFKC", s)          # 全角 -> 半角
    s = re.sub(r"[\s\.,，。、;；:：!！\?？\-_/\\'\"（）()\[\]【】]+", "", s)
    s = "".join(CN_DIGIT.get(ch, ch) for ch in s)
    return s.lower()


def _sim(a: str, b: str) -> float:
    """归一化后的相似度，兼容 difflib 缺失的情况。"""
    try:
        from difflib import SequenceMatcher
        return SequenceMatcher(None, a, b).ratio()
    except Exception:
        return 1.0 if a == b else 0.0


def apply_terms(text: str, terms: list[str], threshold: float = 0.86,
                verbose: bool = False) -> tuple[str, int]:
    """
    术语后处理：把识别结果里形近的片段替换成标准写法。

    例: "indexd" / "index TTS"  ->  "index-tts"
         "G P T 四"             ->  "GPT-4"

    ⚠️ 不能用「按术语长度任意滑动窗口」的朴素做法 —— 那会把相邻汉字一起
    替换掉（实测把「这个 indexd」改成了「index-tts」，整个句子被破坏）。
    这里按术语类型限定候选单位，绝不跨字符类别边界：
      - ASCII 术语：只匹配连续的 字母/数字/-/_/. 串
      - 中文术语  ：只匹配连续汉字串
    归一化后已经写对的直接跳过。
    """
    import re
    if not terms:
        return text, 0

    fixed = 0
    for term in sorted(set(terms), key=len, reverse=True):
        nt = _norm(term)
        if len(nt) < 2:
            continue

        pat = re.compile(r"[A-Za-z0-9][A-Za-z0-9\-_\.]*[A-Za-z0-9]|[A-Za-z0-9]"
                         if term.isascii() else r"[\u4e00-\u9fff]+")

        def _repl(m):
            nonlocal fixed
            cand = m.group(0)
            if _norm(cand) == nt:          # 本来就是对的，别动
                return cand
            if _sim(_norm(cand), nt) >= threshold:
                fixed += 1
                if verbose:
                    print(f"[术语] {cand!r} -> {term!r}", file=sys.stderr)
                return term
            return cand

        text = pat.sub(_repl, text)
    return text, fixed


def _tmp_wav_path(src: str) -> str:
    """
    临时 wav 的存放位置。默认放在源文件同目录，
    因为 /tmp 常常只有几十 MB，装不下一小时的音频。
    """
    base = os.environ.get("ASR_TMP") or os.path.dirname(os.path.abspath(src)) \
        or "."
    os.makedirs(base, exist_ok=True)
    return os.path.join(base, f".asr_cpu_{os.getpid()}_{int(time.time() * 1000)}.wav")


def to_16k_mono(src: str) -> tuple[str, bool]:
    """
    把任意音频统一转成 16kHz 单声道 wav，返回 (路径, 是否为临时文件)。

    优先用 soundfile 自带的解码器（libsndfile 支持 mp3/flac/ogg），
    不需要 ffmpeg；实在读不了才回退到 ffmpeg。
    """
    ext = os.path.splitext(src)[1].lower()
    if ext == ".wav":
        return src, False

    tmp = _tmp_wav_path(src)

    try:
        import soundfile as sf
        data, sr = sf.read(src, dtype="float32", always_2d=True)
        if sr != 16000:
            from math import gcd
            from scipy.signal import resample_poly
            g = gcd(sr, 16000)
            data = resample_poly(data, 16000 // g, sr // g, axis=0)
        mono = data.mean(axis=1) if data.shape[1] > 1 else data[:, 0]
        sf.write(tmp, mono, 16000, subtype="PCM_16")
        return tmp, True
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)

    if not check_ffmpeg():
        sys.exit(
            f"无法解码 {ext} 格式：既没装 soundfile 可用解码，也找不到 ffmpeg。\n"
            "二选一安装:\n"
            "  pip install soundfile         (推荐，纯 pip)\n"
            "  sudo apt install -y ffmpeg    (系统包)\n"
            "  pip install imageio-ffmpeg    (自带静态 ffmpeg，免 sudo)"
        )

    subprocess.run(
        [ffmpeg_path(), "-y", "-i", src, "-ar", "16000", "-ac", "1", "-vn", tmp],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True,
    )
    return tmp, True


def audio_duration(path: str) -> float:
    """读音频时长（秒），用于算实时倍速。失败返回 0。"""
    try:
        import soundfile as sf
        info = sf.info(path)
        return info.frames / info.samplerate
    except Exception:
        return 0.0


# ------------------------------------------------------- 后端 1: Whisper

def run_whisper(args, audio: str) -> str:
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit(
            "缺少 faster-whisper，请先安装:\n"
            "  pip install faster-whisper\n"
            "  (国内建议先执行: export HF_ENDPOINT=https://hf-mirror.com)"
        )

    t0 = time.time()
    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type=args.compute_type,      # CPU 上 int8 最快最省内存
        cpu_threads=args.threads,
        download_root=args.model_dir or None,
    )
    print(f"[i] 模型 {args.model} ({args.compute_type}) 加载耗时 {time.time() - t0:.1f}s",
          file=sys.stderr)

    lang = None if args.language == "auto" else args.language

    # 把术语表拼进 prompt，让解码器一开始就"知道"这些词的存在。
    # Whisper 这里是软偏置，不是硬约束——最后仍有赖后处理兜底。
    prompt = args.prompt or ""
    if args.terms_file:
        terms = ", ".join(load_terms(args.terms_file))
        prompt = f"{prompt}\n专有名词和缩写: {terms}".strip()
    if prompt:
        print(f"[i] initial_prompt: {prompt[:80]}...", file=sys.stderr)

    segments, info = model.transcribe(
        audio,
        language=lang,
        beam_size=1 if args.fast else 5,       # beam=1 贪心解码，速度明显更快
        vad_filter=not args.no_vad,            # 过滤静音段，显著提速
        vad_parameters={"min_silence_duration_ms": 500},
        condition_on_previous_text=False,      # 避免长音频里的幻觉复读
        initial_prompt=prompt or None,
    )

    print(f"[i] 检测到语言: {info.language} (置信度 {info.language_probability:.2f})",
          file=sys.stderr)

    lines, srt = [], []
    dur = 0.0
    for i, seg in enumerate(segments, 1):
        text = seg.text.strip()
        if not text:
            continue
        lines.append(text)
        srt.append(f"{i}\n{srt_ts(seg.start)} --> {srt_ts(seg.end)}\n{text}\n")
        dur = seg.end
        print(f"  [{human_sec(seg.start)}] {text}", file=sys.stderr)

    if args.format == "srt":
        return "\n".join(srt)
    return "\n".join(lines)


# --------------------------------------------------- 后端 2: SenseVoice

def _tmp_root(src: str) -> str:
    base = os.environ.get("ASR_TMP") or os.path.dirname(os.path.abspath(src)) \
        or "."
    os.makedirs(base, exist_ok=True)
    return base


def _vad_split(args, audio: str):
    """
    用 fsmn-vad 把音频切成语音段，写进临时目录，返回 (临时目录, wav 路径列表)。

    为什么要切：SenseVoice 一次吃 200 秒音频时 attention 是 O(n²)，
    切成十几秒的小段后总耗时能降一个数量级——官方 17x 就是这么跑出来的。
    """
    import shutil
    import tempfile

    import numpy as np
    import soundfile as sf
    from funasr_onnx.vad_bin import Fsmn_vad

    data, sr = sf.read(audio, dtype="float32", always_2d=True)
    mono = data[:, 0] if data.shape[1] > 1 else data[:, 0]

    vad = Fsmn_vad(model_dir=args.vad_model or DEFAULT_VAD_MODEL,
                   batch_size=1, quantize=True,
                   intra_op_num_threads=args.threads)
    segs = vad(mono)
    # 返回是多包一层的 [[[beg,end],...]]：外层对应每段输入音频
    while segs and isinstance(segs[0], (list, tuple)) and segs[0] \
            and isinstance(segs[0][0], (list, tuple)):
        segs = segs[0]
    if not segs:
        return None, None

    # VAD 返回的单位各版本不一致（毫秒 or 采样点）。
    # 采样点时最大值应接近总样本数；毫秒时应接近「秒数×1000」，明显更小。
    # 用 0.5 倍总长度作分界，两种情况都能稳妥区分。
    raw_max = max(s[1] for s in segs if len(s) >= 2)
    unit = 1.0 if raw_max > len(mono) * 0.5 else sr / 1000.0

    max_len = int(args.merge_length_s * sr)
    chunks, cur = [], None
    for seg in segs:
        b, e = int(seg[0] * unit), int(seg[1] * unit)
        if cur is None:
            cur = [b, e]
        elif e - cur[0] <= max_len:
            cur[1] = e
        else:
            chunks.append((cur[0], cur[1]))
            cur = [b, e]
    if cur is not None:
        chunks.append((cur[0], cur[1]))

    tmpdir = tempfile.mkdtemp(prefix="asr_vad_", dir=_tmp_root(audio))
    paths = []
    for i, (b, e) in enumerate(chunks):
        p = os.path.join(tmpdir, f"seg_{i:04d}.wav")
        sf.write(p, mono[b:e], sr, subtype="PCM_16")
        paths.append(p)
    return tmpdir, paths


# ---------------------------------------------- 情感 / 事件标签（emoji）处理
# SenseVoice 是「富文本转写」模型，输出天然带两类额外标签，
# 经 rich_transcription_postprocess 后会被渲染成 emoji：
#
#   情感标签 <|EMO_xxx|>  ->  😊 中立/开心  😡 生气  😔 伤心
#                             😰 恐惧  🤢 厌恶  😮 惊讶  🤧 咳嗽
#   事件标签 <|Event_xxx|> -> 🎼 BGM  👏 掌声  😀 笑声  😭 哭声
#                             🔧 噪音  ⌨️ 键盘声  💧 水声 ...
#
# 关键坑：这些标签是【每个 VAD 片段一组】。整段喂进去只有 1 组，
# 一旦按 VAD 切成 10 段就会得到 10 组 —— 于是文本里密密麻麻全是 emoji。
# 做正文/字幕时通常要去掉，做情绪分析时才需要保留。
_EMOJI_RE = re.compile(
    "[\U0001F300-\U0001FAFF"      # 表情符号与主扩展块
    "\U00002600-\U000027BF"      # 杂项符号（☀ ✅ ❗ 等）
    "\U0001F1E6-\U0001F1FF"      # 区域指示符（国旗）
    "\U00002190-\U000021FF"      # 箭头
    "\U00002B00-\U00002BFF"      # 杂项符号补充
    "\U0000FE00-\U0000FE0F]"     # 变体选择符
)


def strip_emoji(text: str) -> str:
    """移除情感/事件 emoji，并清理它们留下的多余空白与空句。"""
    clean = _EMOJI_RE.sub("", text)
    clean = re.sub(r"[ \t]{2,}", " ", clean)     # 连续空白
    clean = re.sub(r"\s+([，。！？、；：])", r"\1", clean)  # 标点前空白
    return clean.strip()


def count_emoji(text: str) -> int:
    return len(_EMOJI_RE.findall(text))


# ------------------------------------------------------------ 资源控制工具

def parse_affinity(spec: str) -> list[int]:
    """
    解析 CPU 亲和性描述，支持三种常见写法：
        "0,2,4"        枚举
        "0-7"          区间（含端点）
        "0-31:2"       区间 + 步长，101 平台这种>64核机器上很常用
        "0-7,16-23"    混合
    返回去重排序后的核编号列表。
    """
    cpus: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            range_part, _, stride_part = part.partition(":")
            lo_s, _, hi_s = range_part.partition("-")
            lo, hi = int(lo_s), int(hi_s)
            stride = int(stride_part) if stride_part else 1
            if lo > hi or stride < 1:
                raise ValueError(f"非法的区间写法: {part}")
            cpus.update(range(lo, hi + 1, stride))
        else:
            cpus.add(int(part))
    if not cpus:
        raise ValueError("空的亲和性设置")
    return sorted(cpus)


def parse_cpu_spec(spec: str) -> set[int]:
    """解析 CPU 核列表：支持 '0,2,4'、'0-7'、'0-31:2'（区间带步长）写法。"""
    cpus: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            body, _, stride = part.partition(":")
            lo_s, _, hi_s = body.partition("-")
            lo, hi = int(lo_s), int(hi_s)
            step = int(stride) if stride else 1
            cpus.update(range(lo, hi + 1, step))
        else:
            cpus.add(int(part))
    return cpus


def apply_cpu_limits(args) -> None:
    """在推理开始前落实 CPU 相关的限制项（线程数在建模时已传入）。"""
    # 进程谦让度：值越大越让着别的进程，0 默认，19 最低优先级（仅能调低不能调高）
    if getattr(args, "nice", 0):
        try:
            os.nice(args.nice)
            print(f"[i] nice 已设为 {args.nice}（数值越大越谦让）",
                  file=sys.stderr)
        except Exception as e:
            print(f"[!] nice 设置失败: {e}", file=sys.stderr)

    # CPU 亲和性：把进程绑到指定核上，避免和别的服务抢核、减少跨 NUMA 抖动
    affinity = getattr(args, "affinity", "") or os.getenv("ASR_CPU_AFFINITY", "")
    if affinity:
        try:
            cpus = parse_cpu_spec(affinity)
            os.sched_setaffinity(0, cpus)
            print(f"[i] CPU 亲和性: {sorted(cpus)}", file=sys.stderr)
        except Exception as e:
            print(f"[!] 亲和性设置失败({affinity}): {e}", file=sys.stderr)


def run_sensevoice(args, audio: str) -> str:
    """
    走 funasr-onnx 的 SenseVoiceSmall（纯 onnxruntime，不需要 torch）。

    注意两点实测结论:
      - 这里的参数是 textnorm 而不是 use_itn，取值 "withitn" / "woitn"
      - SenseVoice 无论 onnx 还是 torch 版都【不支持 hotword】
    """
    try:
        from funasr_onnx import SenseVoiceSmall
        from funasr_onnx.utils.postprocess_utils import \
            rich_transcription_postprocess
    except ImportError:
        sys.exit(
            "缺少 funasr-onnx，请先安装:\n"
            "  pip install funasr-onnx soundfile modelscope\n"
            "  (国内建议加 -i https://mirrors.aliyun.com/pypi/simple/)"
        )

    model_path = args.sv_model or os.getenv("SV_MODEL_DIR") or DEFAULT_SV_MODEL
    t0 = time.time()
    model = SenseVoiceSmall(model_dir=model_path,
                            quantize=not args.no_quantize,
                            batch_size=args.batch,
                            intra_op_num_threads=args.threads)
    print(f"[i] SenseVoice 加载耗时 {time.time() - t0:.1f}s"
          f"  (量化={'开' if not args.no_quantize else '关'})",
          file=sys.stderr)

    lang = args.language if args.language != "auto" else "auto"
    tn = "withitn" if not args.no_itn else "woitn"

    # 先试着按语音切段（提速关键），失败就整段丢给模型
    tmpdir, paths = None, None
    if not args.no_vad:
        try:
            tmpdir, paths = _vad_split(args, audio)
            if paths:
                print(f"[i] VAD 切成 {len(paths)} 段", file=sys.stderr)
        except Exception as e:
            print(f"[!] VAD 切分失败({type(e).__name__})，回退整段识别",
                  file=sys.stderr)
            paths = None

    try:
        res = model(paths if paths else audio, language=lang, textnorm=tn)
        joined = "".join(rich_transcription_postprocess(r) for r in res)
    finally:
        if tmpdir:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    # emoji 是按 VAD 段一组产生的，段数越多越密
    kept = count_emoji(joined)
    if getattr(args, "emoji", "strip") == "strip" and kept:
        joined = strip_emoji(joined)
        print(f"[i] 已移除 {kept} 个情感/事件 emoji", file=sys.stderr)
    return joined.strip()


# ------------------------------------------------------------------ main

def main():
    p = argparse.ArgumentParser(description="CPU-only 本地语音转文字")
    p.add_argument("audio", help="输入音频文件 (mp3/wav/m4a/flac/mp4 ...)")
    p.add_argument("-o", "--output", help="输出文件，默认打印到终端")
    p.add_argument("--backend", default="sensevoice",
                   choices=["sensevoice", "whisper"],
                   help="识别后端，默认 sensevoice（中文最快最准）")
    p.add_argument("--sv-model", default="",
                   help="SenseVoice onnx 模型目录，默认取 SV_MODEL_DIR 环境变量")
    p.add_argument("--model", default="small",
                   help="whisper 模型: tiny/base/small/medium，默认 small")
    p.add_argument("--format", default="txt", choices=["txt", "srt"],
                   help="输出格式，默认 txt")
    p.add_argument("--language", default="auto",
                   help="语言，如 zh/en/ja/yue；auto 为自动检测，默认 auto")
    p.add_argument("--threads", type=int, default=0,
                   help="CPU 线程数，0=自动，默认 0")
    p.add_argument("--compute-type", default="int8",
                   help="量化类型: int8(推荐)/int8_float16/float32，默认 int8")
    p.add_argument("--model-dir", default=os.getenv("ASR_MODEL_DIR", ""),
                   help="模型缓存目录，默认 ~/.cache")
    p.add_argument("--prompt", default="",
                   help="提示词，给模型一点上下文(如专有名词)")
    p.add_argument("--fast", action="store_true",
                   help="贪心解码，速度更快、准确率略降")
    p.add_argument("--no-vad", action="store_true", help="关闭静音过滤")
    p.add_argument("--timestamp", action="store_true",
                   help="sensevoice 后端下启用时间戳(会加载 VAD，稍慢)")
    p.add_argument("--terms-file", default="",
                   help="术语表，每行一个词(如 GPT-4 / PostgreSQL)，用于纠偏")
    p.add_argument("--term-threshold", type=float, default=0.75,
                   help="术语替换的相似度阈值，默认 0.75")
    p.add_argument("--no-itn", action="store_true",
                   help="关闭逆文本正则化(ITN)，保留口语化的原文")
    p.add_argument("--no-quantize", action="store_true",
                   help="SenseVoice 用非量化 onnx 模型")
    p.add_argument("--vad-model", default="",
                   help="fsmn-vad 模型目录，默认取 SV_VAD_DIR 环境变量")
    p.add_argument("--batch", type=int, default=8,
                   help="SenseVoice 批量推理大小，默认 8")
    p.add_argument("--merge-length-s", type=float, default=15.0,
                   help="VAD 片段合并后的最大长度(秒)，默认 15")
    p.add_argument("--emoji", default="strip", choices=["strip", "keep"],
                   help="是否保留 SenseVoice 的情感/事件 emoji，默认 strip(去掉)")
    p.add_argument("--nice", type=int, default=0,
                   help="进程优先级谦让值 0-19，越大越让 CPU 给别人，默认 0")
    p.add_argument("--affinity", default="",
                   help="CPU 亲和性，如 '0-7' 或 '0,2,4' 或 '0-31:2'，限制只用这些核")
    p.add_argument("--json", action="store_true",
                   help="输出 JSON（含文本/耗时/倍速），供程序调用")
    args = p.parse_args()

    if not os.path.exists(args.audio):
        sys.exit(f"找不到文件: {args.audio}")
    if args.threads <= 0:
        args.threads = max(1, (os.cpu_count() or 4) - 1)

    apply_cpu_limits(args)          # nice / 亲和性，越早越好
    print(f"[i] CPU 线程: {args.threads}  批大小: {args.batch}",
          file=sys.stderr)

    wav, is_tmp = to_16k_mono(args.audio)
    dur = audio_duration(wav)      # 在临时文件被删前先量时长

    t0 = time.time()
    try:
        text = run_whisper(args, wav) if args.backend == "whisper" \
            else run_sensevoice(args, wav)
    finally:
        if is_tmp and os.path.exists(wav):
            os.remove(wav)

    cost = time.time() - t0

    terms = load_terms(args.terms_file)
    if terms:
        text, n = apply_terms(text, terms, args.term_threshold, verbose=True)
        print(f"[i] 术语纠偏 {n} 处", file=sys.stderr)

    rtf = (dur / cost) if cost > 0 and dur > 0 else 0.0
    print(f"\n[i] 转写完成 音频 {dur:.1f}s / 耗时 {cost:.1f}s / 实时倍速 "
          f"{rtf:.1f}x", file=sys.stderr)

    if args.json:
        payload = {"ok": True, "file": args.audio, "text": text,
                   "chars": len(text), "duration_s": round(dur, 2),
                   "cost_s": round(cost, 2), "rtfx": round(rtf, 2),
                   "backend": args.backend}
        blob = json.dumps(payload, ensure_ascii=False, indent=2)
        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(blob + "\n")
            print(f"[✓] 已写入 {args.output}", file=sys.stderr)
        else:
            print(blob)
        return

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        print(f"[✓] 已写入 {args.output}", file=sys.stderr)
    else:
        print("\n" + "=" * 40)
        print(text)


if __name__ == "__main__":
    main()
