import type { AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";
import { businessMemoryEntity } from "@/lib/pkm/business-memory-origin";

export type BusinessReviewField = { id: string; path: string[]; label: string; value: unknown };
export type BusinessFieldSelection = Record<string, string[]>;

/** Consent applies to the actual proposed entity, not just its source listing. */
export function businessReviewFields(card: AgentPkmPreviewCard): BusinessReviewField[] {
  const fields: BusinessReviewField[] = [];
  const walk = (value: unknown, path: string[]) => {
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length) {
      for (const [key, child] of Object.entries(value)) {
        if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Invalid business field.");
        if (key !== "_business_origin") walk(child, [...path, key]);
      }
    } else if (path.length) fields.push({ id: JSON.stringify(path), path,
      label: path.map(key => key.replaceAll("_", " ")).join(" › "), value });
  };
  walk(businessMemoryEntity(card).value, []);
  return fields;
}

export function initialBusinessFieldSelection(cards: AgentPkmPreviewCard[]): BusinessFieldSelection {
  return Object.fromEntries(cards.map(card => [card.card_id, businessReviewFields(card).map(field => field.id)]));
}

/**
 * Owner-directed narrowing only: keep the model's destination and merge mode.
 * Arrays are one visible field; nested object leaves can be chosen separately.
 * Rebuild the envelope so unreviewed sibling payloads cannot ride along.
 */
export function selectBusinessReviewFields(card: AgentPkmPreviewCard, selectedIds: readonly string[]): AgentPkmPreviewCard | null {
  const fields = businessReviewFields(card);
  const selected = new Set(selectedIds);
  if (selectedIds.length !== selected.size || selectedIds.some(id => !fields.some(field => field.id === id)))
    throw new Error("The field selection changed. Review the details again.");
  const approved = fields.filter(field => selected.has(field.id));
  if (!approved.length) return null;
  const result = structuredClone(card);
  const original = businessMemoryEntity(card);
  const entity: Record<string, unknown> = {};
  for (const field of approved) {
    let cursor = entity;
    field.path.slice(0, -1).forEach(key => {
      cursor[key] ??= {};
      cursor = cursor[key] as Record<string, unknown>;
    });
    cursor[field.path.at(-1)!] = structuredClone(field.value);
  }
  if (original.value._business_origin) entity._business_origin = structuredClone(original.value._business_origin);
  let payload: Record<string, unknown> = entity;
  for (const key of [...original.path].reverse()) payload = { [key]: payload };
  result.candidate_payload = payload;
  const source = `Owner-selected business details. Ownership is not verified.\n${approved.map(field =>
    `${field.label}: ${typeof field.value === "string" ? field.value : JSON.stringify(field.value)}`).join("\n")}`;
  result.source_text = source;
  result.source_quote = source;
  delete result.context_quotes;
  // Generated readable metadata must be rebuilt from approved content. A model
  // summary of the original full profile is not consent to store omitted facts.
  if (result.structure_decision) delete result.structure_decision.summary_projection;
  if (result.manifest_draft) result.manifest_draft.summary_projection = {};
  if (result.retrieval_hints) delete result.retrieval_hints.aliases;
  return result;
}
