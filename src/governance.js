// 分市场治理领域服务：在事件约定之上提供版本链、评审覆盖、权利判定、
// 发布预检、召回/更正跟踪与历史复原能力。
//
// 设计要点：
// - 一切结论由事件流折叠得出，任何判定都可按 occurred_at 复原到过去时间点；
// - “当前时间”默认为已见事件的最大 occurred_at，保证判定可重放、不依赖墙钟；
// - 召回/更正只在结论发生变化（或新交付即受阻）时触发，并按 notice_id 去重，
//   重复通知不会再次触发召回。

import { VERSION_ASPECTS, validateEvent } from "./art_motif_review.js";

export const DECISIONS = Object.freeze({
  ALLOWED: "ALLOWED",
  PENDING_EVIDENCE: "PENDING_EVIDENCE",
  PROHIBITED: "PROHIBITED",
});

const DECISION_RANK = Object.freeze({ ALLOWED: 0, PENDING_EVIDENCE: 1, PROHIBITED: 2 });

const ASPECT_LABELS = Object.freeze({
  provenance: "来源",
  adaptation: "改绘",
  copy: "解释文案",
  carrier: "载体",
});

const DEFAULT_REQUIRED_DISCIPLINES = Object.freeze(["cultural", "legal"]);

function toTime(value) {
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`无法解析时间：${value}`);
  return parsed;
}

function iso(time) {
  return new Date(time).toISOString();
}

// 载体是独立实体，其余三条版本链挂在素材（motif）下
function chainKey(subjectId, aspect) {
  return aspect === "carrier" ? `carrier:${subjectId}` : `${subjectId}:${aspect}`;
}

function sortedPush(list, entry) {
  list.push(entry);
  list.sort((a, b) => a.time - b.time || a.seq - b.seq);
}

function latestAt(list, at) {
  let found = null;
  for (const entry of list) {
    if (entry.time <= at) found = entry;
    else break;
  }
  return found;
}

function prohibitionMatches(prohibition, pkg, carrierType) {
  if (prohibition.market !== "*" && prohibition.market !== pkg.market) return false;
  if (prohibition.carrier_type && prohibition.carrier_type !== carrierType) return false;
  if (prohibition.scene && prohibition.scene !== pkg.scene) return false;
  return true;
}

// 意见只约束它声明钉住的方面；未声明的方面不参与匹配
function baseVersionsMatch(baseVersions, pinned) {
  return Object.entries(baseVersions).every(([aspect, version]) => pinned[aspect] === version);
}

function makeReason(level, code, message, details) {
  return { level, code, message, details };
}

export function createGovernanceService(options = {}) {
  const requiredDisciplines = options.requiredDisciplines ?? [...DEFAULT_REQUIRED_DISCIPLINES];

  const events = []; // 已受理事件（含归一化的 time/seq）
  const seenEventIds = new Set();
  const usedNoticeIds = new Set(); // 已触发召回/更正的通知号
  const motifs = new Map(); // motifId -> { title, proposed_at }
  const chains = new Map(); // chainKey -> 按 (time, seq) 排序的版本事件
  const opinions = []; // 评审意见，按 (time, seq) 排序
  const rightsConditions = new Map(); // motifId -> 权利条件时间线
  const rightsRevocations = new Map(); // motifId -> 撤权时间线
  const packages = new Map(); // packageId -> 发布包记录
  const versionSuspensions = []; // 版本停用记录
  const releaseToggles = new Map(); // packageId -> 停用/恢复切换
  const remediations = []; // 召回/更正跟踪记录
  const conflicts = []; // 评审意见与当前版本的冲突

  function mapList(map, key) {
    if (!map.has(key)) map.set(key, []);
    return map.get(key);
  }

  function currentAt() {
    return events.length ? events.reduce((max, e) => Math.max(max, e.time), events[0].time) : null;
  }

  function evaluate(pkg, at) {
    const blocking = [];
    const advisories = [];
    const approvals = [];

    const carrierEntry = latestAt(chains.get(chainKey(pkg.carrier_id, "carrier")) ?? [], at);
    const carrierType = carrierEntry ? carrierEntry.payload.carrier_type : null;

    // 1. 权利条件与撤权（期限、署名、禁用条件参与实际判定）
    const condition = latestAt(rightsConditions.get(pkg.motif_id) ?? [], at);
    const revocation = latestAt(rightsRevocations.get(pkg.motif_id) ?? [], at);
    const revoked = revocation
      && toTime(revocation.payload.effective_from) <= at
      && (revocation.payload.markets.includes(pkg.market) || revocation.payload.markets.includes("*"))
      && (!condition || condition.time < revocation.time); // 撤权后重新授权的条件优先
    if (revoked) {
      const p = revocation.payload;
      blocking.push(makeReason("PROHIBITED", "RIGHTS_REVOKED",
        `权利已被撤回（通知 ${p.notice_id}）：${p.reason}`,
        { notice_id: p.notice_id, effective_from: p.effective_from }));
    } else if (!condition) {
      blocking.push(makeReason("PENDING_EVIDENCE", "RIGHTS_MISSING",
        "缺少权利条件记录，无法判定权利状态", {}));
    } else {
      const p = condition.payload;
      if (p.valid_until && toTime(p.valid_until) < at) {
        blocking.push(makeReason("PROHIBITED", "RIGHTS_EXPIRED",
          `权利期限已于 ${p.valid_until} 届满`, { valid_until: p.valid_until }));
      }
      if (p.attribution_required && !pkg.attribution_included) {
        blocking.push(makeReason("PROHIBITED", "ATTRIBUTION_MISSING",
          "权利条件要求署名，发布包未包含署名", {}));
      }
      for (const prohibition of p.prohibitions ?? []) {
        if (prohibitionMatches(prohibition, pkg, carrierType)) {
          blocking.push(makeReason("PROHIBITED", "PROHIBITION_MATCHED",
            `命中禁用条件（市场 ${prohibition.market}）：${prohibition.reason}`,
            { prohibition }));
        }
      }
    }

    // 2. 钉住的版本是否被停用
    for (const aspect of VERSION_ASPECTS) {
      const pinned = pkg.pinned_versions[aspect];
      const key = aspect === "carrier" ? chainKey(pkg.carrier_id, "carrier") : chainKey(pkg.motif_id, aspect);
      const hit = versionSuspensions.find((s) => s.time <= at && s.chainKey === key && s.version === pinned);
      if (hit) {
        blocking.push(makeReason("PROHIBITED", "VERSION_SUSPENDED",
          `引用的${ASPECT_LABELS[aspect]}版本 ${pinned} 已停用：${hit.event.payload.reason}`,
          { aspect, version: pinned, event_id: hit.event.event_id }));
      }
    }

    // 3. 新来源证据与钉住版本冲突 → 待补证
    const provenanceChain = chains.get(chainKey(pkg.motif_id, "provenance")) ?? [];
    const contradicting = provenanceChain.find(
      (e) => e.time <= at && (e.payload.contradicts_versions ?? []).includes(pkg.pinned_versions.provenance),
    );
    if (contradicting) {
      blocking.push(makeReason("PENDING_EVIDENCE", "NEW_EVIDENCE_PENDING",
        `新来源证据（版本 ${contradicting.payload.version}）与引用版本 ${pkg.pinned_versions.provenance} 冲突，待补证`,
        { evidence_version: contradicting.payload.version, pinned_version: pkg.pinned_versions.provenance, event_id: contradicting.event_id }));
    }

    // 4. 发布级停用/恢复（紧急停用携带补审责任与期限）
    const lastToggle = latestAt(releaseToggles.get(pkg.package_id) ?? [], at);
    if (lastToggle && lastToggle.type === "suspend") {
      const p = lastToggle.event.payload;
      if (p.emergency) {
        blocking.push(makeReason("PROHIBITED", "EMERGENCY_SUSPENDED",
          `紧急停用：${p.reason}（补审责任 ${p.follow_up.owner}，补审期限 ${p.follow_up.due_at}）`,
          { follow_up: p.follow_up, event_id: lastToggle.event.event_id }));
      } else {
        blocking.push(makeReason("PROHIBITED", "RELEASE_SUSPENDED",
          `发布已停用：${p.reason}`, { event_id: lastToggle.event.event_id }));
      }
    }

    // 5. 评审覆盖：每个必需专业在发布市场（或 GLOBAL）须有基于钉住版本的有效意见
    for (const discipline of requiredDisciplines) {
      const scoped = opinions.filter(
        (o) => o.time <= at && o.subject_id === pkg.motif_id
          && o.payload.discipline === discipline
          && (o.payload.jurisdiction === pkg.market || o.payload.jurisdiction === "GLOBAL"),
      );
      const usable = scoped.filter((o) => baseVersionsMatch(o.payload.base_versions, pkg.pinned_versions));
      if (!usable.length) {
        blocking.push(makeReason("PENDING_EVIDENCE", scoped.length ? "REVIEW_STALE" : "REVIEW_MISSING",
          scoped.length
            ? `${discipline} 专业在 ${pkg.market} 的评审基于旧版本，需重新审校`
            : `缺少 ${discipline} 专业在 ${pkg.market} 的评审意见`,
          { discipline, jurisdiction: pkg.market }));
        continue;
      }
      const latest = usable[usable.length - 1];
      approvals.push({
        opinion_id: latest.payload.opinion_id,
        discipline,
        jurisdiction: latest.payload.jurisdiction,
        decision: latest.payload.decision,
        base_versions: latest.payload.base_versions,
      });
      if (latest.payload.decision === "reject") {
        blocking.push(makeReason("PROHIBITED", "REVIEW_REJECTED",
          `${discipline} 评审否决（意见 ${latest.payload.opinion_id}）`,
          { opinion_id: latest.payload.opinion_id, discipline }));
      }
      if (latest.payload.decision === "conditional") {
        advisories.push({
          code: "CONDITIONAL_APPROVAL",
          message: `${discipline} 专业附条件通过`,
          conditions: latest.payload.conditions ?? [],
          opinion_id: latest.payload.opinion_id,
        });
      }
    }

    const decision = blocking.some((r) => r.level === "PROHIBITED")
      ? DECISIONS.PROHIBITED
      : blocking.some((r) => r.level === "PENDING_EVIDENCE")
        ? DECISIONS.PENDING_EVIDENCE
        : DECISIONS.ALLOWED;
    return { decision, blocking_reasons: blocking, advisories, approvals };
  }

  function apply(event) {
    const warnings = [];
    const p = event.payload;
    switch (event.kind) {
      case "MOTIF_PROPOSED":
        motifs.set(event.subject_id, { title: p.title, proposed_at: event.time });
        break;
      case "PROVENANCE_RECORDED":
        sortedPush(mapList(chains, chainKey(event.subject_id, "provenance")), event);
        break;
      case "ADAPTATION_RECORDED":
        sortedPush(mapList(chains, chainKey(event.subject_id, "adaptation")), event);
        break;
      case "COPY_RECORDED":
        sortedPush(mapList(chains, chainKey(event.subject_id, "copy")), event);
        break;
      case "CARRIER_RECORDED":
        sortedPush(mapList(chains, chainKey(event.subject_id, "carrier")), event);
        break;
      case "REVIEW_OPINION_ADDED":
        sortedPush(opinions, event);
        break;
      case "RIGHTS_CONDITION_SET":
        sortedPush(mapList(rightsConditions, event.subject_id), event);
        break;
      case "RIGHTS_REVOKED":
        sortedPush(mapList(rightsRevocations, event.subject_id), event);
        break;
      case "RELEASE_PACKAGE_APPROVED":
        packages.set(event.subject_id, {
          package_id: event.subject_id,
          motif_id: p.motif_id,
          market: p.market,
          scene: p.scene ?? null,
          carrier_id: p.carrier_id,
          pinned_versions: { ...p.pinned_versions },
          approval_chain: [...p.approval_chain],
          attribution_included: p.attribution_included,
          approved_at: event.time,
          delivered: false,
          delivered_at: null,
        });
        break;
      case "RELEASE_PACKAGE_DELIVERED": {
        const pkg = packages.get(event.subject_id);
        if (!pkg) warnings.push(`交付事件指向未知发布包 ${event.subject_id}`);
        else {
          pkg.delivered = true;
          pkg.delivered_at = event.time;
        }
        break;
      }
      case "VERSION_SUSPENDED":
        versionSuspensions.push({
          chainKey: chainKey(event.subject_id, p.entity),
          version: p.version,
          time: event.time,
          event,
        });
        break;
      case "RELEASE_SUSPENDED":
        sortedPush(mapList(releaseToggles, event.subject_id), { type: "suspend", event, time: event.time, seq: event.seq });
        break;
      case "RELEASE_REINSTATED":
        sortedPush(mapList(releaseToggles, event.subject_id), { type: "reinstated", event, time: event.time, seq: event.seq });
        break;
      case "RECALL_OPENED": {
        const result = openRemediation(event.subject_id, {
          notice_id: p.notice_id,
          mode: p.mode,
          reason: p.reason,
          cause_event_id: event.event_id,
          at: event.time,
        });
        if (!result) warnings.push(`召回事件指向未知发布包 ${event.subject_id}`);
        else if (result.duplicate) warnings.push(`通知 ${p.notice_id} 已触发过召回/更正，未重复登记`);
        break;
      }
      case "RECALL_UPDATED": {
        const record = remediations.find((r) => r.package_id === event.subject_id && r.notice_id === p.notice_id);
        if (!record) warnings.push(`召回更新未匹配到记录（通知 ${p.notice_id}）`);
        else {
          record.status = p.status;
          record.history.push({ at: event.occurred_at, status: p.status, event_id: event.event_id, note: p.note ?? null });
        }
        break;
      }
      default:
        break;
    }
    return warnings;
  }

  // 并行审校若基于旧版本：比较意见钉住的版本与当时的当前版本
  function detectConflicts(event) {
    if (event.kind !== "REVIEW_OPINION_ADDED") return [];
    const found = [];
    for (const [aspect, version] of Object.entries(event.payload.base_versions)) {
      const key = aspect === "carrier"
        ? chainKey(event.payload.carrier_id, "carrier")
        : chainKey(event.subject_id, aspect);
      const current = latestAt(chains.get(key) ?? [], event.time);
      if (current && current.payload.version !== version) {
        found.push({
          opinion_id: event.payload.opinion_id,
          event_id: event.event_id,
          aspect,
          base_version: version,
          current_version: current.payload.version,
          detected_at: event.occurred_at,
        });
      }
    }
    conflicts.push(...found);
    return found;
  }

  function openRemediation(packageId, { notice_id, mode, reason, cause_event_id, at }) {
    const pkg = packages.get(packageId);
    if (!pkg) return null;
    // 重复通知不得再次触发召回；同包同类的在办记录也不重复开立
    const sameNotice = remediations.find((r) => r.package_id === packageId && r.notice_id === notice_id);
    if (sameNotice) return { duplicate: true, record: sameNotice };
    const openSameMode = remediations.find((r) => r.package_id === packageId && r.mode === mode && r.status !== "completed");
    if (openSameMode) return { duplicate: true, record: openSameMode };
    const record = {
      package_id: packageId,
      notice_id,
      mode,
      reason,
      cause_event_id,
      opened_at: iso(at),
      status: "open",
      history: [{ at: iso(at), status: "open", event_id: cause_event_id }],
    };
    remediations.push(record);
    usedNoticeIds.add(notice_id);
    return { duplicate: false, record };
  }

  function ingest(record) {
    const problems = validateEvent(record);
    if (problems.length) return { ok: false, problems };
    if (seenEventIds.has(record.event_id)) {
      return { ok: true, duplicate: true, effects: { conflicts: [], remediations_opened: [], notice_duplicate: false, warnings: [] } };
    }

    // 快照变更前各已交付发布包的结论，用于识别“受影响的发布”
    const beforeAt = currentAt();
    const before = new Map();
    if (beforeAt !== null) {
      for (const pkg of packages.values()) {
        before.set(pkg.package_id, {
          delivered: pkg.delivered && pkg.delivered_at <= beforeAt,
          decision: evaluate(pkg, beforeAt).decision,
        });
      }
    }
    const noticeId = record.payload?.notice_id;
    const noticeSeenBefore = noticeId ? usedNoticeIds.has(noticeId) : false;

    const event = { ...record, time: toTime(record.occurred_at), seq: events.length };
    seenEventIds.add(record.event_id);
    events.push(event);
    const warnings = apply(event);
    const foundConflicts = detectConflicts(event);

    const effects = { conflicts: foundConflicts, remediations_opened: [], notice_duplicate: noticeSeenBefore, warnings };

    // 新证据、撤权、停用等只暂停结论因此事件而变化的已交付发布
    const afterAt = currentAt();
    for (const pkg of packages.values()) {
      if (pkg.approved_at > afterAt) continue;
      if (!pkg.delivered || pkg.delivered_at > afterAt) continue;
      const after = evaluate(pkg, afterAt);
      if (after.decision === DECISIONS.ALLOWED) continue;
      const prev = before.get(pkg.package_id);
      const wasTracked = prev?.delivered ?? false;
      const escalated = wasTracked && DECISION_RANK[after.decision] > DECISION_RANK[prev.decision];
      const newlyDelivered = !wasTracked;
      if (!escalated && !newlyDelivered) continue;
      const mode = after.decision === DECISIONS.PROHIBITED ? "recall" : "correction";
      const result = openRemediation(pkg.package_id, {
        notice_id: noticeId ?? `event:${record.event_id}`,
        mode,
        reason: after.blocking_reasons.map((r) => r.message).join("；"),
        cause_event_id: record.event_id,
        at: afterAt,
      });
      if (result && !result.duplicate) effects.remediations_opened.push(publicRemediation(result.record));
    }
    return { ok: true, duplicate: false, effects };
  }

  function publicRemediation(record) {
    return { ...record, history: record.history.map((h) => ({ ...h })) };
  }

  function precheck(packageId, opts = {}) {
    const pkg = packages.get(packageId);
    if (!pkg) return { ok: false, problems: ["PACKAGE_UNKNOWN"] };
    const at = opts.at !== undefined ? toTime(opts.at) : currentAt();
    const result = evaluate(pkg, at);
    return {
      ok: true,
      package_id: pkg.package_id,
      market: pkg.market,
      as_of: iso(at),
      decision: result.decision,
      blocking_reasons: result.blocking_reasons,
      advisories: result.advisories,
      conflicts: conflicts.filter((c) => pkg.approval_chain.includes(c.opinion_id)).map((c) => ({ ...c })),
      open_remediations: remediations
        .filter((r) => r.package_id === packageId && r.status !== "completed")
        .map(publicRemediation),
    };
  }

  function rightsSummary(pkg, at) {
    const condition = latestAt(rightsConditions.get(pkg.motif_id) ?? [], at);
    const revocation = latestAt(rightsRevocations.get(pkg.motif_id) ?? [], at);
    return {
      condition: condition ? {
        holder: condition.payload.holder,
        valid_from: condition.payload.valid_from,
        valid_until: condition.payload.valid_until ?? null,
        attribution_required: condition.payload.attribution_required,
        recorded_at: condition.occurred_at,
      } : null,
      revocation: revocation ? {
        notice_id: revocation.payload.notice_id,
        markets: revocation.payload.markets,
        effective_from: revocation.payload.effective_from,
        reason: revocation.payload.reason,
      } : null,
    };
  }

  // 复原过去时间点：当时为何获准（或为何被阻断）
  function explainAt(packageId, atValue) {
    const pkg = packages.get(packageId);
    if (!pkg) return null;
    const at = atValue !== undefined ? toTime(atValue) : currentAt();
    if (pkg.approved_at > at) return null;
    const result = evaluate(pkg, at);
    return {
      package_id: pkg.package_id,
      market: pkg.market,
      as_of: iso(at),
      decision: result.decision,
      blocking_reasons: result.blocking_reasons,
      advisories: result.advisories,
      pinned_versions: { ...pkg.pinned_versions },
      approval_chain: [...pkg.approval_chain],
      applicable_opinions: result.approvals,
      rights: rightsSummary(pkg, at),
    };
  }

  // 结论变化轨迹：哪次事件改变了结论
  function auditTrail(packageId) {
    const pkg = packages.get(packageId);
    if (!pkg) return null;
    const related = events
      .filter((e) => e.time >= pkg.approved_at
        && (e.subject_id === pkg.package_id || e.subject_id === pkg.motif_id || e.subject_id === pkg.carrier_id))
      .sort((a, b) => a.time - b.time || a.seq - b.seq);
    const transitions = [];
    let prev = null;
    for (const e of related) {
      const result = evaluate(pkg, e.time);
      const signature = `${result.decision}|${result.blocking_reasons.map((r) => r.code).sort().join(",")}`;
      if (prev && prev.signature === signature) continue;
      transitions.push({
        at: e.occurred_at,
        event_id: e.event_id,
        kind: e.kind,
        from: prev ? prev.decision : null,
        to: result.decision,
        blocking_reasons: result.blocking_reasons,
      });
      prev = { signature, decision: result.decision };
    }
    return transitions;
  }

  function listRemediations(filter = {}) {
    return remediations
      .filter((r) => (filter.package_id === undefined || r.package_id === filter.package_id)
        && (filter.status === undefined || r.status === filter.status)
        && (filter.mode === undefined || r.mode === filter.mode))
      .map(publicRemediation);
  }

  function listConflicts() {
    return conflicts.map((c) => ({ ...c }));
  }

  function eventLog() {
    return events.map(({ time, seq, ...record }) => record);
  }

  return {
    ingest,
    precheck,
    explainAt,
    auditTrail,
    remediations: listRemediations,
    conflicts: listConflicts,
    eventLog,
    DECISIONS,
  };
}
