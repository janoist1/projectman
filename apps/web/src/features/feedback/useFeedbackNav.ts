import { useFeedbackSummary } from '../../api/queries';
import { useProject } from '../../app/contexts';

/**
 * The menu item of the Jelölések page: shown once the project has a surface to mark on, and to an
 * owner or admin who has to set one up. The badge is what the viewer owes: marks to decide for a
 * processor, answers not read yet for everyone else.
 */
export function useFeedbackNav(): { visible: boolean; badge: number } {
  const { key, can } = useProject();
  const summary = useFeedbackSummary(key).data;
  const visible = Boolean(summary?.configured) || can.manageTeam;
  const badge = summary ? (summary.canProcess ? summary.todo : summary.unreadReplies) : 0;
  return { visible, badge };
}
