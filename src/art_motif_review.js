// art_motif_review 领域资料的基础结构。
//
// 事件约定支持分市场治理：
// - 来源（provenance）、改绘（adaptation）、解释文案（copy）、载体（carrier）四条版本链各自独立演进；
// - 评审意见携带专业范围（discipline）与司法地域（jurisdiction），并记录所基于的版本（base_versions）；
// - 权利条件（期限、署名、禁用场景）与撤权通知直接参与发布判定；
// - 发布包固定其使用的版本与批准链；已交付内容通过召回/更正事件跟踪，不作删除。

export const EVENT_KINDS = Object.freeze([
  "MOTIF_PROPOSED",
  "PROVENANCE_RECORDED",
  "ADAPTATION_RECORDED",
  "COPY_RECORDED",
  "CARRIER_RECORDED",
  "REVIEW_OPINION_ADDED",
  "RIGHTS_CONDITION_SET",
  "RIGHTS_REVOKED",
  "RELEASE_PACKAGE_APPROVED",
  "RELEASE_PACKAGE_DELIVERED",
  "RELEASE_SUSPENDED",
  "RELEASE_REINSTATED",
  "VERSION_SUSPENDED",
  "RECALL_OPENED",
  "RECALL_UPDATED",
]);

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

export const VERSION_ASPECTS = Object.freeze(["provenance", "adaptation", "copy", "carrier"]);
export const OPINION_DECISIONS = Object.freeze(["approve", "conditional", "reject"]);
export const REMEDIATION_MODES = Object.freeze(["recall", "correction"]);
export const REMEDIATION_STATUSES = Object.freeze(["acknowledged", "in_progress", "completed"]);

function req(payload, problems, fields) {
  for (const field of fields) {
    if (!(field in payload)) problems.push(`payload.${field}`);
  }
}

function reqArray(payload, problems, field) {
  if (field in payload && !Array.isArray(payload[field])) problems.push(`payload.${field}`);
}

function optArray(payload, problems, field) {
  if (field in payload && !Array.isArray(payload[field])) problems.push(`payload.${field}`);
}

function checkVersionMap(value, problems, path) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) {
    problems.push(path);
    return;
  }
  for (const [aspect, version] of Object.entries(value)) {
    if (!VERSION_ASPECTS.includes(aspect)) problems.push(`${path}.${aspect}`);
    else if (version === null || version === undefined || version === "") problems.push(`${path}.${aspect}`);
  }
}

function checkDate(payload, problems, field, path = `payload.${field}`) {
  if (field in payload && payload[field] !== null && Number.isNaN(Date.parse(payload[field]))) problems.push(path);
}

const PAYLOAD_RULES = {
  MOTIF_PROPOSED(p, pr) {
    req(p, pr, ["title"]);
  },
  PROVENANCE_RECORDED(p, pr) {
    req(p, pr, ["version", "source_claim", "recorded_by", "evidence_refs"]);
    reqArray(p, pr, "evidence_refs");
    optArray(p, pr, "contradicts_versions");
  },
  ADAPTATION_RECORDED(p, pr) {
    req(p, pr, ["version", "changes_summary"]);
  },
  COPY_RECORDED(p, pr) {
    req(p, pr, ["version", "locale", "text_ref"]);
  },
  CARRIER_RECORDED(p, pr) {
    req(p, pr, ["version", "carrier_type"]);
  },
  REVIEW_OPINION_ADDED(p, pr) {
    req(p, pr, ["opinion_id", "reviewer", "discipline", "jurisdiction", "decision", "base_versions"]);
    if ("decision" in p && !OPINION_DECISIONS.includes(p.decision)) pr.push("payload.decision");
    if ("base_versions" in p) checkVersionMap(p.base_versions, pr, "payload.base_versions");
    // 意见若钉住载体版本，必须说明针对哪个载体
    if (p.base_versions && typeof p.base_versions === "object" && "carrier" in p.base_versions && !("carrier_id" in p)) {
      pr.push("payload.carrier_id");
    }
  },
  RIGHTS_CONDITION_SET(p, pr) {
    req(p, pr, ["holder", "valid_from", "attribution_required", "prohibitions"]);
    if ("attribution_required" in p && typeof p.attribution_required !== "boolean") pr.push("payload.attribution_required");
    checkDate(p, pr, "valid_from");
    checkDate(p, pr, "valid_until");
    if ("prohibitions" in p) {
      if (!Array.isArray(p.prohibitions)) pr.push("payload.prohibitions");
      else {
        p.prohibitions.forEach((item, index) => {
          for (const field of ["market", "reason"]) {
            if (!(field in item)) pr.push(`payload.prohibitions[${index}].${field}`);
          }
        });
      }
    }
  },
  RIGHTS_REVOKED(p, pr) {
    req(p, pr, ["notice_id", "markets", "effective_from", "reason"]);
    reqArray(p, pr, "markets");
    checkDate(p, pr, "effective_from");
  },
  RELEASE_PACKAGE_APPROVED(p, pr) {
    req(p, pr, ["motif_id", "market", "carrier_id", "pinned_versions", "approval_chain", "attribution_included"]);
    if ("pinned_versions" in p) {
      checkVersionMap(p.pinned_versions, pr, "payload.pinned_versions");
      // 发布包必须钉住全部四条版本链，保证同一素材在不同市场可独立判定
      if (p.pinned_versions && typeof p.pinned_versions === "object" && !Array.isArray(p.pinned_versions)) {
        for (const aspect of VERSION_ASPECTS) {
          if (!(aspect in p.pinned_versions)) pr.push(`payload.pinned_versions.${aspect}`);
        }
      }
    }
    reqArray(p, pr, "approval_chain");
    if ("attribution_included" in p && typeof p.attribution_included !== "boolean") pr.push("payload.attribution_included");
  },
  RELEASE_PACKAGE_DELIVERED(p, pr) {
    req(p, pr, ["channel"]);
  },
  RELEASE_SUSPENDED(p, pr) {
    req(p, pr, ["reason", "emergency"]);
    if ("emergency" in p && typeof p.emergency !== "boolean") pr.push("payload.emergency");
    // 紧急停用允许先执行，但补审责任与期限必须随决定保存
    if (p.emergency === true) {
      if (!p.follow_up || typeof p.follow_up !== "object" || Array.isArray(p.follow_up)) {
        pr.push("payload.follow_up");
      } else {
        if (!("owner" in p.follow_up)) pr.push("payload.follow_up.owner");
        if (!("due_at" in p.follow_up)) pr.push("payload.follow_up.due_at");
        else if (Number.isNaN(Date.parse(p.follow_up.due_at))) pr.push("payload.follow_up.due_at");
      }
    }
  },
  RELEASE_REINSTATED(p, pr) {
    req(p, pr, ["reason"]);
  },
  VERSION_SUSPENDED(p, pr) {
    req(p, pr, ["entity", "version", "reason"]);
    if ("entity" in p && !VERSION_ASPECTS.includes(p.entity)) pr.push("payload.entity");
  },
  RECALL_OPENED(p, pr) {
    req(p, pr, ["notice_id", "mode", "reason"]);
    if ("mode" in p && !REMEDIATION_MODES.includes(p.mode)) pr.push("payload.mode");
  },
  RECALL_UPDATED(p, pr) {
    req(p, pr, ["notice_id", "status"]);
    if ("status" in p && !REMEDIATION_STATUSES.includes(p.status)) pr.push("payload.status");
  },
};

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if ("kind" in record && !EVENT_KINDS.includes(record.kind)) problems.push("kind");
  if (problems.length) return problems;
  if (Number.isNaN(Date.parse(record.occurred_at))) problems.push("occurred_at");
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    problems.push("payload");
    return problems;
  }
  const rule = PAYLOAD_RULES[record.kind];
  if (rule) rule(payload, problems);
  return problems;
}
