import { describe,expect,it,vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { CreditCheckoutController } from './credit-payments.controller';
import type { CreditPaymentsService } from './credit-payments.service';
import { DomainError } from '../shared/domain-error.filter';
describe('payment notification HTTP reply',()=>{
 it('sets text/plain only after verification and persistence succeed',async()=>{
  const service={notify:vi.fn().mockResolvedValue('RECV_ORD_ID_test')};
  const reply={type:vi.fn(),send:vi.fn()};reply.type.mockReturnValue(reply);
  await new CreditCheckoutController(service as unknown as CreditPaymentsService).notify({},reply as unknown as FastifyReply);
  expect(reply.type).toHaveBeenCalledWith('text/plain; charset=utf-8');expect(reply.send).toHaveBeenCalledWith('RECV_ORD_ID_test');
 });
 it('does not break JSON error responses by setting a plain content type too early',async()=>{
  const service={notify:vi.fn().mockRejectedValue(new DomainError('验签失败'))};const reply={type:vi.fn(),send:vi.fn()};
  await expect(new CreditCheckoutController(service as unknown as CreditPaymentsService).notify({},reply as unknown as FastifyReply)).rejects.toThrow('验签失败');
  expect(reply.type).not.toHaveBeenCalled();expect(reply.send).not.toHaveBeenCalled();
 });
});
