"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import { HelperText } from "@/components/app-ui/typography";
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
  const [editing, setEditing] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);
  const review = state?.context === context ? state.review : null;
  const eligible = () => current.current === context && context.enabled && !!context.ownerId &&
    !!context.vaultKey && !!context.vaultOwnerToken && context.tokenExpiresAt !== null && Date.now() < context.tokenExpiresAt;
  const session = () => createAgentPkmCaptureGuard({ userId: context.ownerId || "",
    signal: controller.current?.signal ?? AbortSignal.abort(), isEnabled: eligible });

  useEffect(() => {
    const abort = new AbortController(); controller.current = abort; busy.current = false;
    setAcknowledging(false); setOpen(false); setEditing(false);
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
  return <section aria-label="Is this your business?" data-message-role="assistant"
    className="my-3 min-w-0 space-y-[var(--app-form-section-gap)]">
    <div className="space-y-[var(--app-form-field-gap)]">
      <HelperText className="font-semibold text-foreground">One</HelperText>
      <p className="ui-text-body text-foreground">I found a business you may be connected to. Is this yours?</p>
    </div>
    {!open && <Button variant="muted" size="standard" onClick={() => setOpen(true)}>Review business details</Button>}
    {open && <div className="min-w-0 space-y-[var(--app-form-section-gap)] rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-separator)] bg-[color:var(--app-secondary-surface)] p-4 sm:p-5">
        <div className="min-w-0 space-y-[var(--app-form-field-gap)]">
          <h3 className="ui-text-card-title break-words text-foreground">{review.name || review.candidate.draft.name}</h3>
          <p className="ui-text-row-description break-all text-muted-foreground">{review.website || review.candidate.draft.website}</p>
          {(review.name !== review.candidate.draft.name || review.website !== review.candidate.draft.website) &&
            <HelperText>Your correction · ownership still unverified</HelperText>}
          {!review.job && <Button variant="link" size="standard" disabled={pending} aria-expanded={editing}
            onClick={() => setEditing(value => !value)}>{editing ? "Done editing" : "Edit details"}</Button>}
        </div>
        <div className="space-y-[var(--app-form-field-gap)]">
          {review.candidate.synthetic && <HelperText className="font-semibold text-foreground">UAT test suggestion</HelperText>}
          <HelperText className="leading-relaxed text-foreground/80">Why this appeared: your verified email domain matches Hushh. Business ownership has not been verified.</HelperText>
        </div>
        {editing && !review.job && <div className="space-y-[var(--app-form-section-gap)]">
          <div className="space-y-[var(--app-form-field-gap)]"><Label htmlFor="business-review-name">Business name</Label>
            <Input id="business-review-name" maxLength={160} value={review.name} disabled={pending}
              onChange={event => update({ ...review, name: event.target.value, cards: [], selected: [], phase: "offer" })} /></div>
          <div className="space-y-[var(--app-form-field-gap)]"><Label htmlFor="business-review-website">Website</Label>
            <Input id="business-review-website" type="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={512} value={review.website} disabled={pending}
              onChange={event => update({ ...review, website: event.target.value, cards: [], selected: [], phase: "offer" })} /></div>
        </div>}
        <HelperText className="leading-relaxed text-foreground/80">Review first, then choose what to save. Nothing is published and no ownership claim is created.</HelperText>
        {pending && <p role="status" className="text-sm">{review.phase === "preparing" ? "Preparing details for review…" : "Saving approved details…"}</p>}
        {(review.phase === "review" || review.phase === "saving") && <AgentPkmReviewPanel
          cards={review.cards} selectedCardIds={new Set(review.selected)} saving={pending} showSourceText className="[&_button]:min-h-11"
          onToggleCard={review.job ? undefined : id => update({ ...review, selected: review.selected.includes(id)
            ? review.selected.filter(value => value !== id) : [...review.selected, id] })}
          onSave={() => void save()} onDismiss={() => setOpen(false)} />}
        {(review.phase === "offer" || review.phase === "preparing") ? <FlowActionGroup separateSecondary={false}
          primary={<Button size="standard" loading={review.phase === "preparing"}
            disabled={pending || !review.name.trim() || !review.website.trim()}
            onClick={() => void prepare()}>Review details</Button>}
          secondary={<Button variant="muted" size="standard" disabled={pending} onClick={() => void defer("later")}>Later</Button>}
          tertiary={<Button variant="link" size="standard" disabled={pending} onClick={() => void defer("not_me")}>Not my business</Button>} />
          : <div className="flex flex-wrap justify-end gap-2">
            {!review.job && <Button variant="link" size="standard" disabled={pending} onClick={() => void defer("not_me")}>Not my business</Button>}
            <Button variant="link" size="standard" disabled={pending} onClick={() => void defer("later")}>Later</Button>
          </div>}
      </div>}
    <AlertDialog open={acknowledging && open} onOpenChange={setAcknowledging}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Update shared memory?</AlertDialogTitle>
        <AlertDialogDescription>These details affect memory already shared with {sharingCount} {sharingCount === 1 ? "person" : "people"}.</AlertDialogDescription>
      </AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction onClick={() => void save(true)}>Save and update sharing</AlertDialogAction>
      </AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </section>;
}
