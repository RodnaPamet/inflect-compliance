import { NextRequest, NextResponse } from 'next/server';
import { getLegacyCtx } from '@/app-layer/context';
import { downloadFile } from '@/app-layer/usecases/file';
import { withApiErrorHandling } from '@/lib/errors/api';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ fileName: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getLegacyCtx(req);
    const result = await downloadFile(ctx, params.fileName);

    // R5-P1 — downloadFile now returns a discriminated result: S3 mode hands
    // back a presigned URL (redirect), local mode streams a buffer.
    if (result.mode === 'redirect') {
        return NextResponse.redirect(result.downloadUrl, 307);
    }
    return new NextResponse(result.buffer as unknown as BodyInit, {
        headers: {
            'Content-Type': result.mimeType,
            'Content-Disposition': `attachment; filename="${result.name}"`,
        },
    });
});
