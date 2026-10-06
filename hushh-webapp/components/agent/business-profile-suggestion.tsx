"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AgentPkmReviewPanel } from "@/components/agent/agent-pkm-review-panel";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { BusinessSuggestionService } from "@/lib/services/business-suggestion-service";
import { createAgentPkmCaptureGuard } from "@/lib/agent/agent-pkm-capture-runtime";
import { connectorMemorySharingImpact, prepareConnectorMemoryReview } from "@/lib/agent/connector-memory-review";
import { attachBusinessOrigin, businessDraftMessage, createBusinessReviewJob, decideBusinessReview, loadBusinessReview, saveBusinessReview, type BusinessCandidate, type BusinessReviewJob } from "@/lib/agent/business-profile-review";
import type { AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";

type Props = {
  ownerId: string | null; vaultKey: string | null; vaultOwnerToken: string | null;
  tokenExpiresAt: number | null; enabled: boolean;
};
type Review = {
  candidate: BusinessCandidate; name: string; website: string; message: string;
  cards: AgentPkmPreviewCard[]; selected: string[]; job?: BusinessReviewJob;
  phase: "offer" | "preparing" | "review" | "saving";
};

/** On-demand, post-setup UAT suggestion. No automatic memory mutation. */
export function BusinessProfileSuggestion(props: Props) {
  const { ownerId, vaultKey, vaultOwnerToken, enabled, tokenExpiresAt } = props;
  const context = useMemo(() => ({ ownerId, vaultKey, vaultOwnerToken, enabled, tokenExpiresAt }),
    // Expiry is checked at every effect, including while the UI is idle.
    [ownerId, vaultKey, vaultOwnerToken, enabled, tokenExpiresAt]);
  const current = useRef(context);
  current.current = context;
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const [state, setState] = useState<{ context: typeof context; review: Review } | null>(null);
  const [open, setOpen] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);
  const review = state?.context === context ? state.review : null;
  const eligible = () => current.current === context && context.enabled && !!context.ownerId &&
    !!context.vaultKey && !!context.vaultOwnerToken && context.tokenExpiresAt !== null && Date.now() < context.tokenExpiresAt;
  const session = () => createAgentPkmCaptureGuard({ userId: context.ownerId || "",
    signal: controller.current?.signal ?? AbortSignal.abort(), isEnabled: eligible });

  useEffect(() => {
    const abort = new AbortController(); controller.current = abort; busy.current = false;
    setAcknowledging(false); setOpen(false);
    const guard = createAgentPkmCaptureGuard({ userId: context.ownerId || "", signal: abort.signal, isEnabled: eligible });
    if (guard.isCurrent()) void (async () => {
      try {
        const suggestion = await BusinessSuggestionService.get(context.vaultOwnerToken!, abort.signal);
        await guard.assertCurrent();
        const candidate = suggestion.candidates[0];
        if (!candidate) return;
        const checkpoint = await loadBusinessReview(context.ownerId!, context.vaultKey!);
        await guard.assertCurrent();
        if (checkpoint?.decision === "not_me" || checkpoint?.decision === "saved" ||
          (checkpoint?.decision === "later" && (checkpoint.until || 0) > Date.now())) return;
        const job = checkpoint?.job;
        setState({ context, review: { candidate, name: candidate.draft.name, website: candidate.draft.website,
          message: job?.message || "", cards: job?.cards || [], selected: job?.cards.map(card => card.card_id) || [],
          job, phase: job ? "review" : "offer" } });
        setOpen(true);
      } catch {
        // Optional discovery must not block chat or expose provider diagnostics.
        if (guard.isCurrent()) setState(null);
      }
    })();
    return () => { abort.abort(); };
    // Each authority change creates a new owner-bound attempt, including StrictMode replay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context]);

  const freshCandidate = async (guard: ReturnType<typeof session>) => {
    await guard.assertCurrent();
    const fresh = await BusinessSuggestionService.get(context.vaultOwnerToken!, controller.current?.signal);
    await guard.assertCurrent();
    if (!review || fresh.candidates[0]?.businessUid !== review.candidate.businessUid)
      throw new Error("The suggestion is no longer available. Nothing new was saved.");
  };
  const update = (next: Review) => setState({ context, review: next });
  const prepare = async () => {
    if (!review || busy.current || review.job) return;
    const guard = session();
    if (!guard.isCurrent()) return;
    busy.current = true;
    update({ ...review, phase: "preparing" });
    try {
      await freshCandidate(guard);
      const message = businessDraftMessage(review.candidate, review.name, review.website);
      const result = await prepareConnectorMemoryReview({ ...guard, userId: context.ownerId!,
        vaultKey: context.vaultKey!, vaultOwnerToken: context.vaultOwnerToken!, message, source: "business_profile_review" });
      await guard.assertCurrent();
      if (result.incomplete || !result.cards.length) throw new Error("The details could not be fully prepared. Please try again.");
      // Ensure source identity can follow the actual semantic entity before offering Save.
      result.cards.forEach(card => attachBusinessOrigin(card, review.candidate));
      update({ ...review, message, cards: result.cards, selected: result.cards.map(card => card.card_id), phase: "review" });
    } catch {
      if (guard.isCurrent()) { update({ ...review, phase: "offer" }); morphyToast.error("The details could not be prepared. Try again."); }
    } finally { if (guard.isCurrent()) busy.current = false; }
  };
  const chosen = review?.cards.filter(card => review.selected.includes(card.card_id)) || [];
  const sharingCount = connectorMemorySharingImpact(chosen);
  const save = async (sharingImpactAcknowledged = false) => {
    if (!review || review.phase !== "review" || busy.current || !chosen.length) return;
    const guard = session();
    if (!guard.isCurrent()) return;
    if (sharingCount && !sharingImpactAcknowledged) { setAcknowledging(true); return; }
    busy.current = true; setAcknowledging(false); update({ ...review, phase: "saving" });
    let attemptedJob = review.job;
    const action = (async () => {
      await freshCandidate(guard);
      const job = review.job || createBusinessReviewJob(context.ownerId!, review.candidate, review.message, chosen);
      attemptedJob = job;
      update({ ...review, job, phase: "saving" });
      const result = await saveBusinessReview({ ...guard, job, vaultKey: context.vaultKey!,
        vaultOwnerToken: context.vaultOwnerToken!, sharingImpactAcknowledged });
      await guard.assertCurrent();
      if (!result || result.remaining) {
        const checkpoint = await loadBusinessReview(context.ownerId!, context.vaultKey!);
        await guard.assertCurrent();
        update({ ...review, job: checkpoint?.job || job, cards: job.cards,
          selected: job.cards.map(card => card.card_id), phase: "review" });
        throw new Error("Some details still need saving. Retry this review.");
      }
      setState(null); setOpen(false);
      return result;
    })();
    morphyToast.promise(action, { loading: "Saving approved details…", success: "Business details saved to private memory.",
      error: "Some details could not be confirmed. Reopen this review to retry." });
    try { await action; }
    catch {
      if (guard.isCurrent()) {
        // The checkpoint may exist even if a transport response was lost.
        try {
          const checkpoint = await loadBusinessReview(context.ownerId!, context.vaultKey!);
          await guard.assertCurrent();
          const job = checkpoint?.job || attemptedJob;
          update({ ...review, job, cards: job?.cards || review.cards,
            selected: job?.cards.map(card => card.card_id) || review.selected, phase: "review" });
        } catch { if (guard.isCurrent()) update({ ...review, job: attemptedJob,
          cards: attemptedJob?.cards || review.cards, selected: attemptedJob?.cards.map(card => card.card_id) || review.selected, phase: "review" }); }
      }
    } finally { if (guard.isCurrent()) busy.current = false; }
  };
  const defer = async (decision: "later" | "not_me") => {
    if (!review || busy.current) return;
    const guard = session(); if (!guard.isCurrent()) return;
    busy.current = true;
    try {
      await guard.assertCurrent();
      const result = await decideBusinessReview({ ownerId: context.ownerId!, vaultKey: context.vaultKey!, decision,
        assertCurrent: guard.assertCurrent });
      if (result === null) throw new Error("A review is already being saved.");
      await guard.assertCurrent(); setState(null); setOpen(false);
    } catch { if (guard.isCurrent()) morphyToast.error("Your choice could not be saved. Try again."); }
    finally { if (guard.isCurrent()) busy.current = false; }
  };

  if (!review || !eligible()) return null;
  const pending = review.phase === "preparing" || review.phase === "saving";
  return <section aria-label="Business profile suggestion" className="my-3 min-w-0">
    <Button variant="muted" className="min-h-11" onClick={() => setOpen(true)}>Review business details</Button>
    <AdaptiveDetailSurface open={open} onOpenChange={next => { if (!pending) setOpen(next); }}
      title="Is this your business?" description="UAT test suggestion · Your email domain matches Hushh. Ownership is not verified."
      headerTextOverflow="wrap" mobilePresentation="sheet">
      <div className="space-y-[var(--app-form-section-gap)]">
        {!review.job && <div className="space-y-[var(--app-form-related-gap)]">
          <div className="space-y-[var(--app-form-field-gap)]"><Label htmlFor="business-review-name">Business name</Label>
            <Input id="business-review-name" maxLength={160} value={review.name} disabled={pending}
              onChange={event => update({ ...review, name: event.target.value, cards: [], selected: [], phase: "offer" })} /></div>
          <div className="space-y-[var(--app-form-field-gap)]"><Label htmlFor="business-review-website">Website</Label>
            <Input id="business-review-website" type="url" maxLength={512} value={review.website} disabled={pending}
              onChange={event => update({ ...review, website: event.target.value, cards: [], selected: [], phase: "offer" })} /></div>
        </div>}
        <p className="text-sm text-muted-foreground">Only details you select and confirm are saved. This does not publish a profile or claim ownership.</p>
        {pending && <p role="status" className="text-sm">{review.phase === "preparing" ? "Preparing details for review…" : "Saving approved details…"}</p>}
        {(review.phase === "review" || review.phase === "saving") && <AgentPkmReviewPanel
          cards={review.cards} selectedCardIds={new Set(review.selected)} saving={pending} showSourceText className="[&_button]:min-h-11"
          onToggleCard={review.job ? undefined : id => update({ ...review, selected: review.selected.includes(id)
            ? review.selected.filter(value => value !== id) : [...review.selected, id] })}
          onSave={() => void save()} onDismiss={() => setOpen(false)} />}
        <div className="flex flex-wrap gap-2">
          {review.phase === "offer" && <Button className="min-h-11" disabled={pending || !review.name.trim() || !review.website.trim()}
            onClick={() => void prepare()}>Review details</Button>}
          <Button variant="muted" className="min-h-11" disabled={pending} onClick={() => void defer("later")}>Later</Button>
          {!review.job && <Button variant="muted" className="min-h-11" disabled={pending} onClick={() => void defer("not_me")}>Not my business</Button>}
        </div>
      </div>
    </AdaptiveDetailSurface>
    <AlertDialog open={acknowledging && open} onOpenChange={setAcknowledging}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Update shared memory?</AlertDialogTitle>
        <AlertDialogDescription>These details affect memory already shared with {sharingCount} {sharingCount === 1 ? "person" : "people"}.</AlertDialogDescription>
      </AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction onClick={() => void save(true)}>Save and update sharing</AlertDialogAction>
      </AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </section>;
}
