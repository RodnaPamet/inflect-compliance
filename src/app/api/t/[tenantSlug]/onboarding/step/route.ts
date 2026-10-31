import { getTenantCtx } from '@/app-layer/context';
import { saveOnboardingStep, completeOnboardingStep, skipOnboardingStep } from '@/app-layer/usecases/onboarding';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { z } from 'zod';
import { OnboardingStepEnum } from '@/lib/schemas/onboarding';
import { jsonResponse } from '@/lib/api-response';
import { cookies } from 'next/headers';
import { LOCALE_COOKIE, resolveLocale } from '@/lib/locale-constants';

const StepBodySchema = z.object({
    step: OnboardingStepEnum,
    action: z.enum(['save', 'complete', 'skip']),
    data: z.record(z.string(), z.unknown()).optional().default({}),
}).strip();

export const POST = withApiErrorHandling(withValidatedBody(StepBodySchema, async (req, { params }: { params: Promise<{ tenantSlug: string }> }, body) => {
    const ctx = await getTenantCtx(await params, req);

    if (body.action === 'save') {
        const state = await saveOnboardingStep(ctx, body.step, body.data ?? {});
        return jsonResponse(state);
    }

    if (body.action === 'skip') {
        const state = await skipOnboardingStep(ctx, body.step);
        return jsonResponse(state);
    }

    // action === 'complete'. The starter risks and tasks it creates are
    // written in the user's language, the one the UI reads (#4701).
    const locale = resolveLocale((await cookies()).get(LOCALE_COOKIE)?.value);
    const state = await completeOnboardingStep(ctx, body.step, { locale });
    return jsonResponse(state);
}));

