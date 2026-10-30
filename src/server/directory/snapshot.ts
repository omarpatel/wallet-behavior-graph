/**
 * Loads the committed directory sample (data/directory/sample-directory.json, see its README.md) into SourceRows.
 * The sample is synthetic: random wallets with invented labels and stats. Replace it with your own list in the same
 * shape to track real wallets.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanHandle, cleanName, cleanTelegram, cleanUrl, emptyStats, num, type RowStats, type SourceRow } from "./merge";
import type { StudyRecord } from "./types";

export const DIRECTORY_DIR = join(process.cwd(), "data", "directory");
export const DIRECTORY_FILE = "sample-directory.json";

/** One wallet in data/directory/sample-directory.json. */
export interface DirectoryEntry {
  address: string;
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
  url: string | null;
  telegram: string | null;
  followers: number | null;
  rank: number | null;
  stats: Partial<RowStats> | null;
  tags: string[] | null;
  /** Listed as brain-eligible (false = enrichment only). */
  kol: boolean;
  /** Optional early-entry study record for the wallet. */
  study: Partial<StudyRecord> | null;
}

export interface DirectoryFile {
  generatedAt: number;
  wallets: DirectoryEntry[];
}

/** A study record with every field present (missing → null). */
export function studyRecord(s: Partial<StudyRecord>): StudyRecord {
  return {
    hitRate: num(s.hitRate),
    earlyRunners: num(s.earlyRunners),
    earlyMidfails: num(s.earlyMidfails),
    earlyFails: num(s.earlyFails),
    runnersAll: num(s.runnersAll),
    medianDelayMin: num(s.medianDelayMin),
    medianEntryMcapUsd: num(s.medianEntryMcapUsd),
    notes: typeof s.notes === "string" ? s.notes : null,
  };
}

/** SourceRows of one directory file: a "directory" row per wallet, plus a "study" row when it has a study record. */
export function directoryRows(file: DirectoryFile): SourceRow[] {
  const out: SourceRow[] = [];
  for (const w of file.wallets) {
    out.push({
      source: "directory",
      address: w.address,
      name: cleanName(w.name),
      handle: cleanHandle(w.handle),
      url: cleanUrl(w.url),
      avatarUrl: cleanUrl(w.avatarUrl),
      followers: num(w.followers),
      telegram: cleanTelegram(w.telegram),
      rank: num(w.rank),
      stats: w.stats ? { ...emptyStats(), ...w.stats } : null,
      tags: w.tags ?? [],
      study: null,
      kol: w.kol,
      fetchedAt: file.generatedAt,
    });
    if (w.study) {
      out.push({
        source: "study",
        address: w.address,
        name: null,
        handle: null,
        url: null,
        avatarUrl: null,
        followers: null,
        telegram: null,
        rank: null,
        stats: null,
        tags: [],
        study: studyRecord(w.study),
        kol: false,
        fetchedAt: file.generatedAt,
      });
    }
  }
  return out;
}

/** Every directory row from the committed sample. */
export function loadDirectoryRows(): SourceRow[] {
  return directoryRows(JSON.parse(readFileSync(join(DIRECTORY_DIR, DIRECTORY_FILE), "utf8")) as DirectoryFile);
}
