import { AiMemberConfig, DEFAULT_PROVIDER_MODELS, isOperator } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { en, getLocale, hu, operatorMember } from './index';

describe('operatorMember', () => {
  it('is a valid AI Operator with the starting values of a new member', () => {
    const member = operatorMember({ language: 'en', sponsor: 'owner', taken: ['owner'] });
    expect(AiMemberConfig.safeParse(member).success).toBe(true);
    expect(isOperator(member)).toBe(true);
    expect(member).toMatchObject({
      kind: 'ai',
      handle: 'operator',
      displayName: 'Operator',
      role: 'ai_operator',
      model: DEFAULT_PROVIDER_MODELS.claude,
      capacity: 1,
      sponsor: 'owner',
      temp: false,
    });
    expect(member.onLeave).toBeUndefined();
  });

  it('is named in the project language', () => {
    expect(operatorMember({ language: 'hu', sponsor: 'owner', taken: [] }).displayName).toBe('Operátor');
  });

  it('takes the first free handle when operator is taken', () => {
    const handle = (taken: string[]) => operatorMember({ language: 'en', sponsor: 'o', taken }).handle;
    expect(handle(['operator'])).toBe('operator-2');
    expect(handle(['operator', 'operator-2'])).toBe('operator-3');
    expect(handle(['operator-2'])).toBe('operator');
  });
});

describe('the role names (PM-447)', () => {
  it('shows the human operator role as the owner, and the AI one as the Operator', () => {
    expect([hu.roles.operator.name, hu.roles.ai_operator.name]).toEqual(['Tulajdonos', 'Operátor']);
    expect([en.roles.operator.name, en.roles.ai_operator.name]).toEqual(['Owner', 'Operator']);
    expect(getLocale('hu').roles.operator.name).toBe('Tulajdonos');
  });
});
