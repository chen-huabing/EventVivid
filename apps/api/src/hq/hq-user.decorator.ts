import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { HqPrincipal } from './hq-auth.guard';

export const CurrentHqUser = createParamDecorator((_: unknown, context: ExecutionContext): HqPrincipal => {
  return context.switchToHttp().getRequest<{ hqUser: HqPrincipal }>().hqUser;
});
