import { createTossProvider } from './toss.js';
import { createMockPaymentGateway } from './mock.js';

// 설정에 따라 결제 서비스 어댑터를 고른다. 모의 결제일 때만 모의 결제 서비스 라우터(/mock-pg)가 생긴다.
export function createPaymentProvider({ config, db }) {
  if (config.provider === 'toss') {
    return { provider: createTossProvider(config.toss), mockGateway: null };
  }
  const mockGateway = createMockPaymentGateway(db);
  return { provider: mockGateway.provider, mockGateway };
}
