import { describe, expect, it } from 'vitest';
import { add } from './add.ts';

describe('add', () => {
  it('should return correct result', () => {
    expect(add(1, 2)).toBe(3);
  });
});
