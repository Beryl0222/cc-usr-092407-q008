// 时间点审计：审计人员可以按过去的时间点复原"当时为何获准"，以及"哪次变化改变了结论"。
// 所有结论都由 fold(events, { as_of }) 重放得到，不依赖当前状态，因此事后补录、
// 撤权或召回都不会改写历史结论。

import { DECISIONS } from "./art_motif_review.js";
import { evaluatePackage } from "./governance.js";
import { activeRecall, fold } from "./projection.js";

// 复原某时刻的判定依据。
export function reconstructAt(events, packageId, at) {
  const state = fold(events, { as_of: at });
  const pkg = state.packages.get(packageId);
  if (!pkg) return { package_id: packageId, at, existed: false };
  const result = evaluatePackage(state, pkg, at);

  const suspension = state.suspensions.get(packageId);
  const halt = state.halts.get(packageId);
  return {
    package_id: packageId,
    existed: true,
    at,
    decision: result.decision,
    blockers: result.blockers,
    pendings: result.pendings,
    // 当时获准（或被拦）所依据的具体事实：
    why: {
      bound_versions: result.basis.versions,
      rights: result.basis.rights,
      accepted_evidence: result.basis.evidence.filter((e) => e.status === "ACCEPTED"),
      evidence_status: result.basis.evidence,
      opinions: result.basis.opinions,
      approvals: result.basis.approvals,
    },
    lifecycle: {
      delivered: state.deliveries.get(packageId) ?? null,
      suspension: suspension
        ? { active: suspension.active, since: suspension.at, cause_event_id: suspension.cause_event_id, event_id: suspension.event_id }
        : null,
      halt: halt
        ? {
            active: halt.active, since: halt.at, event_id: halt.event_id, reason: halt.reason,
            rework_owner: halt.rework_owner, rework_due_at: halt.rework_due_at,
            rework_ruling: halt.rework
              ? { decision: halt.rework.decision, at: halt.rework.at, event_id: halt.rework.event_id }
              : null,
          }
        : null,
      open_recall: activeRecall(state, packageId),
    },
    // 当时所见到的最后一个事件序号，审计可据此核对重放窗口。
    replayed_event_count: state.events.length,
  };
}

function reasonSignatures(reasons) {
  return new Set(reasons.map((r) => `${r.code}:${JSON.stringify(canonicalDetails(r))}`));
}

function canonicalDetails(r) {
  const detail = { ...r };
  delete detail.code;
  delete detail.severity;
  delete detail.message;
  return detail;
}

// 结论变化时间线：逐事件前缀重放，只保留决策或阻断理由集合发生变化的节点。
// 按事件前缀而非时间戳重放，即使多条事件时间戳相同，也能把转折精确归因到那一条。
export function decisionTimeline(events, packageId) {
  const ordered = events.slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const entries = [];
  let prev = null;

  for (let i = 0; i < ordered.length; i += 1) {
    const e = ordered[i];
    const state = fold(ordered.slice(0, i + 1));
    const pkg = state.packages.get(packageId);
    if (!pkg) continue; // 包尚未组成
    const result = evaluatePackage(state, pkg, e.occurred_at);
    const blockSig = reasonSignatures(result.blockers);
    const changed =
      !prev ||
      prev.decision !== result.decision ||
      !setEquals(prev.blockSig, blockSig);

    if (changed) {
      const appeared = prev ? diffReasons(prev.snapshot.blockers, result.blockers) : result.blockers;
      const disappeared = prev ? diffReasons(result.blockers, prev.snapshot.blockers) : [];
      entries.push({
        changed_by_event: { event_id: e.event_id, kind: e.kind, at: e.occurred_at },
        from_decision: prev?.decision ?? null,
        to_decision: result.decision,
        new_blockers: appeared,
        cleared_blockers: disappeared,
      });
    }
    prev = { decision: result.decision, blockSig, snapshot: result };
  }
  return entries;
}

// 解释 (fromAt, toAt] 区间内哪次事件改变了结论，返回首个转折点及其新增理由。
export function explainChange(events, packageId, fromAt, toAt) {
  const before = reconstructAt(events, packageId, fromAt);
  const timeline = decisionTimeline(events, packageId).filter(
    (t) => t.changed_by_event.at > fromAt && t.changed_by_event.at <= toAt,
  );
  return {
    package_id: packageId,
    from_at: fromAt,
    to_at: toAt,
    decision_at_from: before.existed ? before.decision : "NOT_EXISTED",
    turning_points: timeline,
    decision_at_to: reconstructAt(events, packageId, toAt).decision,
  };
}

function diffReasons(baseReasons, candidateReasons) {
  const base = reasonSignatures(baseReasons);
  return candidateReasons.filter((r) => !base.has(`${r.code}:${JSON.stringify(canonicalDetails(r))}`));
}

function setEquals(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export function renderAudit(record) {
  if (!record.existed) return `${record.package_id} 在 ${record.at} 尚未存在`;
  const lines = [`[${record.decision}] ${record.package_id} @ ${record.at}`];
  if (record.decision === DECISIONS.ALLOWED) {
    const rights = record.why.rights;
    lines.push(`  权利依据事件 ${rights?.event_id ?? "?"}，期限 ${rights?.effective_at ?? "?"} ~ ${rights?.expires_at ?? "无固定届满"}`);
    lines.push(`  批准链：${record.why.approvals.map((a) => `${a.discipline}(${a.event_id})`).join("、") || "（无专业要求）"}`);
    lines.push(`  采信证据：${record.why.accepted_evidence.map((e) => e.evidence_id).join("、") || "无"}`);
  }
  for (const r of record.blockers) lines.push(`  阻断 ${r.code}：${r.message}（事件 ${r.event_id ?? r.halt_event_id ?? r.cause_event_id ?? "?"}）`);
  for (const r of record.pendings) lines.push(`  待补 ${r.code}：${r.message}`);
  return lines.join("\n");
}
