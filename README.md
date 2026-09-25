# 艺术元素分市场治理（事件溯源）

在"艺术元素时代化审校"事件约定之上，提供**按市场（司法地域）判定同一素材能否使用**的治理能力。
所有结论都从只追加的事件流重放得到：不删历史、可复原任何时间点、变化可归因到具体事件。

资料只包含领域约定与虚构样例，不包含真实个人信息、生产连接或外部账号。

## 要解决的问题

一款采用传统纹样的包装已通过总部评审，却在海外上市前被当地顾问指出禁用场景；法务随后更新了
权利期限，研究员又提交了新的来源证据。团队需要回答：**哪些市场、哪些载体必须暂停？**

本模型的回答方式：

- 元素的**来源(source)、改绘(redraw)、解释文案(copy)、载体(carrier)**四线各自版本化演进；
- 评审意见限定**专业范围(discipline)与司法地域(jurisdiction)**；
- **权利期限、署名要求、禁用用途**按市场分别设定并参与实际判定；
- 每个发布包(PACKAGE_COMPOSED)固化它使用的四个版本与**批准链**；
- 因此同一素材在不同市场可同时处于 **ALLOWED / PENDING_EVIDENCE / PROHIBITED**。

## 判定规则（src/governance.js）

`evaluatePackage(state, pkg, at)` 对单个发布包在某时刻给出结论：

| 理由码 | 含义 |
| --- | --- |
| `RIGHTS_NOT_GRANTED` / `RIGHTS_NOT_YET_STARTED` | 该市场未设权利 / 授权未生效 |
| `RIGHTS_TERM_EXPIRED` | 权利期限届满（法务更新后重算，引用设定期限的事件） |
| `RIGHTS_WITHDRAWN` | 撤权 |
| `ATTRIBUTION_MISSING` | 要求署名但绑定的文案版本未含署名 |
| `PROHIBITED_USE_MATCH` | 载体用途标签命中该市场禁用条件 |
| `EVIDENCE_MISSING / PENDING / REJECTED` | 市场证据政策要求的证据缺失、待裁定、被驳回 |
| `VERSION_SUSPENDED` | 绑定版本已停用或不存在 |
| `OPINION_PROHIBITION` / `OPINION_CONCERN` | 该地域该专业意见禁止 / 存疑 |
| `APPROVAL_CHAIN_INCOMPLETE` / `APPROVAL_BASED_ON_STALE_VERSION` | 批准链缺专业 / 批准基于旧版本 |
| `PACKAGE_SUSPENDED` / `PACKAGE_HALTED` / `REWORK_OVERDUE` | 暂停 / 紧急停用 / 补审逾期 |
| `RECALL_OPEN` | 已交付内容处于召回或更正流程 |

任一硬阻断 → `PROHIBITED`；否则有待补项 → `PENDING_EVIDENCE`；否则 `ALLOWED`。

- **基于旧版本的禁止意见不直接阻断新包**，降级为待复审（`OPINION_CONCERN`），必须复审当前版本。
- 评审意见按"评审人 + 专业 + 地域"归并，**同一顾问更新结论以最新意见为准**。

## 生命周期（src/lifecycle.js）

变化先落事件，再由 `impactedPackages` 计算受影响范围并自动处置：

- **新证据 / 撤权 / 期限更新 / 当地意见只作用于受影响市场**；版本停用跨市场命中所有绑定该版本的包。
- 结论恶化为 `PROHIBITED`（已交付包恶化为 `PENDING_EVIDENCE` 同此）才暂停；未受影响的包不产生暂停事件。
- **已交付内容不消失**：暂停已交付包时开 `RECALL_OPENED`（撤回类=召回 `RECALL`，证据类=更正 `CORRECTION`），
  流程走完由 `RECALL_CLOSED` 留痕，期间继续阻断发布。
- 同一原因对同一包只开一次召回，进行中的召回不重复开启。
- `NOTIFICATION_DELIVERED` 按 `notification_id` 幂等：**重复通知不会再次触发召回**。
- `EMERGENCY_HALT` 允许先停用，但必须随存**补审责任人 `rework_owner` 与期限 `rework_due_at`**；
  补审 `HALT_REWORK_RULED(APPROVED)` 才能解除停用，逾期产生 `REWORK_OVERDUE`，驳回则维持停用。
- 并行审校基于旧版本：批准发 `REVIEW_STALENESS_FLAGGED` 并在判定层硬阻断，提示码 `PARALLEL_REVIEW_STALE`。

## 对外接口

- **发布预检**（src/precheck.js）：`precheck(events, packageId, at)` 返回
  `deliverable`、结论与**具体阻断理由**（人话消息 + 结构化细节 + 依据事件号），
  以及发布快照（绑定版本、权利依据、批准/版本事件号）；`renderPrecheck` 生成可贴工单的文本。
- **审计**（src/audit.js）：
  - `reconstructAt(events, packageId, at)` 按过去时间点复原"当时为何获准/被拦"：当时生效的权利、
    采信的证据、批准链、停用与召回状态；
  - `explainChange(events, packageId, fromAt, toAt)` 给出结论转折点，指出**哪次事件改变了结论**
    及新增/消除的阻断理由（按事件前缀重放，同刻多事件也能精确归因）。

## 目录

- `src/art_motif_review.js`：事件种类、理由码与信封/payload 校验（兼容基线事件）。
- `src/event_store.js`：只追加存储、event_id 去重、乐观并发(`expectedSeq`)、通知幂等。
- `src/projection.js`：事件 → 状态的纯函数折叠，支持 `as_of` 时间点。
- `src/governance.js`：分市场判定、受影响包分析、跨市场概览。
- `src/lifecycle.js`：命令服务（暂停/恢复/紧急停用/补审/召回/通知）。
- `src/precheck.js` / `src/audit.js`：发布预检接口与时间点审计。
- `data/sample.json`：虚构事件样例；`tests/`：契约与场景测试。

## 本地核对

```bash
npm run build
npm test
```
