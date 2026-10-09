"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";

import { SurfaceInset } from "@/components/app-ui/surfaces";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import { saveReceiptCanonicalIndexToMemory } from "@/lib/profile/gmail-receipt-memory-save";
import { sanitizeGmailUserMessage } from "@/lib/profile/mail-flow";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";
import { useVault } from "@/lib/vault/vault-context";

type SaveState = "idle" | "saving" | "saved" | "error";

/** Product default for saving after a finished sync; an owner setting can override it later. */
export const RECEIPT_MEMORY_AUTO_SAVE_DEFAULT = true;

/**
 * Keeps the owner's private memory of their receipts current.
 *
 * After a sync finishes, the finished list is saved once through the existing
 * governed writer (`gmail_receipt_memory_save_button`), so Chat with One can
 * answer from it. The owner started that sync, the default is on, and the
 * button below stays as the manual save and the way to update after a failure.
 *
 * Nothing here writes on mount, on a timer, or on a partly loaded list: only a
 * new `syncCompletion` that `savedCompletionRef` has not yet covered. The ref is
 * owned by the page, so a control that mounts late or remounts on a tab change
 * saves a finished sync once and never again.
 */
export function GmailReceiptMemorySave({
  receipts,
  accountKey,
  syncCompletion = 0,
  savedCompletionRef,
  autoSave = RECEIPT_MEMORY_AUTO_SAVE_DEFAULT,
}: {
  receipts: readonly ReceiptListItem[];
  accountKey: string | null | undefined;
  syncCompletion?: number;
  savedCompletionRef?: MutableRefObject<number>;
  autoSave?: boolean;
}) {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const [state, setState] = useState<SaveState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const savingRef = useRef(false);
  const receiptsRef = useRef(receipts);
  receiptsRef.current = receipts;

  // A different list is a different memory to save; keep an in-flight save as it is.
  const listSignature = useMemo(
    () => receipts.map((receipt) => String(receipt.source_id ?? receipt.id)).join("|"),
    [receipts],
  );
  useEffect(() => {
    if (savingRef.current) return;
    setState("idle");
    setMessage(null);
  }, [listSignature]);

  const save = useCallback(async () => {
    if (savingRef.current || !user?.uid) return;
    if (!vaultKey || !vaultOwnerToken || !isVaultUnlocked) {
      setState("error");
      setMessage("Open your private vault to save these receipts to memory.");
      return;
    }
    savingRef.current = true;
    setState("saving");
    setMessage("Saving your receipts to private memory…");
    try {
      await saveReceiptCanonicalIndexToMemory({
        userId: user.uid,
        vaultKey,
        vaultOwnerToken,
        receipts: receiptsRef.current,
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
  }, [accountKey, isVaultUnlocked, user?.uid, vaultKey, vaultOwnerToken]);

  // One save per finished sync. The completion is marked handled before the
  // write, so a failure never loops; the owner retries with the button.
  useEffect(() => {
    if (!savedCompletionRef || syncCompletion <= savedCompletionRef.current) return;
    savedCompletionRef.current = syncCompletion;
    if (!autoSave || receiptsRef.current.length === 0) return;
    void save();
  }, [autoSave, save, savedCompletionRef, syncCompletion]);

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
