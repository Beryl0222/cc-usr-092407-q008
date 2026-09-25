// 分市场判定引擎。
//
// evaluatePackage 是纯函数：给定"截至某时刻折叠出的状态"与一个发布包，回答
// 该包在其目标市场此刻是 ALLOWED / PENDING_EVIDENCE / PROHIBITED，并给出
// 每条结论引用的事实（事件号、版本号、批准、权利期限），审计据此复原"当时为何获准"。
//
// 判定分两层：
//   1. 事实层：四线版本状态、市场域权利（期限/署名/禁用用途）、市场证据政策、
//      限定专业与司法地域的评审意见、批准链是否基于当前绑定版本；
//   2. 运行层：暂停、紧急停用（含补审责任与期限）、进行中的召回/更正。
// 任一硬阻断 => PROHIBITED；否则有待补证项 => PENDING_EVIDENCE；否则 ALLOWED。

import { DECISIONS, ELEMENT_LINES, REASON_CODES, WARNING_CODES } from "./art_motif_review.js";
import { activeRecall, activeRightsAt, currentVersions, findVersion } from "./projection.js";

function reason(code, severity, detail = {}, message = null) {
  return { code, severity, message, ...detail };
}

function opinionApplies(opinion, market) {
  return opinion.jurisdiction === null || opinion.jurisdiction === market;
}

function basisStale(basisVersions, bindings) {
  const staleLines = [];
  for (const line of ELEMENT_LINES) {
    const basis = basisVersions?.[line];
    if (basis !== undefined && basis !== null && basis !== bindings[line]) staleLines.push(line);
  }
  return staleLines;
}

function evidenceMatches(ev, motifId, market, requirement) {
  if (ev.motif_id !== motifId) return false;
  if (ev.jurisdiction !== null && ev.jurisdiction !== market) return false;
  if (requirement.line && ev.line !== requirement.line) return false;
  if (requirement.discipline && ev.discipline !== requirement.discipline) return false;
  return true;
}

function versionCarriesAttribution(version) {
  if (!version) return false;
  if (version.attribution_present === true) return true;
  return typeof version.attribution_text === "string" && version.attribution_text.trim() !== "";
}

function carrierTags(version) {
  const tags = version?.use_tags ?? [];
  return tags.map((t) => (typeof t === "string" ? t : t?.tag)).filter(Boolean);
}

function prohibitedTagSet(uses) {
  return (uses ?? []).map((u) => (typeof u === "string" ? u : u?.tag ?? u?.use)).filter(Boolean);
}

// at: 判定时刻（ISO 字符串）。state 应当由 fold(events, { as_of: at }) 得到。
// ignoreSuspension 仅供生命周期在判断"暂停能否解除"时使用：暂停态本身不应阻止
// 对底层合规性的复查；召回与紧急停用仍照常计入。
export function evaluatePackage(state, pkg, at, { ignoreSuspension = false } = {}) {
  const blockers = [];
  const pendings = [];
  const warnings = [];
  const basis = { versions: {}, rights: null, evidence: [], opinions: [], approvals: [] };
  const { motif_id: motifId, market, bindings, required_disciplines: disciplines } = pkg;

  // —— 运行层门禁 ——
  const halt = state.halts.get(pkg.package_id);
  if (halt?.active) {
    blockers.push(reason(REASON_CODES.PACKAGE_HALTED, "BLOCK", {
      halted_at: halt.at, halted_by: halt.by, halt_event_id: halt.event_id, reason_text: halt.reason,
      rework_owner: halt.rework_owner, rework_due_at: halt.rework_due_at,
    }, `紧急停用中：${halt.reason}`));
    if (halt.rework_due_at && Date.parse(halt.rework_due_at) < Date.parse(at) && !halt.rework) {
      blockers.push(reason(REASON_CODES.REWORK_OVERDUE, "BLOCK", {
        rework_owner: halt.rework_owner, rework_due_at: halt.rework_due_at,
      }, "补审已逾期，责任人未在期限内完成补审"));
    }
  }

  const suspension = state.suspensions.get(pkg.package_id);
  if (suspension?.active && !ignoreSuspension) {
    blockers.push(reason(REASON_CODES.PACKAGE_SUSPENDED, "BLOCK", {
      suspended_at: suspension.at, suspended_by: suspension.by, cause_event_id: suspension.cause_event_id,
      reason_text: suspension.reason,
    }, `发布已暂停：${suspension.reason}`));
  }

  const recall = activeRecall(state, pkg.package_id);
  if (recall) {
    blockers.push(reason(REASON_CODES.RECALL_OPEN, "BLOCK", {
      recall_id: recall.recall_id, recall_type: recall.type, opened_at: recall.opened_at,
      cause_event_id: recall.cause_event_id,
    }, `已交付内容处于${recall.type === "CORRECTION" ? "更正" : "召回"}流程`));
  }

  // —— 绑定的四线版本 ——
  const boundVersions = {};
  for (const line of ELEMENT_LINES) {
    const versionId = bindings[line];
    const v = versionId ? findVersion(state, motifId, line, versionId) : null;
    boundVersions[line] = v;
    basis.versions[line] = v
      ? { version_id: v.version_id, status: v.status, event_id: v.event_id, recorded_at: v.recorded_at }
      : { version_id: versionId ?? null, status: "MISSING", event_id: null };
    if (!v || v.status === "SUSPENDED") {
      blockers.push(reason(REASON_CODES.VERSION_SUSPENDED, "BLOCK", {
        line, version_id: versionId ?? null,
      }, v ? `${line} 线绑定版本已停用` : `${line} 线绑定版本不存在`));
    } else {
      const current = currentVersions(state, motifId);
      if (current[line] && current[line] !== versionId) {
        warnings.push(reason(WARNING_CODES.NEWER_VERSION_AVAILABLE, "WARN", {
          line, bound_version: versionId, current_version: current[line],
        }, `${line} 线已有更新版本，当前发布包仍使用旧版`));
      }
    }
  }

  // —— 市场域权利：期限、署名、禁用用途 ——
  const rights = activeRightsAt(state, motifId, market, at);
  const rightsRecord = state.rights.get(`${motifId}|${market}`);
  if (rightsRecord?.withdrawn) {
    blockers.push(reason(REASON_CODES.RIGHTS_WITHDRAWN, "BLOCK", {
      jurisdiction: market, withdrawn_at: rightsRecord.withdrawn.at, withdrawn_by: rightsRecord.withdrawn.by,
      event_id: rightsRecord.withdrawn.event_id, reason_text: rightsRecord.withdrawn.reason,
    }, `该市场权利已撤回${rightsRecord.withdrawn.reason ? `：${rightsRecord.withdrawn.reason}` : ""}`));
  } else if (!rights) {
    const startsLater = rightsRecord?.terms.find((t) => Date.parse(t.effective_at) > Date.parse(at));
    blockers.push(reason(startsLater ? REASON_CODES.RIGHTS_NOT_YET_STARTED : REASON_CODES.RIGHTS_NOT_GRANTED, "BLOCK", {
      jurisdiction: market,
      effective_at: startsLater?.effective_at ?? null,
    }, startsLater ? "授权尚未生效" : "该司法地域从未设定权利条件"));
  } else {
    basis.rights = {
      jurisdiction: market,
      effective_at: rights.term.effective_at,
      expires_at: rights.term.expires_at,
      attribution_required: rights.term.attribution_required,
      prohibited_uses: rights.term.prohibited_uses,
      event_id: rights.term.event_id,
    };
    if (rights.term.expires_at && Date.parse(rights.term.expires_at) < Date.parse(at)) {
      blockers.push(reason(REASON_CODES.RIGHTS_TERM_EXPIRED, "BLOCK", {
        jurisdiction: market, expired_at: rights.term.expires_at, event_id: rights.term.event_id,
      }, `权利期限已于 ${rights.term.expires_at} 届满`));
    }
    if (rights.term.attribution_required && !versionCarriesAttribution(boundVersions.copy)) {
      blockers.push(reason(REASON_CODES.ATTRIBUTION_MISSING, "BLOCK", {
        jurisdiction: market, line: "copy", required: true, event_id: rights.term.event_id,
      }, "权利条件要求署名，但绑定的解释文案版本未包含署名"));
    }
    const forbidden = prohibitedTagSet(rights.term.prohibited_uses);
    const tags = carrierTags(boundVersions.carrier);
    const hit = tags.filter((t) => forbidden.includes(t));
    if (hit.length > 0) {
      blockers.push(reason(REASON_CODES.PROHIBITED_USE_MATCH, "BLOCK", {
        jurisdiction: market, matched_uses: hit, line: "carrier", event_id: rights.term.event_id,
      }, `载体用途命中该市场禁用条件：${hit.join("、")}`));
    }
  }

  // —— 市场证据政策：逐线要求已采信证据 ——
  const policy = state.policies.get(market);
  const requirements = policy?.required_evidence ?? [];
  for (const raw of requirements) {
    const requirement = typeof raw === "string" ? { line: raw } : raw;
    const matches = [...state.evidence.values()].filter((ev) => evidenceMatches(ev, motifId, market, requirement));
    basis.evidence.push(...matches.map((ev) => ({
      evidence_id: ev.evidence_id, status: ev.status, line: ev.line, event_id: ev.event_id,
    })));
    const accepted = matches.find((ev) => ev.status === "ACCEPTED");
    if (accepted) continue;
    const rejected = matches.find((ev) => ev.status === "REJECTED");
    const pending = matches.find((ev) => ev.status === "SUBMITTED");
    if (rejected) {
      blockers.push(reason(REASON_CODES.EVIDENCE_REJECTED, "BLOCK", {
        jurisdiction: market, line: requirement.line ?? null, evidence_id: rejected.evidence_id,
        ruling_event_id: rejected.ruling?.event_id ?? null,
      }, `${requirement.line ?? "所需"}证据未被采信`));
    } else if (pending) {
      pendings.push(reason(REASON_CODES.EVIDENCE_PENDING, "PENDING", {
        jurisdiction: market, line: requirement.line ?? null, evidence_id: pending.evidence_id,
        submitted_at: pending.submitted_at,
      }, "新证据已提交，等待裁定"));
    } else {
      pendings.push(reason(REASON_CODES.EVIDENCE_MISSING, "PENDING", {
        jurisdiction: market, line: requirement.line ?? null,
      }, `该市场政策要求的${requirement.line ? `${requirement.line}线` : ""}证据尚缺`));
    }
  }

  // —— 评审意见：限定专业范围与司法地域 ——
  // 同一评审人在同一专业/地域范围更新意见时，以最新意见为准（顾问可以撤销或改写结论）。
  const effectiveOpinions = new Map();
  for (const opinion of state.opinions) {
    effectiveOpinions.set(
      `${opinion.motif_id}|${opinion.reviewer_id}|${opinion.discipline}|${opinion.jurisdiction ?? "*"}`,
      opinion,
    );
  }
  for (const opinion of effectiveOpinions.values()) {
    if (opinion.motif_id !== motifId || !opinionApplies(opinion, market)) continue;
    const staleLines = basisStale(opinion.basis_versions, bindings);
    const info = {
      opinion_id: opinion.opinion_id, discipline: opinion.discipline,
      jurisdiction: opinion.jurisdiction, event_id: opinion.event_id,
      basis_versions: opinion.basis_versions, stale_lines: staleLines,
    };
    basis.opinions.push(info);
    const stale = staleLines.length > 0;
    if (opinion.decision === "PROHIBIT" && !stale) {
      blockers.push(reason(REASON_CODES.OPINION_PROHIBITION, "BLOCK", info,
        `${opinion.discipline}专业意见在${opinion.jurisdiction ?? "通用"}范围判定禁止`));
    } else if (opinion.decision === "PROHIBIT" && stale) {
      // 基于旧版本的禁止意见不能阻断新版本发布，但必须在复审前保持待补证。
      pendings.push(reason(REASON_CODES.OPINION_CONCERN, "PENDING", { ...info, original_decision: "PROHIBIT" },
        `${opinion.discipline}专业的禁止意见基于旧版本（${staleLines.join("、")}），须按当前版本复审`));
    } else if (opinion.decision === "CONCERN") {
      pendings.push(reason(REASON_CODES.OPINION_CONCERN, "PENDING", info,
        `${opinion.discipline}专业意见提出疑虑${stale ? "（基于旧版本，待复审）" : ""}`));
    }
  }

  // —— 批准链：专业齐全且基于当前绑定版本 ——
  const chain = state.approvalsByPackage.get(pkg.package_id) ?? [];
  basis.approvals = chain.map((a) => ({
    approval_id: a.approval_id, discipline: a.discipline, reviewer_id: a.reviewer_id,
    basis_versions: a.basis_versions, event_id: a.event_id, at: a.at,
  }));
  for (const discipline of disciplines ?? []) {
    const grants = chain.filter((a) => a.discipline === discipline);
    const latest = grants[grants.length - 1];
    if (!latest) {
      blockers.push(reason(REASON_CODES.APPROVAL_CHAIN_INCOMPLETE, "BLOCK", {
        missing_discipline: discipline,
      }, `批准链缺少必要专业：${discipline}`));
      continue;
    }
    const staleLines = basisStale(latest.basis_versions, bindings);
    if (staleLines.length > 0) {
      blockers.push(reason(REASON_CODES.APPROVAL_BASED_ON_STALE_VERSION, "BLOCK", {
        discipline, approval_id: latest.approval_id, stale_lines: staleLines,
        approval_event_id: latest.event_id,
      }, `${discipline}专业的批准基于旧版本（${staleLines.join("、")}），需按当前版本复审`));
    }
  }

  // —— 并行审校冲突提示（非阻断，硬阻断已在批准/意见层体现） ——
  for (const flag of state.stalenessFlags) {
    if (flag.package_id && flag.package_id !== pkg.package_id) continue;
    if (flag.ref_kind === "OPINION" && !basis.opinions.some((o) => o.opinion_id === flag.ref_id)) continue;
    warnings.push(reason(WARNING_CODES.PARALLEL_REVIEW_STALE, "WARN", {
      ref_kind: flag.ref_kind, ref_id: flag.ref_id, event_id: flag.event_id,
      basis_versions: flag.basis_versions, current_versions: flag.current_versions,
    }, "并行审校基于旧版本，已登记版本冲突"));
  }

  const decision = blockers.length > 0
    ? DECISIONS.PROHIBITED
    : pendings.length > 0
      ? DECISIONS.PENDING_EVIDENCE
      : DECISIONS.ALLOWED;

  return {
    package_id: pkg.package_id,
    motif_id: motifId,
    market,
    at,
    decision,
    blockers,
    pendings,
    warnings,
    basis,
    delivered: state.deliveries.has(pkg.package_id)
      ? state.deliveries.get(pkg.package_id)
      : null,
  };
}

// 受某次变化影响的发布包。rights/evidence/version/opinion 等变化只应暂停真正受影响的包：
// - 市场域权利 / 政策 / 证据 / 意见变化：同素材同市场；
// - 版本停用：绑定该版本（可能跨市场）的全部包。
export function impactedPackages(changeEvent, state) {
  const p = changeEvent.payload ?? {};
  const packages = [...state.packages.values()];
  const sameMotifAndMarket = (pkg, motifId, market) =>
    pkg.motif_id === motifId && (market === null || market === undefined || market === pkg.market);

  switch (changeEvent.kind) {
    case "RIGHTS_CONDITION_SET":
    case "RIGHTS_WITHDRAWN":
      return packages.filter((pkg) => sameMotifAndMarket(pkg, p.motif_id, p.jurisdiction));

    case "MARKET_POLICY_SET":
      return packages.filter((pkg) => pkg.market === p.jurisdiction);

    case "EVIDENCE_SUBMITTED":
    case "EVIDENCE_RULED": {
      const ev = state.evidence.get(p.evidence_id);
      if (!ev) return [];
      return packages.filter((pkg) => sameMotifAndMarket(pkg, ev.motif_id, ev.jurisdiction));
    }

    case "REVIEW_OPINION_ADDED":
      return packages.filter((pkg) => sameMotifAndMarket(pkg, p.motif_id, p.jurisdiction));

    // 版本停用可能跨市场：绑定该版本（任一线）的全部包。
    case "VERSION_SUSPENDED":
      return packages.filter((pkg) =>
        pkg.motif_id === p.motif_id && Object.values(pkg.bindings).includes(p.version_id));

    // 新版本出现本身不触发暂停，只产生"有新版可用"的提示。
    case "ELEMENT_VERSION_RECORDED":
      return [];

    default:
      return packages.filter((pkg) => pkg.package_id === p.package_id);
  }
}

// 同一素材跨市场一览：同一素材在不同市场可同时 ALLOWED / PENDING_EVIDENCE / PROHIBITED。
export function marketOverview(state, motifId, at) {
  return [...state.packages.values()]
    .filter((pkg) => pkg.motif_id === motifId)
    .map((pkg) => {
      const r = evaluatePackage(state, pkg, at);
      return { package_id: pkg.package_id, market: pkg.market, decision: r.decision, blockers: r.blockers, pendings: r.pendings };
    })
    .sort((a, b) => a.market.localeCompare(b.market));
}
