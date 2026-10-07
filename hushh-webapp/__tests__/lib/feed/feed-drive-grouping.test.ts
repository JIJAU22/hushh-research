import { describe, expect, it } from "vitest";

import { collapseDriveLifecycleRows } from "@/lib/feed/feed-drive-grouping";
import type { FeedItem } from "@/lib/services/feed-service";

const REQUEST = "request-1";

function row(
  id: string,
  event_type: string,
  user_facing_status: string,
  overrides: Partial<FeedItem> = {},
): FeedItem {
  return {
    id,
    source_domain: "connected_systems",
    event_type,
    actor_label: "Roopmann V",
    metadata: {
      request_id: REQUEST,
      user_facing_status,
      ...overrides.metadata,
    },
    read: false,
    created_at: "2026-10-08T01:08:00.000Z",
    ...overrides,
  };
}

describe("Drive lifecycle Feed rows", () => {
  it("removes a stale no-match row once files are confirmed", () => {
    const rows = collapseDriveLifecycleRows([
      row("outcome-completed", "document_share_outcome", "completed"),
      row("decision", "document_share_decided", "pending"),
      row("outcome-no-match", "document_share_outcome", "no_match"),
      row("payment", "document_share_payment_confirmed", "paid"),
    ]);

    expect(rows.map((item) => item.id)).toEqual([
      "outcome-completed",
      "decision",
      "payment",
    ]);
  });

  it("keeps a no-files outcome when no successful outcome exists", () => {
    const rows = collapseDriveLifecycleRows([
      row("decision", "document_share_decided", "pending"),
      row("outcome-no-match", "document_share_outcome", "no_match"),
    ]);

    expect(rows.map((item) => item.id)).toEqual(["outcome-no-match"]);
  });

  it("does not merge different requests and preserves non-lifecycle rows", () => {
    const rows = collapseDriveLifecycleRows([
      row("request-a", "document_share_outcome", "no_match", {
        metadata: { request_id: "request-a" },
      }),
      row("request-b", "document_share_decided", "pending", {
        metadata: { request_id: "request-b" },
      }),
      row("request", "document_share_request", "pending"),
    ]);

    expect(rows.map((item) => item.id)).toEqual([
      "request-a",
      "request-b",
      "request",
    ]);
  });
});
