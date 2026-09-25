// 事件 -> 当前状态的纯函数折叠。
// fold(events, { as_of }) 只重放 occurred_at <= as_of 的事件，因此审计可以复原任意
// 过去时间点的状态。投影不做业务判定，只整理事实；判定在 governance.js。

import { ELEMENT_LINES } from "./art_motif_review.js";

function newState() {
  return {
    motifs: new Map(),
    // motif_id -> line -> [version,...]（按记录顺序，最后一个为当前版本）
    versions: new Map(),
    evidence: new Map(),
    opinions: [],
    // `${motif_id}|${jurisdiction}` -> 权利条件
    rights: new Map(),
    policies: new Map(),
    packages: new Map(),
    approvalsByPackage: new Map(),
    stalenessFlags: [],
    deliveries: new Map(),
    suspensions: new Map(),
    halts: new Map(),
    recalls: new Map(), // package_id -> [recall,...]
    notifications: new Map(), // notification_id -> {package_id, at, event_id}
    events: [],
  };
}

function rightsKey(motifId, jurisdiction) {
  return `${motifId}|${jurisdiction}`;
}

function versionsOf(state, motifId) {
  if (!state.versions.has(motifId)) {
    state.versions.set(motifId, new Map(ELEMENT_LINES.map((line) => [line, []])));
  }
  return state.versions.get(motifId);
}

export function currentVersions(state, motifId) {
  const lines = state.versions.get(motifId);
  if (!lines) return {};
  const out = {};
  for (const line of ELEMENT_LINES) {
    const list = lines.get(line) ?? [];
    out[line] = list.length > 0 ? list[list.length - 1].version_id : null;
  }
  return out;
}

export function findVersion(state, motifId, line, versionId) {
  const list = state.versions.get(motifId)?.get(line) ?? [];
  return list.find((v) => v.version_id === versionId) ?? null;
}

export function activeRightsAt(state, motifId, jurisdiction, at) {
  const r = state.rights.get(rightsKey(motifId, jurisdiction));
  if (!r) return null;
  const time = Date.parse(at);
  const effective = r.terms.filter((t) => Date.parse(t.effective_at) <= time);
  if (effective.length === 0) return null;
  return { ...r, term: effective[effective.length - 1] };
}

export function activeRecall(state, packageId) {
  const list = state.recalls.get(packageId) ?? [];
  const open = list.filter((r) => r.closed === null);
  return open.length > 0 ? open[open.length - 1] : null;
}

function apply(state, e) {
  const p = e.payload ?? {};
  state.events.push(e);

  switch (e.kind) {
    case "MOTIF_PROPOSED":
      state.motifs.set(p.motif_id, { motif_id: p.motif_id, name: p.name ?? p.motif_id });
      break;

    case "ELEMENT_VERSION_RECORDED": {
      const lines = versionsOf(state, p.motif_id);
      const version = {
        version_id: p.version_id,
        line: p.line,
        status: "ACTIVE",
        recorded_at: e.occurred_at,
        event_id: e.event_id,
        ...p,
      };
      lines.get(p.line).push(version);
      break;
    }

    // 基线事件与新版停用共用：找到对应版本标记 SUSPENDED。
    case "VERSION_SUSPENDED": {
      if (!p.motif_id || !p.version_id) break;
      const lines = state.versions.get(p.motif_id);
      if (!lines) break;
      for (const list of lines.values()) {
        const v = list.find((x) => x.version_id === p.version_id);
        if (v) v.status = "SUSPENDED";
      }
      break;
    }

    case "EVIDENCE_SUBMITTED":
      state.evidence.set(p.evidence_id, {
        evidence_id: p.evidence_id,
        motif_id: p.motif_id,
        line: p.line ?? null,
        jurisdiction: p.jurisdiction ?? null,
        status: "SUBMITTED",
        submitted_at: e.occurred_at,
        event_id: e.event_id,
        ...p,
      });
      break;

    case "EVIDENCE_RULED": {
      const ev = state.evidence.get(p.evidence_id);
      if (ev) {
        ev.status = p.accepted ? "ACCEPTED" : "REJECTED";
        ev.ruling = { reviewer_id: p.reviewer_id, at: e.occurred_at, note: p.note ?? null, event_id: e.event_id };
      }
      break;
    }

    case "REVIEW_OPINION_ADDED":
      state.opinions.push({
        opinion_id: p.opinion_id,
        motif_id: p.motif_id,
        reviewer_id: p.reviewer_id,
        discipline: p.discipline,
        jurisdiction: p.jurisdiction ?? null,
        decision: p.decision,
        basis_versions: { ...p.basis_versions },
        note: p.note ?? null,
        at: e.occurred_at,
        event_id: e.event_id,
      });
      break;

    case "RIGHTS_CONDITION_SET": {
      const key = rightsKey(p.motif_id, p.jurisdiction);
      const existing = state.rights.get(key) ?? { motif_id: p.motif_id, jurisdiction: p.jurisdiction, terms: [], withdrawn: null };
      existing.terms.push({
        effective_at: p.effective_at ?? e.occurred_at,
        expires_at: p.expires_at ?? null,
        attribution_required: p.attribution_required ?? false,
        prohibited_uses: [...(p.prohibited_uses ?? [])],
        set_by: p.set_by,
        note: p.note ?? null,
        event_id: e.event_id,
        at: e.occurred_at,
      });
      // 法务重新设定条件即视为新的授权，撤权记录进入历史。
      existing.withdrawn = null;
      state.rights.set(key, existing);
      break;
    }

    case "RIGHTS_WITHDRAWN": {
      const key = rightsKey(p.motif_id, p.jurisdiction);
      const existing = state.rights.get(key) ?? { motif_id: p.motif_id, jurisdiction: p.jurisdiction, terms: [], withdrawn: null };
      existing.withdrawn = { at: e.occurred_at, by: p.withdrawn_by, reason: p.reason ?? null, event_id: e.event_id };
      state.rights.set(key, existing);
      break;
    }

    case "MARKET_POLICY_SET":
      state.policies.set(p.jurisdiction, {
        jurisdiction: p.jurisdiction,
        required_evidence: [...(p.required_evidence ?? [])],
        note: p.note ?? null,
        event_id: e.event_id,
        at: e.occurred_at,
      });
      break;

    case "PACKAGE_COMPOSED":
      state.packages.set(p.package_id, {
        package_id: p.package_id,
        motif_id: p.motif_id,
        market: p.market,
        bindings: { ...p.bindings },
        required_disciplines: [...(p.required_disciplines ?? [])],
        composed_by: p.composed_by ?? null,
        at: e.occurred_at,
        event_id: e.event_id,
      });
      state.approvalsByPackage.set(p.package_id, []);
      state.recalls.set(p.package_id, []);
      break;

    case "APPROVAL_GRANTED": {
      const chain = state.approvalsByPackage.get(p.package_id) ?? [];
      chain.push({
        approval_id: p.approval_id,
        package_id: p.package_id,
        discipline: p.discipline,
        reviewer_id: p.reviewer_id,
        basis_versions: { ...p.basis_versions },
        at: e.occurred_at,
        event_id: e.event_id,
      });
      state.approvalsByPackage.set(p.package_id, chain);
      break;
    }

    case "RELEASE_PACKAGE_APPROVED":
      // 兼容基线事件：payload 可能为空。
      if (p.package_id) {
        const chain = state.approvalsByPackage.get(p.package_id) ?? [];
        chain.push({
          approval_id: p.approval_id ?? `legacy-${e.event_id}`,
          package_id: p.package_id,
          discipline: p.discipline ?? "general",
          reviewer_id: p.reviewer_id ?? "legacy",
          basis_versions: { ...(p.basis_versions ?? {}) },
          at: e.occurred_at,
          event_id: e.event_id,
          legacy: true,
        });
        state.approvalsByPackage.set(p.package_id, chain);
      }
      break;

    case "REVIEW_STALENESS_FLAGGED":
      state.stalenessFlags.push({
        ref_kind: p.ref_kind,
        ref_id: p.ref_id,
        package_id: p.package_id ?? null,
        basis_versions: { ...p.basis_versions },
        current_versions: { ...p.current_versions },
        at: e.occurred_at,
        event_id: e.event_id,
      });
      break;

    case "PACKAGE_DELIVERED":
      state.deliveries.set(p.package_id, { at: e.occurred_at, by: p.delivered_by, event_id: e.event_id });
      break;

    case "PACKAGE_SUSPENDED": {
      const prev = state.suspensions.get(p.package_id);
      state.suspensions.set(p.package_id, {
        active: true,
        reason: p.reason,
        cause_event_id: p.cause_event_id,
        by: p.suspended_by,
        at: e.occurred_at,
        event_id: e.event_id,
        resumptions: prev?.resumptions ?? [],
      });
      break;
    }

    case "PACKAGE_RESUMED": {
      const s = state.suspensions.get(p.package_id);
      if (s) {
        s.active = false;
        s.resumptions.push({ by: p.resumed_by, at: e.occurred_at, event_id: e.event_id });
      }
      break;
    }

    case "EMERGENCY_HALT":
      state.halts.set(p.package_id, {
        active: true,
        by: p.halted_by,
        at: e.occurred_at,
        reason: p.reason,
        rework_owner: p.rework_owner,
        rework_due_at: p.rework_due_at,
        rework: null,
        event_id: e.event_id,
      });
      break;

    case "HALT_REWORK_RULED": {
      const h = state.halts.get(p.package_id);
      if (h) {
        h.rework = { decision: p.decision, reviewer_id: p.reviewer_id, at: e.occurred_at, note: p.note ?? null, event_id: e.event_id };
        if (p.decision === "APPROVED") h.active = false;
      }
      break;
    }

    case "RECALL_OPENED": {
      const list = state.recalls.get(p.package_id) ?? [];
      list.push({
        recall_id: p.recall_id,
        package_id: p.package_id,
        type: p.type, // RECALL | CORRECTION
        cause_event_id: p.cause_event_id,
        opened_by: p.opened_by,
        opened_at: e.occurred_at,
        closed: null,
        event_id: e.event_id,
      });
      state.recalls.set(p.package_id, list);
      break;
    }

    case "RECALL_CLOSED": {
      const list = state.recalls.get(p.package_id) ?? [];
      const recall = [...list].reverse().find((r) => r.recall_id === p.recall_id && r.closed === null);
      if (recall) recall.closed = { by: p.closed_by, at: e.occurred_at, event_id: e.event_id };
      break;
    }

    case "NOTIFICATION_DELIVERED":
      state.notifications.set(p.notification_id, { package_id: p.package_id, at: e.occurred_at, event_id: e.event_id });
      break;

    default:
      break;
  }
}

export function fold(events, { as_of = null } = {}) {
  const state = newState();
  const cutoff = as_of === null ? null : Date.parse(as_of);
  const ordered = events
    .filter((e) => cutoff === null || Date.parse(e.occurred_at) <= cutoff)
    .slice()
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  for (const e of ordered) apply(state, e);
  return state;
}
