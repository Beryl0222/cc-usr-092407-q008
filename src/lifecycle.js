// 生命周期命令：把"发生了什么变化"翻译成"哪些发布必须暂停 / 召回 / 更正"。
//
// 关键规则：
// - 任何变化先作为只追加事件落库，再按 impactedPackages 只挑受影响的发布包；
// - 结论恶化为 PROHIBITED（或已交付包恶化为 PENDING_EVIDENCE）才暂停；暂停已交付包时
//   同步开可追踪的召回/更正单，内容不消失；
// - 同一原因事件对同一包只开一次召回；进行中的召回不重复开启；
// - NOTIFICATION_DELIVERED 按 notification_id 幂等，重复通知不可能再次触发召回；
// - 紧急停用不依赖判定结论即可先行，但 EMERGENCY_HALT 必须随存补审责任人与期限，
//   补审通过前不得恢复；
// - 阻断消除后普通暂停可恢复；紧急停用只能由 HALT_REWORK_RULED(APPROVED) 解除，
//   且进行中的召回仍然拦住发布。

import { nowIso } from "./art_motif_review.js";
import { ConcurrencyError, EventStore } from "./event_store.js";
import { evaluatePackage, impactedPackages } from "./governance.js";
import { fold } from "./projection.js";

const RECALL_BLOCKERS = new Set(["RIGHTS_WITHDRAWN", "VERSION_SUSPENDED", "OPINION_PROHIBITION", "RIGHTS_NOT_GRANTED"]);

let counter = 0;
export function genId(prefix) {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export class GovernanceService {
  constructor(store = new EventStore(), { clock = nowIso } = {}) {
    this.store = store;
    this.clock = clock;
  }

  state({ as_of = null } = {}) {
    return fold(this.store.events(), { as_of });
  }

  // 顺序追加（无并发竞争时的便捷入口）。
  commit(record) {
    this.store.append(record, { expectedSeq: this.store.length });
    return record;
  }

  base(kind, subjectId, payload, { event_id = genId(kind.toLowerCase()), at = this.clock() } = {}) {
    return { event_id: event_id, kind, occurred_at: at, subject_id: subjectId, payload };
  }

  // —— 基础编目 ——
  proposeMotif({ motif_id, name }, opts = {}) {
    return this.commit(this.base("MOTIF_PROPOSED", motif_id, { motif_id, name }, opts));
  }

  recordVersion(payload, opts = {}) {
    const e = this.commit(this.base("ELEMENT_VERSION_RECORDED", payload.motif_id, payload, opts));
    // 新版本不暂停任何包；并行审校若仍在旧版本上出具意见，会在出具时被标记冲突。
    return e;
  }

  // 版本停用跨市场影响所有绑定该版本的包。
  suspendVersion(payload, opts = {}) {
    return this.applyChange(this.base("VERSION_SUSPENDED", payload.motif_id, payload, opts));
  }

  submitEvidence(payload, opts = {}) {
    return this.applyChange(this.base("EVIDENCE_SUBMITTED", payload.motif_id, payload, opts));
  }

  ruleEvidence(payload, opts = {}) {
    const pre = this.state();
    const ev = pre.evidence.get(payload.evidence_id);
    return this.applyChange(this.base("EVIDENCE_RULED", ev?.motif_id ?? payload.evidence_id, payload, opts));
  }

  // 评审意见：限定专业与司法地域；若基于旧版本，登记冲突。
  addOpinion(payload, opts = {}) {
    const e = this.base("REVIEW_OPINION_ADDED", payload.motif_id, payload, opts);
    const staleness = this.stalenessForBindings(e, payload.basis_versions);
    this.commit(e);
    for (const s of staleness) this.commit(s);
    return this.propagateChange(e);
  }

  setRights(payload, opts = {}) {
    return this.applyChange(this.base("RIGHTS_CONDITION_SET", payload.motif_id, payload, opts));
  }

  withdrawRights(payload, opts = {}) {
    return this.applyChange(this.base("RIGHTS_WITHDRAWN", payload.motif_id, payload, opts));
  }

  setMarketPolicy(payload, opts = {}) {
    return this.applyChange(this.base("MARKET_POLICY_SET", `market:${payload.jurisdiction}`, payload, opts));
  }

  // —— 发布包 ——
  composePackage(payload, opts = {}) {
    return this.commit(this.base("PACKAGE_COMPOSED", payload.package_id, payload, opts));
  }

  deliver(payload, opts = {}) {
    return this.commit(this.base("PACKAGE_DELIVERED", payload.package_id, payload, opts));
  }

  // 批准链：批准本身如实记录；基于旧版本时另发冲突事件，判定层会硬阻断该批准。
  grantApproval(payload, opts = {}) {
    const approval = this.commit(this.base("APPROVAL_GRANTED", payload.package_id, payload, opts));
    const state = this.state();
    const pkg = state.packages.get(payload.package_id);
    if (pkg) {
      const stale = staleLines(payload.basis_versions, pkg.bindings);
      if (stale.length > 0) {
        this.commit(this.base("REVIEW_STALENESS_FLAGGED", payload.package_id, {
          ref_kind: "APPROVAL",
          ref_id: payload.approval_id,
          package_id: payload.package_id,
          basis_versions: { ...payload.basis_versions },
          current_versions: { ...pkg.bindings },
        }, opts));
      }
    }
    // 批准可能补全或修复批准链：重跑传播，让此前因此暂停的包在底层恢复合规时自动恢复。
    this.propagateChange(approval);
    return approval;
  }

  // —— 紧急停用：先停用，补审责任与期限随决定一起保存 ——
  emergencyHalt(payload, opts = {}) {
    const halt = this.commit(this.base("EMERGENCY_HALT", payload.package_id, payload, opts));
    const actions = [halt];
    const state = this.state();
    // 已交付的紧急停用必须进入可追踪的召回/更正，而不是让内容无声消失。
    if (state.deliveries.has(payload.package_id)) {
      actions.push(...this.openRecallFor(payload.package_id, halt.event_id, payload.halted_by, halt.occurred_at, "RECALL"));
    }
    return { halt, actions };
  }

  ruleHaltRework(payload, opts = {}) {
    const ruled = this.commit(this.base("HALT_REWORK_RULED", payload.package_id, payload, opts));
    const actions = [ruled];
    // 补审通过只解除紧急停用本身；是否允许发布仍由完整判定（召回、权利、证据）决定。
    if (payload.decision === "APPROVED") {
      const state = this.state();
      const result = this.evaluate(payload.package_id, state, ruled.occurred_at, { ignoreSuspension: true });
      const suspension = state.suspensions.get(payload.package_id);
      if (result.decision === "ALLOWED" && !(suspension?.active)) {
        actions.push(this.commit(this.base("PACKAGE_RESUMED", payload.package_id, {
          package_id: payload.package_id, resumed_by: payload.reviewer_id,
          note: "补审通过，紧急停用解除",
        }, opts)));
      }
    }
    return { ruled, actions };
  }

  closeRecall(payload, opts = {}) {
    return this.applyChange(this.base("RECALL_CLOSED", payload.package_id, payload, opts));
  }

  // 外部通知通道可能重投。幂等落库；重复通知不产生新事件，也不会再次触发召回。
  notificationReceived({ notification_id, package_id }, opts = {}) {
    const e = this.base("NOTIFICATION_DELIVERED", package_id, { notification_id, package_id }, opts);
    const stored = this.store.append(e, { expectedSeq: this.store.length });
    return { stored, event: e };
  }

  // —— 内部：变化传播 ——
  applyChange(event) {
    this.commit(event);
    return this.propagateChange(event);
  }

  propagateChange(event) {
    const before = fold(this.store.events().filter((x) => x.event_id !== event.event_id), { as_of: event.occurred_at });
    const after = this.state({ as_of: event.occurred_at });
    const impacted = impactedPackages(event, after);
    const actions = [event];

    for (const pkg of impacted) {
      const prev = evaluatePackage(before, pkg, event.occurred_at);
      const next = evaluatePackage(after, pkg, event.occurred_at);
      const delivered = after.deliveries.has(pkg.package_id);

      const hardStop = next.decision === "PROHIBITED" && prev.decision !== "PROHIBITED";
      const deliveredPending = delivered && next.decision === "PENDING_EVIDENCE" && prev.decision === "ALLOWED";

      if (hardStop || deliveredPending) {
        const blocker = next.blockers[0];
        const actor = event.payload.set_by ?? event.payload.withdrawn_by ?? event.payload.reviewer_id ?? "system";
        const suspend = this.commit(this.base("PACKAGE_SUSPENDED", pkg.package_id, {
          package_id: pkg.package_id,
          reason: blocker?.message ?? "发布条件变化，暂停发布",
          cause_event_id: event.event_id,
          suspended_by: actor,
        }, { at: event.occurred_at, event_id: genId("suspend") }));
        actions.push(suspend);

        if (delivered) {
          const type = blocker && RECALL_BLOCKERS.has(blocker.code) ? "RECALL" : "CORRECTION";
          actions.push(...this.openRecallFor(pkg.package_id, event.event_id, actor, event.occurred_at, type));
        }
      }

      // 阻断消除：恢复普通暂停。以"忽略暂停态本身"的底层判定为准——权利/证据类变化
      // 发生时召回可能仍在进行（底层仍被 RECALL_OPEN 拦），而召回关闭事件之后底层即
      // ALLOWED；两种情况都由这里统一解除暂停。紧急停用只能由补审解除，不走此处。
      const suspensionNow = this.state({ as_of: event.occurred_at }).suspensions.get(pkg.package_id);
      if (suspensionNow?.active) {
        const stateNow = this.state({ as_of: event.occurred_at });
        const underlying = this.evaluate(pkg.package_id, stateNow, event.occurred_at, { ignoreSuspension: true });
        const halt = stateNow.halts.get(pkg.package_id);
        const hasOpenRecall = (stateNow.recalls.get(pkg.package_id) ?? []).some((r) => r.closed === null);
        if (!halt?.active && !hasOpenRecall && underlying.decision === "ALLOWED") {
          actions.push(this.commit(this.base("PACKAGE_RESUMED", pkg.package_id, {
            package_id: pkg.package_id, resumed_by: "system",
            cause_event_id: event.event_id,
            note: "阻断条件已消除，自动恢复",
          }, { at: event.occurred_at, event_id: genId("resume") })));
        }
      }
    }
    return { event, actions, impacted: impacted.map((p) => p.package_id) };
  }

  openRecallFor(packageId, causeEventId, actor, at, fallbackType) {
    const state = this.state({ as_of: at });
    const existing = (state.recalls.get(packageId) ?? []).find((r) => r.closed === null);
    if (existing) return []; // 进行中的召回不重复开启
    const type = fallbackType;
    const opened = this.commit(this.base("RECALL_OPENED", packageId, {
      recall_id: genId("recall"),
      package_id: packageId,
      type,
      cause_event_id: causeEventId,
      opened_by: actor,
    }, { at, event_id: genId("recall-open") }));
    return [opened];
  }

  stalenessForBindings(event, basisVersions) {
    const state = this.state({ as_of: event.occurred_at });
    const flags = [];
    for (const pkg of impactedPackages(event, state)) {
      const stale = staleLines(basisVersions, pkg.bindings);
      if (stale.length > 0) {
        flags.push(this.base("REVIEW_STALENESS_FLAGGED", pkg.package_id, {
          ref_kind: "OPINION",
          ref_id: event.payload.opinion_id,
          package_id: pkg.package_id,
          basis_versions: { ...basisVersions },
          current_versions: { ...pkg.bindings },
        }, { at: event.occurred_at, event_id: genId("staleness") }));
      }
    }
    return flags;
  }

  evaluate(packageId, state = this.state(), at = this.clock(), opts = {}) {
    const pkg = state.packages.get(packageId);
    if (!pkg) throw new Error(`发布包不存在：${packageId}`);
    return evaluatePackage(state, pkg, at, opts);
  }
}

function staleLines(basisVersions, bindings) {
  const out = [];
  for (const [line, version] of Object.entries(bindings)) {
    const basis = basisVersions?.[line];
    if (basis !== undefined && basis !== null && basis !== version) out.push(line);
  }
  return out;
}

export { ConcurrencyError };
