import { EmptyState } from "../components/EmptyState";

/** Placeholder replaced by the full Portfolio page in milestone M6. */
export function PortfolioPage() {
  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Portfolio</h1>
          <p className="lede">Selected work from your tracked projects.</p>
        </div>
      </div>
      <EmptyState message="No projects selected for your portfolio." />
    </div>
  );
}
