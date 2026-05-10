/**
 * v0.5.24 — React subscription to the live contribution tally.
 *
 * Returns the latest known count + submissions list, kicking off a
 * cache-aware refetch on mount and re-rendering whenever any
 * consumer (or the optimistic-increment path) calls
 * `bumpOptimistic` / `fetchContributionStats`. Multiple components
 * mounted at once collapse onto a single network round-trip — see
 * the `inflight` dedup in `services/contributionStats.ts`.
 */

import { useCallback, useEffect, useState } from "react";
import {
  fetchContributionStats,
  readSnapshot,
  subscribeContributionStats,
  type ContributionStats,
} from "@/services/contributionStats";

export interface UseContributionStatsResult extends ContributionStats {
  /** Forces a server refetch, bypassing the localStorage TTL. */
  refetch: () => Promise<void>;
}

export function useContributionStats(): UseContributionStatsResult {
  // Seed from the synchronous snapshot so the badge renders the
  // last-known count on the very first paint. The async fetch fires
  // immediately after and emits a change event when the server
  // responds.
  const [snapshot, setSnapshot] = useState<ContributionStats>(() => readSnapshot());

  useEffect(() => {
    const unsubscribe = subscribeContributionStats(() => {
      // Pull the freshly-mutated snapshot. We don't ship the new
      // value through the event payload because all consumers share
      // the same module-level snapshot — passing it would just
      // duplicate state.
      setSnapshot(readSnapshot());
    });
    void fetchContributionStats();
    return unsubscribe;
  }, []);

  const refetch = useCallback(async () => {
    await fetchContributionStats({ force: true });
  }, []);

  return {
    count: snapshot.count,
    submissions: snapshot.submissions,
    refetch,
  };
}
