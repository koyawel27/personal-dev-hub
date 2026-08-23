import { EmptyState } from "../components/EmptyState";

/** Placeholder replaced by the full Contributions page in milestone M4. */
export function ContributionsPage() {
  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Contributions</h1>
          <p className="lede">Your development activity over time.</p>
        </div>
      </div>
      <EmptyState message="No contribution history yet." />
    </div>
  );
}
