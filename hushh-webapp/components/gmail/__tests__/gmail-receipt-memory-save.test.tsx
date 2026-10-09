import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveReceiptCanonicalIndexToMemory = vi.fn();
vi.mock("@/lib/profile/gmail-receipt-memory-save", () => ({
  saveReceiptCanonicalIndexToMemory: (...args: unknown[]) =>
    saveReceiptCanonicalIndexToMemory(...args),
}));

const vault = { vaultKey: "vault-key", vaultOwnerToken: "owner-token", isVaultUnlocked: true };
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => vault }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "user-1" } }) }));

import { GmailReceiptMemorySave } from "@/components/gmail/gmail-receipt-memory-save";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";

const receipts = [
  { id: 1, gmail_message_id: "m1", source_id: "s1" } as ReceiptListItem,
];

describe("GmailReceiptMemorySave", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vault.isVaultUnlocked = true;
    saveReceiptCanonicalIndexToMemory.mockResolvedValue({ count: 1 });
  });
  afterEach(cleanup);

  it("saves nothing on mount or without a finished sync, then saves once when the owner taps", async () => {
    render(<GmailReceiptMemorySave receipts={receipts} accountKey="owner@example.com" />);
    // No mount effect and no timer may write: the tap is the confirmation.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(saveReceiptCanonicalIndexToMemory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save to private memory" }));
    await waitFor(() => expect(screen.getByText("Saved to your private memory.")).toBeTruthy());
    expect(saveReceiptCanonicalIndexToMemory).toHaveBeenCalledOnce();
    expect(saveReceiptCanonicalIndexToMemory).toHaveBeenCalledWith({
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
      receipts,
      accountKey: "owner@example.com",
    });
    expect(screen.getByRole("button", { name: "Update private memory" })).toBeTruthy();
  });

  it("returns to its starting state when a new sync changes the list", async () => {
    const { rerender } = render(
      <GmailReceiptMemorySave receipts={receipts} accountKey="owner@example.com" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save to private memory" }));
    await waitFor(() => expect(screen.getByText("Saved to your private memory.")).toBeTruthy());

    rerender(
      <GmailReceiptMemorySave
        receipts={[...receipts, { id: 2, gmail_message_id: "m2", source_id: "s2" } as ReceiptListItem]}
        accountKey="owner@example.com"
      />,
    );
    expect(screen.queryByText("Saved to your private memory.")).toBeNull();
    expect(screen.getByRole("button", { name: "Save to private memory" })).toBeTruthy();
  });

  it("reports a failed save without claiming it was saved", async () => {
    saveReceiptCanonicalIndexToMemory.mockRejectedValueOnce(new Error("Failed to save receipt memory."));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<GmailReceiptMemorySave receipts={receipts} accountKey={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Save to private memory" }));
    await waitFor(() => expect(screen.getByText("Failed to save receipt memory.")).toBeTruthy());
    expect(screen.queryByText("Saved to your private memory.")).toBeNull();
    consoleError.mockRestore();
  });

  it("asks the owner to open the vault instead of writing while it is locked", () => {
    vault.isVaultUnlocked = false;
    render(<GmailReceiptMemorySave receipts={receipts} accountKey={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Save to private memory" }));
    expect(screen.getByText(/open your private vault/i)).toBeTruthy();
    expect(saveReceiptCanonicalIndexToMemory).not.toHaveBeenCalled();
  });

  describe("after a finished sync", () => {
    const longer = [
      ...receipts,
      { id: 2, gmail_message_id: "m2", source_id: "s2" } as ReceiptListItem,
    ];

    it("saves once per finished sync, never on a partly loaded list", async () => {
      const ledger = { current: 0 };
      const view = (list: ReceiptListItem[], completion: number) => (
        <GmailReceiptMemorySave
          receipts={list}
          accountKey="owner@example.com"
          syncCompletion={completion}
          savedCompletionRef={ledger}
        />
      );
      const { rerender } = render(view(receipts, 0));
      // Pages arrive one by one during a sync: no write until it finishes.
      rerender(view(longer, 0));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(saveReceiptCanonicalIndexToMemory).not.toHaveBeenCalled();

      rerender(view(longer, 1));
      await waitFor(() => expect(screen.getByText("Saved to your private memory.")).toBeTruthy());
      expect(saveReceiptCanonicalIndexToMemory).toHaveBeenCalledOnce();
      expect(saveReceiptCanonicalIndexToMemory).toHaveBeenCalledWith(
        expect.objectContaining({ receipts: longer, accountKey: "owner@example.com" }),
      );

      // The same finished sync is never saved twice, even when the control remounts.
      rerender(view([...longer], 1));
      cleanup();
      render(view(longer, 1));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(saveReceiptCanonicalIndexToMemory).toHaveBeenCalledOnce();

      // The next finished sync saves again.
      render(view(longer, 2));
      await waitFor(() => expect(saveReceiptCanonicalIndexToMemory).toHaveBeenCalledTimes(2));
    });

    it("saves a sync that finished before the control mounted, once", async () => {
      const ledger = { current: 0 };
      render(
        <GmailReceiptMemorySave
          receipts={receipts}
          accountKey={null}
          syncCompletion={1}
          savedCompletionRef={ledger}
        />,
      );
      await waitFor(() => expect(saveReceiptCanonicalIndexToMemory).toHaveBeenCalledOnce());
      expect(ledger.current).toBe(1);
    });

    it("does not retry a failed save on its own, and offers the manual save", async () => {
      saveReceiptCanonicalIndexToMemory.mockRejectedValueOnce(new Error("Failed to save receipt memory."));
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const ledger = { current: 0 };
      render(
        <GmailReceiptMemorySave
          receipts={receipts}
          accountKey={null}
          syncCompletion={1}
          savedCompletionRef={ledger}
        />,
      );
      await waitFor(() => expect(screen.getByText("Failed to save receipt memory.")).toBeTruthy());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(saveReceiptCanonicalIndexToMemory).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "Save to private memory" })).toBeTruthy();
      consoleError.mockRestore();
    });

    it("writes nothing when auto-save is off or there is nothing to save", async () => {
      const ledger = { current: 0 };
      const { rerender } = render(
        <GmailReceiptMemorySave
          receipts={receipts}
          accountKey={null}
          syncCompletion={1}
          savedCompletionRef={ledger}
          autoSave={false}
        />,
      );
      rerender(
        <GmailReceiptMemorySave
          receipts={[]}
          accountKey={null}
          syncCompletion={2}
          savedCompletionRef={ledger}
        />,
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(saveReceiptCanonicalIndexToMemory).not.toHaveBeenCalled();
    });
  });
});
