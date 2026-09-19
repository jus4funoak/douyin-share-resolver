# share-resolver

输入一段短视频分享文案（App 里「复制链接」粘出来的那坨带乱码文本），解析出该视频的信息，
并可批量转写成文字稿。

解析部分零第三方依赖，只需要 Node 18+。

## 快速开始

```bash
node src/cli.js "粘贴分享文案"     # JSON 输出
node src/cli.js "..." --text       # 人类可读摘要
node src/cli.js --help             # 其余参数：--compact / --raw
```

起本地服务 + 网页（推荐，粘贴即可用）：

```bash
node src/server.js      # http://127.0.0.1:8848
PORT=9000 node src/server.js
```

> 网页只是壳子，解析由本地 Node 后端完成，请先跑 `node src/server.js` 再打开页面。
> 若用别的方式直接打开了 `public/index.html`，在页面右上角填写后端地址
> `http://127.0.0.1:8848` 即可。

作为库使用：

```js
import { resolveShare } from './src/resolver.js';

const r = await resolveShare('粘贴分享文案');
console.log(r.video.playUrl);
```

## 批量转写（本地语音识别）

```bash
./start.sh    # 启动：setsid 后台运行，关终端不停，重复执行不会起第二个实例
./stop.sh     # 停止
```

- <http://127.0.0.1:8848/>       单条解析
- <http://127.0.0.1:8848/batch>  批量转写队列

全程本地 CPU 跑 SenseVoice，**不调任何云端 API，不限条数**。成果落在项目内 `data/`：

```
data/out/         文字稿 .txt 与元信息 .json
data/queue.json   队列状态，服务重启后自动续跑
data/config.json  并发数 / 线程数 / 音源选择
```

换目录：`DY_ASR_DATA=/想放的地方 ./start.sh`

## 环境要求

| 项 | 说明 |
|---|---|
| Node | 18+，零第三方依赖 |
| Python | 3.11 + SenseVoice 模型（仅批量转写需要，首次启动自动下载） |
| ffmpeg | 缺失时由 `imageio-ffmpeg` 提供静态二进制 |

换机器时用环境变量覆盖：`ASR_PYTHON` / `ASR_SCRIPT` / `ASR_TMP` / `DY_ASR_DATA`。

## 注意

- 部分字段（播放量、粉丝数）在该数据源下常返回 0，不可信
- 要口播文案取**视频音轨**；「原声 MP3」只有当标题含「创作的原声」时才等于人声，否则是 BGM
- 并发占用核数 ≈ 并发数 × 每任务线程数，默认 2 × 8
- 数据源为第三方接口，随时可能失效

## 测试

```bash
node test/run.js
```
