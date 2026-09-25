// 只追加（append-only）的事件存储。
//
// 设计要点：
// - 追加前按领域约定校验；event_id 去重；
// - expectedSeq 乐观并发：并行审校同时写事件时，先到先得，后到者拿到 CONCURRENT_APPEND
//   并带着期望/实际序号，调用方应重读投影后重试，而不是静默覆盖；
// - NOTIFICATION_DELIVERED 以 notification_id 幂等落库：重复通知不会产生第二条事件，
//   因此也不可能再次触发召回。

import { validateEvent } from "./art_motif_review.js";

export class ConcurrencyError extends Error {
  constructor(expectedSeq, actualSeq) {
    super(`并发冲突：期望序号 ${expectedSeq}，库内实际 ${actualSeq}，请重读后重试`);
    this.code = "CONCURRENT_APPEND";
    this.expectedSeq = expectedSeq;
    this.actualSeq = actualSeq;
  }
}

export class EventStore {
  constructor() {
    this._events = [];
    this._ids = new Set();
    this._notifications = new Set();
  }

  get length() {
    return this._events.length;
  }

  // 追加一条事件。返回 true；若为重复通知则返回 false（幂等丢弃）。
  append(record, { expectedSeq = this._events.length } = {}) {
    const problems = validateEvent(record);
    if (problems.length > 0) throw new Error(`事件不符合领域约定：${problems.join("、")}`);
    if (this._ids.has(record.event_id)) throw new Error(`事件 event_id 已存在：${record.event_id}`);
    if (expectedSeq !== this._events.length) throw new ConcurrencyError(expectedSeq, this._events.length);

    if (record.kind === "NOTIFICATION_DELIVERED") {
      const nid = record.payload.notification_id;
      if (this._notifications.has(nid)) return false;
      this._notifications.add(nid);
    }

    const stored = { ...record, seq: this._events.length };
    this._events.push(stored);
    this._ids.add(record.event_id);
    return true;
  }

  events() {
    return this._events.slice();
  }
}
