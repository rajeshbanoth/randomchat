// __tests__/integration.mockSockets.test.js
const { makeMockSocket, registerUser, startSearch, activeUsers, instantMatch, calculateCompatibility } = require('../index');

describe('integration: register & match', () => {
  test('two users can be registered and instant matched manually', () => {
    const s1 = makeMockSocket('s1');
    const s2 = makeMockSocket('s2');

    const p1 = registerUser(s1, { username: 'Alice', interests: ['x'] });
    const p2 = registerUser(s2, { username: 'Bob', interests: ['x'] });

    // set users to searching
    activeUsers.get('s1').status = 'searching';
    activeUsers.get('s2').status = 'searching';

    const ok = instantMatch('s1', 's2', 80, 'text');
    expect(ok).toBe(true);

    // verify they both received 'matched' event (mock socket recorded emitted events)
    const s1Emits = s1.emitted.map(e => e.event);
    const s2Emits = s2.emitted.map(e => e.event);
    expect(s1Emits).toContain('matched');
    expect(s2Emits).toContain('matched');
  });
});
