// art_motif_review 领域事件约定。
//
// 素材的四条线各自独立演进：来源(source)、改绘(redraw)、解释文案(copy)、载体(carrier)。
// 评审意见限定专业范围(discipline)与司法地域(jurisdiction)；
// 权利按市场（司法地域）分别设定期限、署名与禁用条件；
// 发布包(package)固化它使用的四个版本与批准链，因此同一素材在不同市场可以同时
// 处于允许(ALLOWED)、待补证(PENDING_EVIDENCE)或禁止(PROHIBITED)。

export const ELEMENT_LINES = Object.freeze(["source", "redraw", "copy", "carrier"]);

// 发布预检结论。
export const DECISIONS = Object.freeze({
  ALLOWED: "ALLOWED",
  PENDING_EVIDENCE: "PENDING_EVIDENCE",
  PROHIBITED: "PROHIBITED",
});

// 阻断 / 提示理由码，发布人员在预检接口中直接看到。
export const REASON_CODES = Object.freeze({
  RIGHTS_NOT_GRANTED: "RIGHTS_NOT_GRANTED", // 该司法地域从未设定权利条件
  RIGHTS_NOT_YET_STARTED: "RIGHTS_NOT_YET_STARTED", // 授权尚未生效
  RIGHTS_TERM_EXPIRED: "RIGHTS_TERM_EXPIRED", // 权利期限届满（法务更新后重算）
  RIGHTS_WITHDRAWN: "RIGHTS_WITHDRAWN", // 撤权
  ATTRIBUTION_MISSING: "ATTRIBUTION_MISSING", // 要求署名但文案版本未含署名
  PROHIBITED_USE_MATCH: "PROHIBITED_USE_MATCH", // 载体用途命中禁用条件
  EVIDENCE_MISSING: "EVIDENCE_MISSING", // 市场政策要求的证据线尚无证据
  EVIDENCE_PENDING: "EVIDENCE_PENDING", // 新证据已提交等待裁定 / 原证据被挑战
  EVIDENCE_REJECTED: "EVIDENCE_REJECTED", // 证据被裁定不采信
  VERSION_SUSPENDED: "VERSION_SUSPENDED", // 绑定版本已被停用
  OPINION_PROHIBITION: "OPINION_PROHIBITION", // 该地域该专业意见明确禁止
  OPINION_CONCERN: "OPINION_CONCERN", // 该地域专业意见提出疑虑，待补证
  APPROVAL_CHAIN_INCOMPLETE: "APPROVAL_CHAIN_INCOMPLETE", // 批准链缺少必要专业
  APPROVAL_BASED_ON_STALE_VERSION: "APPROVAL_BASED_ON_STALE_VERSION", // 批准基于旧版本
  PACKAGE_SUSPENDED: "PACKAGE_SUSPENDED", // 包被暂停（仅受影响包）
  PACKAGE_HALTED: "PACKAGE_HALTED", // 紧急停用
  REWORK_OVERDUE: "REWORK_OVERDUE", // 紧急停用后的补审已逾期
  RECALL_OPEN: "RECALL_OPEN", // 已交付内容处于召回/更正流程
});

// 非阻断性提示（不改变结论，但发布人员应当看到）。
export const WARNING_CODES = Object.freeze({
  NEWER_VERSION_AVAILABLE: "NEWER_VERSION_AVAILABLE", // 绑定版本已被新版取代但尚未触发停用
  PARALLEL_REVIEW_STALE: "PARALLEL_REVIEW_STALE", // 并行审校曾基于旧版本，已记冲突
});

export const EVENT_KINDS = Object.freeze([
  // 素材与四线版本
  "MOTIF_PROPOSED",
  "ELEMENT_VERSION_RECORDED",
  "VERSION_SUSPENDED", // 兼容基线：版本停用
  // 证据
  "EVIDENCE_SUBMITTED",
  "EVIDENCE_RULED",
  // 评审意见（限定专业范围与司法地域）
  "REVIEW_OPINION_ADDED",
  // 市场域权利与政策
  "RIGHTS_CONDITION_SET",
  "RIGHTS_WITHDRAWN",
  "MARKET_POLICY_SET",
  // 发布包与批准链
  "PACKAGE_COMPOSED",
  "RELEASE_PACKAGE_APPROVED", // 兼容基线
  "APPROVAL_GRANTED",
  "REVIEW_STALENESS_FLAGGED",
  "PACKAGE_DELIVERED",
  // 暂停 / 恢复 / 紧急停用 / 补审
  "PACKAGE_SUSPENDED",
  "PACKAGE_RESUMED",
  "EMERGENCY_HALT",
  "HALT_REWORK_RULED",
  // 召回与通知
  "RECALL_OPENED",
  "RECALL_CLOSED",
  "NOTIFICATION_DELIVERED",
]);

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

// 每种事件 payload 的必填键。基线历史事件（RELEASE_PACKAGE_APPROVED / VERSION_SUSPENDED
// 的早期形态）不强制 payload 结构，以保持旧资料可读。
const PAYLOAD_REQUIRED = Object.freeze({
  MOTIF_PROPOSED: ["motif_id", "name"],
  ELEMENT_VERSION_RECORDED: ["motif_id", "line", "version_id"],
  EVIDENCE_SUBMITTED: ["evidence_id", "motif_id", "submitted_by"],
  EVIDENCE_RULED: ["evidence_id", "accepted", "reviewer_id"],
  REVIEW_OPINION_ADDED: ["opinion_id", "motif_id", "reviewer_id", "discipline", "decision", "basis_versions"],
  RIGHTS_CONDITION_SET: ["motif_id", "jurisdiction", "set_by"],
  RIGHTS_WITHDRAWN: ["motif_id", "jurisdiction", "withdrawn_by"],
  MARKET_POLICY_SET: ["jurisdiction"],
  PACKAGE_COMPOSED: ["package_id", "motif_id", "market", "bindings"],
  APPROVAL_GRANTED: ["approval_id", "package_id", "discipline", "reviewer_id", "basis_versions"],
  REVIEW_STALENESS_FLAGGED: ["ref_kind", "ref_id", "basis_versions", "current_versions"],
  PACKAGE_DELIVERED: ["package_id", "delivered_by"],
  PACKAGE_SUSPENDED: ["package_id", "reason", "cause_event_id", "suspended_by"],
  PACKAGE_RESUMED: ["package_id", "resumed_by"],
  EMERGENCY_HALT: ["package_id", "halted_by", "reason", "rework_owner", "rework_due_at"],
  HALT_REWORK_RULED: ["package_id", "decision", "reviewer_id"],
  RECALL_OPENED: ["recall_id", "package_id", "type", "cause_event_id", "opened_by"],
  RECALL_CLOSED: ["recall_id", "closed_by"],
  NOTIFICATION_DELIVERED: ["notification_id", "package_id"],
});

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  problems.push(...validatePayload(record));
  return problems;
}

// 返回 payload 层面的缺失字段路径，如 "payload.motif_id"。
export function validatePayload(record) {
  const required = PAYLOAD_REQUIRED[record.kind];
  if (!required || typeof record.payload !== "object" || record.payload === null) return [];
  return required.filter((name) => !(name in record.payload)).map((name) => `payload.${name}`);
}

export function nowIso() {
  return new Date().toISOString();
}
