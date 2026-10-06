import { z } from "zod";

import { apiJson } from "@/lib/services/api-client";

// Phase 1 admits only a labelled fixture. Real directory candidates require a
// subsequent contract revision; they must not masquerade as synthetic records.
const candidateSchema = z.object({
  business_uid: z.literal("urn:hushh:business:uat:hushh.ai:v1"),
  synthetic: z.literal(true),
  source_identity: z.object({
    source: z.literal("uat_fixture"),
    source_key: z.literal("hushh.ai:v1"),
  }),
  match_evidence: z.array(z.object({
    kind: z.literal("verified_email_domain"), domain: z.literal("hushh.ai"),
  })).length(1),
  draft: z.object({ name: z.string().min(1), website: z.literal("https://hushh.ai") }),
  ownership_verified: z.literal(false),
  claim_created: z.literal(false),
  verification_required: z.array(z.literal("business_authority")).length(1),
});

const responseSchema = z.object({
  contract_version: z.literal("b2b-profile-suggestion.v1"),
  scope: z.literal("b2b"),
  status: z.enum(["disabled", "no_match", "suggestion_available"]),
  candidates: z.array(candidateSchema).max(1),
  pkm_written: z.literal(false),
}).refine((value) => (value.status === "suggestion_available") === (value.candidates.length === 1));

export type BusinessSuggestion = {
  contractVersion: "b2b-profile-suggestion.v1";
  scope: "b2b";
  status: "disabled" | "no_match" | "suggestion_available";
  candidates: Array<{
    businessUid: string;
    synthetic: true;
    sourceIdentity: { source: "uat_fixture"; sourceKey: "hushh.ai:v1" };
    matchEvidence: Array<{ kind: "verified_email_domain"; domain: "hushh.ai" }>;
    draft: { name: string; website: string };
    ownershipVerified: false;
    claimCreated: false;
    verificationRequired: Array<"business_authority">;
  }>;
  pkmWritten: false;
};

export const BusinessSuggestionService = {
  /** Call after setup resolves and the vault unlocks; never persist the result. */
  async get(vaultOwnerToken: string, signal?: AbortSignal): Promise<BusinessSuggestion> {
    if (!vaultOwnerToken.trim()) throw new Error("Unlock your vault to continue.");
    const value = responseSchema.parse(await apiJson<unknown>("/api/one/business/suggestion", {
      method: "GET",
      headers: { Authorization: `Bearer ${vaultOwnerToken}` },
      cache: "no-store",
      signal,
    }));
    return {
      contractVersion: value.contract_version,
      scope: value.scope,
      status: value.status,
      pkmWritten: value.pkm_written,
      candidates: value.candidates.map((candidate) => ({
        businessUid: candidate.business_uid,
        synthetic: candidate.synthetic,
        sourceIdentity: { source: candidate.source_identity.source, sourceKey: candidate.source_identity.source_key },
        matchEvidence: candidate.match_evidence,
        draft: candidate.draft,
        ownershipVerified: candidate.ownership_verified,
        claimCreated: candidate.claim_created,
        verificationRequired: candidate.verification_required,
      })),
    };
  },
};
