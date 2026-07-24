import { describe, expect, it, vi } from 'vitest';
import { routeAutoAdjustForSelection } from './useAppContextMenus';

describe('thumbnail auto-adjust routing', () => {
  it('rejects a loading selected target without invoking either auto-adjust path', async () => {
    const runSelectedMutation = vi.fn(async (_path: string, mutate: () => Promise<void>) => mutate());
    const applyAuto = vi.fn(async () => undefined);

    await expect(
      routeAutoAdjustForSelection(
        () => ({ isReady: false, path: '/fixtures/loading.RAF' }),
        ['/fixtures/loading.RAF', '/fixtures/other.RAF'],
        runSelectedMutation,
        applyAuto,
      ),
    ).rejects.toMatchObject({
      name: 'AutoAdjustTargetLoadingError',
      message: expect.stringContaining('loading'),
    });

    expect(runSelectedMutation).not.toHaveBeenCalled();
    expect(applyAuto).not.toHaveBeenCalled();
  });

  it('routes a ready selected target through the editor mutation callback', async () => {
    const runSelectedMutation = vi.fn(async (_path: string, mutate: () => Promise<void>) => mutate());
    const applyAuto = vi.fn(async () => undefined);

    const selectedTarget = await routeAutoAdjustForSelection(
      () => ({ isReady: true, path: '/fixtures/ready.RAF' }),
      ['/fixtures/ready.RAF', '/fixtures/other.RAF'],
      runSelectedMutation,
      applyAuto,
    );

    expect(selectedTarget).toBe(true);
    expect(runSelectedMutation).toHaveBeenCalledOnce();
    expect(runSelectedMutation).toHaveBeenCalledWith('/fixtures/ready.RAF', expect.any(Function));
    expect(applyAuto).toHaveBeenCalledOnce();
  });

  it('routes a selection excluding the current image through the backend-only callback', async () => {
    const runSelectedMutation = vi.fn(async (_path: string, mutate: () => Promise<void>) => mutate());
    const applyAuto = vi.fn(async () => undefined);

    const selectedTarget = await routeAutoAdjustForSelection(
      () => ({ isReady: false, path: '/fixtures/loading.RAF' }),
      ['/fixtures/other.RAF'],
      runSelectedMutation,
      applyAuto,
    );

    expect(selectedTarget).toBe(false);
    expect(runSelectedMutation).not.toHaveBeenCalled();
    expect(applyAuto).toHaveBeenCalledOnce();
  });

  it('rechecks readiness after a selected mutation waits and before invoking the backend', async () => {
    let selectedImage = { isReady: true, path: '/fixtures/ready.RAF' };
    const applyAuto = vi.fn(async () => undefined);
    const runSelectedMutation = vi.fn(async (_path: string, mutate: () => Promise<void>) => {
      selectedImage = { ...selectedImage, isReady: false };
      await mutate();
    });

    await expect(
      routeAutoAdjustForSelection(() => selectedImage, ['/fixtures/ready.RAF'], runSelectedMutation, applyAuto),
    ).rejects.toMatchObject({ name: 'AutoAdjustTargetLoadingError' });

    expect(runSelectedMutation).toHaveBeenCalledOnce();
    expect(applyAuto).not.toHaveBeenCalled();
  });

  it('rechecks the selected path after a mutation waits and before invoking the backend', async () => {
    let selectedImage = { isReady: true, path: '/fixtures/ready.RAF' };
    const applyAuto = vi.fn(async () => undefined);
    const runSelectedMutation = vi.fn(async (_path: string, mutate: () => Promise<void>) => {
      selectedImage = { isReady: true, path: '/fixtures/replacement.RAF' };
      await mutate();
    });

    await expect(
      routeAutoAdjustForSelection(() => selectedImage, ['/fixtures/ready.RAF'], runSelectedMutation, applyAuto),
    ).rejects.toMatchObject({ name: 'AutoAdjustTargetLoadingError' });

    expect(runSelectedMutation).toHaveBeenCalledOnce();
    expect(applyAuto).not.toHaveBeenCalled();
  });
});
