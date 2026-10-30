import { eq, desc, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { BrainTier } from "@/db/schema";
import { sourceName } from "@/lib/format";
import { brainAvatar, brainTitle, showsPublicName, sortSources, SOURCE_LABEL } from "@/lib/identity";
import type { DirectorySource } from "@/server/directory/types";
import { ARCHETYPE_LABELS } from "@/server/profile/archetypes";
import type { ArchetypeId } from "@/server/profile/types";
import { regionNames } from "./metrics";
import { PUBLIC_DELAY_SEC, type NeuronDTO, type RegionDTO, type SynapseDTO } from "./types";

const { brains, neurons, synapses } = schema;
const pj = (path: string) => sql`json_extract(${brains.profileJson}, ${path})`;

function parseJson<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export interface Graph {
  computedAt: number;
  neurons: NeuronDTO[];
  synapses: SynapseDTO[];
  regions: RegionDTO[];
}

/**
 * Whole public graph over listed brains (hundreds of neurons, a few thousand synapses: loaded and filtered in memory).
 * Synapse samples newer than PUBLIC_DELAY_SEC are dropped. No next/server-only imports: the worker builds squads on it.
 */
export async function loadGraph(): Promise<Graph> {
  const db = getDb();
  const [nrows, srows] = await Promise.all([
    db
      .select({
        id: brains.id,
        codename: brains.codename,
        displayName: brains.displayName,
        xHandle: brains.xHandle,
        status: brains.status,
        provenance: brains.provenance,
        provenanceSource: brains.provenanceSource,
        avatarUrl: brains.avatarUrl,
        publicAvatarUrl: brains.publicAvatarUrl,
        sourcesJson: brains.sourcesJson,
        tier: brains.tier,
        archetypeId: sql<ArchetypeId | null>`${pj("$.archetype.id")}`,
        archetypeLabel: sql<string | null>`${pj("$.archetype.label")}`,
        realizedUsd: sql<number | null>`${pj("$.pnl.realizedUsd")}`,
        medianEntryDelaySec: sql<number | null>`${pj("$.timing.medianEntryDelaySec")}`,
        region: neurons.region,
        pagerank: neurons.pagerank,
        leadShare: neurons.leadShare,
        inWeight: neurons.inWeight,
        outWeight: neurons.outWeight,
        partners: neurons.partners,
        entries: neurons.entries,
        updatedAt: neurons.updatedAt,
      })
      .from(neurons)
      .innerJoin(brains, eq(brains.id, neurons.brainId))
      .where(eq(brains.listed, true)),
    db.select().from(synapses).orderBy(desc(synapses.weight)),
  ]);

  const publicBefore = Math.floor(Date.now() / 1000) - PUBLIC_DELAY_SEC;
  const neuronDTOs: NeuronDTO[] = nrows
    .map((r) => {
      const claimed = r.status === "claimed";
      const label = brainTitle(r);
      let attribution: string | null = null;
      if (!claimed && showsPublicName(r)) {
        const first = sortSources(parseJson<DirectorySource[]>(r.sourcesJson, []))[0];
        const via = (first ? SOURCE_LABEL[first.source] : null) ?? sourceName(r.provenanceSource);
        attribution = `${via ? `via ${via} · ` : ""}codename ${r.codename}`;
      } else if (!claimed && (r.displayName || r.xHandle) && r.provenance !== "unattributed") {
        const src = sourceName(r.provenanceSource);
        attribution = `Publicly attributed to ${r.displayName ?? `@${r.xHandle}`}${src ? ` · ${src}` : ""}`;
      }
      return {
        id: r.id,
        label,
        codename: r.codename,
        avatarUrl: brainAvatar({ ...r, brainId: r.id }),
        attribution,
        claimed,
        tier: r.tier as BrainTier,
        archetype: r.archetypeLabel ?? ARCHETYPE_LABELS[r.archetypeId ?? "unrated"],
        region: r.region,
        pagerank: r.pagerank,
        leadShare: r.leadShare,
        inWeight: r.inWeight,
        outWeight: r.outWeight,
        partners: r.partners,
        entries: r.entries,
        realizedUsd: r.realizedUsd == null ? null : Number(r.realizedUsd),
      };
    })
    .sort((a, b) => b.pagerank - a.pagerank || (a.id < b.id ? -1 : 1));
  const listed = new Set(neuronDTOs.map((n) => n.id));

  const synapseDTOs: SynapseDTO[] = srows
    .filter((s) => listed.has(s.pre) && listed.has(s.post))
    .map((s) => ({
      pre: s.pre,
      post: s.post,
      weight: s.weight,
      events: s.events,
      medianLagSec: s.medianLagSec,
      lastEventAt: s.lastEventAt,
      sample: parseJson<SynapseDTO["sample"]>(s.sampleJson, []).filter((e) => e.at <= publicBefore),
    }));

  const delayOf = new Map(nrows.map((r) => [r.id, r.medianEntryDelaySec == null ? null : Number(r.medianEntryDelaySec)]));
  const names = regionNames(
    neuronDTOs.map((n) => ({
      region: n.region,
      label: n.label,
      pagerank: n.pagerank,
      leadShare: n.leadShare,
      medianEntryDelaySec: delayOf.get(n.id) ?? null,
    })),
  );
  const regions: RegionDTO[] = [...names.entries()].map(([id, r]) => ({ id, name: r.name, size: r.size })).sort((a, b) => a.id - b.id);

  return {
    computedAt: nrows.reduce((m, r) => Math.max(m, r.updatedAt), 0),
    neurons: neuronDTOs,
    synapses: synapseDTOs,
    regions,
  };
}
