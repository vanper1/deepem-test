# 创建虚拟环境并快速启动（USRP 新接口适配版）

```bash
# 1) 进入项目目录
cd /home/deepem/DeepEM_main2
source .venv/bin/activate
export DEEPEM_LLM_API_KEY="null"
export DEEPEM_LLM_BASE_URL="http://localhost:6000/v1"
export DEEPEM_LLM_MODEL="qwen36_35B_A3B"
export DEEPEM_USRP_BASE_URL="http://127.0.0.1:8901"
python -m uvicorn main.server:app --host 0.0.0.0 --port 8146


cd /home/deepem/DeepEM_main

# 2) 创建并激活虚拟环境
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip

# 3) 安装平台依赖
pip install -e .

# 4) 配置主平台与 USRP 采集服务
export DEEPEM_LLM_API_KEY="null"
export DEEPEM_LLM_BASE_URL="http://localhost:8000/v1"
export DEEPEM_LLM_MODEL="qwen36_35B_A3B"
export DEEPEM_USRP_BASE_URL="http://10.112.210.4:8100"
# 如浏览器访问平台时需要显式指定 WebSocket 地址，可设置；默认会由 HTTP 地址自动换算成 ws://...
export DEEPEM_USRP_WS_BASE_URL="ws://10.112.210.4:8100"
export DEEPEM_USRP_DEVICE_ID="usrp-30B1FDE"
export DEEPEM_USRP_FREQ="2400000000"
export DEEPEM_USRP_SAMPLE_RATE="1000000"
export DEEPEM_USRP_BANDWIDTH="1000000"
export DEEPEM_USRP_GAIN="40"
export DEEPEM_USRP_SLICE_DURATION="1"
export DEEPEM_USRP_STEP_DURATION="3"
export DEEPEM_USRP_ANTENNA="RX2"

# 5) 启动平台
python -m uvicorn main.server:app --host 0.0.0.0 --port 8141 --reload
```

浏览器打开：

```text
http://服务器IP:8141/console
```

设备侧 USRP 采集服务仍按采集端文档启动：

```bash
ssh ue@10.112.210.4
cd /home/ue/DeepEM
./start_usrp_service.sh
tail -f /tmp/usrp_service.log
```

## 本版按最新 USRP 采集服务 API 完成的适配

平台已按 `USRP采集服务API说明文档.md` 适配当前部署在 `10.112.210.4:8100` 的新接口：

| 新接口 | 平台适配位置 | 行为 |
|---|---|---|
| `POST /api/usrp/scan` | 设备管理“扫描设备”、启动前自动选设备、智能体工具 `scan_usrp_devices` | 读取真实设备表、能力范围、`scan_error`、`found_count`，并写入平台状态。 |
| `GET /api/usrp/devices` | `/api/devices/status`、智能体工具 `list_usrp_devices`、任务推断工具 `query_usrp_task` | 不触碰硬件地刷新/查询 `OFFLINE/IDLE/BUSY/ERROR`、`current_config`、`task_id`。 |
| `POST /api/usrp/configure` | 设备参数保存、每个采集 step 启动前 | 按新文档先校验并保存 `dev_id/freq/sample_rate/bandwidth/gain/slice_duration/duration/antenna`；`start` 仍会再次提交完整参数。 |
| `POST /api/usrp/start` | 平台“启动采集” | 生成唯一 `task_id`，提交新接口要求的完整参数；已移除旧版 `channel` 字段，`channel` 只保留为平台分析标签。 |
| `POST /api/usrp/{dev_id}/stop` | 平台“停止采集” | 发送 `{task_id}` 异步停止信号，并继续依赖设备状态/完成回调确认最终结束。 |
| `WebSocket /api/usrp/{dev_id}/stream` | 控制台频谱/瀑布图 | 采集启动后浏览器自动连接 USRP WebSocket，消费 `status` 与约 100ms 一帧的 1024 点 `fft` 实时频谱。 |
| `POST /api/collector/upload` | 平台回调 `/api/collector/upload` | 接收采集服务上传的 `.npz` 分片，解析 `iq/freq/sample_rate/bandwidth/gain/slice_index/slice_duration/timestamp`，生成时频图、观测和证据。 |
| `POST /api/collector/session-complete` | 平台回调 `/api/collector/session-complete` | 处理 `completed/stopped/failed`，多频点计划只在 `completed` 且仍有下一 step 时继续。 |

## 依照新接口，平台新增/增强的能力

1. **真实设备能力驱动参数校验**：扫描后展示 `freq_range`、`sample_rate_range`、`bandwidth_range`、`gain_range` 和 `rx_antennas`，保存参数时直接调用 `configure` 做服务端校验。
2. **严格兼容新启动模型**：`configure` 只负责校验/保存，`start` 会按新文档再次提交完整参数；平台不再向 USRP 服务发送旧版 `channel` 字段。
3. **设备状态闭环**：启动前必须扫描并选择 `IDLE` 设备；`BUSY/OFFLINE/ERROR` 会阻止新任务，避免复用被占用设备。
4. **实时 FFT 可视化**：控制台采集期间直接消费 WebSocket 的 1024 点 FFT 数据，实时刷新频谱曲线和瀑布图；上传分片到达后仍会落证据、生成结构化观测。
5. **异步停止与完成回调兼容**：`stop` 仅视为停止信号；平台会处理随后到来的短切片和 `stopped` 完成通知，不再误触发后续频点。
6. **任务查询按新 API 降级兼容**：由于新文档没有 `/api/usrp/tasks/{task_id}`，智能体工具改为从 `/api/usrp/devices` 推断运行中任务，历史结果以平台上传文件和完成回调为准。
7. **多频点计划仍可用**：每个 step 独立 `configure -> start -> upload -> session-complete`，确保每个频点都使用新 API 完整生命周期。

---

# 快速启动
```bash
tmux new -s deepem
cd /home/deepem/DeepEM_main
source .myenv/bin/activate
export DEEPEM_LLM_API_KEY="null"
export DEEPEM_LLM_BASE_URL="http://localhost:8000/v1"
export DEEPEM_LLM_MODEL="qwen36_35B_A3B"
python -m uvicorn main.server:app --host 0.0.0.0 --port 8141 --reload
```
# 可选变量
```bash
export DEEPEM_ES_URL="https://localhost:9200"
export DEEPEM_ES_USERNAME="elastic"
export DEEPEM_ES_PASSWORD="work4deepem"
export DEEPEM_ES_INDEX="deepem_knowledge"
```
# vllm启动模型
```bash

cd /home/deepem/LLMs && /home/deepem/LLMs/.venv/bin/python3 .venv/bin/vllm serve Qwen3.6-35B-A3B-FP8 --served-model-name qwen36_35B_A3B --trust-remote-code --host 0.0.0.0 --port 8000 --max-model-len 32768 --gpu-memory-utilization 0.6 --limit-mm-per-prompt '{"image": 4}' --max-num-seqs 1 --max-num-batched-tokens 32768 --moe-backend triton --enforce-eager --enable-auto-tool-choice --tool-call-parser qwen3_xml --reasoning-parser qwen3 --reasoning-config '{"reasoning_start_str": "<think>", "reasoning_end_str": "I have to give the final answer.</think>"}' --speculative-config '{"method":"dflash","model":"/home/deepem/LLMs/Qwen3.6-35B-A3B-DFlash","num_speculative_tokens":15}' --attention-backend flash_attn

cd /home/deepem/LLMs && /home/deepem/LLMs/.venv/bin/python3 .venv/bin/vllm serve Qwen3.6-35B-A3B-FP8 --served-model-name qwen36_35B_A3B --trust-remote-code --host 0.0.0.0 --port 8000 --max-model-len 32768 --gpu-memory-utilization 0.6 --limit-mm-per-prompt '{"image": 4}' --max-num-seqs 1 --max-num-batched-tokens 32768 --moe-backend triton --enforce-eager --enable-auto-tool-choice --tool-call-parser qwen3_xml --reasoning-parser qwen3 --reasoning-config '{"reasoning_start_str": "<think>", "reasoning_end_str": "我需要做最终回答.</think>"}'  --attention-backend flash_attn

cd /home/deepem/LLMs && vllm serve /home/deepem/LLMs/Qwen3.6-35B-A3B-FP8 --served-model-name qwen36_35B_A3B --trust-remote-code --host 0.0.0.0 --port 8000 --max-model-len 32768 --gpu-memory-utilization 0.6 --limit-mm-per-prompt '{"image": 4}' --max-num-seqs 1 --max-num-batched-tokens 32768 --moe-backend triton --enforce-eager --enable-auto-tool-choice --tool-call-parser qwen3_xml --reasoning-parser qwen3 --reasoning-config '{"reasoning_start_str": "", "reasoning_end_str": "思考预算用尽，下面我需要做最终回答."}' --speculative-config '{"method":"dflash","model":"/home/deepem/LLMs/Qwen3.6-35B-A3B-DFlash","num_speculative_tokens":15}' --attention-backend flash_attn


```
# 不能再加 `--language-model-only`，否则图片输入会被彻底关闭。
# 查看日志：tail -f vllm.log 
# 创建tmux new -s vllm
# 查看vllm终端日志，连接 tmux attach -t vllm
# sudo systemctl start myplatform 启动平台
# journalctl -u myplatform -f 查看平台日志
# sudo systemctl stop myplatform 终止平台


# 代码框架简介
DeepEM_main/
├── README.md                 # 快速启动说明
├── pyproject.toml            # Python 项目依赖配置
├── .env                      # 环境变量配置
├── data/
│   └── nl2sql_demo.db        # 查表示例数据库
├── deepem/
│   └── __init__.py           # 包占位
├── main/
│   ├── server.py             # FastAPI 服务入口
│   ├── app.py                # 应用入口
│   ├── nl2sql_config.py      # 查表配置
│   ├── agent/                # LLM Agent层
│   ├── control/              # 任务、事件、聊天服务层
│   ├── demo/                 # 业务逻辑层
│   ├── devices/              # 设备层（USRP 接入与设备能力查询）
│   ├── protocol/             # 基础数据模型定义
│   ├── realtime/             # 实时信号处理
│   ├── runtime/              # Agent 运行层
│   ├── state/                # 存储层
│   ├── tools/                # 工具系统，含 NL2SQL 等工具
│   └── web/                  # 前端页面与静态资源
└── eval/
    ├── generate_pred_sql.py  # Spider/NL2SQL 预测生成脚本
    └── eval_spider_nl2sql.py # NL2SQL 评测脚本

## 功能简介

目前平台包含真实 USRP 采集接入、研判智能体和问答智能体，用于支撑异常无线信号的自动采集、证据落库、复核研判与任务查询。

### 研判智能体

研判智能体面向异常信号的自动化分析流程。平台点击启动采集后会按 USRP 扫频计划调用设备平台，采集端回传 `.npz` 分片后，主平台会完成信号解析、特征提取、时频图生成、证据元信息落库和异常判定。对于可疑信号，研判智能体会结合场所基线、USRP 任务状态、近期观测记录和工具调用结果，对信号进行复核分析，判断其异常程度、可能原因和处置优先级，并生成或更新异常 Case，辅助操作员完成研判闭环。

### 问答智能体

问答智能体面向操作员的人机交互与任务查询。操作员可以通过聊天界面使用自然语言查询当前采集状态、历史信号、异常 Case、观测记录和分析结果。系统还集成 NL2SQL 能力，支持基于默认或上传的 SQLite 数据库进行只读查询，将自然语言问题转换为 SQL 并返回结构化结果。


#启动 ES
sudo systemctl daemon-reload
sudo systemctl enable elasticsearch.service
sudo systemctl start elasticsearch.service

#查看状态
sudo systemctl status elasticsearch.service
## 代码生成型自主 USRP 采集智能体扩展（WebSocket FFT 版）

本版本新增了面向复杂频谱采集任务的代码生成型自主智能体能力。聊天智能体在面对“全频段扫描、多频点、多次重复取平均、保存结果、异常细扫”等任务时，可以调用 `run_autonomous_usrp_task` 完成端到端流程。

当前版本的关键变化：**自主采集代码不再读取 USRP 采集端生成的 `slice_*.npz` 文件**。主平台暂时无法接收远端任务文件时，智能体会直接通过 USRP WebSocket `/api/usrp/{dev_id}/stream` 接收平台返回的 `fft_data`，并基于这些实时 FFT 帧完成频谱平均、汇总和结果保存。

端到端流程：

1. 从内置 Markdown 知识库 `main/knowledge/usrp_api.md` 检索 USRP API 约束，重点包括 `start`、`devices` 和 WebSocket FFT；
2. 根据用户自然语言任务生成结构化采集计划；
3. 自主生成 `def run_task(ctx):` Python 采集函数；
4. 对生成代码进行 AST 静态安全检查；
5. 通过受控 `SafeUsrpRuntime` SDK 执行采集，不允许生成代码直接访问 `requests`、`os`、`subprocess` 等危险能力；
6. 执行 `scan -> WebSocket 连接 -> start/configure -> 接收 fft_data -> wait_until_idle -> 多次平均 -> save_npz`；
7. 在聊天前端展示知识检索、生成代码、安全校验、WebSocket FFT 帧接收进度和最终结果。

### 新增工具

- `retrieve_usrp_api_knowledge`：检索内置 USRP API Markdown 知识库。
- `generate_usrp_task_code`：生成并校验 `run_task(ctx)` 采集函数。
- `execute_usrp_task_code`：执行指定生成代码。
- `run_autonomous_usrp_task`：端到端自主完成“知识检索 + 代码生成 + 安全检查 + WebSocket FFT 执行采集”。

### 关键环境变量

- `DEEPEM_USRP_BASE_URL`：USRP 采集服务 HTTP 地址，默认 `http://10.112.210.4:8100`。
- `DEEPEM_USRP_WS_BASE_URL`：USRP 采集服务 WebSocket 地址；不配置时会由 HTTP 地址自动换算为 `ws://...`。
- `DEEPEM_USRP_DEVICE_ID`：默认设备 ID，默认 `usrp-30B1FDE`。
- `DEEPEM_USRP_SAMPLE_RATE`：默认采样率，默认 `1000000`。
- `DEEPEM_USRP_BANDWIDTH`：默认接收带宽，默认 `1000000`。
- `DEEPEM_USRP_GAIN`：默认增益，默认 `40`。
- `DEEPEM_USRP_ANTENNA`：默认天线，默认 `RX2`。
- `DEEPEM_AUTONOMOUS_USRP_EXPECTED_FFT_FRAMES`：每次采集期望接收的 WebSocket FFT 帧数，默认 `1`。100 ms 驻留时间通常先取 1 帧。
- `DEEPEM_AUTONOMOUS_USRP_FRAME_TIMEOUT_SEC`：等待单帧 FFT 的超时时间，默认 `1.5` 秒。
- `DEEPEM_AUTONOMOUS_USRP_MAX_FREQS`：限制单次自主任务最大频点数，默认 `500`。

### 示例聊天指令

```text
请通过代码生成型自主智能体采集 A101 会议室背景频谱：70 MHz 到 6 GHz，步长 50 MHz，每个频点 100 ms，重复 3 次取平均，直接使用 USRP 平台返回的 FFT 数据完成采集并保存结果。
```

前端会展示：结构化采集计划、智能体生成的 Python 函数、代码安全检查结果、各频点 WebSocket FFT 接收进度和最终输出文件路径。


## 采集智能体（真实 LLM 自由规划执行）

本版本新增独立页面 `http://127.0.0.1:8000/capture-agent`，并在“智能检测执行/实时检测控制台”顶部加入“采集智能体”入口。

采集智能体不使用预先定义的统一执行模板。创建任务时会调用已配置的真实 OpenAI-compatible LLM：

1. LLM 阅读一个或多个 `.docx` 模板与用户自然语言指令，生成结构化意图、参数来源、假设、风险与待确认项。采集智能体不再提供或回填任何默认采集参数：用户明确参数优先于模板参数，模板参数优先于意图设计；只有用户和模板均未指定的字段才由 LLM 根据当前任务意图设计。
2. LLM 针对当前任务从零生成自由 DAG。节点可以是 LLM 分析、决策、验证节点，也可以是真实工具节点；同一工具可在多个阶段重复使用。
3. 后端校验 JSON Schema、真实工具引用、工具参数字段、依赖 DAG、资源边界和计划指纹，但不会补入设备扫描、配置、代码生成、采集、验证或保存等统一流程节点。
4. 根节点统一绑定人工审批门禁。审批后状态机严格按锁定依赖执行；任何节点、工具、参数或采集范围篡改都会使指纹失效。
5. 每个工具节点可提交不同子频段、步长、次数等子计划，但只能缩小或降低已批准的总体采集资源，不能扩大范围或增加资源消耗。

### LLM 配置要求

采集智能体不允许回退到 `LocalWorkflowLLMClient`、规则式计划器或固定采集代码模板。必须配置真实模型：

```bash
DEEPEM_LLM_API_KEY=your-api-key
DEEPEM_LLM_BASE_URL=https://your-openai-compatible-endpoint/v1
DEEPEM_LLM_MODEL=your-model-name
```

未配置真实 LLM 时，`/api/capture-agent/runtime` 返回不可用状态，前端禁止创建任务，后端返回明确的 `503` 错误。

### 主要能力

- 上传并解析一个或多个 `.docx` 采集模板（不支持旧式 `.doc`）。
- 不同指令可以生成完全不同的节点数量、节点语义、依赖结构和工具调用序列。
- 支持纯分析任务、单阶段采集、多阶段粗扫/精扫、重复工具调用及基于前序输出的决策节点。
- 工具参数支持 `${task.id}`、`${task.instruction}`、`${constraints.<key>}`、`${nodes.<node_id>.outputs.<path>}` 和 `${runtime.autonomous_task_plan}` 占位符。
- 模型 JSON 输出失败时允许一次受约束修复；仍不合法则任务失败，不使用本地固定计划兜底。
- 计划生成后进入人工批准门禁；批准前不访问真实 USRP 设备。
- 计划结构、工具名称、工具参数、规范化约束和完成契约计算 SHA-256 指纹。
- 节点失败按模型计划中的 `max_attempts` 重试，达到上限后暂停并允许追加指令生成新计划版本。
- SSE 实时展示 LLM 规划、节点执行、工具进度和审计事件，断线后可续传。
- 左侧展示动态任务节点，右侧展示选中节点的输入、输出、工具调用、日志、证据和人工备注。
- 真实设备任务采用互斥策略。

### 统一输出目录

每个任务的自主采集产物统一写入：

```text
main/data/autonomous_usrp/<capture_agent_task_id>/
```

目录内包括最终 NPZ、`generated_task.py`、`task_plan.json`、`execution_result.json`、`execution_logs.jsonl` 以及任务审计 JSON/Markdown。NPZ 不再写到 `main/data/autonomous_usrp/` 根目录。

### 使用步骤

1. 配置真实 LLM 环境变量并启动 DeepEM。
2. 打开 `/capture-agent`，确认顶部显示真实规划模型和 endpoint。
3. 上传 `.docx` 模板（可选）。
4. 输入任务，例如“先粗扫 100MHz 至 1GHz，再根据峰值选择两个子频段精扫”。
5. 检查 LLM 自由生成的任务专属 DAG、工具参数和计划指纹，点击“批准并执行”。
6. 在左侧选择节点，在右侧查看实时过程和产物。


## 采集智能体优化版

本版本已增强 LLM 计划占位符预检与运行时解析、实时 reasoning 流、真实设备安全边界和简洁前端。详细变更与验证结果见 `OPTIMIZATION_NOTES.md`。首次运行请复制 `.env.example` 为 `.env` 并填写实际配置。
