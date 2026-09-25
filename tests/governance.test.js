import assert from "node:assert/strict";
import test from "node:test";

import { ConcurrencyError, EventStore } from "../src/event_store.js";
import { DECISIONS, REASON_CODES, validateEvent } from "../src/art_motif_review.js";
import { GovernanceService } from "../src/lifecycle.js";
import { precheck, renderPrecheck } from "../src/precheck.js";
import { explainChange, reconstructAt, renderAudit } from "../src/audit.js";
import { marketOverview } from "../src/governance.js";

// 虚构素材"云雷纹"m-1，三个市场包：DE（已交付）、JP、FR。
const T = (day, hh = "10:00") => `2026-09-${String(day).padStart(2, "0")}T${hh}:00+08:00`;

function buildWorld() {
  const svc = new GovernanceService();
  const at = (day, hh) => ({ at: T(day, hh) });
  const put = (e) => svc.commit(e);

  put(svc.base("MOTIF_PROPOSED", "m-1", { motif_id: "m-1", name: "虚构云雷纹" }, at(1, "09:00")));

  // 四线版本各自独立演进。
  svc.recordVersion({ motif_id: "m-1", line: "source", version_id: "s1", origin: "馆藏拓片（虚构）" }, at(1, "09:10"));
  svc.recordVersion({ motif_id: "m-1", line: "redraw", version_id: "r1" }, at(1, "09:20"));
  svc.recordVersion({ motif_id: "m-1", line: "copy", version_id: "c1", attribution_present: false }, at(1, "09:30"));
  svc.recordVersion({ motif_id: "m-1", line: "copy", version_id: "c2", attribution_present: true, attribution_text: "© 虚构馆藏" }, at(1, "09:35"));
  svc.recordVersion({ motif_id: "m-1", line: "carrier", version_id: "k-food", use_tags: ["FOOD"] }, at(1, "09:40"));
  svc.recordVersion({ motif_id: "m-1", line: "carrier", version_id: "k-alcohol", use_tags: ["ALCOHOL"] }, at(1, "09:45"));

  // 市场域权利：期限、署名、禁用用途各自设定。
  svc.setRights({ motif_id: "m-1", jurisdiction: "DE", set_by: "legal-hq", effective_at: T(1), expires_at: "2028-12-31T00:00:00+08:00", attribution_required: false, prohibited_uses: [] }, at(2));
  svc.setRights({ motif_id: "m-1", jurisdiction: "JP", set_by: "legal-hq", effective_at: T(1), expires_at: "2028-12-31T00:00:00+08:00", attribution_required: true, prohibited_uses: [] }, at(2));
  svc.setRights({ motif_id: "m-1", jurisdiction: "FR", set_by: "legal-hq", effective_at: T(1), expires_at: "2028-12-31T00:00:00+08:00", attribution_required: false, prohibited_uses: [{ tag: "ALCOHOL" }] }, at(2));

  // JP 市场政策要求来源线证据。
  svc.setMarketPolicy({ jurisdiction: "JP", required_evidence: [{ line: "source" }] }, at(2));

  // 三个发布包各自固化使用的版本与必要专业。
  const bindings = (carrier, copy) => ({ source: "s1", redraw: "r1", copy, carrier });
  svc.composePackage({ package_id: "pkg-de", motif_id: "m-1", market: "DE", bindings: bindings("k-food", "c1"), required_disciplines: ["cultural_advisor", "legal"], composed_by: "ops" }, at(3));
  svc.composePackage({ package_id: "pkg-jp", motif_id: "m-1", market: "JP", bindings: bindings("k-food", "c2"), required_disciplines: ["cultural_advisor", "legal"], composed_by: "ops" }, at(3));
  svc.composePackage({ package_id: "pkg-fr", motif_id: "m-1", market: "FR", bindings: bindings("k-alcohol", "c1"), required_disciplines: ["cultural_advisor", "legal"], composed_by: "ops" }, at(3));

  // 总部评审：两专业批准链，均基于各包绑定版本。
  for (const pkg of ["pkg-de", "pkg-jp", "pkg-fr"]) {
    const b = svc.state().packages.get(pkg).bindings;
    svc.grantApproval({ approval_id: `ap-${pkg}-cult`, package_id: pkg, discipline: "cultural_advisor", reviewer_id: "hq-cult", basis_versions: { ...b } }, at(4));
    svc.grantApproval({ approval_id: `ap-${pkg}-legal`, package_id: pkg, discipline: "legal", reviewer_id: "hq-legal", basis_versions: { ...b } }, at(4));
  }

  // DE 已交付上市。
  svc.deliver({ package_id: "pkg-de", delivered_by: "ops" }, at(5));
  return { svc };
}

test("同一素材在不同市场同时处于允许 / 待补证 / 禁止", () => {
  const { svc } = buildWorld();
  // JP 研究员先补来源证据。
  svc.submitEvidence({ evidence_id: "ev-jp-1", motif_id: "m-1", line: "source", jurisdiction: "JP", submitted_by: "researcher" }, { at: T(6) });

  const de = precheck(svc.store.events(), "pkg-de", T(7));
  const jp = precheck(svc.store.events(), "pkg-jp", T(7));
  const fr = precheck(svc.store.events(), "pkg-fr", T(7));

  assert.equal(de.decision, DECISIONS.ALLOWED);
  assert.equal(jp.decision, DECISIONS.PENDING_EVIDENCE);
  assert.match(jp.pending_items[0].message, /等待裁定/);
  assert.equal(fr.decision, DECISIONS.PROHIBITED);
  assert.equal(fr.blocking_reasons[0].code, REASON_CODES.PROHIBITED_USE_MATCH);
  assert.deepEqual(fr.blocking_reasons[0].details.matched_uses, ["ALCOHOL"]);
  assert.match(renderPrecheck(fr), /PROHIBITED_USE_MATCH/);

  // 证据采信后 JP 转允许。
  svc.ruleEvidence({ evidence_id: "ev-jp-1", accepted: true, reviewer_id: "legal-jp" }, { at: T(8) });
  assert.equal(precheck(svc.store.events(), "pkg-jp", T(8)).decision, DECISIONS.ALLOWED);
});

test("当地顾问在 DE 指出禁用场景：已交付包暂停并进入可追踪召回", () => {
  const { svc } = buildWorld();
  const result = svc.addOpinion({
    opinion_id: "op-de-1", motif_id: "m-1", reviewer_id: "local-de-advisor",
    discipline: "cultural_advisor", jurisdiction: "DE", decision: "PROHIBIT",
    basis_versions: { ...svc.state().packages.get("pkg-de").bindings },
    note: "当地节庆禁用场景",
  }, { at: T(10) });

  // 只有 DE 包受影响；意见限定司法地域，不波及 JP/FR。
  assert.deepEqual(result.impacted.sort(), ["pkg-de"]);

  const de = precheck(svc.store.events(), "pkg-de", T(10, "11:00"));
  assert.equal(de.decision, DECISIONS.PROHIBITED);
  assert.ok(de.blocking_reasons.some((r) => r.code === REASON_CODES.OPINION_PROHIBITION));
  assert.ok(de.blocking_reasons.some((r) => r.code === REASON_CODES.PACKAGE_SUSPENDED));

  const state = svc.state();
  const recall = state.recalls.get("pkg-de").at(-1);
  assert.equal(recall.type, "RECALL");
  assert.equal(recall.cause_event_id, result.event.event_id);
  assert.equal(recall.closed, null);
});

test("法务更新权利期限：届满成为具体阻断理由，暂停仅限已恶化的包", () => {
  const { svc } = buildWorld();
  // 09-10 顾问先叫停 DE（带召回）。
  svc.addOpinion({
    opinion_id: "op-de-1", motif_id: "m-1", reviewer_id: "local-de-advisor",
    discipline: "cultural_advisor", jurisdiction: "DE", decision: "PROHIBIT",
    basis_versions: { ...svc.state().packages.get("pkg-de").bindings },
  }, { at: T(10) });

  // 09-15 法务把 DE 期限更新为 09-14 即届满。
  const r = svc.setRights({
    motif_id: "m-1", jurisdiction: "DE", set_by: "legal-hq",
    effective_at: T(15), expires_at: "2026-09-14T00:00:00+08:00",
    attribution_required: false, prohibited_uses: [], note: "期限重谈后缩短",
  }, { at: T(15) });

  assert.deepEqual(r.impacted, ["pkg-de"]); // JP/FR 不被重复暂停
  const de = precheck(svc.store.events(), "pkg-de", T(15, "12:00"));
  const expired = de.blocking_reasons.find((x) => x.code === REASON_CODES.RIGHTS_TERM_EXPIRED);
  assert.ok(expired, "应给出期限届满阻断");
  assert.equal(expired.details.expired_at, "2026-09-14T00:00:00+08:00");
  assert.match(expired.message, /2026-09-14/);
});

test("撤权只暂停受影响市场；新证据同样按司法地域过滤", () => {
  const { svc } = buildWorld();
  const ev = svc.submitEvidence({ evidence_id: "ev-jp-1", motif_id: "m-1", line: "source", jurisdiction: "JP", submitted_by: "researcher" }, { at: T(11) });
  assert.deepEqual(ev.impacted, ["pkg-jp"]);
  svc.ruleEvidence({ evidence_id: "ev-jp-1", accepted: true, reviewer_id: "legal-jp" }, { at: T(12) });
  assert.equal(precheck(svc.store.events(), "pkg-jp", T(12)).decision, DECISIONS.ALLOWED);

  const w = svc.withdrawRights({ motif_id: "m-1", jurisdiction: "JP", withdrawn_by: "legal-jp", reason: "授权链断裂" }, { at: T(16) });
  assert.deepEqual(w.impacted, ["pkg-jp"]); // DE/FR 不产生新的暂停事件

  const jp = precheck(svc.store.events(), "pkg-jp", T(16, "11:00"));
  assert.equal(jp.decision, DECISIONS.PROHIBITED);
  assert.ok(jp.blocking_reasons.some((r) => r.code === REASON_CODES.RIGHTS_WITHDRAWN));
  assert.ok(jp.blocking_reasons.some((r) => r.code === REASON_CODES.PACKAGE_SUSPENDED));
  // JP 未交付，不产生召回单。
  assert.equal((svc.state().recalls.get("pkg-jp") ?? []).length, 0);
});

test("已交付内容不消失：顾问解除疑虑+法务恢复期限后，召回关闭才能重新发布", () => {
  const { svc } = buildWorld();
  svc.addOpinion({ opinion_id: "op-de-1", motif_id: "m-1", reviewer_id: "local-de-advisor", discipline: "cultural_advisor", jurisdiction: "DE", decision: "PROHIBIT", basis_versions: { ...svc.state().packages.get("pkg-de").bindings } }, { at: T(10) });
  svc.setRights({ motif_id: "m-1", jurisdiction: "DE", set_by: "legal-hq", effective_at: T(15), expires_at: "2026-09-14T00:00:00+08:00", attribution_required: false, prohibited_uses: [] }, { at: T(15) });

  // 顾问改判 APPROVE（同一评审人/专业/地域，最新意见为准），但期限仍届满。
  svc.addOpinion({ opinion_id: "op-de-2", motif_id: "m-1", reviewer_id: "local-de-advisor", discipline: "cultural_advisor", jurisdiction: "DE", decision: "APPROVE", basis_versions: { ...svc.state().packages.get("pkg-de").bindings }, note: "补充语境后不构成禁用" }, { at: T(22) });
  assert.equal(precheck(svc.store.events(), "pkg-de", T(22, "11:00")).decision, DECISIONS.PROHIBITED);

  // 法务恢复有效期限：底层合规，但召回仍在进行，继续阻断。
  svc.setRights({ motif_id: "m-1", jurisdiction: "DE", set_by: "legal-hq", effective_at: T(23), expires_at: "2030-01-01T00:00:00+08:00", attribution_required: false, prohibited_uses: [] }, { at: T(23) });
  let de = precheck(svc.store.events(), "pkg-de", T(23, "11:00"));
  assert.ok(de.blocking_reasons.some((r) => r.code === REASON_CODES.RECALL_OPEN), "召回未关闭前不得发布");

  // 召回/更正流程走完并留痕关闭。
  const recallId = svc.state().recalls.get("pkg-de").find((r) => r.closed === null).recall_id;
  svc.closeRecall({ recall_id: recallId, package_id: "pkg-de", closed_by: "ops", outcome: "已换贴新版说明" }, { at: T(24) });
  de = precheck(svc.store.events(), "pkg-de", T(24, "11:00"));
  assert.equal(de.decision, DECISIONS.ALLOWED);
  assert.equal(de.deliverable, true);
});

test("重复通知幂等，不会再次触发召回", () => {
  const { svc } = buildWorld();
  const first = svc.notificationReceived({ notification_id: "ntf-1", package_id: "pkg-de" }, { at: T(9) });
  const second = svc.notificationReceived({ notification_id: "ntf-1", package_id: "pkg-de" }, { at: T(9, "10:05") });
  assert.equal(first.stored, true);
  assert.equal(second.stored, false);
  assert.equal(svc.state().notifications.size, 1);
  assert.equal(svc.state().recalls.get("pkg-de").length, 0);
});

test("紧急停用先执行，补审责任与期限随决定保存；逾期有单独阻断", () => {
  const { svc } = buildWorld();
  const { halt } = svc.emergencyHalt({
    package_id: "pkg-de", halted_by: "duty-manager", reason: "社交舆情：疑似冒犯性使用",
    rework_owner: "cultural-advisor", rework_due_at: "2026-09-26T18:00:00+08:00",
  }, { at: T(25, "08:00") });

  let de = precheck(svc.store.events(), "pkg-de", T(25, "09:00"));
  assert.equal(de.decision, DECISIONS.PROHIBITED);
  const h = de.blocking_reasons.find((r) => r.code === REASON_CODES.PACKAGE_HALTED);
  assert.equal(h.details.rework_owner, "cultural-advisor");
  assert.equal(h.details.rework_due_at, "2026-09-26T18:00:00+08:00");
  // 已交付内容紧急停用同样进入召回流程。
  assert.equal(svc.state().recalls.get("pkg-de").at(-1).cause_event_id, halt.event_id);

  // 补审逾期必须在补审结论作出之前观察（独立实例）。
  const { svc: overdueWorld } = buildWorld();
  overdueWorld.emergencyHalt({ package_id: "pkg-de", halted_by: "duty-manager", reason: "等待补审", rework_owner: "cultural-advisor", rework_due_at: "2026-09-26T18:00:00+08:00" }, { at: T(25, "08:00") });
  assert.ok(precheck(overdueWorld.store.events(), "pkg-de", T(27)).blocking_reasons.some((r) => r.code === REASON_CODES.REWORK_OVERDUE));

  // 补审通过：解除停用（召回另行关闭后才可发布）。
  svc.ruleHaltRework({ package_id: "pkg-de", decision: "APPROVED", reviewer_id: "cultural-advisor", note: "改绘已调整" }, { at: T(25, "14:00") });
  de = precheck(svc.store.events(), "pkg-de", T(25, "15:00"));
  assert.ok(!de.blocking_reasons.some((r) => r.code === REASON_CODES.PACKAGE_HALTED));
  assert.ok(de.blocking_reasons.some((r) => r.code === REASON_CODES.RECALL_OPEN));

  // 补审驳回则保持停用。
  const { svc: svc2 } = buildWorld();
  svc2.emergencyHalt({ package_id: "pkg-fr", halted_by: "duty-manager", reason: "紧急核查", rework_owner: "legal", rework_due_at: T(26) }, { at: T(25) });
  svc2.ruleHaltRework({ package_id: "pkg-fr", decision: "REJECTED", reviewer_id: "legal" }, { at: T(25, "16:00") });
  assert.ok(precheck(svc2.store.events(), "pkg-fr", T(25, "17:00")).blocking_reasons.some((r) => r.code === REASON_CODES.PACKAGE_HALTED));
});

test("并行审校基于旧版本：批准被标记冲突并硬阻断，意见转待复审", () => {
  const svc = new GovernanceService();
  svc.commit(svc.base("MOTIF_PROPOSED", "m-2", { motif_id: "m-2", name: "虚构回纹" }, { at: T(1) }));
  svc.recordVersion({ motif_id: "m-2", line: "source", version_id: "s1" }, { at: T(1) });
  svc.recordVersion({ motif_id: "m-2", line: "redraw", version_id: "r1" }, { at: T(1) });
  svc.recordVersion({ motif_id: "m-2", line: "copy", version_id: "c1" }, { at: T(1) });
  svc.recordVersion({ motif_id: "m-2", line: "carrier", version_id: "k1", use_tags: ["FOOD"] }, { at: T(1) });
  svc.setRights({ motif_id: "m-2", jurisdiction: "DE", set_by: "legal", effective_at: T(1), expires_at: "2030-01-01T00:00:00+08:00" }, { at: T(2) });
  svc.composePackage({ package_id: "pkg-x", motif_id: "m-2", market: "DE", bindings: { source: "s1", redraw: "r1", copy: "c1", carrier: "k1" }, required_disciplines: ["legal"] }, { at: T(3) });
  svc.grantApproval({ approval_id: "ap-x-1", package_id: "pkg-x", discipline: "legal", reviewer_id: "legal", basis_versions: { source: "s1", redraw: "r1", copy: "c1", carrier: "k1" } }, { at: T(4) });

  // 改绘线出了新版本，包绑定升级到 r2；并行的 legal 批准仍基于 r1。
  svc.recordVersion({ motif_id: "m-2", line: "redraw", version_id: "r2" }, { at: T(5) });
  svc.commit(svc.base("PACKAGE_COMPOSED", "pkg-x2", {
    package_id: "pkg-x2", motif_id: "m-2", market: "DE",
    bindings: { source: "s1", redraw: "r2", copy: "c1", carrier: "k1" },
    required_disciplines: ["legal"], composed_by: "ops", supersedes: "pkg-x",
  }, { at: T(6) }));
  svc.grantApproval({ approval_id: "ap-x2-legal", package_id: "pkg-x2", discipline: "legal", reviewer_id: "parallel-legal", basis_versions: { source: "s1", redraw: "r1", copy: "c1", carrier: "k1" } }, { at: T(7) });

  const report = precheck(svc.store.events(), "pkg-x2", T(8));
  const stale = report.blocking_reasons.find((r) => r.code === REASON_CODES.APPROVAL_BASED_ON_STALE_VERSION);
  assert.ok(stale);
  assert.deepEqual(stale.details.stale_lines, ["redraw"]);
  assert.ok(report.warnings.some((w) => w.code === "PARALLEL_REVIEW_STALE"));

  // 基于旧版本的禁止意见不能直接阻断新版，只能挂起为待复审。
  svc.addOpinion({ opinion_id: "op-x-1", motif_id: "m-2", reviewer_id: "advisor", discipline: "cultural_advisor", jurisdiction: "DE", decision: "PROHIBIT", basis_versions: { redraw: "r1" } }, { at: T(9) });
  const after = precheck(svc.store.events(), "pkg-x2", T(10));
  assert.ok(!after.blocking_reasons.some((r) => r.code === REASON_CODES.OPINION_PROHIBITION));
  assert.ok(after.pending_items.some((r) => r.code === REASON_CODES.OPINION_CONCERN));
});

test("版本停用跨市场暂停所有绑定包，已交付者开召回，未绑定者不受影响", () => {
  const svc = new GovernanceService();
  svc.commit(svc.base("MOTIF_PROPOSED", "m-3", { motif_id: "m-3", name: "虚构兽面纹" }, { at: T(1) }));
  for (const [line, vid, extra] of [["source", "s1"], ["redraw", "r1"], ["copy", "c1"], ["carrier", "k1", { use_tags: ["FOOD"] }]]) {
    svc.recordVersion({ motif_id: "m-3", line, version_id: vid, ...(extra ?? {}) }, { at: T(1) });
  }
  svc.recordVersion({ motif_id: "m-3", line: "source", version_id: "s2" }, { at: T(2) });
  for (const j of ["DE", "JP"]) svc.setRights({ motif_id: "m-3", jurisdiction: j, set_by: "legal", effective_at: T(1), expires_at: "2030-01-01T00:00:00+08:00" }, { at: T(2) });
  const b1 = { source: "s1", redraw: "r1", copy: "c1", carrier: "k1" };
  svc.composePackage({ package_id: "p-de", motif_id: "m-3", market: "DE", bindings: b1 }, { at: T(3) });
  svc.composePackage({ package_id: "p-jp", motif_id: "m-3", market: "JP", bindings: b1 }, { at: T(3) });
  svc.composePackage({ package_id: "p-jp2", motif_id: "m-3", market: "JP", bindings: { ...b1, source: "s2" } }, { at: T(3) });
  svc.deliver({ package_id: "p-de", delivered_by: "ops" }, { at: T(4) });

  const r = svc.suspendVersion({ motif_id: "m-3", version_id: "s1", reason: "来源出处有误", suspended_by: "researcher" }, { at: T(10) });
  assert.deepEqual(r.impacted.sort(), ["p-de", "p-jp"]);
  for (const pkg of ["p-de", "p-jp"]) {
    assert.ok(precheck(svc.store.events(), pkg, T(10, "11:00")).blocking_reasons.some((x) => x.code === REASON_CODES.VERSION_SUSPENDED));
  }
  assert.equal(precheck(svc.store.events(), "p-jp2", T(10, "11:00")).decision, DECISIONS.ALLOWED);
  assert.equal(svc.state().recalls.get("p-de").at(-1).type, "RECALL");
  assert.equal(svc.state().recalls.get("p-jp")?.length ?? 0, 0);
});

test("审计：按过去时间点复原当时为何获准，并指出哪次变化改变了结论", () => {
  const { svc } = buildWorld();
  svc.addOpinion({ opinion_id: "op-de-1", motif_id: "m-1", reviewer_id: "local-de-advisor", discipline: "cultural_advisor", jurisdiction: "DE", decision: "PROHIBIT", basis_versions: { ...svc.state().packages.get("pkg-de").bindings } }, { at: T(10) });
  svc.setRights({ motif_id: "m-1", jurisdiction: "DE", set_by: "legal-hq", effective_at: T(15), expires_at: "2026-09-14T00:00:00+08:00", attribution_required: false, prohibited_uses: [] }, { at: T(15) });

  // 09-09：DE 当时为何获准。
  const past = reconstructAt(svc.store.events(), "pkg-de", T(9));
  assert.equal(past.decision, DECISIONS.ALLOWED);
  assert.equal(past.why.rights.jurisdiction, "DE");
  assert.equal(past.why.rights.event_id, svc.store.events().find((e) => e.kind === "RIGHTS_CONDITION_SET" && e.payload.jurisdiction === "DE").event_id);
  assert.equal(past.why.approvals.length, 2);
  assert.equal(past.lifecycle.delivered.at, T(5));
  assert.match(renderAudit(past), /权利依据事件/);

  // 09-12：禁止意见已生效，期限尚未届满；当时的开放召回可复原。
  const mid = reconstructAt(svc.store.events(), "pkg-de", T(12));
  assert.equal(mid.decision, DECISIONS.PROHIBITED);
  assert.ok(mid.blockers.some((b) => b.code === REASON_CODES.OPINION_PROHIBITION));
  assert.ok(!mid.blockers.some((b) => b.code === REASON_CODES.RIGHTS_TERM_EXPIRED));
  assert.ok(mid.lifecycle.open_recall);

  // 变化归因：顾问意见（ALLOWED→PROHIBITED）与法务期限更新（新增届满阻断）。
  const explained = explainChange(svc.store.events(), "pkg-de", T(9), T(16));
  const kinds = explained.turning_points.map((x) => x.changed_by_event.kind);
  assert.ok(kinds.includes("REVIEW_OPINION_ADDED"));
  assert.ok(kinds.includes("RIGHTS_CONDITION_SET"));
  const termPoint = explained.turning_points.find((x) => x.changed_by_event.kind === "RIGHTS_CONDITION_SET");
  assert.ok(termPoint.new_blockers.some((b) => b.code === REASON_CODES.RIGHTS_TERM_EXPIRED));
  assert.equal(explained.decision_at_from, DECISIONS.ALLOWED);
  assert.equal(explained.decision_at_to, DECISIONS.PROHIBITED);
});

test("市场概览与事件存储并发/校验", () => {
  const { svc } = buildWorld();
  const overview = marketOverview(svc.state(), "m-1", T(7));
  assert.deepEqual(overview.map((o) => [o.market, o.decision]).sort(), [
    ["DE", "ALLOWED"], ["FR", "PROHIBITED"], ["JP", "PENDING_EVIDENCE"],
  ]);

  // 乐观并发：陈旧 expectedSeq 被拒。
  const store = new EventStore();
  const rec = svc.base("MOTIF_PROPOSED", "m-9", { motif_id: "m-9", name: "x" }, { at: T(1) });
  store.append(rec, { expectedSeq: 0 });
  assert.throws(() => store.append(svc.base("MOTIF_PROPOSED", "m-9", { motif_id: "m-9", name: "y" }, { at: T(2) }), { expectedSeq: 0 }), (err) => err instanceof ConcurrencyError);

  // 缺字段事件不允许入库。
  assert.deepEqual(validateEvent({ event_id: "x", kind: "UNKNOWN", occurred_at: T(1), subject_id: "s", payload: {} }), ["kind"]);
  assert.deepEqual(validateEvent({ event_id: "x", kind: "PACKAGE_COMPOSED", occurred_at: T(1), subject_id: "s", payload: {} }),
    ["payload.package_id", "payload.motif_id", "payload.market", "payload.bindings"]);
});
