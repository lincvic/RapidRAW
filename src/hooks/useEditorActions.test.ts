import { describe, expect, it, vi } from 'vitest';
import { routeResetForSelection, runAutoAdjustmentsForCurrentSession } from './useEditorActions';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('editor auto-adjust session routing', () => {
  const readySession = (path: string, generation: number) => ({
    adjustmentSessionGeneration: generation,
    selectedImage: { isReady: true, path },
  });

  it('does not calculate or apply adjustments for an unready session', async () => {
    const calculate = vi.fn(async () => ({ exposure: 1 }));
    const apply = vi.fn();

    const applied = await runAutoAdjustmentsForCurrentSession(
      () => ({ adjustmentSessionGeneration: 3, selectedImage: { isReady: false, path: '/fixtures/A.RAF' } }),
      calculate,
      apply,
    );

    expect(applied).toBe(false);
    expect(calculate).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('applies calculated adjustments only while the same ready session remains current', async () => {
    const session = readySession('/fixtures/A.RAF', 3);
    const adjustments = { exposure: 1 };
    const apply = vi.fn();

    const applied = await runAutoAdjustmentsForCurrentSession(
      () => session,
      async () => adjustments,
      apply,
    );

    expect(applied).toBe(true);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(adjustments);
  });

  it('discards a delayed result after navigation selects another image', async () => {
    let session = readySession('/fixtures/A.RAF', 3);
    const calculation = deferred<{ exposure: number }>();
    const apply = vi.fn();
    const operation = runAutoAdjustmentsForCurrentSession(
      () => session,
      () => calculation.promise,
      apply,
    );

    session = readySession('/fixtures/B.RAF', 4);
    calculation.resolve({ exposure: 1 });

    await expect(operation).resolves.toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('discards a delayed result after the same path starts a new editor session', async () => {
    let session = readySession('/fixtures/A.RAF', 3);
    const calculation = deferred<{ exposure: number }>();
    const apply = vi.fn();
    const operation = runAutoAdjustmentsForCurrentSession(
      () => session,
      () => calculation.promise,
      apply,
    );

    session = readySession('/fixtures/A.RAF', 4);
    calculation.resolve({ exposure: 1 });

    await expect(operation).resolves.toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('discards a delayed result when the target becomes unready', async () => {
    let session = readySession('/fixtures/A.RAF', 3);
    const calculation = deferred<{ exposure: number }>();
    const apply = vi.fn();
    const operation = runAutoAdjustmentsForCurrentSession(
      () => session,
      () => calculation.promise,
      apply,
    );

    session = { ...session, selectedImage: { ...session.selectedImage, isReady: false } };
    calculation.resolve({ exposure: 1 });

    await expect(operation).resolves.toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('whole-image reset routing', () => {
  it('reports a loading selected target without invoking any reset path', async () => {
    const resetSelected = vi.fn();
    const resetWithoutSelected = vi.fn();

    await expect(
      routeResetForSelection(
        { isReady: false, path: '/fixtures/loading.RAF' },
        ['/fixtures/loading.RAF'],
        resetSelected,
        resetWithoutSelected,
      ),
    ).rejects.toMatchObject({
      name: 'ResetTargetLoadingError',
      message: expect.stringContaining('loading'),
    });

    expect(resetSelected).not.toHaveBeenCalled();
    expect(resetWithoutSelected).not.toHaveBeenCalled();
  });

  it('routes a ready selected target through the authoritative reset callback', async () => {
    const resetSelected = vi.fn(async () => undefined);
    const resetWithoutSelected = vi.fn();

    const ran = await routeResetForSelection(
      { isReady: true, path: '/fixtures/ready.RAF' },
      ['/fixtures/ready.RAF', '/fixtures/other.RAF'],
      resetSelected,
      resetWithoutSelected,
    );

    expect(ran).toBe(true);
    expect(resetSelected).toHaveBeenCalledWith('/fixtures/ready.RAF');
    expect(resetWithoutSelected).not.toHaveBeenCalled();
  });
});
