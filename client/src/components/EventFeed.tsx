import { Link } from "react-router-dom";
import type { ActivityEventDto } from "@shared/api-types";
import { eventLabel, formatDateTime } from "../format";

/**
 * Development-journal timeline shared by Dashboard, Activity, and Project Detail.
 * Prioritizes when / project / event / meaningful detail without card noise.
 */
export function EventFeed({
  events,
  showProject = true,
}: {
  events: ActivityEventDto[];
  showProject?: boolean;
}) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>When</th>
          {showProject ? <th>Project</th> : null}
          <th>Event</th>
          <th>Detail</th>
        </tr>
      </thead>
      <tbody>
        {events.map((event) => (
          <tr key={event.id}>
            <td>{formatDateTime(event.occurredAt)}</td>
            {showProject ? (
              <td>
                <Link to={`/projects/${event.localRepositoryId}`}>{event.projectName}</Link>
              </td>
            ) : null}
            <td>
              <span className="mono">{eventLabel(event.eventType)}</span>
            </td>
            <td>{event.summary}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
