import { describe, it, expect, vi, afterEach } from 'vitest';
import { startMidnightScheduler } from '../scheduler';

afterEach(() => {
  vi.useRealTimers();
});

describe('startMidnightScheduler', () => {
  it('runs once for a UTC day inside the window', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ({ exitCode: 0 }));
    const handle = startMidnightScheduler({
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      live: true,
      run,
      intervalMs: 10_000,
    });
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('2026-08-25');
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('does not run outside the window', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ({ exitCode: 0 }));
    const handle = startMidnightScheduler({
      now: () => new Date('2026-08-25T01:00:00.000Z'),
      live: true,
      run,
      intervalMs: 10_000,
    });
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    handle.stop();
  });

  it('retries inside the window after exit 3', async () => {
    vi.useFakeTimers();
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 3 })
      .mockResolvedValueOnce({ exitCode: 0 });
    const handle = startMidnightScheduler({
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      live: true,
      run,
      intervalMs: 10_000,
    });
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
    handle.stop();
  });
});
