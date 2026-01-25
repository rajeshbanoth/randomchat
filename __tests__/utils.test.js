// __tests__/utils.test.js
const { calculateCompatibility, getSharedInterests } = require('../index');

describe('calculateCompatibility', () => {
  test('defaults to 50 when missing', () => {
    expect(calculateCompatibility(null, null)).toBe(50);
  });

  test('age closeness increases score', () => {
    const u1 = { age: 25 }, u2 = { age: 27 };
    const s = calculateCompatibility(u1, u2);
    expect(s).toBeGreaterThan(50);
  });

  test('shared interests add to score', () => {
    const u1 = { interests: ['football', 'music'] }, u2 = { interests: ['music', 'cooking'] };
    const s = calculateCompatibility(u1, u2);
    expect(s).toBeGreaterThan(50);
  });
});

describe('getSharedInterests', () => {
  test('returns common interests case-insensitively', () => {
    const a = ['Music', 'football'], b = ['music', 'cooking'];
    const shared = getSharedInterests(a, b);
    expect(shared).toEqual(['Music']);
  });

  test('returns [] for invalid input', () => {
    expect(getSharedInterests(null, null)).toEqual([]);
  });
});
