'use client';

import { useTranslations } from 'next-intl';

/**
 * THE THREE WAYS TO STOP AN AGENT, AT THE POINT OF CHOICE (#2459).
 *
 * They differ in the three things that decide which one an operator wants, and
 * the product stated none of them where the choice is made:
 *
 *   · WHETHER A RUN ALREADY UNDER WAY STOPS. This is the distinction that
 *     matters during an incident and the one most easily assumed wrongly.
 *     SUSPENSION IS A DISPATCH CONTROL: `evaluateAgentRegistration` runs inside
 *     `resolveMcpInvocation`, the workflow engine resolves ONE invocation per
 *     execution and then drives every step on it, so suspending refuses the next
 *     REQUEST and does nothing to a run in flight. THE KILL SWITCH IS A BOUNDARY
 *     CONTROL, step 0 of `authorizeToolCall`, re-read on every tool call — which
 *     is the whole reason it exists, because "nothing in this codebase could
 *     STOP a run that had already started".
 *   · WHETHER IT CAN BE UNDONE. Retire is the only irreversible one.
 *   · WHETHER IT ASKS WHY. Only the kill switch requires a reason, and the
 *     server refuses a blank one: a stop nobody can review afterwards is an
 *     outage with no record.
 *
 * Two caveats are here because they are load-bearing and live nowhere an
 * operator looks. Suspension is INERT for a tenant with `requireRegisteredAgent`
 * off — and worse than inert: a non-ACTIVE agent makes `verdict.agentId` null,
 * and three controls key off exactly that null and OPEN UP. And retirement is
 * refused while proposals await review, so it is not always available even when
 * it is the right answer.
 */
export function StopMethods({ registrationEnforced }: { registrationEnforced: boolean }) {
    const t = useTranslations('admin');

    const rows = [
        {
            key: 'suspend',
            // The flag decides this cell, and the unenforced case is the
            // harder sentence rather than a softer one.
            inFlight: t('stopMethods.suspendInFlight'),
            undo: t('stopMethods.suspendUndo'),
            reason: t('stopMethods.reasonNo'),
            note: registrationEnforced
                ? t('stopMethods.suspendNote')
                : t('stopMethods.suspendNoteUnenforced'),
        },
        {
            key: 'kill',
            inFlight: t('stopMethods.killInFlight'),
            undo: t('stopMethods.killUndo'),
            reason: t('stopMethods.reasonYes'),
            note: t('stopMethods.killNote'),
        },
        {
            key: 'retire',
            inFlight: t('stopMethods.retireInFlight'),
            undo: t('stopMethods.retireUndo'),
            reason: t('stopMethods.reasonNo'),
            note: t('stopMethods.retireNote'),
        },
    ];

    return (
        <div className="space-y-tight" data-testid="stop-methods">
            <p className="text-xs uppercase tracking-wide text-content-subtle">
                {t('stopMethods.heading')}
            </p>
            <ul className="space-y-compact text-sm">
                {rows.map((row) => (
                    <li key={row.key} data-testid={`stop-method-${row.key}`}>
                        <span className="font-medium text-content-emphasis">
                            {t(`stopMethods.${row.key}Name`)}
                        </span>
                        <ul className="mt-1 space-y-tight text-content-muted">
                            <li>{row.inFlight}</li>
                            <li>{row.undo}</li>
                            <li>{row.reason}</li>
                            <li>{row.note}</li>
                        </ul>
                    </li>
                ))}
            </ul>
        </div>
    );
}
