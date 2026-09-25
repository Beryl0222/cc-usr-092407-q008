# 艺术元素时代化审校

本项目用于整理艺术元素时代化审校领域中的事件名称、交换字段与脱敏样例，方便业务、运营和研发人员在同一套术语下讨论后续服务。资料只包含领域约定，不包含真实个人信息、生产连接或外部账号。

在基线事件约定之上，本项目提供**分市场治理能力**：同一素材在不同市场可以同时处于允许、待补证或禁止，团队可以据此判断哪些市场和载体必须暂停。

## 治理能力概览

- **四条独立版本链**：元素来源（provenance）、改绘（adaptation）、解释文案（copy）、载体（carrier）各自演进，互不同步。
- **评审意见有作用域**：每条意见限定专业范围（`discipline`）与司法地域（`jurisdiction`），并记录所基于的版本（`base_versions`）；基于旧版本的并行审校在受理时即提示冲突。
- **权利条件参与判定**：权利期限（`valid_until`）、署名要求（`attribution_required`）、禁用条件（市场 × 载体类型 × 场景）与撤权通知直接决定发布结论。
- **发布包钉住版本与批准链**：每个发布包保存其使用的四个版本与批准链，作为后续判定与审计的基准。
- **受影响才暂停**：新来源证据、撤权、版本停用只暂停结论因此变化的发布；已交付内容进入可追踪的召回（recall）或更正（correction），不作删除。
- **紧急停用**：允许先停用，但补审责任与期限（`follow_up.owner` / `follow_up.due_at`）必须随决定保存，否则事件不予受理。
- **通知幂等**：重复通知（同一 `notice_id`）不会再次触发召回；重复事件 ID 直接幂等忽略。
- **预检与审计**：发布人员通过预检接口获得具体阻断理由；审计人员可按过去时间点复原当时为何获准，以及哪次事件改变了结论。

## 事件目录

所有事件共享最小字段：`event_id`、`kind`、`occurred_at`、`subject_id`、`payload`。

| kind | subject_id | 关键 payload | 用途 |
| --- | --- | --- | --- |
| `MOTIF_PROPOSED` | 素材 | `title` | 登记艺术元素 |
| `PROVENANCE_RECORDED` | 素材 | `version`、`source_claim`、`evidence_refs`、`recorded_by`、`contradicts_versions?` | 来源版本；新证据可声明与旧版本冲突 |
| `ADAPTATION_RECORDED` | 素材 | `version`、`changes_summary` | 改绘版本 |
| `COPY_RECORDED` | 素材 | `version`、`locale`、`text_ref` | 解释文案版本 |
| `CARRIER_RECORDED` | 载体 | `version`、`carrier_type` | 载体版本 |
| `REVIEW_OPINION_ADDED` | 素材 | `opinion_id`、`discipline`、`jurisdiction`、`decision`(approve/conditional/reject)、`base_versions` | 限定专业与地域的评审意见 |
| `RIGHTS_CONDITION_SET` | 素材 | `holder`、`valid_from`、`valid_until`、`attribution_required`、`prohibitions[]` | 权利期限、署名与禁用条件；后设者覆盖先设者 |
| `RIGHTS_REVOKED` | 素材 | `notice_id`、`markets`、`effective_from`、`reason` | 按市场撤权 |
| `RELEASE_PACKAGE_APPROVED` | 发布包 | `motif_id`、`market`、`carrier_id`、`scene?`、`pinned_versions`、`approval_chain`、`attribution_included` | 建立发布包并钉住版本与批准链 |
| `RELEASE_PACKAGE_DELIVERED` | 发布包 | `channel` | 标记已交付（此后阻断将进入召回/更正） |
| `RELEASE_SUSPENDED` | 发布包 | `reason`、`emergency`、`follow_up?` | 停用；紧急时必须携带补审责任与期限 |
| `RELEASE_REINSTATED` | 发布包 | `reason` | 补审通过后恢复 |
| `VERSION_SUSPENDED` | 素材或载体 | `entity`、`version`、`reason` | 停用某条版本链上的具体版本 |
| `RECALL_OPENED` | 发布包 | `notice_id`、`mode`(recall/correction)、`reason` | 手工开立召回/更正 |
| `RECALL_UPDATED` | 发布包 | `notice_id`、`status`(acknowledged/in_progress/completed) | 更新召回/更正进度 |

## 判定规则

`evaluate` 按以下顺序汇总阻断理由，结论取最高严重级：`PROHIBITED` > `PENDING_EVIDENCE` > `ALLOWED`。

| 理由代码 | 级别 | 含义 |
| --- | --- | --- |
| `RIGHTS_MISSING` | 待补证 | 缺少权利条件记录 |
| `RIGHTS_EXPIRED` | 禁止 | 权利期限届满 |
| `RIGHTS_REVOKED` | 禁止 | 权利被撤回（按市场生效） |
| `ATTRIBUTION_MISSING` | 禁止 | 要求署名而发布包未署名 |
| `PROHIBITION_MATCHED` | 禁止 | 命中禁用条件（市场/载体/场景） |
| `VERSION_SUSPENDED` | 禁止 | 钉住的版本已停用 |
| `NEW_EVIDENCE_PENDING` | 待补证 | 新来源证据与钉住版本冲突 |
| `EMERGENCY_SUSPENDED` / `RELEASE_SUSPENDED` | 禁止 | 发布被停用（紧急停用附补审责任与期限） |
| `REVIEW_MISSING` / `REVIEW_STALE` | 待补证 | 缺少所需专业/地域意见，或意见基于旧版本 |
| `REVIEW_REJECTED` | 禁止 | 作用域内最新有效意见为否决 |

## 领域服务 API

`src/governance.js` 导出 `createGovernanceService({ requiredDisciplines? })`（默认 `["cultural", "legal"]`）：

- `ingest(event)` → 校验并受理事件；返回 `{ ok, problems?, duplicate?, effects: { conflicts, remediations_opened, notice_duplicate, warnings } }`。
- `precheck(packageId, { at? })` → 发布预检：`decision`、具体 `blocking_reasons`（代码 + 中文说明 + 细节）、`advisories`、批准链相关的版本 `conflicts`、在办 `open_remediations`。
- `explainAt(packageId, at?)` → 复原某时间点的结论及其依据（批准链、适用意见、权利条件、钉住版本）。
- `auditTrail(packageId)` → 结论变化轨迹：每次变化对应的事件 ID 与前后结论。
- `remediations(filter?)` / `conflicts()` / `eventLog()` → 召回更正台账、版本冲突清单、事件流。

“当前时间”默认为已见事件的最大 `occurred_at`，判定可完整重放，不依赖墙钟。

## 目录

- `src/art_motif_review.js`：事件种类、字段与 payload 校验。
- `src/governance.js`：分市场治理领域服务。
- `data/sample.json`：用于核对资料格式的虚构事件。
- `data/sample_stream.json`：虚构事件流——总部过审后，当地顾问否决、法务更新权利期限、研究员提交新证据的完整演绎。
- `tests/`：契约校验与治理行为测试。

## 本地核对

```bash
npm run build
npm test
```
