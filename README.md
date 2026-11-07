# dsh-feiyu-voice

给 DeepSeek Harness（DSH）用的本地语音插件：用 [MOSS-TTS-Nano](https://github.com/OpenMOSS/MOSS-TTS-Nano)（0.1B、ONNX、**纯 CPU** 可跑）加**你自己的参考音色**合成语音，并可通过 `dsh-qqbot` 直接发成 **QQ 语音条**。

本包**不包含**：模型权重、Python 环境、任何音色文件、任何账号凭据。这些都在你自己的 `ttsHome` 目录里准备。

---

## 一、它给你什么

| 能力 | 入口 |
|---|---|
| 合成一段语音到本地 wav | 工具 `feiyu_speak(text, ref?)` |
| 合成并发成 QQ 语音条 | 工具 `feiyu_send_voice(text, ref?, target?)` |
| 查看服务/音色/路径状态 | 工具 `feiyu_voice_status()` |
| 可视化配置与试听 | **设置 → 小肥鱼语音**（选音色、填 TTS 目录、启停常驻服务、试听） |

插件会按需拉起常驻服务 `scripts/speakd.py`（模型只加载一次，单句约 20–40 秒）；服务没起时自动走冷启动（每次加载模型，1–2 分钟）。

---

## 二、前置要求

| 项 | 要求 |
|---|---|
| DSH | 桌面版或 `dsh web`（Node 由 DSH 自带，无需另装） |
| Python | **3.11 / 3.12 推荐**（3.10–3.13 可用；3.14+ 部分依赖还没有轮子） |
| 磁盘 | 约 2–3 GB（模型 ≈1 GB + torch/onnxruntime ≈1.5 GB） |
| 内存 | 常驻服务约占 **2–3 GB**；8 GB 机器建议不用时关掉 |
| 显卡 | **不需要**，CPU 即可（有 NVIDIA 也可，但本插件默认 CPU） |
| 音色 | 一段 5–15 秒的干净人声 wav（推荐 24 kHz 单声道） |
| QQ 语音（可选） | 已安装 `@tencent-connect/dsh-qqbot` 并配置好机器人 `appId` / `appSecret` |

---

## 三、准备 TTS 运行目录（ttsHome）

默认位置 `~/.dsh/tts`（Windows 即 `C:\Users\<你>\.dsh\tts`）。也可以放在别处，后面在插件里填路径即可。

目标结构：

```
<ttsHome>\
├── venv\                              # Python 虚拟环境
├── _src\MOSS-TTS-Nano-main\           # MOSS-TTS-Nano 源码
│   └── models\                        # 首次运行自动下载的 ONNX 权重
├── refs\                              # 你自己的参考音色
│   └── my-voice.wav
└── out\                               # 生成结果（插件自动建）
```

### 1. 创建虚拟环境

```powershell
$tts = "$env:USERPROFILE\.dsh\tts"
New-Item -ItemType Directory -Force -Path "$tts\_src","$tts\refs","$tts\out" | Out-Null
python -m venv "$tts\venv"
& "$tts\venv\Scripts\python.exe" -m pip install --upgrade pip
```

> macOS / Linux：把 `venv\Scripts\python.exe` 换成 `venv/bin/python`。

### 2. 安装依赖

```powershell
& "$tts\venv\Scripts\python.exe" -m pip install `
  torch==2.7.0 torchaudio==2.7.0 transformers==4.57.1 `
  onnxruntime sentencepiece soundfile numpy
```

> **不要装 `WeTextProcessing` / `pynini`**：Windows 上没有可用的 pynini 轮子，而且本插件调用时固定带 `--disable-wetext-processing`，只用内置的 robust 文本清理。
>
> 国内网络可在每条 pip 命令后加 `--index-url https://pypi.tuna.tsinghua.edu.cn/simple`。

### 3. 放 MOSS-TTS-Nano 源码

```powershell
# 有 git：
git clone https://github.com/OpenMOSS/MOSS-TTS-Nano.git "$tts\_src\MOSS-TTS-Nano-main"
# 没有 git：下载 https://codeload.github.com/OpenMOSS/MOSS-TTS-Nano/tar.gz/refs/heads/main
# 解压后把里面的 MOSS-TTS-Nano-main 放到 <ttsHome>\_src\ 下
```

### 4. 下载模型（首次运行时自动）

插件第一次合成时会自动从 HuggingFace 下载到 `<ttsHome>\_src\MOSS-TTS-Nano-main\models\`（约 0.7–1 GB）。

国内访问不了 HuggingFace 时，先设镜像再启动 DSH：

```powershell
setx HF_ENDPOINT https://hf-mirror.com
```

（也可以在启动 DSH 的终端里临时 `$env:HF_ENDPOINT='https://hf-mirror.com'`。）

### 5. 放入参考音色

把 5–15 秒的干净人声 wav 放进 `<ttsHome>\refs\`，例如 `refs\my-voice.wav`。文件名就是之后在设置页里看到的“音色名字”。

---

## 四、安装插件

1. 把整个 `dsh-feiyu-voice` 目录放到一个**固定位置**（例如 `C:\Users\<你>\Documents\dsh-feiyu-voice`）。
2. 在 DSH 里安装这个本地目录：

   - 让 agent 执行：`plugin_manager install_bundle`，target 填这个目录的**绝对路径**；
   - 或者命令行：`dsh plugin --profile <你的 profile> add file:<该目录的绝对路径>`。

3. **重启 DSH**（Host 与设置页都在启动时装载）。
4. 打开 **设置 → 小肥鱼语音**：
   - 「TTS 目录」填 `<ttsHome>`（留空则用 `~/.dsh/tts`）；
   - 「默认音色」从下拉里选一个（`refs` 下扫到的 wav），或直接填 wav 绝对路径；
   - 点「保存设置」；
   - 在「试听」里输入一句话，点「生成并试听」。

第一次点试听会先加载模型（20–60 秒），之后单句约 20–40 秒。

> 建议先试听确认音色，再在 QQ 场景使用。设置保存在 `~/.dsh/feiyu-voice.json`（优先级高于 bundle patch 里的 `config`）。

---

## 五、配置项

在 profile 的 `cordis.patch.yml` 里（也可以只在设置页改）：

```yaml
- id: feiyu-voice
  name: dsh-feiyu-voice
  config:
    ttsHome: 'C:\Users\你\.dsh\tts'   # 留空 → 环境变量 DSH_FEIYU_TTS_HOME → ~/.dsh/tts
    speakdUrl: 'http://127.0.0.1:18084'
    defaultRef: 'my-voice'            # refs 下的名字，或 wav 绝对路径；留空则每次必须传 ref
    autoStartDaemon: true             # 需要时自动拉起常驻服务
```

环境变量 `DSH_FEIYU_TTS_HOME` 可覆盖默认 ttsHome。

---

## 六、工具用法

```text
feiyu_voice_status()
→ 常驻服务状态、ttsHome、已发现的音色、依赖文件检查

feiyu_speak(text, ref?, maxFrames?)
→ 合成到 <ttsHome>\out\feiyu-*.wav，返回路径 / 时长 / 耗时

feiyu_send_voice(text, ref?, target?, group?, content?, msgId?)
→ 合成并发成 QQ 语音条，返回 message_id
```

`ref` 可以是 `refs` 目录里的名字（不带 `.wav`），也可以是 wav 的绝对路径。

---

## 七、QQ 语音（可选）

需要先装好 [`@tencent-connect/dsh-qqbot`](https://www.npmjs.com/package/@tencent-connect/dsh-qqbot)，并在 profile 的 `cordis.patch.yml` 里配好：

```yaml
- id: im-qqbot
  config:
    appId: '你的 AppID'
    appSecret: '你的 AppSecret'
    access:
      c2cAllow:
        - '你的 openid'     # 不指定 target 时默认发这里第一个
```

`scripts/qq-voice.py` 会自己从这个文件里读凭据（也可用 `QQBOT_APP_ID` / `QQBOT_APP_SECRET` 或 `--config` 覆盖），不会打印密钥。

---

## 八、常见问题

**Q：合成时弹出一个 python 黑窗口？**
插件在 Windows 上用 `venv\Scripts\pythonw.exe` 起常驻服务，正常不弹窗。只有当你把 `ttsHome` 指到一个**没有 pythonw.exe** 的环境时才会退回 `python.exe`。

**Q：第一次合成特别慢 / 卡在“加载模型”？**
模型加载 20–60 秒是正常的（取决于 CPU 与磁盘）。看 `<ttsHome>\speakd-spawn.log` 能看到进度和真实报错。

**Q：下载模型失败？**
设 `HF_ENDPOINT=https://hf-mirror.com` 再重启 DSH；或手动把模型放到 `_src\MOSS-TTS-Nano-main\models\` 下。

**Q：端口 18084 被占用？**
改 `speakdUrl`（比如 `http://127.0.0.1:18085`），插件拉起服务时会用同一个端口。

**Q：内存不够？**
在设置页点「停止」关掉常驻服务，或把 `autoStartDaemon` 设为 false。关掉后每次合成走冷启动（更慢但不常驻）。

**Q：合成成功但 QQ 发不出去？**
检查 `im-qqbot` 凭据、白名单里有没有你的 openid、是否触发了 QQ 主动消息额度（可以让 agent 传 `msgId` 走被动回复）。

**Q：能改音色吗？**
把新的 wav 放进 `refs/`，刷新设置页即可在下拉里看到；也可以直接传绝对路径。

---

## 九、卸载

1. 设置页点「停止」关掉常驻服务；
2. 在 DSH 里移除插件（`plugin_manager remove_bundle` 或 `dsh plugin remove dsh-feiyu-voice`）；
3. 如不再需要，删除 `<ttsHome>`（模型、venv、refs、out）与 `~/.dsh/feiyu-voice.json`。

---

## 十、许可与致谢

- 本插件代码：MIT。
- 语音模型 [MOSS-TTS-Nano](https://github.com/OpenMOSS/MOSS-TTS-Nano)：Apache-2.0，版权归 OpenMOSS 团队；模型权重需你自行下载，不随本包分发。
- 参考音色的版权与授权由使用者自行负责。
