import { CheckCircle2, Clock, RotateCcw, XCircle } from 'lucide-react';

export interface ApprovalStepView {
  id: number;
  step_order: number;
  step_name: string;
  role_label?: string;
  status: string;
  actor_name?: string | null;
  acted_at?: string | null;
  comment?: string | null;
}

export interface ApprovalLogView {
  id: number;
  action: string;
  actor_name: string;
  actor_role: string;
  comment?: string | null;
  created_at: string;
}

const ACTION_TEXT: Record<string, string> = {
  SAVE_DRAFT: '保存草稿',
  SUBMIT: '提交审批',
  RESUBMIT: '修改重提',
  APPROVE: '审批通过',
  RETURN: '退回修改',
  REJECT: '驳回',
  WITHDRAW: '撤回申请',
  PAY: '财务打款核销',
  AUTO_SKIP: '系统自动跳过',
};

export function ApprovalTimeline({
  steps,
  logs,
  paymentNode,
}: {
  steps: ApprovalStepView[];
  logs: ApprovalLogView[];
  paymentNode?: { status: 'WAITING' | 'PENDING' | 'DONE'; paymentRef?: string | null };
}) {
  return (
    <div className="space-y-5">
      {steps.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-stone-500 mb-3">
            审批与付款流程节点
          </h4>
          <div className="flex flex-wrap items-center gap-2">
            {steps.map((s, idx) => {
              const isDone = s.status === 'APPROVED';
              const isPending = s.status === 'PENDING';
              const isReturned = s.status === 'RETURNED';
              const isRejected = s.status === 'REJECTED';
              return (
                <div key={s.id} className="flex items-center gap-2">
                  <div
                    className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs ${
                      isDone
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                        : isPending
                          ? 'bg-amber-50 border-amber-300 text-amber-900 ring-2 ring-amber-100'
                          : isReturned
                            ? 'bg-orange-50 border-orange-200 text-orange-800'
                            : isRejected
                              ? 'bg-rose-50 border-rose-200 text-rose-800'
                              : 'bg-stone-50 border-stone-200 text-stone-500'
                    }`}
                  >
                    {isDone ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                    ) : isPending ? (
                      <Clock className="w-3.5 h-3.5 text-amber-600" />
                    ) : isReturned ? (
                      <RotateCcw className="w-3.5 h-3.5 text-orange-600" />
                    ) : isRejected ? (
                      <XCircle className="w-3.5 h-3.5 text-rose-600" />
                    ) : (
                      <span className="w-3.5 h-3.5 rounded-full border border-stone-300 inline-block" />
                    )}
                    <div>
                      <div className="font-semibold">
                        {s.step_order}. {s.step_name}
                      </div>
                      {s.actor_name && (
                        <div className="text-[11px] opacity-80">{s.actor_name}</div>
                      )}
                    </div>
                  </div>
                  {(idx < steps.length - 1 || paymentNode) && <span className="text-stone-300">→</span>}
                </div>
              );
            })}
            {paymentNode && (
              <div
                className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs ${
                  paymentNode.status === 'DONE'
                    ? 'bg-teal-50 border-teal-200 text-teal-800'
                    : paymentNode.status === 'PENDING'
                      ? 'bg-amber-50 border-amber-300 text-amber-900 ring-2 ring-amber-100'
                      : 'bg-stone-50 border-stone-200 text-stone-500'
                }`}
              >
                {paymentNode.status === 'DONE' ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-teal-600" />
                ) : paymentNode.status === 'PENDING' ? (
                  <Clock className="w-3.5 h-3.5 text-amber-600" />
                ) : (
                  <span className="w-3.5 h-3.5 rounded-full border border-stone-300 inline-block" />
                )}
                <div>
                  <div className="font-semibold">财务付款核销</div>
                  {paymentNode.status === 'DONE' && paymentNode.paymentRef && (
                    <div className="text-[11px] opacity-80 font-mono">{paymentNode.paymentRef}</div>
                  )}
                  {paymentNode.status === 'PENDING' && (
                    <div className="text-[11px] opacity-80">待财务打款</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {logs.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-stone-500 mb-3">
            操作审计日志
          </h4>
          <div className="space-y-2.5 border-l-2 border-stone-200 pl-4 ml-1.5">
            {logs.map((l) => (
              <div key={l.id} className="relative text-xs">
                <span className="w-2 h-2 rounded-full bg-brand-500 absolute -left-[21px] top-1.5" />
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-stone-800">
                    {l.actor_name} · {ACTION_TEXT[l.action] || l.action}
                  </span>
                  <span className="text-stone-400 tabular-nums">{l.created_at}</span>
                </div>
                {l.comment && <p className="text-stone-600 mt-0.5">{l.comment}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
