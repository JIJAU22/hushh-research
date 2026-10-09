"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { SurfaceInset } from "@/components/app-ui/surfaces";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import { saveReceiptCanonicalIndexToMemory } from "@/lib/profile/gmail-receipt-memory-save";
import { sanitizeGmailUserMessage } from "@/lib/profile/mail-flow";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";
import { useVault } from "@/lib/vault/vault-context";

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * The owner's own control for saving the receipts above into private memory.
 *
 * It never saves on its own: no mount effect, no timer, and no reaction to a
 * finished sync. The tap is the confirmation, and it goes through the existing
 * governed writer (`gmail_receipt_memory_save_button`). After a new sync the
 * list changes, the control returns to its starting state, and saving again
 * updates the memory.
 */
export function GmailReceiptMemorySave({
  receipts,
  accountKey,
}: {
  receipts: readonly ReceiptListItem[];
  accountKey: string | null | undefined;
}) {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const [state, setState] = useState<SaveState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const savingRef = useRef(false);

  // A different list is a different memory to save; keep an in-flight save as it is.
  useEffect(() => {
    if (savingRef.current) return;
    setState("idle");
    setMessage(null);
  }, [receipts]);

  const save = useCallback(async () => {
    if (savingRef.current || !user?.uid) return;
    if (!vaultKey || !vaultOwnerToken || !isVaultUnlocked) {
      setState("error");
      setMessage("Open your private vault to save these receipts to memory.");
      return;
    }
    savingRef.current = true;
    setState("saving");
    setMessage(null);
    try {
      await saveReceiptCanonicalIndexToMemory({
        userId: user.uid,
        vaultKey,
        vaultOwnerToken,
        receipts,
        accountKey,
      });
      setState("saved");
      setMessage("Saved to your private memory.");
    } catch (error) {
      console.error("[GmailReceiptMemorySave] Failed to save receipts:", error);
      setState("error");
      setMessage(
        sanitizeGmailUserMessage(error, {
          fallback: "We couldn't save your receipts to memory. Please try again.",
        }),
      );
    } finally {
      savingRef.current = false;
    }
  }, [accountKey, isVaultUnlocked, receipts, user?.uid, vaultKey, vaultOwnerToken]);

  const saving = state === "saving";
  return (
    <SurfaceInset
      className="flex flex-col gap-2 px-4 py-3 text-xs sm:flex-row sm:items-center sm:justify-between"
      data-testid="receipt-memory-save"
    >
      <p aria-live="polite" className="text-muted-foreground">
        {message ?? "Let your private agent answer questions about these receipts."}
      </p>
      <Button
        variant="none"
        effect="fade"
        size="sm"
        onClick={() => void save()}
        disabled={saving}
        className="self-start sm:self-auto"
      >
        {saving
          ? "Saving…"
          : state === "saved"
            ? "Update private memory"
            : "Save to private memory"}
      </Button>
    </SurfaceInset>
  );
}
