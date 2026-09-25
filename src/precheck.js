// 发布预检接口：面向发布人员，回答"这个包此刻能不能发"，并在不能发时给出
// 具体阻断理由（哪条权利、哪天到期、哪个版本被停用、缺哪条证据、哪条批准基于旧版）。

import { DECISIONS } from "./art_motif_review.js";
import { evaluatePackage } from "./governance.js";
import { fold } from "./projection.js";

const LINE_LABELS = Object.freeze({ source: "来源", redraw: "改绘", copy: "解释文案", carrier: "载体" });

export function lineLabel(line) {
  return LINE_LABELS[line] ?? line;
}

// events：完整事件流（或某服务的 store.events()）。
export function precheck(events, packageId, at = new Date().toISOString()) {
  const state = fold(events, { as_of: at });
  const pkg = state.packages.get(packageId);
  if (!pkg) {
    return {
      package_id: packageId, at, deliverable: false, decision: "UNKNOWN",
      blocking_reasons: [{ code: "PACKAGE_NOT_FOUND", message: `发布包不存在：${packageId}` }],
      pending_items: [], warnings: [],
    };
  }
  const result = evaluatePackage(state, pkg, at);
  return {
    package_id: packageId,
    motif_id: result.motif_id,
    market: result.market,
    at,
    deliverable: result.decision === DECISIONS.ALLOWED,
    decision: result.decision,
    delivered: result.delivered,
    blocking_reasons: result.blockers.map((r) => ({ code: r.code, message: r.message, details: stripMessage(r) })),
    pending_items: result.pendings.map((r) => ({ code: r.code, message: r.message, details: stripMessage(r) })),
    warnings: result.warnings.map((r) => ({ code: r.code, message: r.message, details: stripMessage(r) })),
    // 发布时实际使用的版本与批准链随结论一起返回，方便复核留痕。
    release_snapshot: {
      bindings: pkg.bindings,
      required_disciplines: pkg.required_disciplines,
      rights: result.basis.rights,
      approval_event_ids: result.basis.approvals.map((a) => a.event_id),
      version_event_ids: Object.fromEntries(
        Object.entries(result.basis.versions).map(([line, v]) => [line, v.event_id]),
      ),
    },
  };
}

// 给发布人员看的纯文本摘要（终端/工单可直接引用）。
export function renderPrecheck(report) {
  const lines = [];
  const status = {
    ALLOWED: "允许发布",
    PENDING_EVIDENCE: "待补证，暂缓发布",
    PROHIBITED: "禁止发布",
    UNKNOWN: "无法判定",
  }[report.decision] ?? report.decision;
  lines.push(`[${report.decision}] ${report.package_id} @ ${report.market ?? "?"}：${status}`);
  for (const r of report.blocking_reasons) lines.push(`  阻断 ${r.code}：${r.message}`);
  for (const r of report.pending_items) lines.push(`  待补 ${r.code}：${r.message}`);
  for (const w of report.warnings) lines.push(`  提示 ${w.code}：${w.message}`);
  return lines.join("\n");
}

function stripMessage(reason) {
  const { code, severity, message, ...details } = reason;
  return details;
}
