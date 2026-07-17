import {
  getMortConfig,
  listCurrentFacts,
  listPendingReviews,
  type MortConfig,
  type MortFact,
  type MortReviewItem,
} from "@/lib/mort-review";
import { MortReviewList } from "@/components/mort-review-list";
import { MortModeSwitcher } from "@/components/mort-mode-switcher";
import { MortFacts } from "@/components/mort-facts";

export const dynamic = "force-dynamic";

export default async function AdminMortPage() {
  let items: MortReviewItem[] = [];
  let config: MortConfig | null = null;
  let facts: MortFact[] = [];
  let error: string | null = null;
  try {
    [config, items, facts] = await Promise.all([getMortConfig(), listPendingReviews(), listCurrentFacts()]);
  } catch (e) {
    error = e instanceof Error ? e.message : "unreachable";
  }

  return (
    <div className="pb-12">
      {config && <MortModeSwitcher config={config} />}
      <section className="mt-6">
        <h2 className="border-b border-divider pb-2 text-[15px] font-semibold text-text">
          Mort — pending proposals
        </h2>
        <p className="mt-2 text-[13px] text-text-3">
          Mort proposes documentation changes; you decide. Approving executes a
          non-destructive write (Mort only ever edits its own region). Rejecting drops it.
        </p>
        {error ? (
          <p className="mt-4 text-sm text-danger">Couldn&apos;t reach the ingest service: {error}</p>
        ) : items.length === 0 ? (
          <p className="mt-4 text-sm text-text-3">No pending proposals.</p>
        ) : (
          <MortReviewList items={items} />
        )}
      </section>
      {!error && <MortFacts facts={facts} />}
    </div>
  );
}
