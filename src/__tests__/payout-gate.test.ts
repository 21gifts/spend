import { describe, expect, it } from 'vitest';
import { createPayoutGate } from '../payout-gate';

describe('createPayoutGate', () => {
  it('runs callbacks strictly in order', async () => {
    const gate = createPayoutGate();
    const order: number[] = [];
    const first = gate.run(async () => {
      await Promise.resolve();
      order.push(1);
      return 'a';
    });
    const second = gate.run(async () => {
      order.push(2);
      return 'b';
    });
    await expect(Promise.all([first, second])).resolves.toEqual(['a', 'b']);
    expect(order).toEqual([1, 2]);
  });

  it('runs the next callback after a rejection', async () => {
    const gate = createPayoutGate();
    const first = gate.run(async () => {
      throw new Error('boom');
    });
    const second = gate.run(async () => 7);
    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe(7);
  });
});
