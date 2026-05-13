# 🐝 Swarm — 多智能体 AI 编程助手

## 04. 请描述你使用 Agent 或 AI 驱动构建的具体成果

### 一、项目解决的核心痛点

在 AI 辅助编程落地过程中，我们发现三大核心痛点：

**1. 单 Agent 能力边界明显**
传统单一 LLM 代理同时承担"分析、编码、审查"多重角色，导致上下文频繁切换、输出质量不稳定。一个代理既要拆任务又要写代码，容易产生"边写边忘"的架构漂移问题。

**2. 长链任务缺乏可靠的验证闭环**
现有工具生成代码后缺乏系统性的 review 机制，代码能运行≠代码正确。生产环境中常见的安全隐患、边界条件遗漏、性能陷阱无法被及时发现。

**3. 并行效率与容错能力不足**
复杂任务需要多文件协作时，串行执行耗时过长；而模型侧偶发的云端超时/报错会直接中断整个工作流，缺乏自动恢复机制。

**Swarm 的解决方案**：
- **三角色分工**：Architect（架构师）负责拆解与规划，Coder（编码者）负责实现，Reviewer（审查者）负责验证，形成"规划→实现→审查→迭代"的完整闭环。
- **并行流水线**：依赖分析后自动并发调度多个 Coder+Reviewer 组合，子任务完成即释放资源，整体吞吐量提升 3-5 倍。
- **容错自愈**：LLM 调用层内置 5 次重试 + 10 秒退避策略，云端偶发抖动不再中断工作流。

---

### 二、核心逻辑流：长链推理 + 多 Agent 协作

Swarm 采用 **Plan-and-Execute + Actor-Critic** 架构，核心流程如下：

```
用户输入任务
    │
    ▼
┌─────────────────┐
│ 🧠 Architect    │  长链推理：先调查代码库，再推理依赖关系，
│  Leader/规划者   │  最后输出 JSON 任务图（含依赖拓扑）
└─────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ ⚡ 并行执行（Semaphore 控制并发数）       │
│                                         │
│  ┌─────────┐      ┌─────────┐          │
│  │ Coder A │ ──▶  │ReviewerA│          │
│  │         │◀────  │  [APPROVED]        │
│  └─────────┘      └─────────┘          │
│       │  NEEDS_WORK 时循环 3 轮          │
│  ┌─────────┐      ┌─────────┐          │
│  │ Coder B │ ──▶  │ReviewerB│          │
│  │         │◀────  │  [APPROVED]        │
│  └─────────┘      └─────────┘          │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────┐
│ 自动重规划      │  每完成一个子任务，Architect 重新评估剩余计划，
│ (Re-planning)   │  支持动态增删改子任务以适应实际进展
└─────────────────┘
    │
    ▼
┌─────────────────┐
│ 会话持久化      │  保存文件创建记录、任务目标、运行耗时
│ (Session)       │
└─────────────────┘
```

**长链推理（Long-chain Reasoning）**：
- Architect 不是一次性输出结果，而是先调用 `list_files` → `read_file` → `run_command` 调查代码库，再基于实际上下文进行链式推理，最终生成带依赖关系的 JSON 计划。
- Coder 在执行时保留完整对话历史，Reviewer 的反馈直接以 user message 形式回注到 Coder 的上下文中，实现**多轮长链迭代**。

**多 Agent 协作机制**：
1. **Architect 与 Coder 分离**：Architect 只读不写，Coder 只写不规划，避免角色混淆。
2. **Reviewer 与 Coder 对抗**：Reviewer 持有只读工具集，必须通过 `[STATUS: APPROVED]` 或 `[STATUS: NEEDS_WORK]` 给出明确裁决；Coder 在收到 NEEDS_WORK 后必须继续对话并修改代码。
3. **Researcher 工具化**：Architect 可随时调用 Researcher 进行网络搜索或代码库检索，Researcher 作为子 Agent 独立完成后返回结构化报告。

---

### 三、技术栈与工程优化

| 模块 | 技术选型 | 关键优化 |
|------|---------|---------|
| 运行时 | Node.js 18+ + TypeScript ESM | 模块化、类型安全 |
| LLM 接口 | Ollama（兼容 OpenAI API） | 支持本地 + 云端模型无缝切换 |
| 并发控制 | Semaphore | 可配置 maxConcurrentAgents |
| 上下文压缩 | 自动摘要中间轮次 | 超过 32 条消息时自动压缩，保留头尾、摘要中部 |
| 工具缓存 | Map 缓存只读工具结果 | `read_file` / `list_files` / `web_search` 同参数直接命中缓存 |
| 超时保护 | AbortController + 进程组 kill | HTTP 流 60 秒 idle 超时；shell 命令超时后杀整个进程树 |
| 输出格式 | Ollama JSON mode | Architect 的计划响应强制 JSON 格式，解析成功率大幅提升 |

---

### 四、Benchmark 评测结果

我们在两个业界标准 Benchmark 上验证了 Swarm 的端到端能力：

#### 1. HumanEval — 函数级代码生成
- **模型**：`gpt-oss:20b-cloud`（通过 Ollama 云端接入）
- **结果**：**95% pass@1**
- 在 164 个标准编程任务中，Swarm 的多 Agent 协作模式（Coder 实现 + Reviewer 审查 + 自动重试）将模型潜力充分释放，远超单轮 prompt 基线。

#### 2. SWE-Bench Verified — 真实 GitHub Issue 修复
- 数据集：500 个人工验证的 Python 开源项目 Issue
- 模式：Agent 阅读 Issue → 探索代码库 → 生成 Git patch → 通过测试套件
- Swarm 的 Architect 先规划修复路径，Coder 再针对性修改，Reviewer 运行测试验证，形成端到端可落地的自动修复流水线。

---

### 五、使用方式

```bash
# 从 npm 全局安装
npm install -g @harrybob/swarm-cli

# 初始化项目配置
swarm init

# 执行一个任务（自动规划、编码、审查）
swarm run "创建一个带 JWT 认证的 Python REST API"

# 基于上次运行结果修复 Bug
swarm fix "登录接口返回 500 错误"

# 交互模式
swarm chat
```

---

### 六、开源信息

- **npm 包**：`@harrybob/swarm-cli`
- **GitHub**：https://github.com/harry-bob/harrybob-swarm
- **License**：MIT
