import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DECISIONS, createGovernanceService } from "../src/governance.js";

let seq = 0;
function ev(kind, subject_id, payload, occurred_at) {
  seq += 1;
  return { event_id: `t-${seq}`, kind, occurred_at, subject_id, payload };
}

const T = (s) => `2026-06-${s}T09:00:00+08:00`;

// 一条“总部评审已通过”的基线：四条版本链 + 权利条件 + GLOBAL 双专业意见
function baseStream() {
  return [
    ev("MOTIF_PROPOSED", "m1", { title: "云纹" }, T("01")),
    ev("PROVENANCE_RECORDED", "m1", { version: "pv1", source_claim: "馆藏织锦", evidence_refs: ["a1"], recorded_by: "r1" }, T("02")),
    ev("ADAPTATION_RECORDED", "m1", { version: "av1", changes_summary: "线条简化" }, T("03")),
    ev("COPY_RECORDED", "m1", { version: "cv1", locale: "zh-CN", text_ref: "c1" }, T("04")),
    ev("CARRIER_RECORDED", "box1", { version: "cb1", carrier_type: "paper-box" }, T("05")),
    ev("RIGHTS_CONDITION_SET", "m1", { holder: "某博物馆", valid_from: "2026-06-01", valid_until: "2027-05-31", attribution_required: true, prohibitions: [] }, T("06")),
    ev("REVIEW_OPINION_ADDED", "m1", { opinion_id: "op-cul", reviewer: "hq-culture", discipline: "cultural", jurisdiction: "GLOBAL", decision: "approve", base_versions: { provenance: "pv1", adaptation: "av1", copy: "cv1" } }, T("07")),
    ev("REVIEW_OPINION_ADDED", "m1", { opinion_id: "op-leg", reviewer: "hq-legal", discipline: "legal", jurisdiction: "GLOBAL", decision: "approve", base_versions: { provenance: "pv1" } }, T("08")),
  ];
}

function pkgEvent(id, market, extra = {}, at = T("10")) {
  return ev("RELEASE_PACKAGE_APPROVED", id, {
    motif_id: "m1",
    market,
    carrier_id: "box1",
    pinned_versions: { provenance: "pv1", adaptation: "av1", copy: "cv1", carrier: "cb1" },
    approval_chain: ["op-cul", "op-leg"],
    attribution_included: true,
    ...extra,
  }, at);
}

function ingestAll(service, events) {
  return events.map((e) => service.ingest(e));
}

function reasonCodes(precheck) {
  return precheck.blocking_reasons.map((r) => r.code);
}

test("同一素材在不同市场同时处于允许、禁止与不受影响", () => {
  const s = createGovernanceService();
  ingestAll(s, [
    ...baseStream(),
    pkgEvent("pkg-eu", "EU"),
    pkgEvent("pkg-th-alcohol", "TH", { scene: "alcohol" }),
    pkgEvent("pkg-th-food", "TH", { scene: "food" }),
    ev("RIGHTS_CONDITION_SET", "m1", {
      holder: "某博物馆", valid_from: "2026-06-01", valid_until: "2027-05-31", attribution_required: true,
      prohibitions: [{ market: "TH", scene: "alcohol", reason: "宗教含义纹样禁用于酒类包装" }],
    }, T("12")),
  ]);

  const eu = s.precheck("pkg-eu");
  assert.equal(eu.decision, DECISIONS.ALLOWED);

  const thAlcohol = s.precheck("pkg-th-alcohol");
  assert.equal(thAlcohol.decision, DECISIONS.PROHIBITED);
  assert.ok(reasonCodes(thAlcohol).includes("PROHIBITION_MATCHED"));
  assert.match(thAlcohol.blocking_reasons.find((r) => r.code === "PROHIBITION_MATCHED").message, /禁用于酒类/);

  // 同一市场不同场景不受该禁用条件影响
  assert.equal(s.precheck("pkg-th-food").decision, DECISIONS.ALLOWED);
});

test("权利期限参与判定：届满前允许、届满后禁止、法务更新后恢复", () => {
  const s = createGovernanceService();
  ingestAll(s, [...baseStream(), pkgEvent("pkg-eu", "EU")]);

  assert.equal(s.precheck("pkg-eu", { at: "2026-07-01T00:00:00+08:00" }).decision, DECISIONS.ALLOWED);

  const expired = s.precheck("pkg-eu", { at: "2027-06-01T00:00:00+08:00" });
  assert.equal(expired.decision, DECISIONS.PROHIBITED);
  assert.ok(reasonCodes(expired).includes("RIGHTS_EXPIRED"));
  assert.match(expired.blocking_reasons.find((r) => r.code === "RIGHTS_EXPIRED").message, /2027-05-31/);

  // 法务更新权利期限后结论恢复
  s.ingest(ev("RIGHTS_CONDITION_SET", "m1", { holder: "某博物馆", valid_from: "2026-06-01", valid_until: "2028-05-31", attribution_required: true, prohibitions: [] }, "2027-06-15T09:00:00+08:00"));
  assert.equal(s.precheck("pkg-eu").decision, DECISIONS.ALLOWED);
});

test("署名要求参与判定：未署名的发布包被阻断", () => {
  const s = createGovernanceService();
  ingestAll(s, [...baseStream(), pkgEvent("pkg-eu", "EU", { attribution_included: false })]);
  const result = s.precheck("pkg-eu");
  assert.equal(result.decision, DECISIONS.PROHIBITED);
  assert.ok(reasonCodes(result).includes("ATTRIBUTION_MISSING"));
});

test("缺少评审覆盖或权利记录时进入待补证", () => {
  const s = createGovernanceService();
  ingestAll(s, [
    ev("MOTIF_PROPOSED", "m1", { title: "云纹" }, T("01")),
    ev("PROVENANCE_RECORDED", "m1", { version: "pv1", source_claim: "馆藏", evidence_refs: ["a1"], recorded_by: "r1" }, T("02")),
    ev("ADAPTATION_RECORDED", "m1", { version: "av1", changes_summary: "简化" }, T("03")),
    ev("COPY_RECORDED", "m1", { version: "cv1", locale: "zh-CN", text_ref: "c1" }, T("04")),
    ev("CARRIER_RECORDED", "box1", { version: "cb1", carrier_type: "paper-box" }, T("05")),
    ev("REVIEW_OPINION_ADDED", "m1", { opinion_id: "op-cul", reviewer: "x", discipline: "cultural", jurisdiction: "GLOBAL", decision: "approve", base_versions: { provenance: "pv1" } }, T("07")),
    pkgEvent("pkg-eu", "EU"),
  ]);
  const result = s.precheck("pkg-eu");
  assert.equal(result.decision, DECISIONS.PENDING_EVIDENCE);
  assert.ok(reasonCodes(result).includes("REVIEW_MISSING")); // 缺 legal
  assert.ok(reasonCodes(result).includes("RIGHTS_MISSING"));
});

test("并行审校基于旧版本时提示冲突，且旧意见不能覆盖新版本", () => {
  const s = createGovernanceService();
  ingestAll(s, [
    ...baseStream(),
    ev("PROVENANCE_RECORDED", "m1", { version: "pv2", source_claim: "补充馆藏记录", evidence_refs: ["a2"], recorded_by: "r1" }, T("09")),
  ]);

  // 基于 pv1 的迟到意见：当前来源版本已是 pv2
  const late = s.ingest(ev("REVIEW_OPINION_ADDED", "m1", {
    opinion_id: "op-late", reviewer: "jp-culture", discipline: "cultural", jurisdiction: "JP",
    decision: "approve", base_versions: { provenance: "pv1", adaptation: "av1", copy: "cv1" },
  }, T("11")));
  assert.equal(late.effects.conflicts.length, 1);
  assert.deepEqual(late.effects.conflicts[0], {
    opinion_id: "op-late",
    event_id: late.effects.conflicts[0].event_id,
    aspect: "provenance",
    base_version: "pv1",
    current_version: "pv2",
    detected_at: T("11"),
  });
  assert.equal(s.conflicts().length, 1);

  // 钉住 pv2 的发布包：只有基于 pv1 的旧意见 → 评审过期，待补证
  ingestAll(s, [
    ev("RELEASE_PACKAGE_APPROVED", "pkg-jp", {
      motif_id: "m1", market: "JP", carrier_id: "box1",
      pinned_versions: { provenance: "pv2", adaptation: "av1", copy: "cv1", carrier: "cb1" },
      approval_chain: ["op-late"], attribution_included: true,
    }, T("12")),
  ]);
  const result = s.precheck("pkg-jp");
  assert.equal(result.decision, DECISIONS.PENDING_EVIDENCE);
  assert.ok(reasonCodes(result).includes("REVIEW_STALE"));
  // 预检同时向发布人员提示批准链中存在的版本冲突
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].opinion_id, "op-late");
});

test("新来源证据只暂停引用受影响版本的发布", () => {
  const s = createGovernanceService();
  ingestAll(s, [
    ...baseStream(),
    pkgEvent("pkg-a", "EU"),
    ev("RELEASE_PACKAGE_DELIVERED", "pkg-a", { channel: "retail" }, T("11")),
    ev("PROVENANCE_RECORDED", "m1", { version: "pv2", source_claim: "补充记录", evidence_refs: ["a2"], recorded_by: "r1" }, T("12")),
    ev("REVIEW_OPINION_ADDED", "m1", { opinion_id: "op-cul2", reviewer: "hq-culture", discipline: "cultural", jurisdiction: "GLOBAL", decision: "approve", base_versions: { provenance: "pv2", adaptation: "av1", copy: "cv1" } }, T("13")),
    ev("REVIEW_OPINION_ADDED", "m1", { opinion_id: "op-leg2", reviewer: "hq-legal", discipline: "legal", jurisdiction: "GLOBAL", decision: "approve", base_versions: { provenance: "pv2" } }, T("13") ),
    ev("RELEASE_PACKAGE_APPROVED", "pkg-b", {
      motif_id: "m1", market: "EU", carrier_id: "box1",
      pinned_versions: { provenance: "pv2", adaptation: "av1", copy: "cv1", carrier: "cb1" },
      approval_chain: ["op-cul2", "op-leg2"], attribution_included: true,
    }, T("14")),
    ev("RELEASE_PACKAGE_DELIVERED", "pkg-b", { channel: "retail" }, T("14")),
  ]);

  // 研究员提交新证据，仅与 pv1 冲突
  const res = s.ingest(ev("PROVENANCE_RECORDED", "m1", {
    version: "pv3", source_claim: "另一馆藏亦见该纹样，归属待补证", evidence_refs: ["b1"],
    recorded_by: "r2", contradicts_versions: ["pv1"],
  }, T("15")));

  assert.equal(s.precheck("pkg-a").decision, DECISIONS.PENDING_EVIDENCE);
  assert.ok(reasonCodes(s.precheck("pkg-a")).includes("NEW_EVIDENCE_PENDING"));
  assert.equal(s.precheck("pkg-b").decision, DECISIONS.ALLOWED);

  // 只有已交付且受影响的 pkg-a 进入更正跟踪
  assert.equal(res.effects.remediations_opened.length, 1);
  assert.equal(res.effects.remediations_opened[0].package_id, "pkg-a");
  assert.equal(res.effects.remediations_opened[0].mode, "correction");
  assert.equal(s.remediations().length, 1);
});

test("撤权只暂停通知范围内市场的发布", () => {
  const s = createGovernanceService();
  ingestAll(s, [
    ...baseStream(),
    pkgEvent("pkg-eu", "EU"),
    ev("RELEASE_PACKAGE_DELIVERED", "pkg-eu", { channel: "retail" }, T("11")),
    pkgEvent("pkg-th", "TH"),
    ev("RELEASE_PACKAGE_DELIVERED", "pkg-th", { channel: "retail" }, T("11")),
  ]);

  const res = s.ingest(ev("RIGHTS_REVOKED", "m1", {
    notice_id: "n-1", markets: ["TH"], effective_from: "2026-06-20", reason: "授权方终止泰国市场授权",
  }, T("20")));

  assert.equal(s.precheck("pkg-th").decision, DECISIONS.PROHIBITED);
  assert.ok(reasonCodes(s.precheck("pkg-th")).includes("RIGHTS_REVOKED"));
  assert.equal(s.precheck("pkg-eu").decision, DECISIONS.ALLOWED);

  assert.equal(res.effects.remediations_opened.length, 1);
  assert.equal(res.effects.remediations_opened[0].package_id, "pkg-th");
  assert.equal(res.effects.remediations_opened[0].mode, "recall");
});

test("紧急停用先执行并保存补审责任，恢复后结论解除", () => {
  const s = createGovernanceService();
  ingestAll(s, [
    ...baseStream(),
    pkgEvent("pkg-eu", "EU"),
    ev("RELEASE_PACKAGE_DELIVERED", "pkg-eu", { channel: "retail" }, T("11")),
  ]);

  // 缺补审责任/期限的紧急停用不通过校验
  const invalid = s.ingest(ev("RELEASE_SUSPENDED", "pkg-eu", { reason: "舆情风险", emergency: true }, T("12")));
  assert.equal(invalid.ok, false);
  assert.ok(invalid.problems.includes("payload.follow_up"));

  const res = s.ingest(ev("RELEASE_SUSPENDED", "pkg-eu", {
    reason: "舆情风险", emergency: true,
    follow_up: { owner: "review-board", due_at: "2026-07-15" },
  }, T("13")));
  assert.equal(res.ok, true);

  const blocked = s.precheck("pkg-eu");
  assert.equal(blocked.decision, DECISIONS.PROHIBITED);
  const reason = blocked.blocking_reasons.find((r) => r.code === "EMERGENCY_SUSPENDED");
  assert.equal(reason.details.follow_up.owner, "review-board");
  assert.equal(reason.details.follow_up.due_at, "2026-07-15");
  // 已交付内容进入召回跟踪而非消失
  assert.equal(s.remediations({ package_id: "pkg-eu" }).length, 1);

  s.ingest(ev("RELEASE_REINSTATED", "pkg-eu", { reason: "补审通过" }, T("16")));
  assert.equal(s.precheck("pkg-eu").decision, DECISIONS.ALLOWED);
});

test("重复通知不得再次触发召回", () => {
  const s = createGovernanceService();
  ingestAll(s, [
    ...baseStream(),
    pkgEvent("pkg-th", "TH"),
    ev("RELEASE_PACKAGE_DELIVERED", "pkg-th", { channel: "retail" }, T("11")),
    ev("RIGHTS_REVOKED", "m1", { notice_id: "n-1", markets: ["TH"], effective_from: "2026-06-12", reason: "终止授权" }, T("12")),
  ]);
  assert.equal(s.remediations().length, 1);

  // 同一通知号再次到达（不同事件 ID）：不重复触发
  const dup = s.ingest(ev("RIGHTS_REVOKED", "m1", { notice_id: "n-1", markets: ["TH"], effective_from: "2026-06-12", reason: "终止授权" }, T("13")));
  assert.equal(dup.effects.notice_duplicate, true);
  assert.equal(dup.effects.remediations_opened.length, 0);
  assert.equal(s.remediations().length, 1);

  // 召回完成后，重复通知仍不得再次触发
  s.ingest(ev("RECALL_UPDATED", "pkg-th", { notice_id: "n-1", status: "completed" }, T("14")));
  const again = s.ingest(ev("RIGHTS_REVOKED", "m1", { notice_id: "n-1", markets: ["TH"], effective_from: "2026-06-12", reason: "终止授权" }, T("15")));
  assert.equal(again.effects.remediations_opened.length, 0);
  assert.equal(s.remediations().length, 1);

  // 手工重复开立同一通知的召回也会被去重
  const manual = s.ingest(ev("RECALL_OPENED", "pkg-th", { notice_id: "n-1", mode: "recall", reason: "重复登记" }, T("16")));
  assert.equal(manual.effects.warnings.length, 1);
  assert.equal(s.remediations().length, 1);

  // 重复事件 ID 直接幂等忽略
  const sameEvent = ev("RIGHTS_REVOKED", "m1", { notice_id: "n-2", markets: ["TH"], effective_from: "2026-06-12", reason: "x" }, T("17"));
  s.ingest(sameEvent);
  assert.equal(s.ingest(sameEvent).duplicate, true);
});

test("召回/更正全程可追踪，已交付内容不消失", () => {
  const s = createGovernanceService();
  ingestAll(s, [
    ...baseStream(),
    pkgEvent("pkg-th", "TH"),
    ev("RELEASE_PACKAGE_DELIVERED", "pkg-th", { channel: "retail" }, T("11")),
    ev("RIGHTS_REVOKED", "m1", { notice_id: "n-1", markets: ["TH"], effective_from: "2026-06-12", reason: "终止授权" }, T("12")),
  ]);

  s.ingest(ev("RECALL_UPDATED", "pkg-th", { notice_id: "n-1", status: "acknowledged" }, T("13")));
  s.ingest(ev("RECALL_UPDATED", "pkg-th", { notice_id: "n-1", status: "in_progress", note: "渠道已下架 80%" }, T("14")));

  const [record] = s.remediations({ package_id: "pkg-th" });
  assert.equal(record.status, "in_progress");
  assert.deepEqual(record.history.map((h) => h.status), ["open", "acknowledged", "in_progress"]);

  // 发布包与事件流仍然完整可查
  const view = s.precheck("pkg-th");
  assert.equal(view.ok, true);
  assert.equal(view.open_remediations.length, 1);
  assert.ok(s.eventLog().some((e) => e.kind === "RELEASE_PACKAGE_DELIVERED"));
});

test("预检返回具体阻断理由", () => {
  const s = createGovernanceService();
  ingestAll(s, [
    ...baseStream(),
    pkgEvent("pkg-th", "TH", { scene: "alcohol" }),
    ev("RIGHTS_CONDITION_SET", "m1", {
      holder: "某博物馆", valid_from: "2026-06-01", valid_until: "2027-05-31", attribution_required: true,
      prohibitions: [{ market: "TH", scene: "alcohol", reason: "宗教含义纹样禁用于酒类包装" }],
    }, T("12")),
  ]);
  const result = s.precheck("pkg-th");
  assert.equal(result.decision, DECISIONS.PROHIBITED);
  const reason = result.blocking_reasons.find((r) => r.code === "PROHIBITION_MATCHED");
  assert.ok(reason);
  assert.match(reason.message, /市场 TH/);
  assert.equal(reason.details.prohibition.reason, "宗教含义纹样禁用于酒类包装");
});

test("审计可按过去时间点复原获准原因与改变结论的事件", () => {
  const s = createGovernanceService();
  ingestAll(s, [
    ...baseStream(),
    pkgEvent("pkg-eu", "EU"),
    ev("RELEASE_PACKAGE_DELIVERED", "pkg-eu", { channel: "retail" }, T("11")),
  ]);
  const revoke = ev("RIGHTS_REVOKED", "m1", { notice_id: "n-9", markets: ["EU"], effective_from: "2026-06-20", reason: "授权方终止授权" }, T("20"));
  s.ingest(revoke);

  // 复原获准当时：批准链、权利条件、钉住版本
  const before = s.explainAt("pkg-eu", "2026-06-15T00:00:00+08:00");
  assert.equal(before.decision, DECISIONS.ALLOWED);
  assert.deepEqual(before.applicable_opinions.map((o) => o.opinion_id).sort(), ["op-cul", "op-leg"]);
  assert.equal(before.rights.condition.holder, "某博物馆");
  assert.equal(before.pinned_versions.provenance, "pv1");

  // 复原撤权之后
  const after = s.explainAt("pkg-eu", "2026-06-21T00:00:00+08:00");
  assert.equal(after.decision, DECISIONS.PROHIBITED);
  assert.ok(after.blocking_reasons.some((r) => r.code === "RIGHTS_REVOKED"));

  // 结论变化轨迹：哪次事件改变了结论
  const trail = s.auditTrail("pkg-eu");
  assert.equal(trail[0].to, DECISIONS.ALLOWED);
  assert.equal(trail[0].from, null);
  const last = trail[trail.length - 1];
  assert.equal(last.from, DECISIONS.ALLOWED);
  assert.equal(last.to, DECISIONS.PROHIBITED);
  assert.equal(last.event_id, revoke.event_id);
  assert.equal(last.kind, "RIGHTS_REVOKED");
});

test("样例事件流端到端演绎总部过审后的分市场治理", async () => {
  const stream = JSON.parse(await readFile(new URL("../data/sample_stream.json", import.meta.url), "utf8"));
  const s = createGovernanceService();
  const results = ingestAll(s, stream);
  assert.ok(results.every((r) => r.ok), "样例事件流应全部受理");

  // 欧盟市场：新来源证据与钉住版本冲突 → 待补证；已交付 → 更正跟踪
  const eu = s.precheck("pkg-eu");
  assert.equal(eu.decision, DECISIONS.PENDING_EVIDENCE);
  assert.ok(reasonCodes(eu).includes("NEW_EVIDENCE_PENDING"));
  assert.equal(s.remediations({ package_id: "pkg-eu" })[0].mode, "correction");

  // 泰国市场：当地顾问否决 + 法务禁用条件 → 禁止
  const th = s.precheck("pkg-th");
  assert.equal(th.decision, DECISIONS.PROHIBITED);
  assert.ok(reasonCodes(th).includes("PROHIBITION_MATCHED"));
  assert.ok(reasonCodes(th).includes("REVIEW_REJECTED"));

  // st-015 基于旧来源版本 pv1（当时已是 pv2）→ 冲突提示
  assert.ok(s.conflicts().some((c) => c.opinion_id === "op-th-legal" && c.aspect === "provenance" && c.current_version === "pv2"));

  // 审计复原：pkg-eu 在证据提交前获准，st-014 改变结论
  const trail = s.auditTrail("pkg-eu");
  assert.equal(trail[0].to, DECISIONS.ALLOWED);
  const turned = trail.find((t) => t.to === DECISIONS.PENDING_EVIDENCE);
  assert.equal(turned.event_id, "st-014");
});
