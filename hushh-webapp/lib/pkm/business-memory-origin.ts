import type { AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";

export type BusinessMemoryOrigin = { businessUid: string };

/** A person may have many businesses. An agent merge must not relabel one as another. */
export function assertBusinessMemoryTarget(
  current: Record<string, unknown>, card: AgentPkmPreviewCard, origin: BusinessMemoryOrigin,
) {
  const path = String(card.merge_decision?.target_entity_path ||
    (card.target_entity_scope?.includes(".entities.") ? card.target_entity_scope :
      card.target_entity_scope && card.target_entity_id ? `${card.target_entity_scope}.entities.${card.target_entity_id}` : ""));
  if (!path || !origin.businessUid) throw new Error("Business identity needs a fresh review.");
  const segments = path.split(".");
  if (segments.some((segment) => ["__proto__", "prototype", "constructor"].includes(segment)))
    throw new Error("Invalid business destination.");
  let incoming: unknown = card.candidate_payload;
  for (const segment of segments) {
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming) ||
      !Object.prototype.hasOwnProperty.call(incoming, segment))
      throw new Error("The proposed business identity needs a fresh review.");
    incoming = (incoming as Record<string, unknown>)[segment];
  }
  const proposed = incoming && typeof incoming === "object" && !Array.isArray(incoming)
    ? (incoming as Record<string, unknown>)._business_origin : undefined;
  if (!proposed || typeof proposed !== "object" || Array.isArray(proposed) ||
    (proposed as Record<string, unknown>).business_uid !== origin.businessUid)
    throw new Error("The proposed business identity needs a fresh review.");
  let value: unknown = current;
  for (const segment of segments) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Object.prototype.hasOwnProperty.call(value, segment)) return;
    value = (value as Record<string, unknown>)[segment];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The saved business needs review.");
  const prior = (value as Record<string, unknown>)._business_origin;
  if (!prior || typeof prior !== "object" || Array.isArray(prior) ||
    (prior as Record<string, unknown>).business_uid !== origin.businessUid)
    throw new Error("This would combine different or unidentified businesses. Nothing was changed.");
}
