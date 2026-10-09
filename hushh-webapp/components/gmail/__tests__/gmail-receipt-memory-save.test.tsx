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

  it("saves nothing until the owner taps, then saves once through the governed routine", async () => {
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
});
