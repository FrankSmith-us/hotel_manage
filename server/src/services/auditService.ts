import { DbQueryRunner } from '../../db/adapter';
import { AuditBizType, AuthUser } from '../types';
import { nowIso } from '../utils/numbers';

export async function logApprovalAction(
  db: DbQueryRunner,
  params: {
    bizType: AuditBizType;
    bizId: number;
    action: string;
    actor: Pick<AuthUser, 'id' | 'display_name' | 'role'>;
    comment?: string | null;
  }
): Promise<void> {
  await db.execute(
    `INSERT INTO approval_logs (biz_type, biz_id, action, actor_id, actor_name, actor_role, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.bizType,
      params.bizId,
      params.action,
      params.actor.id,
      params.actor.display_name,
      params.actor.role,
      params.comment ?? null,
      nowIso(),
    ]
  );
}
