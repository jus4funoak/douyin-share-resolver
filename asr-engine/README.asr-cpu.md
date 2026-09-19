# asr_cpu —— 纯 CPU 本地音频转文字

不用显卡、不用联网 API、不限时长、不限次数。准确率要求不高时，CPU 方案完全够用。

想看速度 / 准确性的量化对比和选型依据 → [速度与准确性分析.md](速度与准确性分析.md)

---

## 〇、关于英文名词 / 缩写（实测更正）

**SenseVoice 不支持热词。** 这点必须点名：

| 实现 | 热词支持 | 证据 |
|------|---------|------|
| funasr-onnx · SenseVoiceSmall | ❌ | `sensevoice_bin.py` 全文没有 hotword 代码，`__call__` 只接受 `language` / `textnorm` |
| funasr(torch) · SenseVoiceSmall | ❌ | AutoModel 的 generate 没有 hotword 参数 |
| funasr-onnx · **Paraformer** | ✅ | `paraformer_bin.py` 有 `proc_hotword` / `bias_embed` |
| Whisper | ⚠️ | 只有 `initial_prompt` 软偏置 |

网上流传的「SenseVoice 动态热词」说法把 Paraformer 的能力安到了 SenseVoice 头上。**真要 NN 热词偏置，得换 `speech_paraformer-large-contextual_*_onnx`。**

所以选了 SenseVoice 之后，英文名词、缩写、产品名的唯一可靠手段是**后处理纠偏**：

```bash
# 1) 建术语表，每行一个词
cat > terms.txt <<'EOF'
GPT-4
PostgreSQL
Kubernetes
SKU
RAG
EOF

# 2) 转写后自动纠偏
python asr_cpu.py talk.mp3 --terms-file terms.txt -o out.txt
```

原理：把识别结果按术语长度滑动取片，归一化（去空格、去标点、全角转半角、
**中文数字转阿拉伯数字**、统一小写）后算相似度，超过阈值就替换。

于是这些典型错误能被揪回来：

| 模型可能输出 | 纠正后 |
|---|---|
| `G P T 四` / `G P T 4` / `gpt4` | GPT-4 |
| `post gres ql` | PostgreSQL |
| `indextts` / `indexTTS2` | index-tts |

> ⚠️ 踩过的坑：第一版用「按术语长度任意滑动窗口」，结果把「这个 indexd」
> 整体替换成「index-tts」，相邻汉字被吃掉。现版本按术语类型限定候选单位
> （ASCII 术语只匹配字母数字串，中文术语只匹配汉字串），绝不跨字符类别边界。

默认阈值 **0.86**。实测它能干净地覆盖所有「写法差异」——这类归一化后相似度直接拉满到 1.00：

| 模型可能输出 | 相似度 | 结果 |
|---|---|---|
| `GPT四` | 1.00 | → GPT-4 ✅ |
| `gpt4` / `GPT 4` | 1.00 | → GPT-4 ✅ |
| `indextts` | 1.00 | → index-tts ✅ |
| `indexd`（真识别错） | 0.71 | 默认纠不了 |

**别指望它纠正真正的识别错误。** `indexd` 这种属于语义错、不是写法差异，
相似度只有 0.71。正确做法是把常见错误写法一并写进术语表（`indexd`、
`indexTTS2` 都列一行），让它走精确匹配。

不建议把阈值降到 0.7 去强捞：那会让正常的「index」也被替换成「index-tts」。
要调就用 `--term-threshold`，每降一点都要重跑样本确认没误伤。

补充手段：

- 已知音频英文占比超过三成 → 换 Whisper（`--backend whisper`），原生英文能力强得多
- SenseVoice 自带的 ITN 会把连写字母合并（`A B C D` → `ABCD`），通常是好事；
  想保留原始口语用 `--no-itn` 关掉

---

## 一、快速开始（推荐：SenseVoice ONNX）

免 torch、纯 onnxruntime，中文最快最准。

```bash
# 1. 建环境
python3 -m venv ~/asr && source ~/asr/bin/activate

# 2. 装依赖（国内建议加镜像）
pip install -i https://mirrors.aliyun.com/pypi/simple/ \
    funasr-onnx soundfile modelscope

# 3. 下载 SenseVoice ONNX 模型（约 240MB，含量化版）
python -c "
from modelscope.hub.snapshot_download import snapshot_download
print(snapshot_download('iic/SenseVoiceSmall-onnx', cache_dir='./models'))
"

#  ⚠️ 官方 onnx 仓库缺分词文件，必须补这一步，否则初始化报错
python -c "
from modelscope.hub.file_download import model_file_download
model_file_download(
    model_id='iic/SenseVoiceSmall',
    file_path='chn_jpn_yue_eng_ko_spectok.bpe.model',
    local_dir='<上一步输出的模型目录>')
"

# 4. 跑（mp3 由 soundfile 直接解码，不需要 ffmpeg）
python asr_cpu.py input.mp3 -o out.txt
```

> 本机实测环境已就绪：虚拟环境 `/home/ssh/.workbuddy/binaries/python/envs/asrsv`，
> 模型位于 `models/models/iic--SenseVoiceSmall-onnx/snapshots/master/`。
> 用法见下节。

**本机一键调用：**

```bash
cd /home/ssh/WorkBuddy/2026-09-19-01-51-35/asr_cpu
export ASR_TMP=/home/ssh/WorkBuddy/2026-09-19-01-51-35/.tmp
/home/ssh/.workbuddy/binaries/python/envs/asrsv/bin/python asr_cpu.py \
    音频.mp3 --threads 16 -o out.txt
```

---

## 二、三种方案怎么选

| 方案 | 适用 | 模型体积 | 中文效果 | 速度感官 | 安装 |
|------|------|---------|---------|---------|------|
| **faster-whisper small int8** | 通用首选，多语种混说 | ~490MB | 良好 | 大约 2–4 倍实时 | `pip install faster-whisper` |
| **faster-whisper base/tiny int8** | 机器弱、要快 | ~145MB / ~75MB | 一般 | 很快 | 同上 |
| **SenseVoice-Small** | 纯中文音频、量大 | ~230MB | **同体积里最好** | 明显快于 whisper-small | `pip install funasr modelscope` |
| **Vosk small** | 极低配 / 嵌入式 | ~50MB | 一般 | 最快 | `pip install vosk` |

> 速度数字是 8 核 CPU、int8 量化下的粗略量级，实际随机器和音频内容浮动。

**一句话建议**：中文音频、量大、只要文本 → `SenseVoice`；要有字幕时间戳或多语种 → `faster-whisper small`，嫌慢就降 `base`。

---

## 三、常用命令

```bash
# 出字幕
python asr_cpu.py video.mp4 --format srt -o video.srt

# 指定中文，避免自动检测跑偏
python asr_cpu.py a.mp3 --language zh -o a.txt

# 贪心解码 + base 模型，速度优先
python asr_cpu.py long.mp3 --model base --fast

# 给模型喂专有名词，改善人名/术语识别
python asr_cpu.py talk.mp3 --model small --prompt "以下是关于 PostgreSQL 和向量检索的讨论"

# 用 SenseVoice 处理中文录音
python asr_cpu.py meeting.wav --backend sensevoice -o meeting.txt

# 指定模型缓存位置
python asr_cpu.py a.mp3 --model-dir /data/models
```

---

## 四、让 CPU 跑得更快的几个开关

| 手段 | 做法 | 效果 |
|------|------|------|
| 量化 | `compute_type="int8"`（默认） | CPU 上最快，比 float32 快 2–3 倍 |
| 贪心解码 | `--fast`（beam_size=1） | 再快 30%+，准确率略降 |
| 静音过滤 | 默认开启 VAD | 音频越"空"收益越大 |
| 模型降档 | small → base → tiny | 每次约快 2–3 倍 |
| 线程数 | `--threads 8` | 设为物理核数附近最好，超线程收益有限 |
| 切片并行 | ffmpeg 按静音切段，多进程跑 | 长音频提速明显 |

导出原生线程数别超物理核，OpenMP 抢线程反而变慢。

---

## 五、常见坑

- **报缺 ffmpeg**：脚本只对 whisper 后端做重采样，装 ffmpeg 即可；wav 输入不用装。
- **下载模型卡住**：设 `HF_ENDPOINT=https://hf-mirror.com`（whisper）或 `MODELSCOPE_ENDPOINT`（SenseVoice）。
- **长音频后半段开始胡言乱语**：脚本已关闭 `condition_on_previous_text`，仍有幻觉就把 `--model` 升到 medium，或用更小的切片。
- **输出一堆重复句**：多半是静音段太长，别关 VAD；必要时加 `--prompt` 锚定主题。
- **内存吃紧**：tiny/base 只需 1GB 不到，small 约 1–2GB，medium 约 3–4GB。
- **音乐/多人重叠说话**：所有开源 CPU 方案都吃力，需要先用 Demucs 之类做人声分离。

---

## 六、想做实时/流式

离线批量用上面这套；要麦克风实时或边录边出字：

- **sherpa-onnx**：SenseVoice / Paraformer 的 C++ 推理，无 torch 依赖，树莓派都能跑，自带流式 —— `pip install sherpa-onnx`
- **FunASR 流式版**：`paraformer-zh-streaming`，适合服务端长连接

需要的话跟我说，我补一份流式版本。

---

## 七、为什么输出里有一堆表情符（SenseVoice 的富文本标签）

SenseVoice 不是纯 ASR 模型，它是**富文本转写（Rich Transcription）**模型，
除了文字还会输出两类额外标签。`rich_transcription_postprocess` 会把它们渲染成 emoji：

| 类别 | 原始标签 | 渲染为 | 含义 |
|------|---------|-------|------|
| 情感 EMO | `<\|EMO_UNKNOWN\|>` | 😊 | 中立/开心、😡 生气、😔 伤心、😰 恐惧、🤢 厌恶、😮 惊讶、🤧 咳嗽 |
| 事件 Event | `<\|Event_Music\|>` | 🎼 | BGM；另有 👏 掌声、😀 笑声、😭 哭声、🔧 噪音、⌨️ 键盘声、💧 水声 |

**关键点：这些标签是「每个音频片段一组」。**
实测同一段 198 秒音频：

| 喂法 | 片段数 | emoji 数 |
|------|-------|---------|
| 整段直喂 | 1 | 2 |
| VAD 切成 10 段 | 10 | **20** |

而切成 10 段是提速的关键（3.3x → 18x），所以「要速度」就必然会带出一堆 emoji。
这是设计使然，不是 bug。

处理方式：

```bash
python asr_cpu.py a.mp3                 # 默认 strip，正文干净
python asr_cpu.py a.mp3 --emoji keep    # 保留，用来做情绪/氛围分析
```

`strip` 模式（默认）会顺手清掉 emoji 留下的多余空白和空句。
如果你要拿它做「这段视频哪里在笑/哪里换了 BGM」这类分析，用 `--emoji keep`。

---

## 八、完整参数表

### 资源占用相关（CPU / 内存）

| 参数 | 默认 | 作用 | 怎么调 |
|------|------|------|-------|
| `--threads` | 核数-1 | ONNXRuntime **intra** op 线程数，单条推理内部并行度 | 物理核数附近最好；超线程抢不到收益 |
| `--batch` | 8 | VAD 切段后一次喂几段 | 内存够就 8–16，收益递减 |
| `--merge-length-s` | 15 | VAD 片段合并后的最大长度 | **越小越快**（段更多更好并行），但 <8s 会损失上下文连贯性 |
| `--nice` | 0 | 进程谦让度 0–19，数值越大越让 CPU 给别人 | 机器上还有别的服务时给 10–19 |
| `--affinity` | 空 | 绑核，支持 `0,2,4` / `0-7` / `0-31:2`（区间带步长） | 避免和别的服务抢核、减少跨 NUMA 抖动 |
| 环境变量 `OMP_NUM_THREADS` | — | 限制 OpenMP 嵌套线程 | 建议＝`--threads`，防止线程互相打架 |
| `--no-quantize` | 关 | 用非量化 onnx | 量化在 **CPU 上收益远大于 GPU**（接近内存带宽瓶颈，权重字节减半＝流量减半），一般不关 |

> 注意：`inter_op` 线程数 **不可配** —— funasr-onnx 只把 `intra_op_num_threads` 传给了
> ONNXRuntime，源码里 `punc_bin.py` / `sensevoice_bin.py` 都没有透出 inter op 参数。
> 想控制总占用就用「进程数 × intra 线程」这个公式。

### 质量相关

| 参数 | 默认 | 作用 |
|------|------|------|
| `--language` | auto | 指定 zh/en/ja/yue/ko 通常比 auto 准 |
| `--no-itn` | 关（即开 ITN） | 逆文本正则化：`二零二五` → `2025`。**对含英文/数字的稿子是双刃剑**，建议同一段各跑一次对比 |
| `--terms-file` | 无 | 术语表，每行一个词，用于纠英文缩写 |
| `--term-threshold` | 0.86 | 纠偏相似度阈值。**调低会误伤正常文本**，缩写建议 ≥0.85 |
| `--emoji` | strip | 是否保留情感/事件 emoji |
| `--no-vad` | 关（即开 VAD） | 关闭力度：质量和速度都会明显下降，不建议 |

### 输出相关

| 参数 | 默认 | 作用 |
|------|------|------|
| `-o` | 无（打印） | 写到文件 |
| `--json` | 关 | 输出 JSON：`text / chars / duration_s / cost_s / rtfx`，供程序调用 |
| `--format srt` | txt | 生成字幕（whisper 后端） |

---

## 九、本机实测基线（Xeon Gold 6150，18 核 36 线程）

198 秒中文音频：

| 配置 | 耗时 | 实时倍速 |
|------|------|---------|
| 整段直喂 | 60.4s | 3.3x |
| VAD 切 10 段 + 批量，**16 线程独占** | **10.7s** | **18.6x** |
| 同上，但 3 路并发跑 | 单条约 13.7s | 约 14.5x / 路，但总吞吐翻倍 |

结论：**先保证「按 VAD 切段」，再谈线程数和并发。**
整段喂不仅慢 6 倍，还会严重吞字（实测漏掉近半内容）。
